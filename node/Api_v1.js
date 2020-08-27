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
      res.json({ url: CyWrite.config.base_url+'/w/editor?'+clone.token, token: clone.token });
    });

  /* TODO other API methods go here  */

  return router;

};
