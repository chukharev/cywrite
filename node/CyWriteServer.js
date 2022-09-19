"use strict";
// CyWrite Server-side Classes

const
  util         = require('util'),
  crypto       = require('crypto'),
  fs           = require('fs'),
  sqlite3      = require('sqlite3'),
  http         = require('http'),
  qs           = require('qs'),
  moment       = require('moment'),
  async        = require('async'),
  winston      = require('winston'),
  _            = require('underscore')
  ;

var CW = require('./CyWrite.js');

module.exports = CW;
CW.config = require('./config.js');

CW.clones = new Object();

CW.module_exists = function (name) {
  try { return require.resolve(name) }
  catch (e) { return false }
};


/*if (CW.config.features.hunspell && CW.module_exists('nodehun')) {
  var nodehun = require('nodehun');
  var dir = 'node_modules/nodehun/examples/dictionaries/en_US';
  var affbuf = fs.readFileSync(dir+'/en_US.aff');
  var dictbuf = fs.readFileSync(dir+'/en_US.dic');
  CW.dict = new nodehun(affbuf,dictbuf);
  CW.dict_cache = new Object;
};*/

/*CW.dict = {
  spellSuggestions: (word, cb) => {
    cb(null, false, ['hello', 'world']) 
  }
};*/

CW.dict_cache = new Object;


/*** CLONE *******************************************************************/

// does not call inherited constructor; completely overriden
CW.Clone = function(p) {
  CW.extend(this, {
    csn: 1, // character sequence number
    spans: new Object(),
    sentences: new Object(),
    last_span_id: 1,
    death_sequence: 0,
    chars_seq: [],
    chars_map: {},

    role: 'live'
  }, p);

  if (!this.config) this.config = {};
  if (!this.config.modules) this.config.modules = { }; //spellcheck: 1, analyze: 1 };
  for (var o in this.config.modules) {
    if (!this.config.modules[o] || /^(off|0|disabled?|false)$/i.test(this.config.modules[o])) delete this.config.modules[o];
  }
  if (!this.metadata) this.metadata = {};

  if (!this.token) this.token = this.generate_token(this.role === 'research' ? 'Z' : '');
  if (!CW.clones[this.token] && this.role !== 'research') CW.clones[this.token] = this;

  this.init_winston();

  if (this.role == 'live') {
    this.socket = new CW.Socket(this);
    this.socket.upstream('cmd');
    this.undo_stack = new Array();
    this.redo_stack = new Array();
    this.chkpnt = 1;
  }
  this.viewers = new Object();
  this.broadcast_data = new Object();

  if (CW.config.delays) this.delays = CW.extend({}, CW.config.delays);
  if (this.role !== 'research') CW.async(this, 'inactive', this.delays.inactive);

  if (CW.ProWrite) CW.ProWrite.init(this);

  return this;
}

CW.Clone.prototype = Object.create(CW.Display.prototype);
var return_this = function() { return this; }

CW.extend(CW.Clone.prototype, {
  move_cursor: return_this,
  draw: return_this,
  blink_cursor: return_this,
  resize: return_this,
  send_event: return_this,

  init_winston: function(){
    this.logger = winston.createLogger({
      transports: [
        new (winston.transports.Console)({level: (this.log_level_console || CW.config.log_level_console || '>>>')}), // fixme
        new (winston.transports.File)({ filename: CW.config.dir_logs+'/'+this.token+'.log', level: (this.log_level_file || CW.config.log_level_file || 'info') })
      ],
      levels: {'>>>': 4, '<<<': 3, debug: 2, info: 1, error: 0 }
    });
  },

  start_playback: function() {
    this.playback_direction = this.seek_z ? 'seek' : 'fwd';
    this.log('debug', 'start_playback', { direction: this.playback_direction });

    this.start_session();

    var that = this;
    this.cur_t = 0;
    this.cur_z = {};
    this.cleanup();
    this.db3 = new sqlite3.Database(CW.config.dir_archive+'/'+this.original_token);
    this.db3.all('select * from props where name=?;', ['adjustments'], function(err, rows) {
      if (rows && rows[0] && !that.adjustments) {
        const json = JSON.parse(rows[0].value);
        that.adjustments = json;
      }
      that.db3.all('select * from document where kind=?;', ['initial'], function(err, rows) {
        if (!rows || !rows.length) return that.shutdown();
        var doc = JSON.parse(rows[0].json);
        that.set_paragraphs(doc.paragraphs);
        that.csn = doc.csn;
        that.db3.all('select * from act order by z desc limit 1;', function(err, rows) {
          if (!rows.length) return that.shutdown();
          that.broadcast_data.scope = {z9:rows[0].z, t9:rows[0].t};
          that.db3.all('select * from act order by z asc limit 1;', function(err, rows) {
            that.broadcast_data.scope.z0 = rows[0].z;
            that.broadcast_data.scope.t0 = rows[0].t;
            CW.async(that, 'proceed_playback', 0);
          });
        });
      });
    });
  },

  proceed_playback: function() {
    if (this.playback_direction == 'pause' || (this.role !== 'research' && CW.is_empty_object(this.viewers))) {
      return;
    }
    this.log('debug', 'proceed_playback', { direction: this.playback_direction });
    var that = this;
    if (!this.cur_z.act) this.cur_z.act = 0;
    if (!this.cur_z.eye) this.cur_z.eye = 0;
    if (!this.cur_z.key) this.cur_z.key = 0;
    var dir = this.playback_direction;
    this.db3.all('select * from act where z > ? order by z asc limit 3;', [this.cur_z.act], function(err, rows) { //  : 'select * from act where z <= ? order by z desc limit 3;
      let next = rows[0];
      if (!next) {
        that.playback_direction='pause';
        that.cur_z.act = that.broadcast_data.scope.z9;
        that.cur_t = that.broadcast_data.scope.t9;
        CW.async(that, 'broadcast', 0);
        return;
      }

      let next_eye, next_key;

      const get_next_eye = function(cb) {
        if (dir === 'fwd' && !that.ignore_eye) {
          that.db3.all("select * from eye where z > ? and (k='s' and t >= ? or k<>'s') order by z asc limit 1;", [that.cur_z.eye, that.cur_t + (that.throttle_eye || 0)], function(err, rows_eye) {
            next_eye = rows_eye ? rows_eye[0] : null;
            cb();
          });
        } else cb();
      }
      
      const get_next_key = function(cb) {
        if (dir === 'fwd' && !that.ignore_key) {
          that.db3.all("select * from key where z > ? order by z asc limit 1;", [that.cur_z.key], function(err, rows_key) {
            next_key = rows_key ? rows_key[0] : null;
            cb();
          });
        } else cb();
      }

      get_next_eye(() => get_next_key(() => {
        const min_t = Math.min(next.t, next_eye ? next_eye.t : next.t, next_key ? next_key.t : next.t);
        if (next_eye && next_eye.t === min_t) that.apply_playback('eye', next_eye);
        else if (next_key && next_key.t === min_t) that.apply_playback('key', next_key);
        else that.apply_playback('act', next);
      }));
    });
  },

  apply_playback: function(channel, msg) {
    //this.log('debug', 'apply_playback', {channel: channel, msg: msg });
    delete this.next_playback_msg;
    
    if (!this.begin_t) this.begin_t = msg.t;
    this.cur_t = msg.t;

    if (msg.json) {
      CW.extend(msg, JSON.parse(msg.json));
      delete msg.json;
    }

    this.next_playback_msg = { channel: channel, msg: msg };

    CW.async(this, 'process_message', 0);
  },

  log: function() {
    var args = [];
    for (var i=0;i<arguments.length;i++) {
      args.push(arguments[i]);
    }
    if (this.logger) {
      this.logger.log.apply(this.logger, args);
    } else {
      console.log.apply(console, args);
    }
  },

  connect: function(conn) {
    let that = this;
    var ip = conn.headers['x-forwarded-for'] || conn.remoteAddress;
    this.log('info', 'connect', { agent: conn.headers['user-agent'], ip: ip, proto: conn.protocol });
    if (this.conn) {
      this.log('info', 'closing previous connection');
      delete this.conn.CW_clone;
      this.conn.write('goodbye'); this.conn.end(); delete this.conn;
    }
    
    if (!this.session_started) {
      this.start_session();
    }

    if (!conn.CW_clone) {
      conn.on('data', function(e) { if (this.CW_clone) this.CW_clone.socket.on_data(e); else console.log('*** ZOMBIE! ***') });
      conn.on('close', function() { if (this.CW_clone) {
        this.CW_clone.log('info', 'connection closed');
        CW.async(this.CW_clone, 'inactive', this.CW_clone.delays.inactive);
        delete this.CW_clone.conn;
      } });
    }
    conn.CW_clone = this;
    this.conn = conn;
    this.socket.awaiting_ack = false;
    this.socket.dispatch(true);
    if (!this.paragraphs) {
      if (this.config.previous_token) {
        this.retrieve_old_document(this.config.previous_token, function(document) {
          that.load_document(document);
        });
      } else this.load_document();
    }
  },

  shutdown: function() {
    this.destroy();
  },

  destroy: function() {
    if (this.deleted) return;
    this.deleted = 1; // phase 1 of deletion ==> db3_do's still allowed
    var that=this;
    this.log('info', 'destroying clone');
    delete CW.clones[this.token];
    this.save_document(false, function() {
      
      that.deleted = 2; // phase 2 of deletion ==> no further db3_do's allowed

      if (!CW.is_empty_object(that.viewers)) { that.log('info', 'removing viewers'); for (var o in that.viewers) that.remove_viewer(that.viewers[o]); }
      if (that.queue) { that.log('info', 'destroying queue', that.queue.name); if (that.ctag) that.queue.unsubscribe(that.ctag); that.queue.destroy(); delete that.queue; } 
      if (that.conn) { that.log('info', 'disconnecting client'); that.conn.write('goodbye'); that.conn.end(); delete that.conn; }
      
      if (that.db3) {
        that.log('info', 'closing db3'); that.db3.close(function(err){
          // do not archive a playback db3
          if (!/-R$/.test(that.token)) CW.utils.archive_db3(that.token);
        });
        delete that.db3;
      }

      CW.async(that);
      if (that.socket) CW.async(that.socket);
    });
  },

  on_tick: function() {
    if (this.deleted) return;
    this.trigger_hooks('tick');
    CW.async(this, 'on_tick', 1000);
  },

  start_session: function() {
    let live = this.role === 'live';
    if (live) CW.async(this, 'on_tick', 1000);
    if (this.on_start) this.on_start.call(this); // todo remove
    this.session_started = Date.now();
    this.trigger_hooks('start');
  },

  on_message: function(data, info) {
    this.log('debug', 'amqp message received', data);
    if (data == 'goodbye') {
      this.destroy();
      return;
    }
    var d = JSON.parse(data);
    for (o in d) {
      if (this.sentences[o]) {
        this.sentences[o].apply_analysis(d[o]);
      }
    }
  },

  // (object)
  create_span: function(d) {
    var p = this.paragraphs[d.npd];

    for (var id in p.spans) {
      if (p.spans[id].kind == d.kind && p.spans[id].op0 == d.op0 && p.spans[id].op1 == d.op1
      && (p.spans[id].exclusive || d.exclusive) ) return d.spangroup ? null : id;
    }
    this.last_span_id++;
    CW.extend(d, {
      id: this.last_span_id,
      z_initiated: this.z(),
      pz0: p.z0
    });

    var span = new CW.Span(d, p);

    this.spans[this.last_span_id] = span;
    p.spans[this.last_span_id] = span;
    if (span.sentence) span.sentence.spans[this.last_span_id] = span;

    if (!d.spangroup) this.send_cmd('add_span', span.snapshot());
    else d.spangroup.spans_list.push(span);

    return this.last_span_id;
  },

  create_spangroup: function(sg_d, spans_d) {
    var sg = new CW.SpanGroup(sg_d);
    var last_span_id = this.last_span_id; // begin transaction
    var rollback;
    for (var i=0; i<spans_d.length; i++) {
      var id = this.create_span(CW.extend({spangroup: sg}, spans_d[i]));
      if (!id) {
        rollback=true;
        break;
      }
    }
    if (rollback) {
      for (var i=last_span_id+1; i<this.last_span_id; i++) this.spans[i].destroy();
      this.last_span_id = last_span_id;
      return false;
    }
    // commit
    var msg = {spangroup: sg_d, spans: []};
    for (var i=0; i<sg.spans_list.length; i++) msg.spans.push(sg.spans_list[i].snapshot());
    this.send_cmd('add_spangroup', msg);
    return true;
  },

  send_cmd: function(cmd, data) {
    var msg = CW.extend({cmd: cmd}, data);
    this.trigger_hooks('cmd', msg);
    if (!this.socket) return;
    this.socket.send('cmd', msg);
  },

  db3_do: function(sql, args1, callback) {
    var that = this;
    if (this.db3 && this.deleted !== 2) {
      var db3 = this.db3;
      this.db3.serialize(function() {
        var stmt = db3.prepare(sql);
        stmt.run.apply(stmt, args1);
        stmt.finalize(function(err) {
          if (err) that.log('error', 'db3_do', err);
          if (callback) callback();
        });
      });
    }
  },

  apply_eye_adjustments: function(eye_data) {
    if (this.adjustments && this.adjustments.eye_row_shift) {
      eye_data.y -= this.adjustments.eye_row_shift * (this.char_height + this.interline);
    }
  },

  process_message: function(channel, msg) {
    var live = this.role === 'live' ? 1 : 0;
    if (!live && !this.next_playback_msg) return;
    if (!live) {
      channel = this.next_playback_msg.channel;
      msg = this.next_playback_msg.msg;
    }
    if (live && msg.t) {
      this.cur_t = msg.t;
      if (!this.broadcast_data.scope) this.broadcast_data.scope = { t0: msg.t };
    }
    if (channel == 'act') {
      let need_save = this.apply_event(msg);
      if (need_save && live) {
        CW.async(this, 'save_document', this.delays.save_document);
      }
    } else if (channel == 'key') {
      if (live) this.db3_do('INSERT INTO key (z, t, k, code, iki, dur, z_act) VALUES (?, ?, ?, ?, ?, ?, ?)', [msg.z, msg.t, msg.k, msg.code, msg.iki, msg.dur, msg.z_act]);
    } else if (channel == 'eye') {
      var d0 = msg.data ? msg.data : null;
      if (live) this.db3_do('INSERT INTO eye (z, t, k, start, dur, x, y, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [msg.z, msg.t, msg.k, msg.start, msg.dur, msg.x, msg.y, d0?JSON.stringify(d0):null]);
      if (msg.k === 'fix') {
        this.broadcast_data.eye = { x: msg.x, y: msg.y };
        this.apply_eye_adjustments(this.broadcast_data.eye);
        CW.async(this, 'broadcast', 0);
      }
      if (msg.k === 's') { // 's'ample (i.e. any eye movement)
        this.broadcast_data.eye_s = { x: msg.x, y: msg.y };
        this.apply_eye_adjustments(this.broadcast_data.eye_s);
        CW.async(this, 'broadcast', 0);
      }
      if (msg.k === 'end') {
        this.broadcast_data.eye = {};
        CW.async(this, 'broadcast', 0);
      }
      if (msg.k === 'cal_start') {
        this.broadcast_data.eye = { is_calibrating: true };
        CW.async(this, 'broadcast', 0);
      }
      if (msg.k === 'cal' || msg.k === 'cal_timeout') {
        this.broadcast_data.eye = { is_calibrating: false };
        if (d0) {
          this.config.ave_error = d0.ave_error;
        }
        CW.async(this, 'broadcast', 0);
      }
    } else if (channel == 'img') {
      this.broadcast_data.img = msg;
      CW.async(this, 'broadcast', 100);
    }
    if (!live) {
      this.log('debug', 'process_message', { channel: channel, msg: msg });
      if (msg.t) this.cur_t = msg.t;
      this.cur_z[channel] = msg.z;
      if (this.on_message_processed) this.on_message_processed.call(this, channel, msg);
      this.trigger_hooks(channel, msg);
      this.proceed_playback();
    }
  },

  generate_token: function(suffix) {
    var tkn = (CW.config.node_id || '9999') + '-' + new Date().getTime().toString(36)+'-';
    tkn += CW.random_string(10);
    if (suffix) tkn += '-'+suffix;
    return tkn;
  },

  retrieve_old_document: function(token, callback) {
    let that = this;
    let fn = CW.config.dir_archive+'/'+token;
    fs.access(fn, fs.F_OK, function(err) {
      if (err) return that.shutdown();
      let db3 = new sqlite3.Database(fn);
      let initial_token, metadata;
      db3.all('select * from props where name=?;', ['initial_token'], function(err, rows1) {
        if (rows1 && rows1[0])
          initial_token = rows1[0].value;
        db3.all('select * from props where name=?;', ['metadata'], function(err, rows1) {
          if (rows1 && rows1[0])
            metadata = JSON.parse(rows1[0].value);
          db3.all('select * from document where kind=?;', ['final'], function(err, rows) {
            db3.close();
            if (!rows || !rows.length) return that.shutdown();
            let doc = JSON.parse(rows[0].json);
            doc.token = token;
            doc.metadata = metadata;
            doc.initial_token = initial_token || token;
            callback(doc);
          });
        });
      });
    });
  },

  load_document: function(old_document) {
    let that=this;
    this.log('info', 'load_document');
    this.db3 = new sqlite3.Database(CW.config.dir_current+'/'+this.token);
    this.db3.run("CREATE TABLE act (z INTEGER PRIMARY KEY, z_transaction INTEGER, csn INTEGER, t INTEGER, k TEXT, json TEXT, undo TEXT, chkpnt INTEGER)");
    this.db3.run("CREATE TABLE props (name TEXT PRIMARY KEY, value TEXT)");
    this.db3.run("CREATE TABLE key (z INTEGER PRIMARY KEY, t INTEGER, k TEXT, code INTEGER, z_act INTEGER, iki INTEGER, dur INTEGER)");
    this.db3.run("CREATE TABLE eye (z INTEGER PRIMARY KEY, t INTEGER, k TEXT, z_act INTEGER, start INTEGER, dur INTEGER, x INTEGER, y INTEGER, json TEXT)");
    this.db3.run("CREATE TABLE document (kind TEXT PRIMARY KEY, json TEXT)");
    this.db3_do("INSERT INTO props(name, value) VALUES(?, ?)", ["config", JSON.stringify(this.config)]);

    if (old_document && old_document.token) {
      this.db3_do("INSERT INTO props(name, value) VALUES(?, ?)", ["previous_token", old_document.token]);
      this.db3_do("INSERT INTO props(name, value) VALUES(?, ?)", ["initial_token", old_document.initial_token]);
    }

    let metadata = {};
    if (old_document && old_document.metadata)
      CW.extend(metadata, old_document.metadata);
    if (that.metadata)
      CW.extend(metadata, this.metadata);
    this.metadata = metadata;

    this.db3_do("INSERT INTO props(name, value) VALUES(?, ?)", ["metadata", JSON.stringify(this.metadata)]);

    console.log('CONFIG:', that.config);
    that.set_paragraphs(that.config.template ? that.config.template : old_document ? old_document.paragraphs : ['']);
    if (!that.config.template && old_document && old_document.csn) that.csn = old_document.csn+1;

    let msg = new Object();
    msg.paragraphs = that.snapshot({no_props:1, no_csns:1}).paragraphs;
    //msg.set_doc_id = that.doc_id;
    msg.set_delays = that.delays;
    let opts = CW.extend({}, that.config); // doc.config,
    that.config = opts;
    msg.set_config = opts;
    //if (doc.token) that.prev_token = doc.token;
    that.socket.send('cmd', msg);
    that.save_document(true);
    CW.async(that, 'analyze_loaded_paragraphs', 0);
  },

  analyze_loaded_paragraphs: function() {
    if (this.role != 'live') return;
    for (var i=0; i<this.paragraphs.length; i++) {
      if (!this.paragraphs[i].analyzed) {
        this.paragraphs[i].analyzed = true;
        CW.async(this.paragraphs[i], 'analyze', this.delays.analyze_paragraph);
        CW.async(this.paragraphs[i], 'spellcheck', this.delays.spellcheck);
        CW.async(this, 'analyze_loaded_paragraphs', this.delays.analyze_loaded_paragraphs);
        return;
      }
    }
  },

  // capture - if true, the session is being created (was: force capturing of the document)
  // callback is called only when capture=false
  save_document: function(capture, callback) {
    var to_save = CW.extend({ csn: this.csn }, this.snapshot({no_props: 1}));
    var that = this;

    if (capture) {
      this.db3_do('INSERT INTO document (kind, json) VALUES (?, ?)', ['initial', JSON.stringify(to_save)]);
      this.db3_do('INSERT INTO document (kind, json) VALUES (?, ?)', ['final', JSON.stringify(to_save)]);
      this.db3_do('INSERT INTO props (name, value) VALUES (?, ?)', ['csn0', this.csn]);
      this.db3_do('INSERT INTO props (name, value) VALUES (?, ?)', ['token', this.token]);
      //this.db3_do('INSERT INTO props (name, value) VALUES (?, ?)', ['config', JSON.stringify(this.config)]);
    } else if (this.role === 'live') {
      this.db3_do('UPDATE document set json=? where kind=?', [JSON.stringify(to_save), 'final'], callback);
    } else {
      if (callback) callback();
    }
  },

  inactive: function() {
    this.log('info', 'inactive');
    if (this.role == 'live' && !this.conn) this.destroy();
  },


  // returns true if the text has changed
  apply_event: function(d) {
    this.log('debug', 'applying event', { z: d.z, k: d.k});
    if (d.csn) this.csn = d.csn;
    var prev_csn = this.csn; // before the event
    var undo, undid = false; // stores undo data for events changing text; flag showing if undo has been performed
    var chkpnt = null; // '1' for the first event of "undo" checkpoint
    var live = this.role == 'live' ? true : false;
    
    var d0 = _.omit(d, 'z', 't', 'k', 'transaction', 'z_transaction', 'csn', 'undo', 'chkpnt');

    if (/^(start|eager-btn-clicked)$/.test(d.k)) {
      this.broadcast_data.scope.t0 = d.t;
      this.start_session();
      //console.log('new t0=', this.broadcast_data.scope.t0);
    } else if (d.k == 'focus') {
      this.is_focused = d0.is_focused;
      if (d0.app) {
        this.active_window = _.omit(d0, 'is_focused');
      }
    } else if (d.k == 'join_paragraphs') {
      undo = { offset: this.paragraphs[d.npd].text.length-1, align: this.paragraphs[d.npd+1].align, z0: this.paragraphs[d.npd+1].z0, z1: this.paragraphs[d.npd+1].z1 };
      this.join_paragraphs(d.npd);
      chkpnt=1;
    } else if (d.k == 'split_paragraphs') {
      this.split_paragraphs(d.npd, d.offset);
      chkpnt=1;
    } else if (d.k == 'remove_paragraph') {
      undo = this.paragraphs[d.npd].snapshot();
      chkpnt=1;
      this.remove_paragraph(d.npd);
    } else if (d.k == 'edit') {
      undo = this.paragraphs[d.npd].snapshot({ op0: d.offset, op1: d.offset+d.len-1 });
      if (live) {
        if (!this.editing_pz0 || this.paragraphs[d.npd].z0 != this.editing_pz0) {
          chkpnt = 1;
          this.editing_pz0 = this.paragraphs[d.npd].z0;
        }
      }
      this.paragraphs[d.npd].edit(d.offset, d.len, d.repl, d.repl_styles);
    } else if (d.k == 'cursor') {
      if (live) var f1 = this.cursor_to_frozen();
      this.cur_row = d.cur_row;
      this.cur_col = d.cur_col;
      this.top_row = d.top_row;
      this.block_start = d.block_start;
      if (live) {
        var f2 = this.cursor_to_frozen();
        if (f1.npd != f2.npd || f1.offset != f2.offset) {
          this.paragraphs[f1.npd].cursor_moved(f1, f2);
          if (f1.npd != f2.npd) this.paragraphs[f2.npd].cursor_moved(f1, f2);
        }
      }
    } else if (d.k == 'resize') {
      let a = ['viewport_width', 'viewport_height', 'char_width', 'char_height', 'interline', 'rows', 'cols', 'cur_row', 'cur_col', 'top_row'];
      for (let i=0; i<a.length; i++) this[a[i]] = d[a[i]];
      this.render();
    } else if (d.k == 'paragraph_id') {
      this.paragraphs[d.npd].z0 = d.z;
    } else if (d.k == 'add_span') {
      if (live) {
        if (this.spans[d.id]) this.spans[d.id].z_shown = d.z;
      } else {
        var p = this.paragraph_by_z0(d.pz0);
        if (p) p.add_span(d);
      }
    } else if (d.k == 'add_spangroup') {
      if (live) {
        for (var o in d.spans) if (this.spans[o]) this.spans[o].z_shown = d.z;
      } else {
        this.add_spangroup(d);
      }
    } else if (d.k == 'destroy_span') {
      if (this.spans[d.id]) this.spans[d.id].destroy();
    } else if (d.k == 'set_hint') {
      this.set_hint(d);
    } else if (d.k == 'align') {
      undo = { align: this.paragraphs[d.npd].align };
      this.paragraphs[d.npd].align = d.align;
      chkpnt=1;
    } else if (d.k == 'block_change_styles') {
      undo = {styles: CW.extend({}, this.paragraphs[d.npd].styles)};
      this.paragraphs[d.npd].block_change_styles(d.op0, d.op1, d.changes);
      chkpnt=1;
    } else if (d.k == 'begin_undo') {
      if (live) {
        this.log('debug', 'begin_undo', { redo_stack: this.redo_stack, undo_stack: this.undo_stack});
        if (this.chkpnt) {
          this.undo_stack.push([this.chkpnt, this.z()]);
          this.chkpnt=null;
        }
        if (this.undo_stack.length) {
          var range = this.undo_stack.pop();
          this.perform_undo(range[0], range[1]);
          undid = true;
          d0.range = range;
          delete this.editing_pz0;
          this.redo_stack.push(range);
        } else {
          this.send_cmd('undo', { failed: 1 });
        }
      } else {
        if (d.range) this.perform_undo(d.range[0], d.range[1]);
      }
    } else if (d.k == 'begin_redo') {
      if (live) {
        this.log('debug', 'begin_redo; redo_stack=', this.redo_stack, ' undo_stack=', this.undo_stack);
        if (this.redo_stack.length) {
          var range = this.redo_stack.pop();
          this.perform_redo(range[0], range[1]);
          this.undo_stack.push(range);
          undid=true;
          d0.range = range;
          delete this.editing_pz0;
        } else {
          this.send_cmd('redo', { failed: 1 });
        }
      } else {
        if (d.range) this.perform_redo(d.range[0], d.range[1]);
      }
    } else if (d.k == 'fb') {
      this.fb = d0;
    }

    if (live) {
      if (d.transaction && !this.transaction || (this.transaction != d.transaction)) {
        chkpnt=1;
        this.transaction = d.transaction;
      } else {
        if (!d.transaction) delete this.transaction; else chkpnt=null;
      }
      if (chkpnt && d.k != 'edit') delete this.editing_pz0;
      if (chkpnt) this.redo_stack = new Array();

      //console.log('*>>>>>>>>>', d, undo);
      this.db3_do('INSERT INTO act (z, z_transaction, csn, t, k, json, undo, chkpnt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [d.z, this.transaction, prev_csn, d.t, d.k, JSON.stringify(d0), undo ? JSON.stringify(undo) : null, chkpnt]);
      if (d.end_transaction) delete this.transaction;

      if (chkpnt && this.chkpnt) {
        this.undo_stack.push([this.chkpnt, this.z()-1]);
        this.chkpnt = null;
      }
      if (chkpnt) this.chkpnt = this.z();
    } else {
      //console.log('*>>>>>>>>>', d, undo);
      if (d.undo && undo) {
        var undo1 = JSON.parse(d.undo);
        if (JSON.stringify(undo1) !== JSON.stringify(undo)) {
          if (this.fix_undo_data) {
            this.db3_do('UPDATE act set undo=? where z=?', [JSON.stringify(undo), d.z]);
            console.log('Fixing undo data: ' + JSON.stringify(undo1) + ' ---> ' + JSON.stringify(undo));
          }
        }
      }
    }

    if (undo && !d.undo) {
      d.undo = JSON.stringify(undo);
    }

    if (this.role === 'research' && d.k === 'edit') {}
    else CW.async(this, 'broadcast', this.role === 'research' ? 0 : 100);

    // return !!undo || undid;
    return (live && !!undo) || undid;
  },

  undo_event: function(d) {
    this.log('debug', 'undo_event', d.z);

    if (d.k == 'edit') {
      this.paragraphs[d.json.npd].edit(d.json.offset, d.json.repl.length, d.undo.text, d.undo.styles, d.undo.csns);
      this.paragraphs[d.json.npd].clean();
    } else if (d.k == 'join_paragraphs') {
      this.paragraphs[d.json.npd].clean();
      this.split_paragraphs(d.json.npd, d.undo.offset);
      this.paragraphs[d.json.npd+1].clean();
      CW.extend(this.paragraphs[d.json.npd+1], { align: d.undo.align, z0: d.undo.z0, z1: d.undo.z1 });
    } else if (d.k == 'split_paragraphs') {
      this.join_paragraphs(d.json.npd);
      this.paragraphs[d.json.npd].clean();
    } else if (d.k == 'block_change_styles') {
      this.paragraphs[d.json.npd].styles = d.undo.styles;
      this.paragraphs[d.json.npd].clean();
    } else if (d.k == 'remove_paragraph') {
      this.insert_paragraph(d.json.npd, d.undo);
      this.paragraphs[d.json.npd].clean();
    } else if (d.k == 'align') {
      this.paragraphs[d.json.npd].align = d.undo.align;
      this.paragraphs[d.json.npd].clean();
    }
  },

  redo_event: function(d) {
    this.log('debug', 'redo_event', d.z);

    let old_csn;
    
    if (d.csn) {
      old_csn = this.csn;
      this.csn = d.csn;
    }

    if (d.k == 'join_paragraphs') {
      this.join_paragraphs(d.json.npd);
      this.paragraphs[d.json.npd].clean();
    } else if (d.k == 'split_paragraphs') {
      this.split_paragraphs(d.json.npd, d.json.offset);
      this.paragraphs[d.json.npd].clean();
      this.paragraphs[d.json.npd+1].clean();
    } else if (d.k == 'remove_paragraph') {
      this.remove_paragraph(d.json.npd);
    } else if (d.k == 'edit') {
      this.paragraphs[d.json.npd].edit(d.json.offset, d.json.len, d.json.repl, d.json.repl_styles);
      this.paragraphs[d.json.npd].clean();
    } else if (d.k == 'align') {
      this.paragraphs[d.json.npd].align = d.json.align;
    } else if (d.k == 'block_change_styles') {
      this.paragraphs[d.json.npd].block_change_styles(d.json.op0, d.json.op1, d.json.changes);
      this.paragraphs[d.json.npd].clean();
    }

    if (old_csn) this.csn = old_csn;
  },

  replay_event: function(d) {
    this.apply_event(d);
  },

  join_paragraphs: function(npd) {
    var old_length = this.paragraphs[npd].text.length;

    for (var o in this.paragraphs[npd+1].sentences) {
      var s = this.paragraphs[npd+1].sentences[o];
      s.op0 += old_length-1;
      s.op1 += old_length-1;
      s.paragraph = this.paragraphs[npd];
      this.paragraphs[npd].sentences[o] = s;
      delete this.paragraphs[npd+1].sentences[o];
    }

    this.paragraphs[npd].csns = this.paragraphs[npd].csns.concat(this.paragraphs[npd+1].csns);

    return CW.Display.prototype.join_paragraphs.call(this, npd);
  },

  csn_range: function(len) {
    var foo = [];
    if (len > 0) {
      var n0 = this.csn;
      for (this.csn++; this.csn <= n0+len; this.csn++) {
        foo.push(this.csn);
      }
      this.csn--;
    }
    return foo;
  },

  split_paragraphs: function(npd, offset) {
    var r = CW.Display.prototype.split_paragraphs.call(this, npd, offset);

    for (var o in this.paragraphs[npd].sentences) {
      var s = this.paragraphs[npd].sentences[o];
      var new_op0 = s.op0 - offset;
      var new_op1 = s.op1 - offset;
      if (new_op0 < 0 && new_op1 >= 0) s.destroy();
      else if (new_op0 >= 0) {
        s.op0 = new_op0;
        s.op1 = new_op1;
        s.paragraph = this.paragraphs[npd+1];
        delete this.paragraphs[npd].sentences[o];
        this.paragraphs[npd+1].sentences[o] = s;
      }
    }
    this.paragraphs[npd+1].csns = this.paragraphs[npd].csns.splice(offset, this.paragraphs[npd].csns.length-offset);

    return r;
  },

  perform_undo: function(from, to) {
    var that=this;
    this.undoing = true;
    this.paragraphs_to_remove = new Array();
    this.log('debug', 'performing undo from '+from+' to '+to);
    this.db3.all('select * from act where z between ? and ? order by z desc;', [from, to], function(err, rows) {
      for (var i=0; i<rows.length; i++) {
        var row = rows[i];
        if (row.json) row.json = JSON.parse(row.json); else row.json = {};
        if (row.undo) row.undo = JSON.parse(row.undo); else row.undo = {};
        that.undo_event(row);
      }

      var out = new Array();
      for (var i=0; i<that.paragraphs.length; i++) {
        if (that.paragraphs[i].cleaned) {
          delete that.paragraphs[i].cleaned;
          out.push(that.paragraphs[i].snapshot({brief: true}));
        }
      }
      var to_remove = new Array();
      for (var i=0; i<that.paragraphs_to_remove.length; i++) to_remove.push(that.paragraphs_to_remove[i].z0);
      delete that.paragraphs_to_remove;

      that.undoing = false;
      that.send_cmd('undo', { update: out, remove: to_remove });

      that.db3.all("select * from act where k='cursor' and z <= ? order by z desc limit 1;", [from], function(err, rows) {
        if (rows.length) {
          var json = JSON.parse(rows[0].json);
          that.send_cmd('cursor', { cur: json.cur, block_start: json.block_start });
        }
      });

      CW.async(that, 'analyze_loaded_paragraphs', 0);
    });
  },

  perform_redo: function(from, to) {
    var that=this;
    this.undoing = true;
    this.paragraphs_to_remove = new Array();
    this.log('debug', 'performing redo from '+from+' to '+to);
    this.db3.all('select * from act where z between ? and ? order by z asc;', [from, to], function(err, rows) {
      for (var i=0; i<rows.length; i++) {
        var row = rows[i];
        if (row.json) row.json = JSON.parse(row.json); else row.json = {};
        if (row.undo) row.undo = JSON.parse(row.undo); else row.undo = {};
        that.redo_event(row);
      }

      var out = new Array();
      for (var i=0; i<that.paragraphs.length; i++) {
        if (that.paragraphs[i].cleaned) {
          delete that.paragraphs[i].cleaned;
          out.push(that.paragraphs[i].snapshot({brief: true}));
        }
      }
      var to_remove = new Array();
      for (var i=0; i<that.paragraphs_to_remove.length; i++) to_remove.push(that.paragraphs_to_remove[i].z0);
      delete that.paragraphs_to_remove;

      that.undoing = false;
      that.send_cmd('redo', { update: out, remove: to_remove });

      that.db3.all("select * from act where k='cursor' and z <= ? order by z desc limit 1;", [to], function(err, rows) {
        if (rows.length) {
          var json = JSON.parse(rows[0].json);
          that.send_cmd('cursor', { cur: json.cur, block_start: json.block_start });
        }
      });
      CW.async(that, 'analyze_loaded_paragraphs', 0);
    });
  },

  add_viewer: function(v) {
    var that=this;
    this.log('debug', 'add_viewer');
    this.viewers[v.id]=v;
    v.CW_clone = this;
    v.CW_data = { ok: true };
    v.on('data', function(d){ that.viewer_data(v, d) });
    this.log('info', 'viewer '+v.id+' added');
    this.send_to_viewer(v);
    v.on('close', function() {
      if (this.CW_clone) {
        this.CW_clone.remove_viewer(this);
        delete this.CW_clone;
      }
    });
  },

  remove_viewer: function(v) {
    if (this.viewers[v.id]) {
      try {
        this.viewers[v.id].write('goodbye');
      } catch (e) {
      }
      delete this.viewers[v.id];
      if (v.CW_clone === this) delete v.CW_clone;
      this.log('info', 'viewer '+v.id+' removed');
    }
  },

  viewer_data: function(v, json) {
    var d = JSON.parse(json);
    //console.log(d);
/*    if (d.dir) {
      this.playback_direction = d.dir;
      this.log('info', 'dir', d.dir);
      CW.async(this, 'proceed_playback', 0);
      CW.async(this, 'broadcast', 100);
    }
    if (d.start_over) {
      this.start_playback();
    }*/
    if (d.ok) {
      v.CW_data.ok = true;
      this.send_to_viewer(v);
    }
    if (d.resize) {
      this.send_cmd('resize', d.resize);
    }
    if (d.cmd) {
      console.log('sending '+d.cmd);
      this.send_cmd(d.cmd, d.data);
    }
    if ('image_requested' in d) {
      v.image_requested = d.image_requested;
    }
  },

  send_to_viewer: function(v) {
    var d = v.CW_data;
    if (!d.ok) return;
    var out = {};
    var need_send = false;
    for (var el in this.broadcast_data) {
      if (el === 'img' && !v.image_requested) continue;

      if (!d[el] || JSON.stringify(d[el]) !== JSON.stringify(this.broadcast_data[el])) {
        out[el] = this.broadcast_data[el];
        need_send = true;
      }
    }
    if (need_send) {
      v.write(JSON.stringify(out));
      d.ok = 0;
      CW.extend(d, JSON.parse(JSON.stringify(this.broadcast_data)));
    }
  },

  broadcast: function(data) {
    this.log('debug', 'broadcast');
    if (typeof this.cur_row === 'undefined') return;
    this.render();
    var fb = CW.extend({}, this.fb);
    for (var o in fb) {
      var s = this.spans[o];
      if (!s) continue;
      if (s.spangroup) {
        fb[o].spangroup = s.spangroup.snapshot();
        fb[o].spans = new Array();
        for (var o1 in s.spangroup.spans_list) fb[o].spans.push(s.spangroup.spans_list[o1].snapshot());
      } else {
        fb[o].span = s.snapshot();
      }
    }
    var focus = { is_focused: this.is_focused };
    if (!this.is_focused && this.active_window) CW.extend(focus, this.active_window);
    CW.extend(this.broadcast_data, {
      rows: this.rows ? this.html_rows() : {},
      block: this.rows ? this.json_block() : {},
      size: { cols: this.cols, rows: this.rows, viewport_width: this.viewport_width, viewport_height: this.viewport_height, char_width: this.char_width, char_height: this.char_height, interline: this.interline },
      cursor: { cur_row: this.cur_row, cur_col: this.cur_col_shown() },
      focus: focus,
      position: { z: this.z(), t: this.cur_t, dir: this.playback_direction },
      fb: fb,
      hint: this.hint
    }, data);

    if (this.config) this.broadcast_data.config = this.config;

    for (var o in this.viewers) {
      this.send_to_viewer(this.viewers[o]);
    }

    if (this.on_broadcast) this.on_broadcast.call(this);
    this.trigger_hooks('broadcast');
    if (!this.role !== 'live' && this.playback_direction === 'pause') {
      this.trigger_hooks('playback_ended');
    }
  },

  build_chars_map: function() {
    const that=this;

    const seen_now = {};
    for (let i=0; i<this.paragraphs.length; i++) {
      const p = this.paragraphs[i];
      for (let j=0; j<p.csns.length; j++) {
        let csn = p.csns[j];
        seen_now[csn]=true;
      }
    }

    this.death_sequence++;
    var seen_dead = false;
    for (let csn in this.chars_map) {
      if (!seen_now[csn] && !this.chars_map[csn].deleted) {
        this.chars_map[csn].deleted = this.death_sequence;
        seen_dead = 1;
      } else if (seen_now[csn] && this.chars_map[csn].deleted) {
        this.chars_map[csn].deleted = 0;
      }
    }
    if (!seen_dead) this.death_sequence--;

    let prev_csn = 0;
    for (let i=0; i<this.paragraphs.length; i++) {
      const p = this.paragraphs[i];
      for (var j=0; j<p.csns.length; j++) {
        const csn = p.csns[j];
        if (!this.chars_map[csn]) {
          const chr = { c: p.text[j], csn: csn, p0: p.z0, p9: p.z0 };
          let ok;
          for (let k=0; k<this.chars_seq.length; k++) {
            if (this.chars_seq[k].csn === prev_csn) {
              if (k < this.chars_seq.length-1) {
                for (k++; k<this.chars_seq.length; k++) {
                  if (!this.chars_seq[k].deleted) {
                    k--;
                    break;
                  }
                }
              }
              this.chars_seq.splice(k+1, 0, chr);
              ok=1;
              break;
            }
          }
          if (!ok) this.chars_seq.unshift(chr);
          this.chars_map[csn] = chr;
        } else {
          this.chars_map[csn].p9 = p.z0;
        }
        prev_csn = csn;
      }
    }
  },

  csns_to_string: function(csns) {
    let string = "";
    for (let j=0; j<this.chars_seq.length; j++) {
      let add = "";
      if (j && this.chars_seq[j].p !== this.chars_seq[j-1].p && string.length) add = "\n";
      if (csns.includes(this.chars_seq[j].csn)) string += add + this.chars_seq[j].c;
    }
    return string;
  },

  schedule_hint: function(id, hint) {
    if (!this.scheduled_hints) this.scheduled_hints = {};
    if (!this.scheduled_hints[id] && !hint) return;
    let first_priority;
    if (!hint) {
      delete this.scheduled_hints[id];
    } else {
      this.scheduled_hints[id] = hint;
    }
    let best_id;
    for (let id in this.scheduled_hints) {
      if (first_priority === undefined || this.scheduled_hints[id].priority < first_priority) {
        first_priority = this.scheduled_hints[id].priority;
        best_id = id;
      }
    }
    if (best_id && best_id !== this.active_hint_id) {
      this.send_cmd('set_hint', { hint: this.scheduled_hints[best_id] });
      this.active_hint_id = best_id;
    } else if (id === best_id) {
      this.send_cmd('set_hint', { hint: this.scheduled_hints[best_id] || {} });
    } else if (!best_id && this.active_hint_id) {
      this.send_cmd('set_hint', {});
      this.active_hint_id = undefined;
    }
  },

  mark_working_edge: function(frozen, range, edge_id) {
    for (let csn in this.jcsns) {
      if (this.jcsns[csn].stain === edge_id) delete this.jcsns[csn].stain;
    }
    let go0 = this.frozen_to_global(frozen);
    for (let go=go0-range; go<=go0+range; go++) {
      let frozen1 = this.global_to_frozen(go);
      if (frozen1) {
        let p = this.paragraphs[frozen1.npd];
        if (frozen1.offset < p.csns.length) {
          let csn = p.csns[frozen1.offset];
          if (!this.jcsns[csn]) this.jcsns[csn] = {};
          this.jcsns[csn].stain = edge_id;
        } else {
          range++; // fixme do lateral ranges instead?
        }
      }
    }
  },
  
  find_edge_id: function(frozen, range) {
    const check_stain = (delta) => {
      let frozen1 = this.global_to_frozen(go0 + delta);
      if (!frozen1) return 0;
      let p = this.paragraphs[frozen1.npd];
      if (frozen1.offset >= p.csns.length) return -1;
      let csn = p.csns[frozen1.offset];
      if (this.jcsns[csn] && this.jcsns[csn].stain) return this.jcsns[csn].stain;
      return 0;
    }

    let go0 = this.frozen_to_global(frozen);
    let skip_left=0, skip_right=0;
    for (let delta=0; delta<=range; delta++) {
      let stain;

      do {
        let delta_left = -delta-skip_left;
        stain = check_stain(delta_left);
        if (stain === -1) skip_left++;
        if (stain > 0) return stain;
      } while(stain === -1);
      
      do {
        let delta_right = delta+skip_right;
        stain = check_stain(delta_right);
        if (stain === -1) skip_right++;
        if (stain > 0) return stain;
      } while(stain === -1);
    }
    return 0;
  },
  
  find_edge_id_in_deletion: function(deletion, range) {
    if (deletion && deletion.length) {
      let last_n = deletion.slice(-1 * range);
      last_n.reverse();
      for (let csn of last_n) {
        if (this.jcsns[csn] && this.jcsns[csn].stain) return this.jcsns[csn].stain;
      }
    }
    return 0;
  },

  do_sustained_reading_analysis: function() {
    this.broadcast_data.sr = 0;
    const fixations = this.sustained_eye;
    if (fixations.length < 3) return;
    const last = fixations.slice(-3);
    let y_sum = 0;
    for (let x of last) {
      if (!x.is_text_fixated) return;
      y_sum += x.y;
    }
    let y_ave = y_sum / last.length;

    if (!(last[2].x > last[1].x && last[1].x > last[0].x && last[1].x - last[0].x < this.char_width * 25 && last[2].x - last[1].x < this.char_width * 25)) return;
    const y_tolerance = 100;
    for (let x of last) {
      if (Math.abs(x.y - y_ave) > y_tolerance) return;
    }
    fixations[fixations.length - 1].is_sustained_reading = true;
    this.interval.has_sustained_reading = true;
    this.broadcast_data.sr = 1;
  },

  do_incremental_process_analysis: function(msg, channel) {
    const range = 2;

    if (!this.paragraphs || !this.paragraphs.length) return;
    if (!this.interval) this.interval = {};
    if (!this.jcsns) {
      this.jcsns = {};
      this.last_edge_id = 0;
    }

    if (channel === 'cmd') {
      if (msg.cmd === 'redo' || msg.cmd === 'undo') {
        this.build_chars_map();
      }
      return;
    }

    if (channel === 'key' && msg.k === 'down') {
      if (!this.interval.key) this.interval.key = [];
      this.interval.key.push({ t: msg.t, code: msg.code, iki: msg.iki });
      return;
    }

    if (channel === 'eye') {
      if (msg.k === 'fix') {
        if (!this.interval.eye) this.interval.eye = [];
        if (!this.sustained_eye) this.sustained_eye = [];
        const eye = { t_start: msg.t };
        this.interval.eye.push(eye);
        this.sustained_eye.push(eye);

        var eye_row = parseInt(msg.y / (this.char_height + this.interline));
        var eye_col = parseInt(msg.x / this.char_width);
        eye.row = eye_row;
        eye.col = eye_col;
        eye.x = msg.x;
        eye.y = msg.y;
        if (eye_row >= 0 && eye_row < this.rows && eye_col >= 0 && eye_col <= this.cols) {
          eye.is_text_fixated = true;
          var cr = this.cur_row; var cc = this.cur_col;
          this.cur_row=eye_row; this.cur_col=eye_col;
          var frozen_eye = this.cursor_to_frozen();
          this.cur_row=cr; this.cur_col=cc;

          eye.fixation_offset = this.frozen_to_global(frozen_eye);
          eye.is_ro_fixated = !!this.paragraphs[frozen_eye.npd].ro;
          eye.inscription_offset = this.interval.global_offset;
          const coords = [eye.inscription_offset, eye.fixation_offset].sort((a,b) => a-b)
          eye.displacement_text = this.get_text_between(coords[0], coords[1]);

          this.do_sustained_reading_analysis();

        } else {
          eye.is_text_fixated = false;
        }
        this.last_eye = eye;
      }

      if (msg.k === 'end' && this.last_eye) {
        this.last_eye.duration = msg.dur;
        this.last_eye = null;
      }
    }

    const cursor = this.cursor_to_frozen();

    let is_paragraph_operation = false;
    if (msg.k === 'split_paragraphs') {
      msg.k = 'edit';
      msg.repl = '\n';
      is_paragraph_operation = true;
    }
    if (msg.k === 'join_paragraphs') {
      msg.k = 'edit';
      msg.repl = '';
      msg.len = 1;
      is_paragraph_operation = true;
    }

    const event_type =
      msg.k === 'edit' && msg.repl.length === 1 && !msg.len ? 'production' :
      msg.k === 'edit' && msg.len > 0 && !msg.repl.len      ? 'deletion' :
      msg.k === 'edit' ? 'block-operation'
      : '';


    if (event_type || msg.k === 'cursor' || msg.k === 'resize') this.sustained_eye = [];

    let iv0 = undefined;

    // terminate previous interval
    if (event_type) {
      this.build_chars_map();

      iv0 = this.interval || {};
      iv0.next_event_type = event_type;
      iv0.next_event_is_paragraph_operation = is_paragraph_operation;

      if (event_type === 'production') {
        iv0.text = msg.repl;
        /*if (/^[\w'-]$/.test(msg.repl) && /post-/.test(iv0.location)) {
          iv0.word_started = true;
        }*/
      }
      iv0.duration = msg.t - iv0.t_start;

      // create a new interval
      this.interval = { id: (iv0.id || 0) + 1 };
    }

    if (msg.k === 'edit' && !is_paragraph_operation) {
      cursor.npd = msg.npd;
      cursor.offset = msg.offset + msg.repl.length;
    }

    const iv = this.interval;
    if (!iv.t_start) iv.t_start = msg.t;
    if (!iv.z_start) iv.z_start = msg.z;

    let global_offset = this.frozen_to_global(cursor);
    
    iv.edge_id = this.find_edge_id(cursor, range);

    if (event_type === 'deletion' && iv0.cursor_moved && !iv0.cursor_returned) {
      if (iv0.initial_inscription_offset === global_offset + msg.len) iv0.cursor_returned = true;
    }

    iv.pretext = this.paragraphs[cursor.npd].text.substring(0, cursor.offset);

    iv.location =
      /^\s*$/.test(iv.pretext)        ? 'post-paragraph' :
      /[.!?]["\s]*$/.test(iv.pretext) ? 'post-sentence' :
      /[^\w'-]$/.test(iv.pretext)     ? 'post-word' :
      'within-word';

    if (msg.k === 'edit' || !('initial_inscription_offset' in iv)) {
      iv.initial_inscription_offset = global_offset;
    }
    iv.global_offset = global_offset;

    if (iv.initial_inscription_offset !== global_offset && !iv.cursor_moved) {
      iv.cursor_moved = true;
      iv.cursor_returned = false;
    }
    if (iv.initial_inscription_offset === global_offset && iv.cursor_moved) {
      iv.cursor_returned = true;
    }

    const coords = [iv.global_offset, iv.initial_inscription_offset].sort((a,b) => a-b)
    iv.jump_text = this.get_text_between(coords[0], coords[1]);

    if (msg.k === 'edit') {
      iv0.z_end = msg.z;
      iv0.t_end = msg.t;

      if (!this.cur_segment) this.cur_segment = { id: 0, csns_del: [], csns_ins: [] };
      if (!iv0 || iv0.cursor_moved && !iv0.cursor_returned || is_paragraph_operation || iv0.next_event_type === 'deletion' && this.cur_segment.ins) {
        // start a new segment
        if (iv0 && this.cur_segment.id) iv0.prev_segment = JSON.parse(JSON.stringify(this.cur_segment));
        this.cur_segment = { id: this.cur_segment.id+1, ins: msg.repl.length, del: msg.len, csns_ins: [], csns_del: [] };
      } else {
        if (msg.len > 0) this.cur_segment.del += msg.len;
        if (msg.repl.length) this.cur_segment.ins += msg.repl.length;
      }

      let u = msg.undo ? JSON.parse(msg.undo) : {};
      if (u.csns) {
        this.cur_segment.csns_del = this.cur_segment.csns_del.concat(u.csns);
        iv0.csns_del = [].concat(u.csns);
      } else {
        iv0.csns_del = [];
      }
      if (msg.repl.length) {
        iv0.csns_ins = this.paragraphs[msg.npd].csns.slice(msg.offset, msg.offset+msg.repl.length);
        this.cur_segment.csns_ins = this.cur_segment.csns_ins.concat(iv0.csns_ins);
        iv0.csn = this.paragraphs[msg.npd].csns[msg.offset];
      } else {
        iv0.csns_ins = [];
      }

      this.cur_segment_deleted = msg.len;
      this.cur_segment.text_del = this.csns_to_string(this.cur_segment.csns_del);
      this.cur_segment.text_ins = this.csns_to_string(this.cur_segment.csns_ins);
  
      if (!iv0.cursor_moved || iv0.cursor_returned) delete iv0.jump_text;
    }
    if (iv0) {
      if (!iv0.edge_id) {
        iv0.edge_id = this.find_edge_id_in_deletion(iv0.csns_del, range)
      }
      if (!iv0.edge_id) {
        this.last_edge_id++;
        iv0.edge_id = this.last_edge_id;
      }
      if (msg.k === 'edit' && !is_paragraph_operation) {
        for (let csn of iv0.csns_del) {
          if (!this.jcsns[csn]) this.jcsns[csn] = {};
          this.jcsns[csn].interval_id_del = iv0.id;
          this.jcsns[csn].edge_id_del = iv0.edge_id;
        }
        for (let csn of iv0.csns_ins) {
          if (!this.jcsns[csn]) this.jcsns[csn] = {};
          this.jcsns[csn].interval_id_ins = iv0.id;
          this.jcsns[csn].edge_id_ins = iv0.edge_id;
        }
      }
      this.mark_working_edge(cursor, range, iv0.edge_id);

      iv0.cursor_moved = !!iv0.cursor_moved;
      iv0.cursor_returned = !!iv0.cursor_returned;

//      console.log('*************************************************', this.cur_segment);
      this.trigger_hooks('interval_end', iv0);
    }
  }

});


/*** PARAGRAPH - (inherited) *************************************************/

var old_cywrite_paragraph = CW.Paragraph;
CW.Paragraph = function(text, npd, display) {
  old_cywrite_paragraph.call(this, text, npd, display);
  this.sentences = new Object();
  delete this.edit_history;
  this.csns = (typeof text === 'object' && text.csns) ? CW.extend(new Array(), text.csns) : display.csn_range(this.text.length-1);

  return this;
}
CW.Paragraph.prototype = CW.extend({}, old_cywrite_paragraph.prototype);
CW.extend(CW.Paragraph.prototype, {
  draw: return_this,

  analyze: function() {
    if (this.display.role !== 'live' || this.ro) return;
    let p = this;
    let re = /\w.+?([.!?]|\s*$)/g;
    this.analyzed = true;

    let txt = p.text.substr(0, p.text.length-1); // remove the final $
    txt = txt
      .replace(/\be\.g\./ig, 'e*g*')
      .replace(/\be\. g\./ig, 'e* g*')
      .replace(/\bi\.e\./ig, 'i*e*')
      .replace(/\bi\. e\./ig, 'i* e*');

    let match;
    while ((match = re.exec(txt)) != null) {
      let sent = new CW.Sentence(match.index, match.index+match[0].length-1, p);
    }
    for (let o in p.sentences) {
      if (p.sentences[o].z_updated < this.display.z()) {
        p.sentences[o].destroy();
      }
    }
  },

  edit: function(offset, len, repl, repl_styles, repl_csns) {
    var r = old_cywrite_paragraph.prototype.edit.call(this, offset, len, repl, repl_styles);

    var args = [offset, len].concat(repl_csns ? repl_csns : this.display.csn_range(repl.length));
    Array.prototype.splice.apply(this.csns, args);

    return r;
  },

  touch: function() {
    old_cywrite_paragraph.prototype.touch.call(this);
    if (this.display.role != 'research') {
      CW.async(this, 'analyze', this.display.delays.analyze_paragraph);
      CW.async(this, 'spellcheck', this.display.delays.spellcheck);
    }
  },

  destroy: function() {
    if (this.deleted) return this;
    if (this.display.undoing) this.display.paragraphs_to_remove.push(this);
    old_cywrite_paragraph.prototype.destroy.call(this);
    for (var o in this.sentences) this.sentences[o].destroy();
    return this;
  },

  cursor_moved: function(f1, f2) {
    if (this.cur_word && f1.npd == this.npd && f1.offset >= this.cur_word.op0 && f1.offset <= this.cur_word.op1+1 &&
    (f2.npd != this.npd || f2.offset < this.cur_word.op0 || f2.offset > this.cur_word.op1+1)) this.spellcheck();
  },

  spellcheck: function() {
    if (this.display.role !== 'live' || this.ro) return;
    if (/hhfeng/i.test(this.text) && !this.display.easter_hhfeng) {
      this.display.easter_hhfeng=true;
      this.display.send_cmd('eval', {js: 'this.rpane.css("background-image", "url(http://upload.wikimedia.org/wikipedia/en/0/05/Hello_kitty_character_portrait.png)")'});
    }
    if (/endux/i.test(this.text) && !this.display.easter_endux) {
      this.display.easter_endux=true;
      this.display.send_cmd('eval', {js: 'this.rpane.css("background-image", "url(https://cdn.linguatorium.net/hlam/cats1.jpg)")'});
    }

    if (/debug/i.test(this.text)) {
      setTimeout(() => this.display.send_cmd('set_hint', { hint: { box: { kind: 'yellow large animate__animated animate__zoomIn', message: '<span class="fa fa-align-center"></span> You have 10 minutes &gt; left.' } } }), 5000);
    }

    if (!CW.dict) return;
    if (!this.display.config.modules.spellcheck) return;

    var re = /([\w']+)/g;
    var t=this;
    var errors = new Object();
    var offset = this.display.cur_paragraph().npd == this.npd ? this.cursor_to_offset() : -1;

    delete this.cur_word;

    var match;
    while ((match = re.exec(this.text)) != null) {
      var word = match[0];
      var op0 = match.index;
      var op1 = match.index + word.length - 1;

      if (offset >= op0 && offset <= op1+1) {
        this.cur_word = { op0: op0, op1: op1, word: word };
        continue;
      }

      if (!CW.dict_cache[word]) {
        (function (word) {
          CW.dict.spellSuggestions(word, function(err, correct, suggestions) {
            t.display.log('debug', 'spellcheck returned', err, correct, suggestions, 'for word', word);
            if (correct) CW.dict_cache[word] = 1; else CW.dict_cache[word] = suggestions;
            if (!correct) {
              CW.async(t, 'spellcheck', t.display.delays.spellcheck);
            }
          });
        }) (word);
      } else if (CW.dict_cache[word] != 1) {
        errors [this.display.create_span({npd: this.npd, op0: op0, op1: op1, kind: 'Spelling', perishable: true, exclusive: true, message: 'You have a spelling error here. Please fix. Suggestions: '+CW.dict_cache[word].join(', ')}) ] = true;
      }
    }
    for (var o in this.spans) {
      if (this.spans[o].kind == 'Spelling' && !errors[o] && !(this.cur_word && this.cur_word.op0 == this.spans[o].op0 && this.cur_word.op1 == this.spans[o].op1)) {
        this.spans[o].destroy();
        this.display.send_cmd('destroy_span', { id: o });
      }
    }
  },

  clean: function() {
    if (this.deleted) return;
    delete this.stats;
    CW.async(this);
    for (var o in this.spans) {
      this.spans[o].destroy();
      this.display.send_cmd('destroy_span', { id: o });
    }
    for (var o in this.sentences) {
      this.sentences[o].destroy();
    }
    delete this.analyzed;
    this.cleaned = true;
  }


});

/*** SENTENCE ****************************************************************/

CW.Sentence = function(op0, op1, p) {
  this.paragraph = p;
  if (p.deleted) return; ////?????
  this.display = p.display;

  var t = this;
  var len = op1-op0+1;
  var text = p.text.substr(op0, len);
  var csn1 = 0;
  for (var i=op0; i<=op1; i++) {
    if (p.csns[i] > csn1) csn1 = p.csns[i];
  }
  var sent = { text: text, op0: op0, op1: op1, csn1: csn1, len: len, id: csn1+'-'+len, spans: new Object()};
  if (p.sentences[sent.id]) {
    CW.extend(p.sentences[sent.id], {
      z_updated: this.display.z(),
      op0: op0,
      op1: op1
    });
  } else {
    sent.z_created = this.display.z();
    sent.z_updated = this.display.z();
    CW.extend(this, sent);
    p.sentences[sent.id] = this;
    CW.async(this, 'analyze', t.display.delays.analyze_sentence);
  }
  if (!this.display.sentences[sent.id]) this.display.sentences[sent.id] = p.sentences[sent.id];
  return p.sentences[sent.id];
}

CW.Sentence.prototype = {
  analyze: function() {
    if (!this || this.deleted || !CW.config.features.analyze) return;
    if (!this.display.config.modules.analyze) return;

    this.display.log('debug', 'analyzing sentence', this.id, this.text);

    var that=this;
    setTimeout(function(){if (that.display.queue) CW.rabbit.publish(CW.config.queues.parser, that.text, { correlationId: that.id, replyTo: that.display.queue.name, headers: { 'nextReplyTo': CW.config.queues.analyzer, 'coreNLPArgs': '-ssplit.eolonly true', 'CW-ID': that.id }});}, 0);

    // Calling language tool
    http.request({
      host: 'localhost',
      port: '11111',
      path: '/?'+qs.stringify({text: that.text, language: 'en'})
    }, function(response) {
      var str = '';
      response.on('data', function (chunk) { str += chunk; });
      response.on('end', function () {
        if (!that.deleted) parseString(str, function(err, r) {
          var spans = new Array();
          if (r && r.matches && r.matches.error && r.matches.error.length) {
            for (var i = 0; i < r.matches.error.length; i++) {
              var err = r.matches.error[i].$;
              if (/EN_QUOTES/.test(err.ruleId)) continue;
              that.display.create_span({ npd: that.paragraph.npd, message: err.msg, op0: parseInt(err.fromx) + that.op0, op1: parseInt(err.tox) + that.op0 - 1, kind: 'Grammar', sentence: that });
            }
          }
        })
      });
    }).on('error', function(){}).end();
  },

  apply_analysis: function(d) {
    if (!this || this.deleted) return;

    this.display.log('debug', 'applying analysis to sentence', this.id);
    for (var i = 0; i < d.length; i++) {
      var it = d[i];
      var allow_hhfeng = false;
      var k = it.spangroup.kind;
      /* TODO examples of custom extensions; for hhfeng and aysels
        if (k && /nkfust\.edu\.tw/.test(this.display.doc_id)) {
        if (/CauseEffect/.test(k) && !this.display.config.modules['aysels-cause-effect']) continue;
          if (/-[123]$/.test(this.display.doc_id)) allow_hhfeng = true;
          allow_hhfeng = true;
      }
      if (/x-hhfeng/i.test(k) && !allow_hhfeng) continue;
      */
      for (var j = 0; j < it.spans.length; j++) {
        it.spans[j].op0 = parseInt(it.spans[j].os0) + this.op0;
        it.spans[j].op1 = parseInt(it.spans[j].os1) + this.op0;
        it.spans[j].npd = this.paragraph.npd;
        it.spans[j].sentence = this;
      }
      this.display.create_spangroup(it.spangroup, it.spans);
    }
  },

  destroy: function() {
    if (this.deleted) return;
    this.deleted = 1;
    CW.async(this);
    if (this.spans) {
      for (var o in this.spans) {
        this.spans[o].destroy();
        this.display.send_cmd('destroy_span', { id: o });
      }
    }
    delete(this.paragraph.sentences[this.id]);
    delete(this.display.sentences[this.id]);
  }

};


CW.accept_connection = function(conn) {
  var _on_data = function(e) {
    var d = JSON.parse(e);

    if (d.connect && d.connect == 'clone' && d.token) {
      if (CW.clones[d.token]) {
        var new_clone = CW.clones[d.token];
        if (new_clone.paragraphs && d.need_init) {
          this.write('goodbye'); this.end();
        } else {
          this.removeListener('data', _on_data);
          new_clone.connect(this);
        }
      } else {
        this.write('goodbye'); this.end();
      }
    } else if (d.connect && d.connect == 'viewer' && d.token) {
      if (CW.clones[d.token]) {
        this.removeListener('data', _on_data);
        CW.clones[d.token].add_viewer(this);
      } else {
        this.write('goodbye'); this.end();
      }
    } else {
      this.write('goodbye');
      this.end();
    }
  }

  conn.on('data', _on_data);
}

/// utils

CW.utils = new Object;

CW.utils.sanitize_db3 = function(token, callback) {
  let fname = CW.config.dir_current+'/'+token;
  let db = new sqlite3.Database(fname, sqlite3.OPEN_READWRITE, function(err) {
    if (err) {
      console.log('*** sanitize_db3', token, 'open failed');
      if (callback) callback(err);
      return;
    }
    db.close(function(err){
      if (err) {
        console.log('*** sanitize_db3', token, 'close failed');
        if (callback) callback(err);
        return;
      }
      if (callback)
        callback();
    });
  });
}

CW.utils.archive_db3 = function(token, callback) {
  let fname = CW.config.dir_current+'/'+token;
  const done = function() {
    fs.rename(fname, CW.config.dir_archive+'/'+token, function(err) {
      console.log('*** archive_db3', token, err || 'ok');
      CW.utils.summarize_db3(token, callback);
    });
  }
  console.log('will archive');
  let db = new sqlite3.Database(fname, sqlite3.OPEN_READWRITE, function(err) {
    db.all('select * from eye order by z desc limit 1;', function(err, rows) {
      if (rows && rows.length) {
        let t = rows[0].t;
        console.log('inserting eye event with t='+t);
        db.serialize(function() {
          var stmt = db.prepare('insert into act(t, k) values(?,?)');
          stmt.run.apply(stmt, [t, 'finalize_eye_data']);
          stmt.finalize(() => db.close(done));
        });
      } else {
        db.close(done);
      }
    });
  });
}

CW.utils.sanitize_all_db3 = function (callback) {
  var files = fs.readdirSync(CW.config.dir_current);
  if (files.length) {
    console.log('*** Sanitizing and archiving db3 files...');
    async.eachSeries(files, function(file, callback) {
      if (!/-journal/.test(file)) CW.utils.sanitize_db3(file, function(){ CW.utils.archive_db3(file, callback) });
      else callback();
    }, callback);
  } else {
    callback();
  }
};

CW.utils.summarize_db3 = function(token, callback) {
  if (!callback) callback = function() {};
  let fname = CW.config.dir_archive+'/'+token;
  let db = new sqlite3.Database(fname, sqlite3.OPEN_READWRITE, function(err) {
    if (err) {
      console.log('*** summarize_db3', token, 'open failed');
      if (callback) callback(err);
      return;
    }
    console.log('+ summarize_db3', token);
    let props = {};
    db.all('select * from props;', [], function(err, rows) {
      if (rows && rows.length) {
        for (let row of rows) {
          props[row.name] = row.value;
        }
      }
      db.all('select * from act order by z asc limit 1;', [], function(err, rows) {
        if (rows && rows.length) props.t0 = rows[0].t;
        db.all('select * from act order by z desc limit 1;', [], function(err, rows) {
          if (rows && rows.length) props.t9 = rows[0].t;
          db.all('select count(*) as cnt from act where k=?;', ['edit'], function(err, rows) {
            if (rows && rows.length) props.n_edits = rows[0].cnt;
            db.close();
            CW.summary_db.serialize(() => {
              CW.summary_db.run('delete from sessions where token=?', [token])
                .run('insert into sessions(token, initial_token, previous_token, config, metadata, t0, t9, n_edits) values (?, ?, ?, ?, ?, ?, ?, ?);',
                  [token, props.initial_token, props.previous_token, props.config, props.metadata, props.t0, props.t9, props.n_edits])
                .run('update sessions set next_token=? where token=?', [token, props.previous_token], () => { if (callback) callback()});
            });
          });
        });
      });
    });
  });
};

CW.utils.summarize_all_db3 = function(callback) {
  let files = fs.readdirSync(CW.config.dir_archive);
  CW.summary_db.all('select token from sessions', function(err, rows) {
    let sessions = rows.map(x => x.token);
    console.log('*** Summarizing archived db3 files...');
    async.eachSeries(files, function(file, callback) {
      if (!sessions.includes(file))
        CW.utils.summarize_db3(file, callback);
      else callback();
    }, function() {
      async.eachSeries(sessions, function(session, callback) {
        if (!files.includes(session)) {
          console.log('+ deleting '+session);
          CW.summary_db.run('delete from sessions where token=?', [session])
            .run('update sessions set next_token=NULL where next_token=?', [session], () => { if (callback) callback() });
        }
        else callback();
      }, callback);
    });
  });
};
          
CW.utils.to_html = function(p, options) {
  if (!options) options = {};
  if (CW.is_array(p)) {
    var html = '';
    for (var i=0; i<p.length; i++) html += CW.utils.to_html(p[i], options);
    return html;
  }
  var html = options.no_styles ? ('<p align="'+p.align+'">') : ('<p class="paragraph ' + p.align + (p.ro ? ' ro' : '') + '">');
  var span_open;
  for (var i=0; i<p.text.length; i++) {
    var ch = p.text.charAt(i);
    ch = ch == '&' ? '&amp;' : ch == '"' ? '&quot;' : ch == '<' ? '&lt;' : ch == '>' ? '&gt;' : ch; // ch == "'" ? '&apos;' 
    if (typeof p.styles[i] !== 'undefined') {
      if (span_open) html += '</span>';
      span_open = false;
      if (p.styles[i]) {
        if (options.no_styles) {
          html += '<span style="';
          if (/bold/.test(p.styles[i])) html += 'font-weight: bold; ';
          if (/italic/.test(p.styles[i])) html += 'font-style: italic; ';
          if (/underline/.test(p.styles[i])) html += 'text-decoration: underline; ';
          html += '">';
        } else html += '<span class="'+p.styles[i]+'">';
        span_open = true;
      }
    }
    html += ch;
  }
  if (span_open) html+= '</span>';
  html += '</p>';
  return html;
}

CW.utils.to_txt = function(p, options) {
  if (!options) options = {};
  if (CW.is_array(p)) {
    var txt = '';
    for (var i=0; i<p.length; i++) txt += p[i].text + "\n";
    return txt;
  }
  return p.text;
}

CW.utils.open_summary_db3 = function(callback) {
  if (CW.summary_db) return callback();
  console.log('*** Opening summary db...');
  CW.summary_db = new sqlite3.Database(CW.config.dir_summary + '/summary.db3', function(err) {
    if (err) {
      console.log('! Failed to open summary db', err);
    } else {
      CW.summary_db.run('CREATE TABLE sessions(token TEXT PRIMARY KEY, initial_token TEXT, previous_token TEXT, next_token TEXT, config TEXT, metadata TEXT, t0 INTEGER, t9 INTEGER, n_edits INTEGER);', [], function(err) {
        callback();
      });
    }
  });
};

    
if (CW.config.features.prowrite) {
  (require('./ProWrite.js'))(CW);
}
