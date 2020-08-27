// CyWrite Server
// See LICENSE.txt

var express = require('express'), sockjs = require('sockjs'), CW = require('./CyWriteServer.js'),
cookieParser = require('cookie-parser'), qs=require('qs'), os=require('os'),
bodyParser = require('body-parser'), fs=require('fs'), async = require('async');
api_v1 = require('./Api_v1.js')(CW), api_research = require('./Api_research.js')(CW);

var app, server;

console.log('*** Initializing...');

var templates={};
templates.editor = fs.readFileSync(__dirname+'/editor.html', 'utf-8');

async.series([
  CW.utils.sanitize_all_db3,

  function (callback) {
    app = express();
    app.use(cookieParser()).enable('trust proxy').use(bodyParser.json()).use(bodyParser.urlencoded({extended: true}));
    server = require('http').createServer(app);

    var node_prefix = '/node/';

    sockjs.createServer().on('connection', function(conn) { CW.accept_connection(conn) }).installHandlers(server, {prefix: node_prefix+'sock'});

    app.use('/w', express.static(__dirname + '/static', {maxAge: 0}));
    //app.get('/w', function (req, res) { res.sendFile(__dirname + '/index.html', {maxAge: 0}); });
    //app.get('/w/admin.html', function (req, res) { res.sendFile(__dirname + '/admin.html', {maxAge: 0}); });
    app.get('/w/CyWrite.js', function (req, res) {  res.sendFile(__dirname + '/CyWrite.js', {maxAge: 0}); });
    app.get('/w/CyTrack.js', function (req, res) {  res.sendFile(__dirname + '/CyTrack.js', {maxAge: 0}); });
    app.get('/w/CyWrite.css', function (req, res) {  res.sendFile(__dirname + '/CyWrite.css', {maxAge: 0}); });
    app.get('/w/editor', function (req, res) {  res.sendFile(__dirname + '/editor.html', {maxAge: 0}); });
    app.get('/w/viewer', function (req, res) {  res.sendFile(__dirname + '/viewer.html', {maxAge: 0}); });
    app.get('/w/debug', function (req, res) {  res.sendFile(__dirname + '/debug.html', {maxAge: 0}); });
    app.get('/w/shutdown.html', function (req, res) {  res.sendFile(__dirname + '/shutdown.html', {maxAge: 0}); });

    app.get(node_prefix+'/download', function (req, res) {
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

    app.get('/w/playback', function(req, res) {
      var token = req.param("token");
      var z = req.param("z");
      var clone = new CW.Clone({ role: 'playback', original_token: token, seek_z: z });
      res.redirect('viewer?'+clone.token);
    });

    app.use('/api/v1', api_v1);
    app.use('/api/research', api_research);

    var port = CW.config.port || 9999;
    server.listen(port);
    console.log("*** Init OK");

    callback();
  }
]);
