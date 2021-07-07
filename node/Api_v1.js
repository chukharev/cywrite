"use strict";

const express = require('express'), sqlite3 = require('sqlite3'), fs = require('fs');

module.exports = function(CyWrite) {
  const send_error = function(res, code, msg) {
    res.statusCode = code;
    res.send(msg || ('Error '+code));
  }

  const router = express.Router();

  router.route('/launch')
    .all(function(req, res) {
      const clone = new CyWrite.Clone( req.body ? req.body : {} );
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
        for (let row of rows) {
          if (row.metadata) row.metadata = JSON.parse(row.metadata);
          if (row.config) row.config = JSON.parse(row.config);
        }
        res.json(rows);
      });
    });
  
  router.route('/final-text/:token')
    .all(function(req, res) {
      if (/[.\/]/.test(req.params.token)) return res.status(401).send('error');
      const fn = CyWrite.config.dir_archive+'/'+req.params.token;
      fs.exists(fn, (ok) => {
        if (!ok) {
          res.status(404); res.send('not found'); return;
        }

        const db = new sqlite3.Database(fn, sqlite3.OPEN_READONLY, (err) => {
          if (err) {
            res.status(404); res.send('could not open'); return;
          }
          db.all('select * from document where kind=?;', ['final'], (err, rows) => {
            if (rows && rows[0]) {
              let j = JSON.parse(rows[0].json);
              res.json({ txt: CyWrite.utils.to_txt(j.paragraphs), html: CyWrite.utils.to_html(j.paragraphs), json: j.paragraphs });
            } else {
              res.status(404); res.send('could not find document'); return;
            }
            db.close();
          });
        });
      })
    });

  router.route('/log-file/:token')
    .all(function(req, res) {
      if (/[.\/]/.test(req.params.token)) return res.status(401).send('error');
      res.sendFile(CyWrite.config.dir_archive+'/'+req.params.token);
    });

  return router;

};
