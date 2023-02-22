// This script outputs the *_eye.txt and the *_key.txt formats
// usage: node research_output_key_eye.js {token}

"use strict";

const output_folder = "script_output";

var fs = require('fs');
var express = require('express');
var CW = require('./CyWriteServer.js');

function process_token(token, cb) {
  var inscription = 0, production = 0, p_number=0, block_cursor=0;
  var eye;

  console.log(token);

  var key_output = [];

  var r = new CW.Clone({
    role: 'research',
    original_token: token,
    log_level_console: 'error',

    global_offset: function(msg) {
      if (msg.cur) return this.global_offset(msg.cur);
      if (!('npd' in msg)) return 0;
      var go = 0;
      for (var i=0; i<msg.npd; i++) go += this.paragraphs[i].text.length;
      go += msg.offset;
      return go;
    },

    text_between: function(go1, go2) {
      var gt = '';
      for (var i=0; i<this.paragraphs.length; i++) gt += this.paragraphs[i].text;
      return gt.substring(go1, go2);
    },

    global_length: function() {
      var gl=0;
      for (var i=0; i<this.paragraphs.length; i++) gl += this.paragraphs[i].text.length;
      return gl;
    }
  });

  let mod_time = 0;
  let mod_gap = 0;

  r.register_hook('key', function(msg) {
    if (msg.k === 'down') {
      if (msg.code === 16 || msg.code === 17 || msg.code === 18) {
        if (!mod_time) mod_time = msg.t;
        mod_gap = 0;
      } else {
        mod_gap++;
        if (mod_gap > 2) mod_time = 0;
      }
    }
  });

  r.register_hook('act', function(msg) {
    if (msg.k === 'edit' || msg.k === 'split_paragraphs') {
      var go = this.global_offset(msg);
      var is_production = false, displacement = go - inscription;
      if (msg.k === 'split_paragraphs') {
        msg.repl = '$';
      }
      if (msg.repl.length === 1 && !msg.len) {
        is_production = true;
      }                   
      var old_inscription = inscription;
      if (is_production) {
        inscription = go + 1;
        p_number++;
        var text = this.paragraphs[msg.npd].text.substring(0, msg.offset);
        var location = 'OTHER';
        
        if (msg.k === 'edit') {
          if (msg.repl === " ") {
            location = (/^\s*$/.test(text) || /[.?!]"?\s*$/.test(text)) ? 'PRESENTENCE' : /\w$/.test(text) ? 'PREWORD' : location;
          } else if (/\w/.test(msg.repl)) {
            location = (/^\s*$/.test(text) || /[.?!]"?\s+$/.test(text)) ? 'SENTENCE' : /\w\s+$/.test(text) ? 'WORD' : /\w$/.test(text) ? 'WITHIN' : location;
          }
        }
      }
      var debug = (msg.len ? '<' : '') + msg.repl;
      
      key_output.push([debug, msg.t, mod_time || 'NA', msg.z, p_number, is_production?'P':msg.len>0?'D':'OTHER_EVENT', go, go-old_inscription, is_production?this.global_length()-inscription-1:'-', is_production?location:'-']);
      block_cursor=1;
      mod_time = mod_gap = 0;
    }

    if (msg.k === 'cursor') {
      if (block_cursor) {
        block_cursor = false;
        return;
      }
      key_output.push([debug, msg.t, 'NA', msg.z, p_number, 'C', '-', '-', '-', '-']);
    }
  });

  r.register_hook('eye', function(msg) {
    if (msg.k === 'fix') {
      eye = { t: msg.t };
      var eye_row = parseInt(msg.y / (this.char_height + this.interline));
      var eye_col = parseInt(msg.x / this.char_width);
      if (eye_row >= 0 && eye_row < this.rows && eye_col >= 0 && eye_col <= this.cols) {
        var cr = this.cur_row; var cc = this.cur_col;
        this.cur_row=eye_row; this.cur_col=eye_col;
        var frozen_eye = this.cursor_to_frozen();
        this.cur_row=cr; this.cur_col=cc;

        eye.offset = this.global_offset(frozen_eye);
        if (frozen_eye.npd === 0) {
          eye.kind = 'PROMPT'
        }
        eye.displacement = eye.offset - inscription;
        if (eye.offset < inscription) {
          var text = this.text_between(eye.offset, inscription);
          eye.words = text.split(/[\s\$]+/).length;
          eye.sentences = text.split(/[\$\.!?]+/).length;
        }
      }
    }

    if (msg.k === 'end' && eye) {
      if (eye.offset) {
        eye.duration = msg.dur;
        output('eye', [eye.t, eye.duration, eye.displacement, (eye.words || 1)-1, (eye.sentences || 1)-1, eye.kind || '-'].join("\t"));
      }
      eye = null;
    }
  });

  r.register_hook('playback_ended', function() {
    const loctrans = (row) => row[8] === 'P' ? row[12] : row[8];
    var last_p=-1;
    for (var i=0; i<key_output.length-1; i++) {
      key_output[i].push(loctrans(key_output[i]) + " --> " + loctrans(key_output[i+1]));
      if (key_output[i][8] === 'P') {
        if (last_p >= 0 && key_output[i][9] === key_output[last_p][9]+1) {
          key_output[last_p][13] = loctrans(key_output[last_p]) + " --> " + loctrans(key_output[i]);
          for (var j=last_p+1; j<i; j++) {
            key_output[j][13] = 'FUTILE';
          }
        }
        last_p = i;
      } else if (key_output[i][8] !== 'C') {
        last_p = -1;
      }
    }
    for (var i=0; i<key_output.length; i++) {
      output('key', key_output[i].join("\t"));
    }
    setTimeout(cb, 1000);
  });

  var signature = token;
  var output = function(file, line) {
    fs.appendFileSync(output_folder+'/'+signature+'_'+file+'.txt', line+"\n")
  }
  fs.writeFileSync(output_folder+'/'+signature+'_key.txt', ["Debug", "Timestamp_Long", "Timestamp_Mod_Long", "Z", "P_Index", "Event", "Offset", 'Displ', 'Edge', 'Location', 'Transition'].join("\t") + "\n");
  fs.writeFileSync(output_folder+'/'+signature+'_eye.txt', ["Timestamp_Long", "Duration", "Displ", "Words", "Sentences", "Kind"].join("\t") + "\n");
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
