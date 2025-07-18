"use strict";

var fs = require('fs');
var express = require('express');
var CW = require('./CyWriteServer.js');

const output_folder = "script_output";

function process_token(token, cb) {
  console.log(token);

  const r = new CW.Clone({
    role: 'research',
    original_token: token,
    log_level_console: 'error',
    throttle_eye: 0 // 10000, // to effectively remove eye samples (only consider 1 sample per 10 seconds)
  });

  r.register_hook('interval_end', (i) => {
    output.push(i)
  });
  let output = [];
  r.register_hook('playback_ended', () => {
    fs.writeFileSync(output_folder+'/'+token+'_incremental.json', JSON.stringify(output, null, 2));
    if (cb) cb();
  });
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
