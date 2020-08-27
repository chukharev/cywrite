"use strict";

var fs = require('fs');
var express = require('express');

module.exports = function(CW) {
  var send_error = function(res, code, msg) {
    res.statusCode = code;
    res.send(msg || ('Error '+code));
  }

  var router = express.Router();

  router.route('/session/:token').get(function(req, res) {
    graph_db_status(req.params.token, function(pct) {
      if (pct === 2) res.json({ ready: true, progress: 1 }); else res.json({ ready: false, progress: pct });
    });
  });
  
  router.route('/session/:token/data').get(function(req, res) {
    res.sendFile(CW.config.sqlite_graph+'/'+req.params.token+'.graph', {maxAge: 0, headers: { 'content-type': 'application/json'}});
  });

  var graph_db_processing = {};
  var graphs = {};

  function graph_db_status(token, cb) {
    var fn = CW.config.sqlite_graph+'/'+token+'.graph';
    if (token in graph_db_processing) return cb(graph_db_processing[token] > 1 ? 1 : graph_db_processing[token]);
    fs.exists(fn, function(ok) {
      if (!ok) {
        create_graph_db(token);
        cb(0);
      } else cb(2);
    });
  }

  function create_graph_db(token) {
    var fn = CW.config.sqlite_graph+'/'+token+'.graph';
    var cur_data = {}, cur_rows = {}, cur_vars={};
    var summary = {}, annotations = { lookback: [] }, html = {}, calibration = {};
    
    var chars_map = {}; var chars_seq = []; var chars_info = {};

    graph_db_processing[token] = 0;
    var out_all = [], out_diff = {};
    var count_typed_chars=0;
    var flags = {};
    var cur_revision = {};
    var cur_deleted;
    var revisions = [];
    var mark_previous_csn = 0, mark_previous_offset = 0;

    var r = new CW.Clone({
      role: 'research',
      original_token: token,
      log_level_console: 'error',
      eye_y_shift: 0, //yshifts[token] || 
      death_sequence: 0,
      //fix_undo_data: true,

      on_message_processed: function(channel, msg) {
        var that=this;

        if (channel === 'act' && /start|eager-btn-clicked/.test(msg.k)) {
          out_all = []; cur_data={}; cur_rows={}; cur_vars={}; summary={}; flags={}; out_diff = {};
          count_typed_chars=0;
        }
        if (channel === 'key') {
          //console.log(msg);
        }
        if (channel === 'act' && msg.k === 'edit') {
          var global_offset = 0;
          for (var i=0; i<msg.npd; i++) global_offset += this.paragraphs[i].text.length;
          global_offset += msg.offset;

          var left = msg.offset;
          var right = msg.offset + msg.len - 1;
          var z0 = this.paragraphs[msg.npd].z0;
          var continued;
          if (cur_revision.para_z0 && cur_revision.para_z0 === z0) {
            if (msg.len > 0) {
              if (left === cur_revision.offset || right === cur_revision.offset-1) continued = true;
            }
            if (msg.repl.length) {
              if (cur_revision.offset+msg.repl.length === msg.offset || cur_revision.offset === msg.offset) continued = true;
            }
          }
          if (!cur_deleted && msg.len > 0) continued = false;
          var mark_continued = continued;

          if (continued) {
            cur_revision.offset = msg.offset;
            cur_revision.z_end = msg.z;
            if (msg.len > 0) cur_revision.del += msg.len;
            if (msg.repl.length) cur_revision.ins += msg.repl.length;
          } else {
            revisions.push(cur_revision);
            cur_revision = { ins: msg.repl.length, del: msg.len, para_z0: z0, z_start: msg.z, offset: msg.offset, z_end: msg.z, i: [], d: [] };
          }

          var u = JSON.parse(msg.undo);
          if (u.csns) {
            cur_revision.d = cur_revision.d.concat(u.csns);
          }
          if (msg.repl.length)
            cur_revision.i = cur_revision.i.concat(this.paragraphs[msg.npd].csns.slice(msg.offset, msg.offset+msg.repl.length));

          
          cur_deleted = msg.len;

          if (msg.repl.length == 1) {
            var csn = this.paragraphs[msg.npd].csns[msg.offset];

            if (mark_previous_csn) {
              if (!chars_info[mark_previous_csn]) chars_info[mark_previous_csn] = {};
              chars_info[mark_previous_csn].then_revision = mark_continued ? 'N' : mark_previous_offset >= global_offset-1 ? 'Y' : 'F';
            }
            mark_previous_csn = csn;
            mark_previous_offset = global_offset;

            count_typed_chars++;
            flags.typing=msg.t;
            var info_adder = function(csn, z) {
              that.db3.all('select * from key where z_act=? and iki order by z asc;', [msg.z], function(err, rows) {
                if (rows.length) {
                  var ks = [];
                  for (var i=0; i<rows.length; i++) {
                    //ks.push(rows[i].code);
                    ks.push(rows[i].iki);
                  }
                  if (!chars_info[csn]) chars_info[csn] = {};
                  chars_info[csn].z = z;
                  chars_info[csn].ks = ks;
                }
              });
            }
            info_adder(csn, msg.z);
          } else {
            if (mark_previous_csn) {
              if (!chars_info[mark_previous_csn]) chars_info[mark_previous_csn] = {};
              chars_info[mark_previous_csn].then_revision = mark_continued ? 'N' : mark_previous_offset >= global_offset-1 ? 'Y' : 'F';
            }
            mark_previous_csn = 0;
            mark_previous_offset = global_offset;

            flags.typing=false;
          }
          if (msg.len > 0) {
            if (!summary.removed_chars) summary.removed_chars = 0;
            summary.removed_chars += msg.len;
            flags.deleting=msg.t;
          } else {
            flags.deleting=false;
          }
        }
        if (channel === 'eye' && msg.k === 'fix') {
          var eye_row = parseInt(msg.y / (this.char_height + this.interline));
          var eye_col = parseInt(msg.x / this.char_width);
          if (eye_row >= 0 && eye_row < this.rows && eye_col >= 0 && eye_col <= this.cols) {
            var cr = this.cur_row; var cc = this.cur_col;
            this.cur_row=eye_row; this.cur_col=eye_col; this.frozen_eye = this.cursor_to_frozen();
            this.cur_row=cr; this.cur_col=cc;
            flags.eye=msg.t;
          } else {
            this.frozen_eye = null;
          }
        }
        if (channel === 'eye' && msg.k === 'cal') {
          calibration = msg;
        }
      },
      on_broadcast: function() {
        var that=this;
        var out = {};
        var pct = that.broadcast_data.position.z / that.broadcast_data.scope.z9;
        var t1 = that.broadcast_data.position.t - that.broadcast_data.scope.t0;
        graph_db_processing[token] = pct;
        //console.log(pct);

        var seen_now = {};
        for (var i=0; i<this.paragraphs.length; i++) {
          var p = this.paragraphs[i];
          for (var j=0; j<p.csns.length; j++) {
            var csn = p.csns[j];
            seen_now[csn]=1;
          }
        }
        this.death_sequence++;
        var seen_dead = false;
        for (var csn in chars_map) {
          if (!seen_now[csn] && !chars_map[csn].deleted) {
            chars_map[csn].deleted = this.death_sequence;
            seen_dead = true;
          }
        }
        if (!seen_dead) this.death_sequence--;
        var prev_csn = 0;
        for (var i=0; i<this.paragraphs.length; i++) {
          var p = this.paragraphs[i];
          for (var j=0; j<p.csns.length; j++) {
            var csn = p.csns[j];
            if (!chars_map[csn]) {
              var chr = { c: p.text[j], csn: csn, p: p.z0 };
              var ok;
              for (var k=0; k<chars_seq.length; k++) {
                if (chars_seq[k].csn === prev_csn) {
                  if (k < chars_seq.length-1) {
                    for (k++; k<chars_seq.length; k++) {
                      if (!chars_seq[k].deleted) {
                        k--;
                        break;
                      }
                    }
                  }
                  chars_seq.splice(k+1, 0, chr);
                  ok=1;
                  break;
                }
              }
              if (!ok) chars_seq.unshift(chr);
              chars_map[csn] = chr;
            } else {
              chars_map[csn].p = p.z0;
            }
            prev_csn = csn;
          }
        }

        for (var o in this.broadcast_data.rows) {
          if (!(o in cur_rows) || this.broadcast_data.rows[o] !== cur_rows[o]) {
            cur_rows[o] = this.broadcast_data.rows[o];
            out[o] = cur_rows[o];
          }
        }
          
        for (var o in this.broadcast_data) {
          if (o === 'rows' || o === 'position') continue;
          if (!(o in cur_data) || (JSON.stringify(this.broadcast_data[o]) !== JSON.stringify(cur_data[o]))) {
            cur_data[o] = this.broadcast_data[o];
            out[o] = JSON.parse(JSON.stringify(cur_data[o]));
          }
        }

        var product=0;
        var process=0;
        var cursorloc=0;
        var topleft=0;
        var eyeloc=0, eyecsn=0;
        var frozen = that.cursor_to_frozen();
        var cr = that.cur_row; var cc = that.cur_col;
        that.cur_row=0; that.cur_col=0; var frozen_topleft = that.cursor_to_frozen();
        that.cur_row=cr; that.cur_col=cc;
        for (var i=0; i<that.paragraphs.length; i++) {
          if (i == frozen.npd) cursorloc = product + frozen.offset;
          if (i == frozen_topleft.npd) topleft = product + frozen_topleft.offset;
          if (that.frozen_eye && i == that.frozen_eye.npd) {
            eyeloc = product + that.frozen_eye.offset;
            eyecsn = that.paragraphs[i].csns[that.frozen_eye.offset] || 0;
          }
          product += that.paragraphs[i].text.length - 1;
        }
        
        // set z=true to ignore zero v's
        var _update_var = function(k, v, z) {
          if (z && !v) return;
          if (!k in cur_vars || cur_vars[k] !== v) cur_vars[k]=out[k]=v;
        }

        var _push_diff = function(k, v) {
          if (!out_diff[k]) out_diff[k]=[];
          out_diff[k].push({t: t1, v: v});
        }

        _update_var('cur', cursorloc);
        _update_var('prc', product + (summary.removed_chars||0));
        _update_var('prd', product);
        _update_var('top', topleft);
        _update_var('typ', count_typed_chars);
        _update_var('eyf', eyeloc, true);
        _update_var('eyc', eyecsn, true);

        if (flags.typing || flags.deleting) flags.last_change = cursorloc;

        var changeloc = flags.last_change || cursorloc;
        if (eyeloc) {
          var eye_prompt = that.paragraphs[that.frozen_eye.npd].ro;
          if (!eye_prompt) _push_diff('aeyf', Math.abs(eyeloc - changeloc));
          _push_diff('aeyp', eye_prompt ? 1 : 0);
        }
        if (!flags.last_typed_chars) flags.last_typed_chars = 0;
        if (count_typed_chars > flags.last_typed_chars) {
          _push_diff('dtyp', count_typed_chars - flags.last_typed_chars);
          flags.last_typed_chars=count_typed_chars;
        }

        if (!flags.last_removed_chars) flags.last_removed_chars = 0;
        if (summary.removed_chars && summary.removed_chars > flags.last_removed_chars) {
          _push_diff('drem', summary.removed_chars - flags.last_removed_chars);
          flags.last_removed_chars=summary.removed_chars;
        }

        if (flags.typing && flags.eye) {
          if (eyeloc && cursorloc && (cursorloc-eyeloc) > 10 && (flags.eye - flags.typing < 10000)) {
            if (!summary.lookbacks) summary.lookbacks = 0;
            summary.lookbacks++;
            //annotations.lookback.push([t1, t1]);
            flags.typing = flags.eye = false;
          }
        }

        if (!CW.is_empty_object(out)) {
          out_all.push({t: t1, z: that.broadcast_data.position.z, d: out});
        }

        if (that.playback_direction === 'pause') {
          revisions.push(cur_revision);
          summary.typed_chars = count_typed_chars;
          CW.extend(summary, that.stats);
          summary.paragraphs = 0;
          for (var i=0; i<that.paragraphs.length; i++) {
            if (!that.paragraphs[i].ro && that.paragraphs[i].text.length > 1) summary.paragraphs++;
          }
          var paras = that.snapshot();
          html.final = CW.utils.to_html(paras.paragraphs, { no_styles: true });

          var last_t = out_all[out_all.length-1].t;
          var t_window = 5000;
          var old_v = {}, max_v = {};
          for (var i=t_window; i<last_t-t_window; i+=t_window) {
            //console.log(i);
            var new_v = {};
            for (var o in out_diff) {
              var sum=0, count=0;
              for (var j=0; j<out_diff[o].length; j++) {
                var e = out_diff[o][j];
                if (e.t < i-t_window) continue;
                if (e.t > i+t_window) break;
                count++;
                sum+=e.v;
              }
              var res = !count ? 0 : /^a/.test(o) ? sum/count : sum;
              if (1 || !(o in old_v) || (old_v[o] !== res)) {
                new_v[o] = old_v[o] = res;
                max_v[o] = max_v[o] && max_v[o] > res ? max_v[o] : res;
              }
            }
            if (!CW.is_empty_object(new_v)) {
              var z;
              for (var k=0; k<out_all.length; k++) {
                z = out_all[k].z;
                if (out_all[k].t>=i) break;
              }
              out_all.splice(k, 0, { t: i, z: z, d: new_v });
            }
          }
          max_v.drem = max_v.dtyp;
          for (var i=0; i<out_all.length; i++) {
            for (var o in max_v) {
              if (out_all[i].d[o]) out_all[i].d[o] = out_all[i].d[o] > max_v[o] ? 1000 : parseInt(1000 * out_all[i].d[o] / max_v[o]);
            }
          }

          for (var i=0; i<chars_seq.length; i++) {
            if (chars_info[chars_seq[i].csn]) chars_seq[i].info = chars_info[chars_seq[i].csn];
          }
          var str = JSON.stringify({ frames: out_all, annotations: annotations, summary: summary, calibration: calibration, html: html, chars_seq: chars_seq, revisions: revisions });
          fs.writeFile(fn, str, function() {
            delete graph_db_processing[token];
          });
        }
      }
    });
    r.start_playback();
  }

  CW.create_graph_db = create_graph_db;

  return router;
};
