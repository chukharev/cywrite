"use strict";

const express = require('express'), sqlite3 = require('sqlite3');

module.exports = function(CyWrite) {
  const send_error = function(res, code, msg) {
    res.statusCode = code;
    res.send(msg || ('Error '+code));
  }

  const router = express.Router();

  router.route('/launch')
    .all(function(req, res) {
      const clone = new CyWrite.Clone({ config: req.body ? req.body : null });
      clone.log('info', 'clone created', clone.config);
      res.json({ url: '/w/editor?'+clone.token, token: clone.token });
    });

  router.route('/live')
    .all(function(req, res) {
      res.json(Object.keys(CyWrite.clones).map((x) => { return { token: x, metadata: CyWrite.clones[x].metadata, config: CyWrite.clones[x].config } }));
    });

  router.route('/archive')
    .all(function(req, res) {
      CyWrite.summary_db.all('select * from sessions;', [], (err, rows) => {
        res.json(rows);
      });
    });

  /* TODO other API methods go here  */

  return router;

};
