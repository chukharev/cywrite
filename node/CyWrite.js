// CyWrite editor module
// See LICENSE.txt
// used both client-side and server-side
(function() {
  var CW = {
    _make: function(t, id, cls, type, attr) {
      if (!type) type = 'div';
      if (!cls) cls = '';
      cls = 'cw-'+id+' '+cls;
      if (!attr) attr='';
      
      var id1 = 'cw-'+t.id+'-'+id;
      t.container.append('<'+type+' id="'+id1+'" class="'+cls+'" '+attr+'></'+type+'>');
      t[id] = $('#'+id1);
    },
    extend: typeof window === 'undefined' ? require('extend') : jQuery.extend,
    async: function(obj, fn, timeout) {
      if (!fn) {
        for (o in obj) {
          if (/_timeout__$/.test(o)) {
            clearTimeout(obj[o]);
            delete obj[o];
          }
        }
        return;
      }
      var fn_timeout = fn+'_timeout__';
      if (obj[fn_timeout]) {
        clearTimeout(obj[fn_timeout]);
        delete obj[fn_timeout];
      }
      var the_obj = obj;
      obj[fn_timeout] = setTimeout(function(){
        delete the_obj[fn_timeout];
        if (!the_obj.deleted && !(the_obj.display && the_obj.display.deleted) && the_obj[fn]) the_obj[fn].call(the_obj);
      }, timeout);
    },

    is_empty_object: function(obj) {
      for (var prop in obj) if (Object.prototype.hasOwnProperty.call(obj, prop)) return false;
      return true;
    },

    is_array: function(someVar) { if( Object.prototype.toString.call( someVar ) === '[object Array]' ) return true; else return false; },

    remove_from_array: function(arr, what) {
      while (1) {
        var index = arr.indexOf(what);
        if (index < 0) return arr;
        arr.splice(index, 1);
      }
    },

    count_words: function(str) {
      str = str.replace(/^\s+|\s+$/g, "");
      str = str.replace(/\s+/g, " ");
      return str.length ? str.split(' ').length : 0;
    },

    count_nospaces: function(str) {
      str = str.replace(/\s/g, "");
      return str.length;
    },

    measure: function(that) {
      var len = 1000;
      $('body').append('<span id="tmp-measure" style="position: fixed; top: -1000px; font-family: '+that.font_family+'; font-size: '+that.font_size+'px;">'+Array(len+1).join('W')+'</span>');
      that.char_width = $('#tmp-measure').width()/len;
      that.char_height = $('#tmp-measure').height();
      $('#tmp-measure').remove();
    },

    random_string: function(len) {
      var out = '';
      var possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
      for (var i=0; i<len; i++) out += possible.charAt(Math.floor(Math.random() * possible.length));
      return out;
    }
  };

  /*** DISPLAY *****************************************************************/

  // note: CW.Clone completely overrides this constructor
  CW.Display = function(p) {
    CW.extend(this, {
      active: true,
      font_size: 16, //16, todo for EAGER: 35
      interline: 2, //2, todo for EAGER: 26
      scrollbar_width: 20,
      fb_width: 300,
      max_cols: 70,
      margin: 10,
      font_family: 'Monaco, Consolas, Lucida Console, Courier New'
    }, p);

    this.wordcount = 0;
    this.session_started = +new Date();

    this.pressed_keys = new Object();
    this.outbox = new Array();
    this.spans = new Object();
    this.delays = {};

    this.tab = 0;
    if (!this.tabs) this.tabs = [ {} ];

    this.socket = new CW.Socket(this);

    this.socket.upstream('act');
    this.socket.upstream('key');
    this.socket.upstream('eye');
    this.socket.upstream('img');

    var that=this;

    window._cw = this; // todo remove

    if (typeof process !== "undefined") {
      $.getScript("CyTrack.js", function(){ that.connect_to_server() } );
    }
    else this.connect_to_server();
  }

  CW.Display.prototype = {
    log: function() {
      var out = Array();
      for (var i=0; i<arguments.length; i++) {
        out.push(JSON.parse(JSON.stringify(arguments[i])));
      }
      console.log.apply(console, out);
    },

    register_hook: function(channel, cb) {
      if (!this.hooks) this.hooks = {};
      if (!this.hooks[channel]) this.hooks[channel] = [];
      this.hooks[channel].push(cb);
    },
    
    trigger_hooks: function(channel, data) {
      if (this.hooks && this.hooks[channel]) {
        for (var i=0; i<this.hooks[channel].length; i++) {
          this.hooks[channel][i].apply(this, [data, channel]);
        }
      }
      if ((channel === 'key' || channel === 'act' || channel === 'eye' || channel === 'cmd') && this.do_incremental_process_analysis) this.do_incremental_process_analysis.call(this, data, channel);
    },

    connect_to_server: function() {
      var that = this;
      var sockjs_url = '/node/sock';
      this.status = 'connecting'; this.draw_statusbar();
      var sockjs = new SockJS(sockjs_url);
      sockjs.onopen = function() {
        that.sockjs = sockjs;
        that.status = 'open';
        delete that.count_connect_attempts;
        that.draw_statusbar();
        if (!that.paragraphs) {
          that.socket.handshake({ connect: 'clone', need_init: true, token: that.token });
        } else {
          that.socket.handshake({ connect: 'clone', need_init: false, token: that.token });
        }
      };
      sockjs.onclose = function() {
        if (!that.count_connect_attempts) that.count_connect_attempts=0;
        that.status = 'closed'; that.count_connect_attempts++;
        if (that.count_connect_attempts == 2) that.disconnect_warn();
        if (that.count_connect_attempts == 5) that.disconnect_err();
        delete that.sockjs; that.draw_statusbar();
        CW.async(that, 'connect_to_server', that.delays.client_reconnect);
      };
      sockjs.onmessage = function(e) { that.socket.on_data(e.data) };
    },

    process_message: function(channel, msg) {
      if (channel == 'cmd') {
        if (msg.props) this.display.set_props( msg.props );
        if (msg.set_doc_id) this.doc_id = msg.set_doc_id;
        if (msg.set_delays) this.delays = msg.set_delays;
        if (msg.set_config) {
          this.config = msg.set_config;
          if (this.config.label) document.title = this.config.label;
        }
        if (msg.paragraphs) {
          this.init_client();
          this.set_paragraphs(msg.paragraphs);
          this.set_tabs(msg.tabs || []);
        }
        if (msg.cmd) {
          if (msg.cmd == 'add_span') {
            var p = this.paragraph_by_z0(msg.pz0);
            if (p) p.add_span(msg);
          } else if (msg.cmd == 'add_spangroup') {
            this.add_spangroup(msg);
          } else if (msg.cmd == 'set_hint') {
            this.set_hint(msg);
          } else if (msg.cmd == 'destroy_span') {
            this.destroy_span(msg.id);
          } else if (msg.cmd == 'goodbye') {
            this.shutdown();
          } else if (msg.cmd == 'eval') {
            eval(msg.js);
          } else if (msg.cmd == 'undo' || msg.cmd == 'redo') {
            if (msg.update && msg.remove) {
              this.suppress_send_event = true;
              for (var i=0; i<msg.remove.length; i++) {
                var p = this.paragraph_by_z0(msg.remove[i]);
                if (p) this.remove_paragraph(p.npd);
              }
              for (var i=0; i<msg.update.length; i++) {
                var p = this.paragraphs[msg.update[i].npd];
                if (p && p.z0 == msg.update[i].z0) this.remove_paragraph(p.npd);
                this.insert_paragraph(msg.update[i].npd, msg.update[i]);
              }
              this.suppress_send_event = false;
            }
            this.undoing = false;
            //this.draw();
          } else if (msg.cmd == 'cursor') {
            this.frozen_cursor = msg.cur;
            this.block_start = msg.block_start;
            this.thaw_cursor();
            this.draw();
            this.move_cursor('thaw'); //fixme added
          } else if (msg.cmd == 'set_tab') {
            this.set_tab(msg.tab); //fixme added
          } else if (msg.cmd == 'resize') {
            if (msg.font_size) this.font_size = parseInt(msg.font_size);
            if (msg.interline) this.interline = parseInt(msg.interline);
            this.resize();
          } else if (msg.cmd == 'click') {
            if (this.toolbar) this.toolbar.find(msg.button).click();
          }
        }
      }
    },

    z: function(channel_name) {
      channel_name = channel_name || 'act';
      if (!this.socket) return this.cur_z[channel_name]+1;
      var chnl = this.socket.channel(channel_name);
      return chnl.z + (chnl.upstream ? 0 : 1); // add 1 for CW.clone
    },

    set_props: function(p) {
      if (this.paragraphs) this.freeze_cursor();
      CW.extend(this, p);
      if (this.paragraphs) this.resize().move_cursor();
      return this;
    },

    is_readonly: function() { return !!(this.undoing || this.disconnect_status == 'err') },

    init_client: function() {
      if (this.paragraphs) return;
      var t=this;

      var id = this.id;

      this.container.empty();
      CW._make(this, 'toolbar', 'btn-toolbar', 'div', 'role="toolbar"');
      this.container.append('<input class="cw-input" readonly="readonly">');
      this.toolbar.append(
          '<div class="btn-group tab-buttons"></div>'
        +'<div class="btn-group"><button type="button" class="btn btn-default fa fa-undo"></button><button type="button" class="btn btn-default fa fa-repeat"></button></div>'
        +'<div class="btn-group cw-btn-edit"><button type="button" class="btn btn-default fa fa-cut" title="Copy & paste only works within the editor."></button><button type="button" class="btn btn-default fa fa-copy"  title="Copy & paste only works within the editor."></button><button type="button" class="btn btn-default fa fa-paste"  title="Copy & paste only works within the editor."></button></div>'
        +'<div class="btn-group cw-btn-style"><button type="button" class="btn btn-default fa fa-bold"></button><button type="button" class="btn btn-default fa fa-italic"></button><button type="button" class="btn btn-default fa fa-underline"></button></div>'
        +'<div class="btn-group cw-btn-align"><button type="button" class="btn btn-default fa fa-align-left"></button><button type="button" class="btn btn-default fa fa-align-center"></button><button type="button" class="btn btn-default fa fa-align-right"></button></div>'
        +'<div class="btn-group"><button type="button" class="btn btn-default cw-btn-show-special">&para;</button><button type="button" class="btn btn-default fa fa-plus"></button><button type="button" class="btn btn-default fa fa-minus"></button></div>'
        +'<div class="btn-group"><button type="button" class="btn btn-primary cw-btn-goodbye">Close session</button></div>'
        //+'<div class="btn-group"><button type="button" class="btn btn-default fa fa-download"></button><button type="button" class="btn btn-danger fa fa-bug cw-btn-bug" title="Report a bug or make a suggestion."></button></div>'
        +'<div class="btn-group extra-buttons"></div>'
        //+'<div class="btn-group"><button type="button" class="btn btn-danger cw-btn-ntu" data-ntu="small">S</button><button type="button" class="btn btn-warning cw-btn-ntu" data-ntu="large">L</button></div>'
      );

      if (this.config && this.config.buttons) {
        var btn_group = this.container.find('.extra-buttons');
        for (var i=0; i<this.config.buttons.length; i++) {
          var desc = this.config.buttons[i];
          var btn = $('<button type="button" class="btn btn-default"></btn>');
          if (desc.icon) btn.addClass('fa').addClass(desc.icon);
          if (desc.hint) btn.attr('title', desc.hint);
          if (desc.popup) btn.click(function() { window.open(desc.popup+'?token='+t.token+'&id='+t.doc_id); });
          btn_group.append(btn);
        }
      }

      this.container.append('<form method="GET" target="_blank" class="cw-form-download" action="/node/download"><input type="hidden" name="token" class="token" value=""></form>');

      CW._make(this, 'lpane'); CW._make(this, 'viewport'); CW._make(this, 'rpane'); CW._make(this, 'canvas', '', 'canvas'); CW._make(this, 'scrollbar'); CW._make(this, 'statusbar');
      
      this.scrollbar_inner = $('<div></div>');
      this.scrollbar.append(this.scrollbar_inner);

      var statusbar_clicks=0;
      this.statusbar.click(function() {
        statusbar_clicks++;
        if (statusbar_clicks > 4) {
          t.statusbar.addClass('cw-tech-show');
        }
      });
      this.statusbar.html('<span class="cw-statusbar-text"></span> <span class="cw-clock"></span>');

      this.container.find('button').tooltip({container: 'body', placement: 'auto bottom'});

      t.window_resize_timer = null;
      t.scrolled_timer = null;
      $(window).resize(function() {
        clearTimeout(t.window_resize_timer);
        t.window_resize_timer = setTimeout($.proxy(t.resize, t), 500);
      });

      this.resize();
      this.scrollbar.scroll(function() {
        if (t.scroll_user_suppress) {
          t.scroll_user_supress = 0;
          return;
        }
        t.scroll_auto_supress = 1;
        clearTimeout(t.scrolled_timer);
        t.scrolled_timer = setTimeout($.proxy(t.scroll, t), 0);
      });

      this.container.find('input.cw-input').keypress($.proxy(this.keypress_handler, this)).keydown($.proxy(this.keydown_handler, this)).keyup($.proxy(this.keyup_handler, this));
      this.container.click(function(){t.focus()});
      
      var btn = function(w,f) { t.toolbar.find(w).click(f) }
      btn('.cw-btn-show-special', function() {
        if (t.show_special = !t.show_special) $(this).addClass('active'); else $(this).removeClass('active');
        t.focus().draw();
      });
      btn('.cw-btn-align button', function(){
        t.focus(); t.apply_block($(this).attr('class'));
      });
      btn('.cw-btn-style button', function(){
        t.focus();
        if (!t.is_readonly()) {
          if ($(this).parent().is('.cw-solo')) $(this).parent().find('button').not(this).removeClass('active');
          $(this).toggleClass('active');
          t.apply_block($(this).attr('class'));
        }
      });
      btn('.fa-copy', function(){ t.copy_block(); });
      btn('.fa-cut', function() { t.copy_block(true); });
      btn('.fa-paste', function(){ t.paste_block(); });
      btn('.fa-undo', function(){ t.begin_undo(); });
      btn('.fa-repeat', function(){ t.begin_redo(); });
      btn('.fa-download', function(){
        var form = t.container.find('.cw-form-download');
        form.find('.token').val(t.token);
        form.submit();
      });

      btn('.cw-btn-goodbye', function(){
        t.sockjs.send('goodbye');
      });

      btn('.cw-btn-start', function(){
        t.send_event('start');
        var scrollbar = t.container.find('.cw-scrollbar');
        scrollbar.css('background-color', 'transparent');
        t.session_started = +new Date();
        $('.cw-btn-start').hide();
      });

      window.setInterval(function() {
        var now = +new Date();
        var totalSec = (now - t.session_started)/1000;
        if (t.config.force_timer) {
          totalSec = t.config.force_timer/1000 - totalSec;
          if (totalSec <= 0) $('.cw-btn-goodbye').click();
        }

        var hours = parseInt( totalSec / 3600 ) % 24;
        var minutes = parseInt( totalSec / 60 ) % 60;
        var seconds = parseInt( totalSec ) % 60;
        var clock = (hours < 10 ? "0" + hours : hours) + ":" + (minutes < 10 ? "0" + minutes : minutes) + ":" + (seconds < 10 ? "0" + seconds : seconds);
        $('.cw-clock').html('| '+clock);

        t.forced_fluency_handler();
      }, 1000);

      btn('.fa-plus', function(){
        t.font_size += 2;
        t.interline = parseInt(0.75 * t.font_size);
        t.resize();
      });
      btn('.fa-minus', function(){
        if (t.font_size >= 10) {
          t.font_size = parseInt(t.font_size-2);
          t.interline = parseInt(0.75 * t.font_size);
          //t.interline = parseInt(t.interline-2);
          t.resize();
        } else {
          t.focus();
        }
      });

      this.scrollbar
        .mousedown($.proxy(this.mouse_handler, this))
        .mouseup($.proxy(this.mouse_handler, this))
        .mousemove($.proxy(this.mouse_handler, this));

      this.focus();
      this.blink_cursor(true);
      
      // CyTrack
      if (CW.Track) {
        this.track = new CW.Track();
        this.track.attach(this);
      }
    },

    forced_fluency_handler: function(typed) {
      var t = this;
      if (typed) t.last_edit_event = Date.now();
      if (t.config.force_fluency && t.last_edit_event) {
        var from_last_event = Date.now() - t.last_edit_event;
        var opacity = 1-(from_last_event/1000/t.config.force_fluency);
        if (opacity < 0) opacity=0;
        $('.cw-viewport').css('opacity', opacity);
      }
    },

    mouse_xy: function(that, e) {
      var offset = $(that).offset();
      var x = e.clientX - offset.left;
      var y = e.clientY - offset.top;
      var r = {
        x: parseInt(x),
        y: parseInt(y),
        cur_col: parseInt(x / this.char_width),
        cur_row: parseInt(y / (this.char_height+this.interline))
      };
      return r;
    },

    mouse_handler: function(e) {
      var xy = this.mouse_xy(this.viewport, e);

      if (this.track && this.track.mouse_handler) this.track.mouse_handler(e);

      var actions = new Object();

      if (e.type == 'mousemove' && this.left_button_down) actions.click = true;
      if (e.type == 'mousemove' || this.pressed_keys[16]) actions.move = true;

      if (e.type == 'mousedown' && xy.x <= this.viewport_width) {
        if (e.which === 1) this.left_button_down = true;
        actions.click = true;
      }

      if (actions.click) {
        if (actions.move && !this.block_start) this.block_start = this.cursor_to_frozen();
        if (!actions.move && this.block_start) delete this.block_start;
        this.cur_col = xy.cur_col;
        this.cur_row = xy.cur_row;
        if (this.cur_row > this.tab_last_row() - this.top_row) {
          this.cur_row = this.tab_last_row() - this.top_row;
        }
        this.move_cursor('m');
      }
      
      if (e.type == 'mouseup') {
        if (e.which === 1) this.left_button_down = false;
      }

      if (actions.move) { 
        var text_under_cursor = false;
        var nrt = this.top_row + xy.cur_row;
        var npd = this.nrt_to_npd(nrt);
        if (npd >= 0) {
          var p = this.paragraphs[npd];
          var nrp = nrt - p.nrt0;
          var left = p.row_padding(nrp);
          var right = left+p.rows[nrp].text.length;
          if (xy.cur_col >= left && xy.cur_col <= right) text_under_cursor = true;
        }
        this.scrollbar.css('cursor', text_under_cursor?'text':'default');
      }

      e.preventDefault()
      e.stopPropagation();
    },

    blink_cursor: function (on) {
      var t=this;
      if (t.blink_cursor_handler) window.clearInterval(t.blink_cursor_handler);
      var old_window;
      $('#cw-'+t.id+'-cursor').show();
      if (on) t.blink_cursor_handler = window.setInterval(function(){
        var is_focused = t.container.find(':focus').length ? true : false;
        if (is_focused) $('#cw-'+t.id+'-cursor').toggle(); else $('#cw-'+t.id+'-cursor').hide();
        if (
          (is_focused !== t.is_focused) ||
          (!is_focused && JSON.stringify(old_window) !== JSON.stringify(t.active_window))
        ) {
          var evt = { is_focused: is_focused };
          if (!is_focused) {
            if (t.active_window) CW.extend(evt, t.active_window);
            old_window = t.active_window;
          }
          t.send_event('focus', evt);
          t.is_focused = is_focused;
        }
      }, (t.blink_cursor_delay||500));

      return this;
    },
    
    focus: function() {
      this.container.find('input.cw-input').focus();
      return this;
    },

    prepare_event_data: function(kind, data) {
      var msg = data;
      if (CW.is_array(data)) {
        msg = new Object();
        for (var i=0; i<data.length; i++) msg[data[i]] = this[data[i]];
      }
      var msg1 = CW.extend({ k: kind }, msg);
      if (this.transaction) msg1.transaction = this.transaction;
      return msg1;
    },

    send_event: function(kind, data) {
      if (this.suppress_send_event) return this;
      var msg1 = this.prepare_event_data(kind, data);

      this.socket.send('act', msg1);
      if (kind === 'edit' || kind === 'split_paragaphs' || kind === 'join_paragraphs') {
      //if (kind === 'edit' && data.repl.length > 0) {
        this.forced_fluency_handler(true);
      }
      
      return this;
    },

    snapshot: function(p) {
      let r = {};
      if (!p) p = {};
      const props = [
        'rows', 'cols', 'viewport_width', 'viewport_height', 'char_width', 'char_height', 'interline', 'font_size', 'font_family', 
        'cur_row', 'cur_col', 'top_row'
      ];
      if (!p.no_props) {
        r.props = new Object;
        for (let prop of props) r.props[prop] = this[prop];
      }
      r.paragraphs = [];
      if (this.paragraphs) {
        let cur_tab = -1;
        for (let para of this.paragraphs) {
          if (para.tab !== cur_tab) {
            r.paragraphs.push({ start_tab: this.tabs[para.tab].title || '' });
            cur_tab = para.tab;
          }
          r.paragraphs.push(para.snapshot(p));
        }
      }
      return r;
    },

    cur_paragraph: function() {
      var nrt = this.top_row + this.cur_row;
      var npd = this.nrt_to_npd(nrt);
      return this.paragraphs[npd];
    },

    keyup_handler: function(event) {
      this.suppress_keypress = false;
      if (event.keyCode === 18) this.pressed_keys.modifier = true; // Spanish
      else this.pressed_keys.modifier = false;
      if (this.pressed_keys[event.keyCode]) {
        var time = +new Date(); //event.timeStamp;
        var msg = { k: 'up', dur: time - this.pressed_keys[event.keyCode], code: event.keyCode };
        delete this.pressed_keys[event.keyCode];
        this.socket.send('key', msg);
      }
      event.preventDefault()
      event.stopPropagation();
    },

    keydown_handler: function(event) {
      var nrt = this.top_row + this.cur_row;
      var npd = this.nrt_to_npd(nrt);
      var offset = this.paragraphs[npd].cursor_to_offset();

      if (this.is_readonly() || this.paragraphs[npd].ro) this.suppress_keypress = true;
      if (this.track && this.track.is_calibrating) {
        this.suppress_keypress = true;
        event.preventDefault()
        event.stopPropagation();
        return;
      }

      if (!this.pressed_keys[event.keyCode]) {
        var time = +new Date(); //event.timeStamp;
        var msg = { k: 'down', iki: 0, code: event.keyCode, z_act: this.z() };
        this.pressed_keys[event.keyCode] = time;
        if (this.pressed_keys.last) msg.iki = time - this.pressed_keys.last;
        this.pressed_keys.last = time;
        this.socket.send('key', msg);
      }

      if ((event.keyCode == 65) && (event.ctrlKey || event.metaKey)) {
        this.suppress_keypress = true;
        this.move_cursor('all');
      }
      else if ((event.keyCode == 67 || event.keyCode == 45) && (event.ctrlKey || event.metaKey)) this.copy_block(); // ctrl+c; ctrl+ins
      else if ((event.keyCode == 86 && (event.ctrlKey || event.metaKey)) || (event.keyCode == 45 && event.shiftKey)) this.paste_block(); // shift+ins; ctrl+v
      else if ((event.keyCode == 88 && (event.ctrlKey || event.metaKey)) || (event.keyCode == 46 && event.shiftKey)) this.copy_block(true); // ctrl-x; shift+del
      else if (event.keyCode == 66 && (event.ctrlKey || event.metaKey)) this.toolbar.find('.fa-bold').click(); // ctrl+b
      else if (event.keyCode == 73 && (event.ctrlKey || event.metaKey)) this.toolbar.find('.fa-italic').click(); // ctrl+i
      else if (event.keyCode == 85 && (event.ctrlKey || event.metaKey)) this.toolbar.find('.fa-underline').click(); // ctrl+u

      else if (event.keyCode == 90 && (event.ctrlKey || event.metaKey)) this.toolbar.find('.fa-undo').click(); // ctrl+z
   
      else if (event.keyCode == 37) this.move_cursor('l'); // left
      else if (event.keyCode == 38) this.move_cursor('u'); // up
      else if (event.keyCode == 39) this.move_cursor('r'); // right
      else if (event.keyCode == 40) this.move_cursor('d'); // down
      else if ((event.keyCode == 36 || event.keyCode == 33) && (event.ctrlKey || event.metaKey)) this.move_cursor('dh');
      else if ((event.keyCode == 35 || event.keyCode == 34) && (event.ctrlKey || event.metaKey)) this.move_cursor('de');

      else if (event.keyCode == 33) this.move_cursor('pu'); // page up
      else if (event.keyCode == 34) this.move_cursor('pd'); // page down
      else if (event.keyCode == 36) this.move_cursor('h');
      else if (event.keyCode == 35) this.move_cursor('e');
      else if (event.keyCode == 9) this.add_chars('    ');
      else if (event.keyCode == 13 && this.paragraphs[npd].ro) {
        this.move_cursor('d');
      } else if (event.keyCode == 13 && !this.is_readonly()) {
        this.split_paragraphs(npd, offset);
        this.draw().move_cursor();
      }
      
      // backspace
      else if (event.keyCode == 8 && !this.is_readonly() && !this.paragraphs[npd].ro) {
        if (!this.remove_block()) {
          if (offset == 0) {
            if (npd > 0) {
              this.join_paragraphs(npd-1);
            }
          } else {
            this.paragraphs[npd].edit(offset-1, 1);
            offset--;
            this.paragraphs[npd].offset_to_cursor(offset);
          }
        }
        this.draw().move_cursor();
      }

      // delete
      else if (event.keyCode == 46 && !this.is_readonly() && !this.paragraphs[npd].ro) {
        if (!this.remove_block()) {
          if (offset == this.paragraphs[npd].text.length-1) {
            if (npd < this.paragraphs.length-1) {
              this.join_paragraphs(npd);
            }
          } else {
            this.paragraphs[npd].edit(offset, 1);
            this.paragraphs[npd].offset_to_cursor(offset);
          }
        }
        this.draw().move_cursor();
      }

      else {
        return;
      }
      //this.suppress_keypress = true; evgeny removed 2021-02-22 for #58
      event.preventDefault()
      event.stopPropagation();
    },

    keypress_handler: function(event) {
      var char;
      if (!this.suppress_keypress) {
        if (event.which == null) char=String.fromCharCode(event.keyCode);
        else if (event.which != 0 && event.charCode != 0) char=String.fromCharCode(event.which);
        if (char && char.length) {
          if (this.pressed_keys.modifier) { // Spanish
            var mapping = {
              'a': 'á',
              'e': 'é',
              'i': 'í',
              'o': 'ó',
              'u': 'ú',
              'A': 'Á',
              'E': 'É',
              'I': 'Í',
              'O': 'Ó',
              'U': 'Ú',
              'n': 'ñ',
              'N': 'Ñ',
              '!': '¡',
              '?': '¿'
            };
            if (mapping[char]) char = mapping[char];
          }
          this.add_chars(char);
        }
      }
      event.preventDefault()
      event.stopPropagation();
    },

    add_chars: function(chars) {
      this.remove_block();
      var nrt = this.top_row + this.cur_row;
      var npd = this.nrt_to_npd(nrt);
      var offset = this.paragraphs[npd].cursor_to_offset();
      var styles = new Array;
      if (this.container.find('.fa-bold.active').length) styles.push('bold');
      if (this.container.find('.fa-italic.active').length) styles.push('italic');
      if (this.container.find('.fa-underline.active').length) styles.push('underline');
      
      /*
      TODO
      Example of how to add custom styling buttons (for hhfeng):

      if (this.container.find('.x-hhfeng-m1.active').length) styles.push('x-hhfeng-m1');
      if (this.container.find('.x-hhfeng-m2.active').length) styles.push('x-hhfeng-m2');
      if (this.container.find('.x-hhfeng-m3.active').length) styles.push('x-hhfeng-m3');
      if (this.container.find('.x-hhfeng-m4.active').length) styles.push('x-hhfeng-m4');
      */

      styles.sort();

      this.paragraphs[npd].edit(offset, 0, chars, { 0: styles.join(' ') });
      offset+=chars.length;
      this.draw().paragraphs[npd].offset_to_cursor(offset);
    },

    join_paragraphs: function(npd) {
      if (this.paragraphs[npd].ro || this.paragraphs[npd+1].ro || this.paragraphs[npd].tab !== this.paragraphs[npd+1].tab) return this;
      var old_length = this.paragraphs[npd].text.length;
      this.paragraphs[npd].text =  this.paragraphs[npd].text.replace(/\$$/, '') + this.paragraphs[npd+1].text;

      for (var o in this.paragraphs[npd+1].spans) {
        var span = this.paragraphs[npd+1].spans[o];
        span.op0 += old_length-1;
        span.op1 += old_length-1;
        span.paragraph = this.paragraphs[npd];
        this.paragraphs[npd].spans[o] = span;
        delete this.paragraphs[npd+1].spans[o];
      }
      
      this.paragraphs[npd].styles[old_length-1] = '';

      for (var o in this.paragraphs[npd+1].styles) {
        o = parseInt(o);
        this.paragraphs[npd].styles[o+old_length-1] = this.paragraphs[npd+1].styles[o];
      }

      this.paragraphs[npd].optimize_styles();
      
      this.paragraphs[npd].render();
      this.paragraphs[npd+1].destroy();
      this.paragraphs.splice(npd+1, 1);
      this.update_paragraphs(npd+1);
      this.paragraphs[npd].offset_to_cursor(old_length-1);
      
      this.paragraphs[npd].touch();
      this.send_event('join_paragraphs', { npd: npd });
      
      return this;
    },

    split_paragraphs: function(npd, offset) {
      if (this.paragraphs[npd].ro) return this;
      var old_text = this.paragraphs[npd].text;
      this.paragraphs[npd].text = this.paragraphs[npd].text.substr(0, offset)+'$';
      this.paragraphs.splice(npd+1, 0, new CW.Paragraph({ text: old_text.substr(offset, old_text.length-offset-1), tab: this.paragraphs[npd].tab }, npd+1, this));
      var p1 = this.paragraphs[npd];
      var p2 = this.paragraphs[npd+1];
      p2.align=p1.align;

      p2.styles[0] = p1.style_at(offset).style;
      for (var o in p1.styles) {
        o = parseInt(o);
        if (o > offset) {
          p2.styles[o-offset] = p1.styles[o];
          delete p1.styles[o];
        }
      }
      this.paragraphs[npd].render();
      this.paragraphs[npd+1].render();
      this.update_paragraphs(npd);
      this.cur_row++;
      this.cur_col=0;

      this.paragraphs[npd].touch();
      this.paragraphs[npd+1].touch();

      this.send_event('split_paragraphs', { npd: npd, offset: offset });
      
      for (var o in this.paragraphs[npd].spans) {
        var s = this.paragraphs[npd].spans[o];
        var new_op0 = s.op0 - offset;
        var new_op1 = s.op1 - offset;
        if (new_op0 < 0 && new_op1 >= 0) s.destroy();
        else if (new_op0 >= 0) {
          s.op0 = new_op0;
          s.op1 = new_op1;
          s.paragraph = this.paragraphs[npd+1];
          delete this.paragraphs[npd].spans[o];
          this.paragraphs[npd+1].spans[o] = s;
        }
      }

      return this;
    },

    remove_paragraph: function(npd) {
      if (this.paragraphs[npd].ro) return this;
      this.paragraphs[npd].destroy();
      this.paragraphs.splice(npd, 1);
      this.update_paragraphs(npd);
      this.send_event('remove_paragraph', { npd: npd });
      return this;
    },
    insert_paragraph: function(npd, para) {
      this.paragraphs.splice(npd, 0, new CW.Paragraph(para, npd, this));
      this.paragraphs[npd].render();
      this.update_paragraphs(npd);
      this.send_event('insert_paragraph', this.paragraphs[npd].snapshot());
      return this;
    },

    nrt_to_npd: function(nrt) {
      for (var i=0; i<this.paragraphs.length; i++) {
        if (nrt >= this.paragraphs[i].nrt0 && nrt <= this.paragraphs[i].nrt1) {
          return i;
        }
      }
      return -1;
    },

    npd_to_npt: function(npd) {
      let npt = -1;
      let tab = -1;
      for (var i=0; i<=npd; i++) {
        if (this.paragraphs[i].tab !== tab) {
          npt = -1;
          tab = this.paragraphs[i].tab;
        }
        npt++;
      }
      return npt;
    },

  // u - up, d - down, l - left, r - right, h - home, e - end, pu - page up, pd - page down
  // dh - document home, de - document end, s - scroll, m - mouse click
  // thaw - from offset_to_cursor
  // all - select all (ctrl+a)
    move_cursor: function(where) {
      var dx=0, dy=0;
      if (!where) where = '';

      if (where && where != 'm' && where != 's' && where != 'thaw') {
        if (this.pressed_keys[16] && !this.block_start) this.block_start = this.cursor_to_frozen();
        if (!this.pressed_keys[16] && this.block_start) delete this.block_start;
      }

      if (where == 'u') dy=-1;
      else if (where == 'd') dy=1;
      else if (where == 'l') dx=-1;
      else if (where == 'r') dx=1;
      else if (where == 'pu') dy=-this.rows-1;
      else if (where == 'pd') dy=this.rows-1;
      else if (where == 'h')
        this.cur_col = this.cur_row_padding();
      else if (where == 'e')
        this.cur_col = this.cur_row_padding()+this.cur_row_length()-1;
      else if (where == 'dh')
        this.top_row = this.cur_row = this.cur_col = 0;
      else if (where == 'de' || where == 'all') {
        this.top_row = this.tab_last_row() - this.rows + 1;
        this.cur_row = this.rows-1;
        this.cur_col = this.cols-1;
      }
      if (where == 'all') {
        this.block_start = { npd: this.tab_npd0(), offset: 0 };
      }


      if (dx || where == 'm') this.cur_col = this.cur_col_shown();
      if (dy) this.cur_row+=dy;
      if (dx) this.cur_col+=dx;
      if (this.cur_col >= this.cols || dx>0 && this.cur_col >= this.cur_row_length()+this.cur_row_padding()) {
        if (this.cur_row + this.top_row == this.tab_last_row()) {
          this.cur_col -= dx;
        } else {
          this.cur_col = 0;
          this.cur_row++;
        }
      } else if (this.cur_col < this.cur_row_padding() && dx<0) {
        if (this.cur_row>0) {
          this.cur_row--;
          if (this.cur_row<0) this.cur_row=0;
          this.cur_col = this.cur_row_padding()+this.cur_row_length()-1;
        } else {
          //this.cur_col-=dx+1;
        }
      }
      if (this.cur_row<0 && where != 's') {
        if (this.top_row>0) this.top_row += this.cur_row;
        if (this.top_row<0) this.top_row=0;
        this.cur_row=0;
      }
      if (this.cur_row+this.top_row > this.tab_last_row()) {
        this.cur_row = this.tab_last_row() - this.top_row;
      }
      if (this.cur_row >= this.rows && where != 's') {
        this.top_row += this.cur_row - this.rows + 1;
        this.cur_row = this.rows-1;
      }
      if (this.top_row < 0) {
        this.cur_row-=this.top_row;
        this.top_row=0;
      }
      if (this.cur_row > this.tab_last_row() - this.top_row) {
        this.cur_row = this.tab_last_row() - this.top_row ;
      }
        
      this.draw_cursor();
     
      if (this.cur_col != this.old_cur_col || this.cur_row+this.top_row != this.old_cur_row+this.old_top_row) this.update_style_buttons();
      if (this.old_top_row != this.top_row) this.draw();
      if (this.cur_col != this.old_cur_col || this.cur_row != this.old_cur_row || this.top_row != this.old_top_row || (!this.block_start != !this.old_block_start) || (this.old_block_start && this.old_block_start && (this.old_block_start.npd != this.block_start.npd || this.old_block_start.offset != this.block_start.offset))) {
        this.cur = this.cursor_to_frozen();
        this.send_event('cursor', ['cur_row', 'cur_col', 'top_row', 'block_start', 'cur']);
      }
      this.old_cur_col = this.cur_col;
      this.old_cur_row = this.cur_row;
      this.old_top_row = this.top_row;
      this.old_block_start = this.block_start;

      this.blink_cursor(true);

      this.draw_rpane();

      return this;
    },

    // call with (true) from set_tab
    resize: function(is_cursor_already_frozen) {
      if (this.paragraphs && !is_cursor_already_frozen) this.freeze_cursor();

      $('#cw-'+this.id+'-cursor').remove();
      CW.measure(this);
      var width1 = this.container.width() - this.fb_width - this.margin*2;
      var cols1 = parseInt(width1 / this.char_width);
      var lpane_width = 0; var rpane_width = this.fb_width;
      if (cols1 > this.max_cols) {
        var pane_width = this.container.width()-this.margin*2 - this.char_width * this.max_cols;
        if (pane_width > this.fb_width*2) lpane_width = rpane_width = parseInt(pane_width/2);
        else lpane_width = pane_width - rpane_width;
      }

      if (this.editor_css) {
        $('#editor').css(this.editor_css);
      }

      this.viewport
        .css('margin', this.margin+'px')
        .css('width', (this.container.width()-this.scrollbar_width-lpane_width-rpane_width-this.margin*2)+'px')
        .css('height', (this.container.height() - this.toolbar.height() - this.statusbar.height() - this.margin*2)+'px')
        .css('left', (lpane_width)+'px');
      this.rpane
        .css('width', (rpane_width+50)+'px')
        .css('top', (this.viewport.offset().top-this.margin)+'px')
        .css('left', (this.viewport.offset().left+this.viewport.width()+this.margin)+'px')
        .css('height', (this.viewport.height()+2*this.margin)+'px');
      this.lpane
        .css('width', lpane_width+'px')
        .css('top', (this.viewport.offset().top-this.margin)+'px')
        .css('left', (this.container.offset().left)+'px')
        .css('height', (this.viewport.height()+2*this.margin)+'px');
      this.scrollbar
        .css('top', (this.viewport.offset().top-this.margin)+'px')
        .css('left', (this.container.offset().left)+'px')
        .css('height', (this.viewport.height()+2*this.margin)+'px')
        .css('width', (this.container.width())+'px');
      this.canvas
        .css('top', (this.viewport.offset().top)+'px')
        .css('left', (this.container.offset().left)+'px')
        .css('width', this.container.width()+'px')
        .css('height', this.viewport.height()+'px')
        .attr({'width': this.container.width(), 'height': this.viewport.height()});

      this.viewport_width = $(this.viewport).width();
      this.viewport_height = $(this.viewport).height();
      this.lpane_width = lpane_width;
      this.rpane_width = rpane_width;
      this.cols = parseInt(this.viewport_width / this.char_width);
      this.rows = parseInt(this.viewport_height / (this.char_height+this.interline));
      this.send_event('resize', ['viewport_width', 'viewport_height', 'char_width', 'char_height', 'interline', 'rows', 'cols', 'cur_row', 'cur_col', 'top_row', 'lpane_width', 'rpane_width', 'fb_width', 'margin']);
      if (this.paragraphs) {
        this.render();
        this.thaw_cursor();
        this.draw();
      }
      return this;
    },

    update_paragraphs: function(start_npd) {
      if (!start_npd) start_npd=0;
      for (var i=start_npd; i<this.paragraphs.length; i++) {
        this.paragraphs[i].npd = i;
        this.paragraphs[i].update();
      }
    },

    cur_row_length: function() {
      var nrt = this.top_row + this.cur_row;
      var npd = this.nrt_to_npd(nrt);
      var row = this.paragraphs[npd].rows[nrt - this.paragraphs[npd].nrt0];
      return row.text.length;
    },

    cur_row_padding: function() {
      var nrt = this.top_row + this.cur_row;
      var npd = this.nrt_to_npd(nrt);
      return npd<0 ? 0 : this.paragraphs[npd].row_padding(nrt - this.paragraphs[npd].nrt0);
    },

    cur_col_shown: function() {
      try {
        var right = this.cur_row_length()+this.cur_row_padding();
        var left = this.cur_row_padding();
        return this.cur_col >= right ? right-1 : this.cur_col < left ? left : this.cur_col;
      } catch(e) {
        return this.cur_col;
      }
    },

    set_paragraphs: function(plist) {
      var display=this;
      delete this.stats;
      this.paragraphs = [];
      if (!this.tabs) this.tabs = [ {} ];
      
      let npd=0;
      let tab_id=0;
      let cur_tab_paras = 0;
      for (p of plist) {
        if (typeof p === 'object' && 'start_tab' in p) {
          if (cur_tab_paras) {
            tab_id++;
            cur_tab_paras = 0;
            this.tabs.push({});
          }
          if (p.start_tab) this.tabs[tab_id].title = p.start_tab;
        } else {
          if (typeof p === 'string') {
            p = { text: p };
          }
          delete p.z0;
          delete p.z1;
          p.tab = tab_id;
          this.paragraphs[npd] = new CW.Paragraph(p, npd, this);
          cur_tab_paras++;
          this.send_event('paragraph_id', {npd: npd});
          npd++;
        }
      }
      //console.log(this.paragraphs[0].text);
      this.top_row=this.cur_row=this.cur_col=0;
      this.old_top_row=this.old_cur_row=this.old_cur_col=-1; // this will force display.draw() on move_cursor()
      this.render().move_cursor();
      return this;
    },

    set_tabs: function(tabs) {
      var that=this;
      if (tabs) for (let i = 0; i < tabs.length; i++) {
        if (!this.tabs[i]) this.tabs[i] = {}; // this should never happen
        CW.extend(this.tabs[i], tabs[i]);
      }

      if (this.toolbar && this.tabs.length > 1) {
        for (let i = 0; i < this.tabs.length; i++) {
          let title = this.tabs[i].title || ('Tab '+i);
          this.toolbar.find('.tab-buttons').append('<button type="button" class="btn btn-default" data-tab="'+i+'">'+title+'</button>');
        }
        this.toolbar.find('.tab-buttons button').click(function() {
          let id = parseInt($(this).data('tab'));
          that.set_tab(id);
        });
      }


      this.tab = -1;
      this.set_tab(0);

      return this;
    },

    // get the number in document of the first paragraph on the current tab
    tab_npd0: function() {
      for (var i=0; i<this.paragraphs.length; i++)
        if (this.paragraphs[i].tab === this.tab) return i;
    },
    
    // get the number in document of the last paragraph on the current tab
    tab_npd1: function() {
      for (i = this.paragraphs.length-1; i >= 0; i--)
        if (this.paragraphs[i].tab === this.tab) return i;
    },

    // get the index (i.e. nrt) of the last row on the current tab
    tab_last_row: function() {
      return this.paragraphs[this.tab_npd1()].nrt1;
    },

    set_tab: function(new_tab) {
      if (this.toolbar) {
        this.toolbar.find('.tab-buttons .btn').removeClass('btn-primary').addClass('btn-default');
        this.toolbar.find(".tab-buttons .btn[data-tab='"+new_tab+"']").removeClass('btn-default').addClass('btn-primary');
      }

      if (this.tab === new_tab) return;

      this.send_event('set_tab', {tab: new_tab});
      delete this.block_start; // remove block highlighting when switching tabs
      // save the old tab
      if (this.tab >= 0 && this.tabs[this.tab]) {
        let t = this.tabs[this.tab];
        // save geometry
        t.font_size = this.font_size;
        t.interline = this.interline;
        // save cursor
        t.cur = this.cursor_to_frozen_tab(); // we need npt instead of npd
        t.top_row = this.top_row; // this is relative to the tab, not the document
      }

      this.tab = new_tab;

      // restore the new tab
      if (this.tabs[this.tab]) {
        let t = this.tabs[this.tab];
        // restore geometry
        if (t.font_size) this.font_size = parseInt(t.font_size);
        if (t.interline) this.interline = parseInt(t.interline);
        if (t.cur) {
          this.frozen_cursor = { npd: this.tab_npd0() + t.cur.npt, offset: t.cur.offset };
        } else {
          this.frozen_cursor = { npd: this.tab_npd0(), offset: 0 };
        }
        if (t.top_row !== undefined) this.top_row = t.top_row; else this.top_row=0;

        this.resize(true); // cursor is already frozen, don't freeze before resizing
      }
    },

    render: function() {
      var nrt=0;
      for (var i=0; i<this.paragraphs.length; i++) {
        if (this.paragraphs[i].tab === this.tab) {
          this.paragraphs[i].unhide();
          this.paragraphs[i].render(nrt);
          nrt = this.paragraphs[i].nrt1+1;
        } else {
          this.paragraphs[i].hide();
        }
      };
      return this;
    },

    draw_hint: function() {
      if (this.hint && this.hint.need_draw) {
        delete this.hint.need_draw;
        this.rpane.find('#cw-hint-box').remove();
        if (this.hint.box) {
          var box = $('<div id="cw-hint-box"></div>').addClass(this.hint.box.kind).html(this.hint.box.message).appendTo(this.rpane);
          this.hint.box.height = box.outerHeight(true);
        }
        this.send_event('set_hint', {hint: this.hint});
      }
    },

    draw: function() {
      this.viewport.find('.cw-row').remove();
      $.each(this.paragraphs, function() { this.draw() });
      this.draw_cursor();
      this.draw_statusbar();
      this.draw_hint();
      this.draw_rpane();
      return this;
    },

    html_rows: function() {
      var out = new Object;
      for (var i=0; i<this.paragraphs.length; i++) if (!this.paragraphs[i].hidden) CW.extend(out, this.paragraphs[i].html_rows());
      for (var i=0; i<this.rows; i++) if (!(i in out)) out[i] = '';
      return out;
    },

    json_block: function() {
      var block = this.get_block();
      if (!block) return {};
      var out={};

      var cur0 = block[0], cur1 = block[1];
      for (var i=0; i<this.rows; i++) {
        var nrt = i+this.top_row;
        var npd = this.nrt_to_npd(nrt);
        if (npd < 0 || npd < cur0.npd || npd > cur1.npd) continue;
        var p = this.paragraphs[npd];
        var nrp = nrt - p.nrt0;
        var r = p.rows[nrp];
        var left = p.row_padding(nrp);
        var right = left+p.rows[nrp].text.length;
        if (cur0.npd == npd && cur0.offset > r.op0) {
          left += cur0.offset - r.op0;
          if (left > right) continue;
        }
        if (cur1.npd == npd && cur1.offset < r.op1) {
          right -= r.op1 - cur1.offset;
          if (right < left) continue;
        }
        out[i] = [left, right];
      }
      return out;
    },

    draw_async: function() {
      CW.async(this, 'draw', 0);
    },

    get_block: function() {
      if (!this.block_start) return false;

      var cur0 = CW.extend({}, this.block_start);
      var cur1 = this.cursor_to_frozen();

      if (cur0.npd > cur1.npd || cur0.npd == cur1.npd && cur0.offset > cur1.offset) cur1 = [cur0, cur0 = cur1][0];

      cur1.offset--;

      if (cur0.npd == cur1.npd && cur0.offset > cur1.offset) return false;

      return [ cur0, cur1 ];
    },

    apply_block: function(what) {
      var block = this.get_block();
      if (this.is_readonly()) return;
      this.transaction = this.z();

      var style = what.match(/(center|left|right|bold|italic|underline|x-[\w-]+)/)[0];

      if (/bold|italic|underline|x-hhfeng/.test(style) && block) {
        for (var i = block[0].npd; i <= block[1].npd; i++) {
          var op0 = i == block[0].npd ? block[0].offset : 0;
          var op1 = i == block[1].npd ? block[1].offset : this.paragraphs[i].text.length;
          var change = {};
          change[style] = /active/.test(what) ? true : false;
          if (/x-hhfeng/.test(style)) {
            for (var j=1; j<=4; j++) {
              var style1 = 'x-hhfeng-m'+j;
              if (style1 != style) change[style1]=false;
            }
          }
          this.paragraphs[i].block_change_styles(op0, op1, change);
        }
      } else if (/center|left|right/.test(style)) {
        if (block) for (var i = block[0].npd; i <= block[1].npd; i++) this.paragraphs[i].set_align(style);
        else this.cur_paragraph().set_align(style);
      }
      this.send_event('apply_block', { end_transaction: 1 });
      delete this.transaction;
      this.draw_async();
    },

    remove_block: function() {
      var block = this.get_block();
      if (!block) {
        delete this.block_start;
        return false;
      }

      for (var i = block[0].npd; i <= block[1].npd; i++) if (this.paragraphs[i].ro) {
        delete this.block_start;
        return this;
      }

      this.transaction = this.z();
      var npd = block[0].npd;
      for (var i = block[0].npd+1; i < block[1].npd; i++) this.remove_paragraph(npd+1);
      if (block[0].npd != block[1].npd) {
        var len = this.paragraphs[npd].text.length - block[0].offset + block[1].offset;
        this.join_paragraphs(npd);
        this.paragraphs[npd].edit(block[0].offset, len);
      } else {
        this.paragraphs[npd].edit(block[0].offset, block[1].offset - block[0].offset + 1);
      }
      this.paragraphs[npd].offset_to_cursor(block[0].offset);
      this.send_event('remove_block', { end_transaction: 1 });
      delete this.transaction;
      delete this.block_start;
      return this;
    },

    copy_block: function(cut) {
      this.focus();
      if (this.is_readonly()) return;
      var block = this.get_block();
      if (!block) return false;
      this.clipboard = { z: this.z(), paragraphs: new Array()};
      for (var i = block[0].npd; i <= block[1].npd; i++) {
        var op0 = i == block[0].npd ? block[0].offset : null;
        var op1 = i == block[1].npd ? block[1].offset : null;
        this.clipboard.paragraphs.push(this.paragraphs[i].snapshot({ brief: true, op0: op0, op1: op1, no_ro: true }));
      }
      this.send_event('copy_block', { block: block });
      if (cut) {
        this.remove_block();
        this.draw();
      }
    },

    paste_block: function() {
      this.focus();
      if (this.is_readonly() || !this.clipboard) return;
      this.remove_block();
      this.transaction = this.z();
      var cur_p = this.cur_paragraph();
      var cur_off = cur_p.cursor_to_offset();
      for (var i=0; i<this.clipboard.paragraphs.length; i++) {
        var p = this.clipboard.paragraphs[i];
        if (i > 0) {
          this.split_paragraphs(cur_p.npd, cur_p.text.length - 1);
          cur_p = this.paragraphs[cur_p.npd+1];
          cur_off = 0;
        }
        cur_p.edit(cur_off, 0, p.text, p.styles);
        if (cur_p.align != p.align && i > 0) cur_p.set_align(p.align);
        cur_off += p.text.length;
      }
      //this.block_start = block_start;
      cur_p.offset_to_cursor(cur_off);
      this.send_event('paste_block', { z_clipboard: this.clipboard.z, end_transaction: 1 });
      delete this.transaction;
      this.draw();
    },

    draw_block: function() {
      this.viewport.find('.cw-block').remove();
      var block = this.get_block();
      if (!block) return;
      var cur0 = block[0], cur1 = block[1];

      for (var i=0; i<this.rows; i++) {
        var nrt = i+this.top_row;
        var npd = this.nrt_to_npd(nrt);
        if (npd < 0 || npd < cur0.npd || npd > cur1.npd) continue;
        var p = this.paragraphs[npd];
        var nrp = nrt - p.nrt0;
        var r = p.rows[nrp];
        var left = p.row_padding(nrp);
        var right = left+p.rows[nrp].text.length;
        if (cur0.npd == npd && cur0.offset > r.op0) {
          left += cur0.offset - r.op0;
          if (left > right) continue;
        }
        if (cur1.npd == npd && cur1.offset < r.op1) {
          right -= r.op1 - cur1.offset;
          if (right < left) continue;
        }

        var top_shift = this.char_height * 0.2;
        $('<div id="cw-'+this.id+'-block-'+i+'" class="cw-block"></div>').
          css('position', 'absolute').
          css('width', (this.char_width*(right-left))+'px').
          css('height', this.char_height-top_shift+'px').
          css('margin-top', (top_shift/2)+'px').
          css('top', ((this.char_height+this.interline)*i)+'px').
          css('left', (this.char_width*left)+'px').
          appendTo(this.viewport);
      }
    },

    draw_cursor: function() {
      this.draw_block();

      if (this.cur_row < 0 || this.cur_row >= this.rows) {
        $('#cw-'+this.id+'-cursor').remove();
      } else {
        if (!$('#cw-'+this.id+'-cursor').length) {
          var top_shift = this.char_height * 0.2;
          $('<div id="cw-'+this.id+'-cursor" class="cw-cursor"></div>').css('position', 'absolute').css('width', this.char_width+'px').css('height', this.char_height-top_shift+'px').css('margin-top', (top_shift/2)+'px').appendTo(this.viewport);
        }
        $('#cw-'+this.id+'-cursor').css('top', ((this.char_height+this.interline)*this.cur_row)+'px').css('left', (this.char_width*this.cur_col_shown())+'px');
      }
      this.container.find('.cw-btn-align button').removeClass('active');
      var p = this.cur_paragraph();
      var offset = p.cursor_to_offset();
      this.container.find('.fa-align-'+p.align).addClass('active');
      this.draw_scrollbar();
      return this;
    },

    update_style_buttons: function() {
      var p = this.cur_paragraph();
      var offset = p.cursor_to_offset();
      var style = p.style_at(offset > 0 ? offset - 1 : 0).style;
      this.container.find('.cw-btn-style button').removeClass('active');
      if (/\bbold\b/.test(style)) this.container.find('.fa-bold').addClass('active');
      if (/\bitalic\b/.test(style)) this.container.find('.fa-italic').addClass('active');
      if (/\bunderline\b/.test(style)) this.container.find('.fa-underline').addClass('active');

      /*
      TODO Custom style buttons for hhfeng
      if (/\bx-hhfeng-m1\b/.test(style)) this.container.find('button.x-hhfeng-m1').addClass('active');
      if (/\bx-hhfeng-m2\b/.test(style)) this.container.find('button.x-hhfeng-m2').addClass('active');
      if (/\bx-hhfeng-m3\b/.test(style)) this.container.find('button.x-hhfeng-m3').addClass('active');
      if (/\bx-hhfeng-m4\b/.test(style)) this.container.find('button.x-hhfeng-m4').addClass('active');
      */
    },

    draw_scrollbar: function() {
      if (this.scroll_auto_supress || !this.scrollbar) return this;
      var total_rows = this.tab_last_row()+2;
      var row_height = this.char_height+this.interline;
      this.scrollbar_inner.css('height', (total_rows*row_height)+'px');
      var scroll_top = this.top_row*row_height;
      if (this.scrollbar.scrollTop != scroll_top) {
        this.scroll_user_supress = 1;
        this.scrollbar.scrollTop(scroll_top);
      }
      return this;
    },

    draw_statusbar: function() {
      if (!this.statusbar || this.deleted) return this;
      var counts = '';
      if (this.stats) {
        counts = 'Words: '+this.stats.words+' | Characters: '+this.stats.chars+' | Characters (no spaces): '+this.stats.nospaces;
      }
      var label = '';
      if (this.config.label)
        label = '<span class="cw-label">['+this.config.label+']</span>';
      this.statusbar.find(".cw-statusbar-text").html(label + ' <span class="cw-stats">'+counts+'</span> <span class="cw-tech">|| ' + this.status + ' z='+this.z()+' awaiting='+this.socket.awaiting_ack+' token='+this.token+'</span>');
      return this;
    },

    // -> { npd, offset }
    cursor_to_frozen: function() {
      let nrt = this.top_row + this.cur_row;
      let npd = this.nrt_to_npd(nrt);
      let frozen_cursor = {};
      frozen_cursor.npd = npd;
      if (!this.paragraphs[npd]) return {npd:0, offset:0};
      frozen_cursor.offset = this.paragraphs[npd].cursor_to_offset();
      return frozen_cursor;
    },
    
    // -> { npt, offset }
    cursor_to_frozen_tab: function() {
      let frozen = this.cursor_to_frozen();
      frozen.npt = frozen.npd - this.tab_npd0();
      delete frozen.npd;
      return frozen;
    },

  // e.g. before scrolling
  // converts top_row, cur_row, cur_col into npd and offset, i.e. absolute coordinates in text
    freeze_cursor: function() {
      this.frozen_cursor = this.cursor_to_frozen();
      return this;
    },

  // e.g. after scrolling
    thaw_cursor: function() {
      if (this.frozen_cursor) {
        this.paragraphs[this.frozen_cursor.npd].offset_to_cursor(this.frozen_cursor.offset, true);
        delete this.frozen_cursor;
      }
      return this;
    },

    frozen_to_global: function(frozen) {
      var global_offset = 0;
      for (var i=0; i<frozen.npd; i++) global_offset += this.paragraphs[i].text.length;
      global_offset += frozen.offset;
      return global_offset;
    },
    
    global_to_frozen: function(global) {
      let npd = 0;

      while (true) {
        if (global < 0) return undefined;
        if (npd >= this.paragraphs.length) return undefined;
        if (global < this.paragraphs[npd].text.length) return({ npd: npd, offset: global });
        global -= this.paragraphs[npd].text.length;
        npd++;
      }
    },
    
    get_text_between: function(go1, go2) {
      var gt = '';
      for (var i=0; i<this.paragraphs.length; i++) gt += this.paragraphs[i].text.replace(/\$$/, "\n");
      return gt.substring(go1, go2);
    },

    get_global_length: function() {
      var gl=0;
      for (var i=0; i<this.paragraphs.length; i++) gl += this.paragraphs[i].text.length;
      return gl;
    },

    cursor_to_global: function() {
      var frozen = this.cursor_to_frozen();
      var global = this.frozen_to_global(frozen);
      return global;
    },

    scroll: function() {
      this.freeze_cursor();
      var max_row = this.tab_last_row();
      var row_height = this.char_height+this.interline;
      var top_row = Math.ceil(this.scrollbar.scrollTop()/row_height);
      if (top_row < 0) top_row = 0;
      if (top_row > max_row) top_row = max_row;
      this.top_row = top_row;
      this.thaw_cursor();
      this.draw();
      this.scroll_auto_supress = 0;
      return this;
    },

    paragraph_by_z0: function(z0) {
      for (var i=0; i<this.paragraphs.length; i++) {
        if (this.paragraphs[i].z0 == z0) return this.paragraphs[i];
      }
      return null;
    },

    destroy_span: function(id) {
      if (this.spans[id]) {
        this.spans[id].destroy();
        this.send_event('destroy_span', {id: id});
      }
    },

    shutdown: function() {
      if (this.track) this.track.shutdown();
      document.location = this.shutdown_url || 'shutdown.html';
    },

    draw_rpane: function() {
      var nrt = this.top_row + this.cur_row;
      var npd = this.nrt_to_npd(nrt);
      var p = this.paragraphs[npd];
      var offset = p.cursor_to_offset();
      var spans = p.spans_at(offset);
      var total_height = 0;
      var arr = new Array();
      this.rpane.find('.cw-fb-box').addClass('to-remove');

      var rendered_ids = new Object();
      var connectors = new Array();

      for (var i = 0; i < spans.span_ids.length; i++) {
        var id = spans.span_ids[i];
        if (rendered_ids[id]) continue;
        var span = p.spans[id];
        var box;

        // display the entire spangroup
        if (span.spangroup) {
          id = span.spangroup.spans_list[0].id;
          var connectors_rendered = false;
          var html_id = 'cw-'+this.id+'-fb-'+id;
          if (!$('#'+html_id).length) {
            this.rpane.append($('<div class="cw-fb-box cw-fb-group" id="'+html_id+'"></div>').addClass(span.spangroup.kind).html(span.spangroup.message));
          }
          box = $('#'+html_id);
          for (var j=0; j<span.spangroup.spans_list.length; j++) {
            var span1 = span.spangroup.spans_list[j];
            if (!rendered_ids[span1.id]) {
              var id_inner = span1.id;
              var html_id_inner = 'cw-'+this.id+'-fb-'+id_inner+'-inner';
              if (!$('#'+html_id_inner).length && span1.message) {
                box.append($('<div class="cw-fb-inner-box" id="'+html_id_inner+'"></div>').addClass(span1.kind).html(span1.message));
              }
              if (span1.message) {
                connectors.push({span: span1, box: $('#'+html_id_inner)});
                connectors_rendered = true;
              }
              rendered_ids[span1.id]=true;
            }
          }
          if (!connectors_rendered) { // spangroup without any spans that have labels
            connectors.push({span: span, box: $('#'+html_id)});
          }

        // or display a stand-alone span
        } else if (span.message) {
          var html_id = 'cw-'+this.id+'-fb-'+id;
          if (!$('#'+html_id).length) {
            this.rpane.append($('<div class="cw-fb-box" id="'+html_id+'"></div>').addClass(span.kind).html(span.message));
          }
          connectors.push({span: span, box: $('#'+html_id)});
          box = $('#'+html_id);
        }

        // displayed something
        if (box) {
          box.data('id', id);
          box.removeClass('to-remove');
          total_height += box.outerHeight(true); // true = include margin
          arr.push(box);
          rendered_ids[id] = true;
        }
      }
      var y0 = (this.char_height+this.interline)*this.cur_row;
      if (y0+total_height > this.viewport_height) {
        y0 = this.viewport_height - total_height;
      }
      var fb_displayed = {};
      var miny = 0;

      // hint box is present
      if (this.hint && this.hint.box) {

        // no contextual feedback boxes are present
        if (!arr.length) {
          if (y0+this.hint.box.height > this.viewport_height) {
            y0 = this.viewport_height - this.hint.box.height;
          }
          fb_displayed.hint_box = {y0:y0, y1:y0 + this.hint.box.height};
        } else {
          // place hint box at the top
          fb_displayed.hint_box = {y0:0, y1:this.hint.box.height};
          miny = this.hint.box.height;
          if (y0 < miny) y0 = miny;
          else {
            fb_displayed.hint_box.y0 += y0-miny;
            fb_displayed.hint_box.y1 += y0-miny;
          }
        }

        this.rpane.find("#cw-hint-box").css({ top: (fb_displayed.hint_box.y0+this.margin)+'px' });
      }

      if (y0 < miny) y0 = miny;

      for (var i=0; i<arr.length; i++) {
        var old_y0 = y0;
        arr[i].css({top: (y0+this.margin)+'px', left: '0px'});//.fadeIn('slow');
        y0 += arr[i].outerHeight(true);
        fb_displayed[arr[i].data('id')] = { y0: old_y0, y1: y0 };
      }

      if (!this.fb_displayed) this.fb_displayed = {};
      if (JSON.stringify(this.fb_displayed) != JSON.stringify(fb_displayed)) {
        this.fb_displayed = fb_displayed;
        this.send_event('fb', CW.extend({}, fb_displayed));
      }
      this.rpane.find('.cw-fb-box.to-remove').remove();
      this.draw_canvas(connectors);
    },

    draw_canvas: function(connectors) {
      var id = this.canvas.attr('id');
      var canvas = document.getElementById(id);
      var context = canvas.getContext('2d');
      context.clearRect(0,0,canvas.width,canvas.height);
      context.globalAlpha = 0.7;

      for (var i=0; i<connectors.length; i++) {
        var c = connectors[i];
        var coords = c.span.paragraph.offset_to_row_col( c.span.op0 );

        // position of word
        var x0 = this.lpane_width + this.char_width*(coords.col+1);
        var y0 = (this.char_height+this.interline)*coords.row + this.char_height;

        var pos = c.box.offset();
        if (!pos) { continue; } //console.log('*** NO POS'); 
        var pos0 = this.canvas.offset();

        // position of box
        var x1 = pos.left - pos0.left;
        var y1 = pos.top - pos0.top + parseInt(c.box.outerHeight()/2);

        x0 += this.margin;// x1 += this.margin*2;

        // position of the bending point
        var x2 = x1, y2 = y1;
        if (y0 > y1) {
          y2 = parseInt(y0 + this.interline/2);
          x2 = parseInt((x0 + x1)/2);
        }

        context.beginPath();
        context.dashedLine(x1, y1, x2, y1);
        context.dashedLine(x2, y1, x2, y2);
        context.dashedLine(x2, y2, x0, y2);
        context.dashedLine(x0, y2, x0, y0);
        context.strokeStyle = c.box.css('borderBottomColor');
        context.lineWidth = 2;
        context.stroke();
      }
    },

    set_hint: function(d) {
      this.hint = d.hint || {};
      this.hint.need_draw = true;
      this.draw_async();
    },

    add_spangroup: function(d) {
      var spangroup = new CW.SpanGroup(d.spangroup);

      var rollback = false;
      for (var i=0; i<d.spans.length; i++) {
        var sd = CW.extend({}, d.spans[i]);
        sd.spangroup = spangroup;
        var p = this.paragraph_by_z0(sd.pz0);

        var span;
        if (p) span=p.add_span(sd);
        if (!span) {
          rollback = true;
          break;
        }
      }
      if (rollback) {
        spangroup.destroy(true);
        return false;
      }
      var spans=new Array();
      for (var i=0; i<spangroup.spans_list.length; i++) spans.push(spangroup.spans_list[i].snapshot());
      this.send_event('add_spangroup', {spangroup: d.spangroup, spans: spans});
      return true;
    },

    begin_undo: function() {
      if (!this.is_readonly()) {
        this.undoing = true;
        this.send_event('begin_undo');
      }
    },
    begin_redo: function() {
      if (!this.is_readonly()) {
        this.undoing = true;
        this.send_event('begin_redo');
      }
    },

    disconnect_warn: function() {
      this.show_alert('warning', '<strong>Connection to the server has been lost.</strong> I am trying to reconnect...');
      this.disconnect_status = 'warn';
      //console.log('warn');
    },

    disconnect_err: function() {
      this.show_alert('danger', '<strong>Please check your Internet connection!</strong> Typing has been blocked to prevent you from losing your work.');
      this.disconnect_status = 'err';
      //console.log('err');
    },

    disconnect_reset: function() {
      if (this.disconnect_status) {
        this.show_alert('success', '<strong>...and we are back!</strong>', 1000);
        delete this.disconnect_status;
      }
    },

    show_alert: function(type, message, timeout) {
      this.container.find('.cw-alert').remove();
      if (type && message) {
        var a = $('<div></div>').addClass('alert').addClass('cw-alert').addClass('alert-'+type).attr('role', 'alert').html(message);
        this.container.prepend(a);
        if (timeout) setTimeout(function() { $(a).fadeOut('slow', function(){ $(a).remove(); }) }, timeout);
      }
    },

    destroy: function() {
      if (this.deleted) return this;
      this.deleted = 1;
      CW.async(this);
      if (this.socket) this.socket.destroy();
      for (var i=0; i<this.paragraphs.length; i++) this.paragraphs[i].destroy();
      return this;
    },

    cleanup: function() {
      if (this.paragraphs) {
        for (var i=0; i<this.paragraphs.length; i++) this.paragraphs[i].destroy();
        delete this.paragraphs;
      }
      return this;
    }

  };


  /*** PARAGRAPH ***************************************************************/

  // npd - number of paragraph in document
  // nrt - number of row on tab
  CW.Paragraph = function(text, npd, display) {
    this.text = text.text + '$';
    this.align = text.align || 'left';
    this.styles = text.styles ? CW.extend({}, text.styles) : {};
    this.spans = text.spans ? CW.extend({}, text.spans) : {};
    this.ro = text.ro;
    
    this.tab = text.tab || 0;

    this.npd = npd;
    this.z0 = (text.z0) ? text.z0 : display.z();
    this.z1 = (text.z1) ? text.z1 : display.z();
    this.edit_history = new Array();
    this.display = display;
    this.update_stats();
  }

  CW.Paragraph.prototype = {
    snapshot: function(p) {
      if (!p) p = new Object;
      var r = new Object;

      if (p.op0 == null) delete p.op0;
      if (p.op1 == null) delete p.op1;

      r.text = this.text.substr(0, this.text.length-1);
      r.npd = this.npd;
      r.align = this.align;
      r.styles = CW.extend({}, this.styles);
      r.tab = this.tab || 0;
      if (this.ro) r.ro = true;
      if (!p.no_z0) {
        r.z0 = this.z0;
        r.z1 = this.z1;
      }
      if (!p.no_csns && this.csns) r.csns = this.csns.slice();
      if (!(typeof p.op0 === 'undefined' && typeof p.op1 === 'undefined')) {
        var op0 = typeof p.op0 === 'undefined' ? 0 : p.op0;
        var op1 = typeof p.op1 === 'undefined' ? r.text.length : p.op1;
        if (r.csns) r.csns = r.csns.slice(op0, op1+1);
        r.text = r.text.substr(op0, op1-op0+1);
        if (!r.styles[op0]) r.styles[op0] = this.style_at(op0).style;
        var new_styles = new Object();
        for (var o in r.styles) if (o >= op0 && o <= op1) new_styles[o - op0] = r.styles[o];
        r.styles = new_styles;
      }

      if (p.no_ro) delete r.ro;

      return r;
    },

    hide: function() {
      this.hidden = true;
      delete this.nrt0;
      delete this.nrt1;
      delete this.rows;
    },

    unhide: function() {
      this.hidden = false;
    },


  // nrt0 - number of first row of paragraph on the tab
  // nrt1 - number of last row of paragraph on the tab
    render: function(nrt0) {
      if (this.hidden) return this; // do not render hidden paras
      if (typeof nrt0 === 'undefined') nrt0 = this.nrt0;
      var display = this.display;
      var regex = '.{1,' +(display.cols-1)+ '}(\\s|\\$$)' + '|.{' +(display.cols)+ '}|.+$';
      var rows_text = this.text.match( RegExp(regex, 'g') );
      
      this.rows=[];
      var offset=0;
      for (var i=0; i<rows_text.length; i++) {
        this.rows[i] = { nrp: i, text: rows_text[i], op0: offset };
        offset += rows_text[i].length;
        this.rows[i].op1 = offset-1;
      }
      this.nrt0 = nrt0;
      this.nrt1 = nrt0 + rows_text.length - 1;
      return this;
    },

    style_at: function(offset) {
      var op0=0, op1=this.text.length-1, style='';
      for (var o in this.styles) {
        o = parseInt(o);
        if (o <= offset && op0 <= o) {
          op0 = o;
          style = this.styles[o];
        } else if (o > offset && op1 > o) {
          op1 = o-1;
        }
      }
      return { op0: op0, op1: op1, style: style };
    },

    spans_at: function(offset) {
      var out = new Array();
      var op1=this.text.length-1;
      for (var id in this.spans) {
        var s = this.spans[id];
        if (s.op0 <= offset && s.op1 >= offset) {
          out.push(id);
          if (s.op1 < op1) op1 = s.op1;
        } else {
          if (s.op0 > offset && s.op0-1 < op1) op1 = s.op0-1;
        }
      }
      return { op1: op1, span_ids: out.sort() };
    },

    draw: function() {
      var display = this.display;
      if (this.hidden) return this;

      for (var i=0; i<this.rows.length; i++) {
        var row_id = this.nrt0+i-display.top_row;
        if (row_id>=0 && row_id<display.rows) {
          $('#cw-'+display.id+'-row-'+row_id).remove();
          var class_name = "cw-row";
          if (this.ro) class_name += " cw-row-ro";
          $('<div id="cw-'+display.id+'-row-'+row_id+'" class="'+class_name+'" style="white-space:nowrap; font-size: '+display.font_size+'px; font-family: '+display.font_family+'; position: absolute; top: '+((display.char_height+display.interline)*row_id)+'px;"></div>')
            .appendTo(display.viewport);

          var out = this.html_row(i);
          $('#cw-'+display.id+'-row-'+row_id).html(out);
        }
      }
      return this;
    },

    html_rows: function() {
      var display = this.display;
      var out = new Object;

      for (var i=0; i<this.rows.length; i++) {
        var row_id = this.nrt0+i-display.top_row;
        if (row_id>=0 && row_id<display.rows) out[row_id] = this.html_row(i);
      }
      return out;
    },

    html_row: function(nrp) {
      var row = this.rows[nrp];
      var t = row.text;
      var out = '';
      var j = 0;
      while (j < t.length) {
        var style = this.style_at(j + row.op0);
        var spans = this.spans_at(j + row.op0);
        var next_j = (style.op1 < spans.op1 ? style.op1 : spans.op1 ) - row.op0 + 1;
        var t1 = t.substr(j, next_j-j);
        t1 = t1.replace(/&/g, '&amp;').replace(/[<]/g, "&lt;").replace(/[>]/g, "&gt;").replace(/\s/g, this.display.show_special ? '&middot;' : '&nbsp;');
        var classes = '';
        if (style.style) classes += style.style;
        if (spans.span_ids) {
          for (var k=0; k<spans.span_ids.length; k++) {
            if (classes.length) classes += ' ';
            classes += this.spans[ spans.span_ids[k] ].kind;
          }
        }
        out += (classes.length ? '<span class="cw-span '+classes+'">' : '<span>') + t1 + '</span>';
        j = next_j;
      }
      if (nrp == this.rows.length-1) out=out.replace(/\$<\/span>$/, this.display.show_special ? '&para;</span>' : '</span>');
      out = Array(this.row_padding(nrp)+1).join("&nbsp;") + out;
      if (this.ro) out = '<div class="cw-row-ro">'+out+'</div>';
      return out;
    },

    // update nrts (called from display.update_paragraphs)
    update: function() {
      if (this.hidden) {
        delete this.nrt0;
        delete this.nrt1;
        return;
      }
      let is_prev_para_unhidden = (this.npd > 0 && !this.display.paragraphs[this.npd-1].hidden);
      this.nrt0 = is_prev_para_unhidden ? this.display.paragraphs[ this.npd-1 ].nrt1 + 1 : 0;
      this.nrt1 = this.nrt0 + this.rows.length - 1;
    },

    optimize_styles: function() {
      var keys = Object.keys(this.styles).sort(function(a,b){return a-b});
      var last_style;
      for (var i=0; i<keys.length; i++) {
        var cur_style = this.styles[keys[i]];
        if (i > 0 && cur_style == last_style) delete this.styles[keys[i]];
        last_style = cur_style;
      }
      // remove style of the final '$' in the paragraph, if there are other styles
      //console.log('before: ', this.styles);
      if (this.text.length > 1 && this.styles[this.text.length-1] !== undefined) delete this.styles[this.text.length-1];
      //console.log('after: ', this.styles);
      return this;
    },

    add_span: function(span0) {
      var span = new CW.Span(span0, this);
      if (this.spans[span.id]) return;
      if (span.z_initiated < this.z0) return;
      if (span.z_initiated < this.z1 && this.edit_history) {
        for (var i=0; i<this.edit_history.length; i++) {
          var h = this.edit_history[i];
          if (h[0] > span.z_initiated) {
            span.adjust(h[1], h[2], h[3]);
          }
          if (span.deleted) return;
        }
      }
      span.z_displayed = this.display.z;
      this.spans[span.id] = span;
      this.display.spans[span.id] = span;
      this.display.draw_async();
      if (!span.spangroup) this.display.send_event('add_span', span.snapshot());
      else span.spangroup.spans_list.push(span);
      return span;
    },

    edit: function(offset, len, repl, repl_styles) {
      if (typeof repl == 'undefined') repl = '';
      if (typeof repl_styles == 'undefined') repl_styles = new Object;
      if (this.ro) return this;

      this.text = this.text.substr(0, offset) + repl + this.text.substr(offset+len);
      
      var s1 = this.style_at((len == 0 && offset > 0) ? offset-1 : offset);
      var s2 = this.style_at(offset+len);
      var new_styles = new Object;
      new_styles[offset] = s1.style;
      for (var o in repl_styles) {
        o = parseInt(o);
        new_styles[offset+o] = repl_styles[o];
      }
      new_styles[offset+repl.length] = s2.style;
      for (var o in this.styles) {
        o = parseInt(o);
        if (o<offset) new_styles[o]=this.styles[o];
        else if (o>offset+len) new_styles[o-len+repl.length]=this.styles[o];
      }
      this.styles = new_styles;
      this.optimize_styles();

      for (var id in this.spans) {
        this.spans[id].adjust(offset, len, repl.length);
      }
      
      var old_nrt1 = this.nrt1;
      this.render();
      if (this.nrt1 != old_nrt1) this.display.update_paragraphs(this.npd+1);
      
      this.touch();
      if (this.edit_history) this.edit_history.push([ this.display.z(), offset, len, repl.length ]);
      this.display.send_event('edit', { npd: this.npd, offset: offset, len: len, repl: repl, repl_styles: repl_styles });

      return this;
    },

    // paragraph changed - update z1
    touch: function() {
      this.z1 = this.display.z();
      this.update_stats();
      return this;
    },

    update_stats: function() {
      if (this.ro) return this;
      if (!this.display.stats)
        this.display.stats = { words: 0, chars: 0, nospaces: 0 };
      else if (this.stats) for (var o in this.stats) this.display.stats[o] -= this.stats[o];
      var txt = this.text.substr(0, this.text.length-1);
      this.stats = { words: CW.count_words(txt), chars: txt.length, nospaces: CW.count_nospaces(txt) };
      for (var o in this.stats) this.display.stats[o] += this.stats[o];
      return this;
    },

    set_align: function(new_align) {
      if (this.ro) return this;
      if (this.align != new_align) {
        this.display.send_event('align', { npd: this.npd, align: new_align });
        var offset = this.cursor_to_offset();
        this.align = new_align;
        //this.draw();
        this.offset_to_cursor(offset);
      }
      return this;
    },

    row_padding: function(nrp) {
      if (this.align=='left') return 0;
      else if (this.align=='right') return this.display.cols - this.rows[nrp].text.length;
      else if (this.align=='center') return parseInt((this.display.cols - this.rows[nrp].text.length)/2);
      return 0;
    },

    cursor_to_offset: function() {
      var display = this.display;
      var offset;
      var nrp = display.cur_row + display.top_row - this.nrt0;
      if (nrp<0) offset=0;
      else if (nrp>=this.rows.length) offset=this.text.length;
      else offset = this.rows[nrp].op0 + display.cur_col_shown() - this.row_padding(nrp);
      return offset;
    },

    offset_to_cursor: function(offset, scroll) {
      var display = this.display;
      var coords = this.offset_to_row_col(offset);
      if (coords) {
        display.cur_row = coords.row;
        display.cur_col = coords.col;
        display.move_cursor(scroll ? 's' : 'thaw');
      }
      return this;
    },

    offset_to_row_col: function(offset) {
      if (this.hidden) return false;
      var display = this.display;
      for (var i=0; i<this.rows.length; i++) {
        if (offset>=this.rows[i].op0 && offset<=this.rows[i].op1) {
          return { row: i + this.nrt0 - display.top_row, col: offset - this.rows[i].op0 + this.row_padding(i) };
        }
      }
      return false;
    },

    destroy: function() {
      if (this.deleted) return this;
      this.deleted = 1;
      if (this.stats && this.display.stats) for (var o in this.stats) this.display.stats[o] -= this.stats[o];
      CW.async(this);
      for (var o in this.spans) this.spans[o].destroy();
      return this;
    },

    block_change_styles: function(op0, op1, changes) {
      if (this.ro) return this;
      if (!this.styles[op0] && op0 >= 0) this.styles[op0] = this.style_at(op0).style;
      if (!this.styles[op1+1] && op1+1 <= this.text.length) this.styles[op1+1] = this.style_at(op1+1).style;
      for (var o in this.styles) {
        if (o >= op0 && o <= op1) {
          var arr = this.styles[o].split(' ');
          for (var o1 in changes) {
            CW.remove_from_array(arr, o1);
            if (changes[o1]) arr.push(o1);
          }
          arr.sort();
          CW.remove_from_array(arr, '');
          this.styles[o] = arr.join(' ');
        }
      }
      this.optimize_styles();
      this.display.send_event('block_change_styles', { npd: this.npd, op0: op0, op1: op1, changes: changes });
    },

  };


  /*** SPAN ********************************************************************/

  CW.Span = function(w, paragraph, spangroup) {
    CW.extend(this, w);
    this.paragraph = paragraph;
    this.display = paragraph.display;
    if (spangroup) {
      this.spangroup = spangroup;
      spangroup.spans.push(this);
    }
    delete this.npd; // it should not exist
    return this;
    // added to paragraph.spans and display.spans in add_span/create_span
  }

  CW.Span.prototype = {
    destroy: function(silent) {
      if (this.deleted) return this;
      this.deleted=1;
      CW.async(this);
      if (this.paragraph.spans && this.paragraph.spans[this.id]) delete this.paragraph.spans[this.id];
      if (this.paragraph.display.spans && this.paragraph.display.spans[this.id]) delete this.paragraph.display.spans[this.id];
      if (!silent) {
        this.display.draw_async();
        this.display.send_event('destroy_span', { id: this.id });
      }
      if (this.spangroup) this.spangroup.destroy(silent);
      return this;
    },

    adjust: function (op0, len, repl_len) {
      //console.log('adjusting span '+this.id);

      // cut to the right of span
      if (op0 > this.op1) return this;
      var op1 = op0+len;

      // cut to the left of span, simply adjust offsets
      if (op1 < this.op0) {
        this.op0 -= len-repl_len;
        this.op1 -= len-repl_len;
        return this;
      } 

      if (this.perishable) {
        this.destroy();
        return this;
      }

      // change within span
      if (op0 > this.op0 && op1 <= this.op1) {
        this.op1 -= len-repl_len;
        return this;
      }

      // span entirely within cut - remove span
      if (op0 <= this.op0 && op1 > this.op1) {
        this.destroy();
        return this;
      }

      // cut some chars at the beginning of span
      if (op0 <= this.op0) {
        this.op0=op1-len+repl_len;
        this.op1 -= len-repl_len;
      }

      // cut some chars at the end of span
      else if (op1 >= this.op1) {
        this.op1=op0-1;
      } else {
        // should not happen
      }

      return this;
    },

    snapshot: function() {
      return { id: this.id, pz0: this.paragraph.z0, op0: this.op0, op1: this.op1, kind: this.kind, message: this.message, perishable: this.perishable, exclusive: this.exclusive, source: this.source, z_initiated: this.z_initiated };
    }
  };

  /*** SPANGROUP ***************************************************************/

  CW.SpanGroup = function(w) {
    this.spans_list = new Array();
    CW.extend(this, w);
    return this;
  }

  CW.SpanGroup.prototype = {
    destroy: function(silent) {
      if (this.deleted) return this;
      this.deleted=1;
      CW.async(this);
      for (var i=0; i<this.spans_list.length; i++) this.spans_list[i].destroy(silent);
      return this;
    },
    snapshot: function() {
      return { kind: this.kind, message: this.message };
    }
  };


  /*** SOCKET ******************************************************************/

  CW.Socket = function (display) {
    this.display = display;
    this.channels = new Object();
    this.awaiting_ack = false;
  }

  CW.Socket.prototype = {
    channel: function(name) {
      if (!this.channels[name]) this.channels[name] = { z: 1, upstream: false };
      return this.channels[name];
    },

    upstream: function(name) {
      this.channels[name] = { z: 2, outbox: new Array(), upstream: true };
    },

    send: function(channel, msg) {
      var c = this.channel(channel);
      if (!c.upstream) return;
      var final_message = CW.extend({ z: this.channel(channel).z++, t: +new Date() }, msg);
      c.outbox.push(final_message);
      this.display.trigger_hooks(channel, final_message);
      this.dispatch();
    },
    
    send_noack: function(noack_channel, msg) {
      var to_send = { noack_channel: noack_channel, msg: msg };
      if (this.display.conn) {
        this.display.log('>>>', 'noack:'+noack_channel);
        this.display.conn.write(JSON.stringify(to_send));
      } else if (this.display.sockjs) {
        this.display.log('>>>', 'noack:'+noack_channel);
        this.display.sockjs.send(JSON.stringify(to_send));
      }
      this.display.trigger_hooks(noack_channel, msg);
    },

    dispatch: function(force) {
      if (this.awaiting_ack) return;
      var to_send = { ack: {} };
      var need_send = false;
      var can_ack = false;
      for (var o in this.channels) {
        if (this.channels[o].upstream) {
          if (this.channels[o].outbox.length) {
            to_send[o] = this.channels[o].outbox;
            need_send = true;
          }
        } else {
          to_send.ack[o] = this.channels[o].z;
          can_ack = true;
        }
      }

      if (!need_send && !force) return;
      if (force && !can_ack && !need_send) return;

      if (this.display.conn) {
        this.display.log('>>>', to_send);
        this.display.conn.write(JSON.stringify(to_send));
        if (need_send) this.awaiting_ack = true;
      } else if (this.display.sockjs) {
        this.display.log('>>>', to_send);
        this.display.sockjs.send(JSON.stringify(to_send));
        if (need_send) this.awaiting_ack = true;
      }
    },

    silence: function() {
      this.display.log('info', 'silence');
      if (this.display.conn) {
        this.display.log('info', 'conn.end()');
        this.display.conn.end();
      } else if (this.display.sockjs) {
        this.display.sockjs.close();
        this.display.log('info', 'sockjs.close()');
      } else {
        this.display.log('info', 'nothing here');
      }
    },

    destroy: function() {
      if (this.deleted) return;
      this.deleted = 1;
      CW.async(this);
      if (this.display.conn) {
        this.display.conn.end();
        this.display.conn = null;
      } else if (this.display.sockjs) {
        this.display.sockjs.close();
        this.display.sockjs = null;
      }
      this.display.socket = null;
    },

    on_data: function(data) {
      if (this.display.delays && this.display.delays.silence) CW.async(this, 'silence', this.display.delays.silence);
      this.last_activity = +new Date();

      if (this.display.sockjs) {
        if (this.display.delays.client_disconnect_warn) CW.async(this.display, 'disconnect_warn', this.display.delays.client_disconnect_warn);
        if (this.display.delays.client_disconnect_err) CW.async(this.display, 'disconnect_err', this.display.delays.client_disconnect_err);
        CW.async(this.display, 'disconnect_reset', 0);
      }
      
      if (data == 'goodbye') {
        this.display.log('<<<', 'goodbye; will shut down');
        this.display.shutdown();
        return;
      }
      if (data == 'ping') {
        this.display.log('<<<', 'ping; pong');
        if (this.display.conn) this.display.conn.write('pong'); else this.display.sockjs.send('pong');
        return;
      }
      if (data == 'pong') {
        this.display.log('<<<', 'pong');
        return;
      }
      var inbox = typeof data === 'string' ? JSON.parse(data) : data;

      if (inbox.noack_channel) {
        this.display.log('<<<', 'noack:'+inbox.noack_channel);
        this.display.process_message(inbox.noack_channel, inbox.msg);
        this.display.trigger_hooks(inbox.noack_channel, inbox.msg);
        return;
      }

      var ack = false;

      this.display.log('<<<', inbox); // data

      if (inbox.handshake) {
        this.display.process_handshake(inbox.handshake);
      }

      if (inbox.ack) {
        for (var o in inbox.ack) {
          var c = this.channel(o);
          var len=0;
          for (var i=0; i<c.outbox.length; i++) if (c.outbox[i].z <= inbox.ack[o]) len = i+1;
          if (len) c.outbox.splice(0, len);
        }
      }

      for (var channel in inbox) {
        if (CW.is_array(inbox[channel])) {
          ack = true;
          //console.log('processing inbox for channel '+channel);
          for (var i=0; i<inbox[channel].length; i++) {
            var msg = inbox[channel][i];
            if (msg.z == this.channel(channel).z + 1) {
              this.display.process_message(channel, msg);
              this.display.trigger_hooks(channel, msg);
              this.channel(channel).z++;
            } else if (msg.z > this.channel(channel).z + 1) {
              this.display.shutdown();
              return;
            }
          }
        }
      }

      this.awaiting_ack = false;
      this.dispatch(ack);
      this.display.draw_statusbar();

      // heartbeats are sent from the server only
      if (this.display.conn && this.display.delays && this.display.delays.heartbeat) CW.async(this, 'heartbeat', this.display.delays.heartbeat);
    },

    heartbeat: function(data) {
      if (this.display.conn) { // from the server only
        this.display.log('>>>', 'ping');
        this.display.conn.write('ping');
        if (this.display.delays.heartbeat) CW.async(this, 'heartbeat', this.display.delays.heartbeat);
        if (this.display.delays.silence) CW.async(this, 'silence', this.display.delays.silence);
      }
    },

    handshake: function(data) {
      this.awaiting_ack = false;
      if (this.display.sockjs) {
        this.display.sockjs.send(JSON.stringify(data));
        this.awaiting_ack = true;
      }
    }
  };

  // Initialization /////////////////////////////////////////////////////////////

  // NodeJS: export CW
  if (typeof window === 'undefined') {
    module.exports = CW; return;
  }

  window.CW = CW;

  var jquery_fn_factory = function(attrib_name, entity_name) {
    var fn = function(config) {
      if (!config) config = {};
      var old;
      if (old = $(this).data(attrib_name)) {
        CW.extend(old, config);
        return old;
      }
      CW.extend(config, {
        id: $(this).attr('id')||'default',
        container: $(this)
      });
      var object = new CW[entity_name](config);
      $(this).data(attrib_name, object);
      $(this).bind('destroyed', function() {
        console.log('destroy');
        object.destroy();
      });
      return object;
    };
    return fn;
  }

  // Client-side initialization

  $.fn.CW_display = jquery_fn_factory('cw-display', 'Display');
  $.fn.CW_viewer = jquery_fn_factory('cw-viewer', 'Viewer');

  // Dashed lines
  // from: http://stackoverflow.com/questions/4576724/dotted-stroke-in-canvas
  var CP = window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype;
  if(CP && CP.lineTo) CP.dashedLine = function(x, y, x2, y2, dashArray){
      if(! dashArray) dashArray=[2,2];
      var dashCount = dashArray.length;
      var dx = (x2 - x);
      var dy = (y2 - y);
      var xSlope = (Math.abs(dx) > Math.abs(dy));
      var slope = (xSlope) ? dy / dx : dx / dy;

      this.moveTo(x, y);
      var distRemaining = Math.sqrt(dx * dx + dy * dy);
      var dashIndex = 0;
      while(distRemaining >= 0.1){
          var dashLength = Math.min(distRemaining, dashArray[dashIndex % dashCount]);
          var step = Math.sqrt(dashLength * dashLength / (1 + slope * slope));
          if(xSlope){
              if(dx < 0) step = -step;
              x += step
              y += slope * step;
          }else{
              if(dy < 0) step = -step;
              x += slope * step;
              y += step;
          }
          this[(dashIndex % 2 == 0) ? 'lineTo' : 'moveTo'](x, y);
          distRemaining -= dashLength;
          dashIndex++;
      }
  }

  // from http://jmvcsite.heroku.com/pluginify?plugins[]=jquery/dom/destroyed/destroyed.js
  var oldClean = jQuery.cleanData;

  $.cleanData = function( elems ) {
    for ( var i = 0, elem; (elem = elems[i]) !== undefined; i++ ) {
      $(elem).triggerHandler("destroyed");
      //$.event.remove( elem, 'destroyed' );
    }
    oldClean(elems);
  };

})();
