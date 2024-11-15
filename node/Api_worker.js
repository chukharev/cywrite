"use strict";

const express = require('express');
//import express from 'express';

// Main module export function
module.exports = function(CW) {
  const TIMEOUT_LONG_POLLING = CW.config.workers.timeout_long_polling;
  // A map to store worker data
  const workers = {};

  // A map to store the token to worker mapping
  const tokenToWorker = {};

  // The jobs queue
  let jobs = [];

  const workerTypes = CW.config.workers.worker_types;

  const router = express.Router();
  router.use(express.json());

  // set a timeout for every second to check the workers health
  // and assign jobs to available workers
  setInterval(() => {
    monitorWorkersHealth();
    assignJobsToWorkers();
  } , 1000);

  /**
   * Handles the timeout for long polling requests
   * This terminates the worker's current request and sends a 'no_job' response.
   * 
   * @param {string} workerId - The unique identifier for the worker
   */
  const handleLongPollingTimeout = (workerId) => {
    const worker = workers[workerId];
    if (worker && worker.current_request) {
      const { res, timeout } = worker.current_request;
      
      res.json({ result: 'no_job' });
      clearTimeout(timeout);
      delete worker.current_request;
      
      // Mark the worker as stale
      // this will be reset to 0 once the worker sends a new request
      worker.stale_since = Date.now();
    }
  };

  const monitorWorkersHealth = () => {
    const now = Date.now();

    const deadWorkers = [];
    for (const workerId in workers) {
      const worker = workers[workerId];
      const staleFor = now - worker.stale_since;

      // kill the worker if it is stale for too long
      if (staleFor > worker.worker_type.treatAsDeadAfter) {
        // for stateful workers, remove the jobs of all assigned tokens
        for (const token in worker.assignedTokens) {
          // remove the jobs related to the token
          jobs = jobs.filter(job => {
            if (job.token === token) {
              if(job.worker_type.isStateful){
                // call the callback with an error
                job.result_callback(job, { error: 'worker_dead' });
                return false;
              }
            }
            return true;
          });
        }

        // for stateless workers, mark the currently assigned job as 'added' so that it can be reassigned later
        if (worker.current_job) {
          const job = jobs.find(job => job.job_id === worker.current_job);
          if (job) {
            job.state = 'added';
          }
        }

        // mark the worker as dead (instant deletion might cause iteration issues within the map)
        deadWorkers.push(workerId);
        console.log(`############### Stale for ${staleFor} #################`);
      }
      // mark the worker as unavailable if it has been stale for a while
      else if (staleFor > worker.worker_type.doNotAssignTokensAfter) {
        worker.is_available = false;
      } else {
        worker.is_available = true;
      }
    }

    // remove the dead workers
    deadWorkers.forEach(workerId => {
      console.log(`############### Worker ${workerId} is being deleted #################`);
      delete workers[workerId];
    });

    /*
    console.log('Workers map:', workers);
    console.log('Jobs list:', jobs);
    console.log('Token to worker mapping:', tokenToWorker);*/
  };

  const assignStatefulJob = (job, sortedWorkers) => {
    if (job.token in tokenToWorker) {
      // token is already assigned to a worker
      const workerId = tokenToWorker[job.token];
      if (!(workerId in workers)) {
        // worker is dead, inform the callback and mark the job as failed (to remove later)
        job.result_callback(job, { error: 'worker_dead' });
        job.state = 'failed';
      } else {
        const worker = workers[workerId];
        if(worker.is_available && worker.current_request) {
          // send the job to the worker
          // FOR NOW: sending the entire 'job' object
          worker.current_job = job.job_id;
          worker.current_request.res.json({ result: 'job', job });
          clearTimeout(worker.current_request.timeout);
          delete worker.current_request;
          job.state = 'processing';
        }
      }
      return;
    }

    for (const worker of sortedWorkers) {
      if (worker.worker_type.isStateful && worker.is_available && worker.current_request) {
        worker.assignedTokens.push(job.token);
        tokenToWorker[job.token] = worker.worker_id;

        // send the job to the worker
        // FOR NOW: sending the entire 'job' object
        worker.current_job = job.job_id;
        worker.current_request.res.json({ result: 'Successfully retrieved a job', job });
        clearTimeout(worker.current_request.timeout);
        delete worker.current_request;
        job.state = 'processing';
        break;
      }
    }
  };

  const assignStatelessJob = (job, sortedWorkers) => {
    // stateless workers will have their assigned tokens as empty
    // so assign a job to a random stateless available worker
    for (const worker of sortedWorkers) {
      if (!worker.worker_type.isStateful && worker.is_available && worker.current_request) {

        // send the job to the worker
        // FOR NOW: sending the entire 'job' object
        worker.current_job = job.job_id;
        worker.current_request.res.json({ result: 'job', job });
        clearTimeout(worker.current_request.timeout);
        delete worker.current_request;
        job.state = 'processing';
        break;
      }
    }
  };

  const assignJobsToWorkers = () => {
    // sort the workers by the number of assigned tokens
    const sortedWorkers = Object.values(workers).sort((a, b) => a.assignedTokens.length - b.assignedTokens.length);

    for (const job of jobs) {
      if(job.state !== 'added'){
        continue;
      }
      if(job.worker_type.isStateful){
        assignStatefulJob(job, sortedWorkers);
      } else {
        assignStatelessJob(job, sortedWorkers);
      }
    }

    // remove the failed jobs
    jobs = jobs.filter(job => job.state !== 'failed');
  }

  /**
   * Route to register a new worker.
   * Generates a unique worker ID and stores worker information.
   */
  router.route('/register/:worker_type').all((req, res) => {
    const workerType = req.params.worker_type;
    if (!(workerType in workerTypes)) {
      return res.json({ error: 'wrong_worker_type', worker_type: workerType });
    }

    const workerId = `${workerType}:${Date.now()}${Math.random()}`;
    
    workers[workerId] = {
      worker_id: workerId,
      stale_since: Date.now(),
      worker_type: workerTypes[workerType],
      assignedTokens: [],
      current_job: null,
      is_available: true
    };
    
    res.json({ result: 'ok', worker_id: workerId });

    // Monitor workers health
    monitorWorkersHealth();
  });

  /**
   * Route to retrieve a job for a worker.
   * Initiates long polling and handles conflicts with existing requests.
   */
  router.route('/get_job/:worker_id').all((req, res) => {
    const workerId = req.params.worker_id;
    const worker = workers[workerId];

    if (!worker) {
      return res.json({ error: 'no_worker' });
    }

    // Handle existing long-polling requests
    if (worker.current_request) {
      worker.current_request.res.json({ result: 'conflicting_request' });
      clearTimeout(worker.current_request.timeout);
    }

    // Set the new long-polling request and its timeout handler
    worker.current_request = {
      req,
      res,
      timeout: setTimeout(() => handleLongPollingTimeout(workerId), TIMEOUT_LONG_POLLING)
    };
    worker.current_job = null;

    // refresh the stale time
    worker.stale_since = Date.now();

    // mark the worker as not stale, because there is a current request from the worker now
    // worker.stale_since = 0;

    // Monitor workers health
    monitorWorkersHealth();

    // Assign the jobs to available workers
    assignJobsToWorkers();
  });

  /**
   * Route to submit the result of a job by the worker.
   * For now, it simply returns a success response.
   */
  router.route('/submit_result/:job_id').post((req, res) => {
    // Monitor workers health
    monitorWorkersHealth();

    // Process the result submitted in req.body (implementation needed)
    const jobId = req.params.job_id;
    const job = jobs.find(job => job.job_id === jobId);
    if (!job) {
      res.json({ result: 'Token (session) not found'}); // not error because the submission is successful
    } else {  
      // delete the job from jobs list
      jobs = jobs.filter(job => job.job_id !== jobId);

      if(tokenToWorker[job.token]){
        const worker = workers[tokenToWorker[job.token]];
        worker.current_job = null;
        worker.stale_since = Date.now(); // update the stale time
      }

      // FOR NOW: result is the entire req.body
      job.result_callback(job, req.body);
      res.json({ result: 'ok'});
    }
  });

  /**
   * Route to update the heartbeat of a worker.
   */
  router.route('/heartbeat/:worker_id').post((req, res) => {
    // monitor workers health
    monitorWorkersHealth();

    const workerId = req.params.worker_id;
    const worker = workers[workerId];

    if (!worker) {
      return res.json({ error: 'no_worker' });
    }

    worker.stale_since = Date.now();
    worker.is_available = true;

    res.json({ result: 'ok' });
  });
  
  /**
   * Route to get the list of the current jobs in the queue.
   */
  router.route('/get_job_queue').get((req, res) => {
    if(!jobs){
      return res.json({error: 'The queue is null'});
    } else {
      res.json(jobs);
    }
  });

  /**
   * Route to get the list of the current workers.
   * Returns a json object containing the workers.
   */
  router.route('/get_workers').get((req, res) => {
    if(!workers){
      return res.json({error: 'The workers list is null'});
    } else {
      res.json(workers);
    }
  });

  /**
   * Route to get the list of the current token to worker mapping.
   */
  router.route('/get_token_to_worker_mapping').get((req, res) => {
    if(!tokenToWorker){
      return res.json({error: 'The token to worker mapping is null'});
    } else {
      res.json(tokenToWorker);
    }
  });



  /**
   * An API function exposed to the main CyWrite system through the CW object
   * used to add a job.
   * 
   * @param {Object} job - Job object that needs to be added
   */
  CW.worker_add_job = function(job) {
    
    // Monitor workers health first
    monitorWorkersHealth();
    
    job.state = 'added';
    job.worker_type = workerTypes[job.worker_type];
    jobs.push(job);

    // Assign the jobs to available workers
    assignJobsToWorkers();
  };

  /**
   * An API function exposed to the main CyWrite system through the CW object
   * used to notify the server when a token is destroyed.
   * 
   * @param {String} token - token that needs to be destroyed
   */
  CW.worker_token_destroyed = function(token) {
    jobs = jobs.filter(job => job.token !== token);

    const workerId = tokenToWorker[token];
    // in-case the token is not present in the map (i.e. no stateful job with the token appeared before)
    if (!workerId) {
      return;
    }

    delete tokenToWorker[token];

    const worker = workers[workerId];
    if (!worker) {
      return;
    }

    worker.assignedTokens = worker.assignedTokens.filter(t => t !== token);

    // Monitor workers health
    monitorWorkersHealth();
  };

  /**
   * Just a helper method (can be deleted anytime) that shows the current state of the workers and jobs.
   * @returns {Object} - An object containing the workers, jobs, and the token to worker mapping
   */
  CW.worker_get_states = () => {
    return {
      workers,
      jobs,
      tokenToWorker
    };
  };

  return router;
};
