"use strict";

const fs = require('fs');
const path = require('path');
const express = require('express');
const CW = require('./CyWriteServer.js');

const output_folder = "script_output";
const arc_folder = "arc";

// Ensure output folder exists
try {
  if (!fs.existsSync(output_folder)) {
    fs.mkdirSync(output_folder);
  }
} catch (err) {
  console.error(err);
}


const get_TPSF = function(clone) {
  let text = '';
  for (let i = 1; i < clone.paragraphs.length; i++) {
    text += clone.paragraphs[i].text.slice(0, -1) + "\n";
  }
  return text;
}

let old_tpsf = '';

function process_token(token, cb) {
  console.log(`Processing token: ${token}`);

  const r = new CW.Clone({
    role: 'research',
    original_token: token,
    log_level_console: 'error',
    throttle_eye: 20000
  });

  let output = [];
  r.register_hook('interval_end', (i) => {
    output.push(i);
    i.tpsf = old_tpsf;
    old_tpsf = get_TPSF(r);
  });

  r.register_hook('playback_ended', () => {
    fs.writeFileSync(
      path.join(output_folder, `${token}_incremental.json`),
      JSON.stringify(output, null, 2)
    );
    console.log(`Finished processing ${token}`);
    if (cb) cb();
  });

  r.start_playback();
}

// Read all files in arc directory and extract token names (without extension)
fs.readdir(arc_folder, (err, files) => {
  if (err) {
    console.error("Error reading arc directory:", err);
    return;
  }

  const tokens = files
    .filter(file => fs.lstatSync(path.join(arc_folder, file)).isFile())
    .map(file => path.parse(file).name); // removes file extension

  function process_next(index) {
    if (index >= tokens.length) {
      console.log("All tokens processed.");
      return;
    }

    process_token(tokens[index], () => process_next(index + 1));
  }

  process_next(0);
});
