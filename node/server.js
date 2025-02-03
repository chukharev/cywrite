"use strict";

const
  express = require('express'),
  sockjs = require('sockjs'),
  CW = require('./CyWriteServer.js'),
  cookieParser = require('cookie-parser'),
  qs=require('qs'),
  os=require('os'),
  bodyParser = require('body-parser'),
  fs=require('fs'),
  Async = require('async'),
  api_v1 = require('./Api_v1.js')(CW),
  api_research = require('./Api_research.js')(CW), // post-session viewer
  expressBasicAuth = require('express-basic-auth');

var app, server;

console.log('*** Initializing...');

for (let param in CW.config) {
  if (/^dir_/.test(param)) {
    const dir = CW.config[param];
    if (!fs.existsSync(dir)) {
      console.log('+ Creating dir '+dir);
      fs.mkdirSync(dir);
    }
  }
}

Async.series([
  CW.utils.open_summary_db3,
  CW.utils.sanitize_all_db3,
  CW.utils.summarize_all_db3,

  function (callback) {
    app = express();
    app.use(cookieParser()).enable('trust proxy').use(bodyParser.json()).use(bodyParser.urlencoded({extended: true}));
    if (CW.config.users) app.use(expressBasicAuth({ challenge: true, realm: 'CyWrite', users: CW.config.users }));
    server = require('http').createServer(app);

    var node_prefix = '/node/';

    sockjs.createServer().on('connection', function(conn) { CW.accept_connection(conn) }).installHandlers(server, {prefix: node_prefix+'sock'});

    for (let file of ['CyWrite.js', 'CyTrack.js', 'CyWriteViewer.js', 'CyWrite.css', 'editor.html', 'viewer.html', 'debug.html', 'shutdown.html']) {
      app.get('/w/'+file, (req, res) => res.sendFile(__dirname + '/' + file, {maxAge: 0}));
      if (/\.html$/.test(file)) app.get('/w/'+file.slice(0, -5), (req, res) => res.sendFile(__dirname + '/' + file, {maxAge: 0}));
    }

    app.get(node_prefix+'download', function (req, res) {
      var token = req.param("token");
      var clone = CW.clones[token];
      if (clone) {
        var paras = clone.snapshot();
        var html = CW.utils.to_html(paras.paragraphs, {no_styles: true});
        html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"></head><body>'+html+'</body></html>';

        res.setHeader('Content-disposition', 'attachment; filename=document.doc');
        res.setHeader('Content-type', 'application/msword');

        res.send(html);
      } else {
        res.send('error');
      }
    });
    
    app.get(node_prefix+'image', function (req, res) {
      var token = req.param("token");
      var clone = CW.clones[token];
      if (clone && clone.eyetracker_image) {
        const img = clone.eyetracker_image;
        res.writeHead(200, {
           'Content-Type': 'text/plain',
           'Content-Length': img.length
        });
        res.end(img); 
      } else {
        res.send('error');
      }
    });

    app.use('/api/v1' + (CW.config.api_secret ? '/'+CW.config.api_secret : ''), api_v1);
    app.use('/api/research', api_research);
    if (CW.config.workers) {
      const api_worker = require('./Api_worker.js')(CW);
      app.use('/api/worker' + (CW.config.workers.api_secret ? '/'+CW.config.workers.api_secret : ''), api_worker);
      console.log('*** api_worker initialized');
    }
    app.use('/static', express.static(__dirname + '/static'));

    app.get('/', (req, res) => res.redirect(302, '/w/debug')); 

    const port = CW.config.port || 9999;
    server.listen(port);
    console.log("*** Init OK");
    console.log("*** Go to http://localhost:" + port + "/ in your browser to get started");

    callback();
  }
]);
