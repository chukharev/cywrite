// This script applies a correction to the y-axis of eye data (to compensate for the eye-tracker's systematic bias)
// usage: node gaze_correction.js {token}

'use strict';

var CW = require('./CyWriteServer.js'), _ = require('underscore');

var eye_count=0, rc_eye={}, rc_cursor={};

function gaze_correction(token, cb) {
  var row_sum = 0, col_sum = 0, row_real_sum=0, count_sum = 0, count_above=0, count_below=0;

  console.log('+ Processing '+token);

  var stats = {};

  var r = new CW.Clone({
    role: 'research',
    original_token: token,
    log_level_console: 'error',
    adjustments: {}, // make sure that existing adjustments are overriden

    on_message_processed: function(channel, msg) {
      if (channel === 'act' && msg.k === 'cursor') {
        if (eye_count == 1 && rc_cursor.row >= 0 && rc_cursor.row < this.rows) {
          if (!stats[rc_cursor.row]) stats[rc_cursor.row] = [];
          stats[rc_cursor.row].push(rc_eye.row-rc_cursor.row);
          row_sum += Math.abs(rc_eye.row-rc_cursor.row);
          row_real_sum += rc_eye.row-rc_cursor.row;
          col_sum += Math.abs(rc_eye.col-rc_cursor.col);
          count_sum++;
          if (rc_eye.row < rc_cursor.row) count_above++;
          if (rc_eye.row > rc_cursor.row) count_below++;
        }
        eye_count=0;
        rc_cursor = { row: this.cur_row, col: this.cur_col };
      }
      if (channel === 'eye' && msg.k === 'fix') {
        var eye_row = (msg.y / (this.char_height + this.interline));
        var eye_col = (msg.x / this.char_width);
        if (eye_row >= -5 && eye_row < this.rows+5 && eye_col >= -5 && eye_col <= this.cols+5) {
          eye_count++;
          rc_eye = {col: eye_col, row: eye_row};
        }
      }
    },

    on_broadcast: function() {
      if (this.playback_direction === 'pause') {
        const eye_row_shift = row_real_sum/count_sum;
        console.log("count = "+count_sum+"; eye_row_shift="+eye_row_shift);
        this.db3_do('delete from props where name=?;', ['adjustments'], ()=>{
          this.db3_do('insert into props(name,value) values(?,?);', ['adjustments', JSON.stringify({ eye_row_shift: eye_row_shift })]);
        });
        for (var row in stats) {
          var r = stats[row];
          var sum = 0;
          for (var i=0; i<r.length; i++) sum += r[i];
          console.log("row "+row+": count="+r.length+"; eye_row_shift="+sum/r.length);
        }
        if (cb) cb();
      }
    }
  });
  r.start_playback();
}

gaze_correction(process.argv[2], () => console.log('done'));
