// This script creates a dump of a given token in a new folder
// usage: node research_dump_session.js {token}

"use strict";

const output_folder = "session_dumps";

var fs = require('fs');
var express = require('express');
var CW = require('./CyWriteServer.js');

function process_token(token, cb) {
  console.log(token);

  const r = new CW.Clone({
    role: 'research',
    original_token: token,
    log_level_console: 'error',
    ignore_eye: true
  });

  r.register_hook('act', function(msg) {
    if (msg.k !== 'cursor') {
      const dump = this.snapshot({no_props:1, no_csns:1});
      dump.msg = msg;
      fs.writeFileSync(output_folder+'/'+token+'/'+msg.z+'.json', JSON.stringify(dump));
    }
  });

  if (cb) r.register_hook('playback_ended', cb);
  try {
    fs.mkdirSync(output_folder+'/'+token);
  } catch(err) {}
  r.start_playback();
}


try {
  if (!fs.existsSync(output_folder)) {
    fs.mkdirSync(output_folder)
  }
} catch (err) {
  console.error(err)
}

process_token(process.argv[2], () => console.log('done'));
