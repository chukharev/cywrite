// Uses GazePoint GP3
(function(CW) {

  var UDP_PORT = '4244'
  var UDP_IP = '127.0.0.1'

  var gui = require('nw.gui'), fs=require('fs'), child_process=require('child_process'), net = require('net');

  function read_tag(xml, cb) {
    if (!xml) return '';
    var hash = {};
    var tag_name;
    return xml.replace(/[\r\n]*(<.+?>)[\r\n]*/g, function(tag) { 
      tag_name = tag.match(/<(\w+)/);
      tag_name = tag_name ? tag_name[1].toUpperCase() : '';
      var reg = new RegExp(/(\w+)=\"(.+?)\"/g);
      var res;
      while (( res = reg.exec(tag)) !== null) {
        var val = res[2];
        if (!res[2].match(/[^\d.]/)) val = Number(val);
        hash[res[1].toLowerCase()] = val;
      }
      cb(tag_name, hash);
      return '';
    })
  }

  function _shuffle(a) {
    var j, x, i;
    for (i = a.length; i; i--) {
      j = Math.floor(Math.random() * i);
      x = a[i - 1];
      a[i - 1] = a[j];
      a[j] = x;
    }
  }

  CW.Track = function(w) {
    CW.extend(this, w);

    this.status = 'off';

    that = this;

    var monitor = require('active-window');
    monitor.getActiveWindow(function(w) {
      if (that.display) that.display.active_window = w;
    }, -1, 1);

    try {
      var settings = fs.readFileSync('cytrack_settings.json');
      if (settings) {
        settings = JSON.parse(settings);
        for (el in settings) if (!(el in this)) this[el] = settings[el]; // only allow overriding settings that are not set
      }
    } catch(e) {
    }

    return this;
  }

  CW.Track.prototype = {
    attach: function(display) {
      this.display = display;
      var that = this;

      if (this.display_settings) CW.extend(this.display, this.display_settings);

      this.display.log = function() {
        var out = Array();
        for (var i=0; i<arguments.length; i++) {
          out.push(JSON.parse(JSON.stringify(arguments[i])));
        }
        console.log.apply(console, out);
        try {
          fs.appendFileSync('sessions/'+that.display.token+'.log', JSON.stringify(out) + "\n");
        } catch(e) {
        }
      }
      
      this.status = 'off';
      this.display.toolbar.prepend('<div class="btn-group"><button type="button" class="btn btn-default fa fa-eye"></button><button type="button" class="btn btn-danger cw-btn-start">Begin Session</button></div>');
      this.display.track = this;
      
      var scrollbar = this.display.container.find('.cw-scrollbar');
      scrollbar.css('background-color', 'black');

      this.button = this.display.toolbar.find('.fa-eye');
      var that=this;
      this.button.click(function() { that.btn_clicked() });
      this.display.toolbar.find('.cw-btn-start').click(function(){
        that.display.send_event('start');
        var scrollbar = that.display.container.find('.cw-scrollbar');
        scrollbar.css('background-color', 'transparent');
        that.display.session_started = +new Date();
        $('.cw-btn-start').hide();
      });

      this.win = gui.Window.get();

      this.win.maximize();
      this.button.click();

      that.display.font_size = 35;
      that.display.interline = 26;
      that.display.resize();
    },

    gp_send: function() {
      if (this.gp_socket) for (var i=0; i<arguments.length; i++) this.gp_socket.write(arguments[i]+"\r\n");
      return this;
    },

    shutdown: function() {
      if (this.gp_socket) this.gp_socket.end();
      if (this.udp_server) {
        this.udp_server.close();
        this.udp_server.unref();
      }
      gui.App.quit();
    },

    gp_connect: function() {
      var that=this;
      if (this.gp_socket) return;
      this.gp_socket = net.createConnection(4242, 'localhost');
      that.gp_progress();
      this.gp_socket.on('connect', function() { that.gp_connected() })
      .on('error', function() {
        delete that.gp_socket;
        console.log('************** Gazepoint is starting now...');

        if (that.gp_cam_update_rate) {
          var reg_command = 'reg add "HKCU\\SOFTWARE\\Gazepoint-GazeTechnologyPlatform\\Gazepoint\\GazepointProfileID" /v "_cam_update_rate" /t REG_SZ /d "'+that.gp_cam_update_rate+'" /f';
          child_process.exec(reg_command);
        }

        var exec_path = '\\gazepoint\\gazepoint\\bin\\gazepoint.exe';
        var exec_path_64 = '\\gazepoint\\gazepoint\\bin64\\gazepoint.exe';
        var try_path = function(path, next) { fs.exists(path, function(yes) { if (yes) { child_process.execFile(path); CW.async(that, 'gp_connect', 10000); } else if (next) next(); return; });};
        if (process.env['ProgramFiles(x86)']) try_path(process.env['ProgramFiles(x86)'] + exec_path, function() {
          try_path(process.env['ProgramFiles(x86)'] + exec_path_64, function() { that.gp_failed(); });
          //if (process.env['ProgramFiles']) try_path(process.env['ProgramFiles'] + exec_path, function() { that.gp_failed(); });
        });
      });
    },

    gp_progress: function() {
      this.status='wait';
      this.button.removeClass('btn-default btn-success').addClass('btn-info');
    },

    gp_connected: function() {
      var that=this;
      var w = gui.Window.get();
      //w.show();
      //w.focus();
      this.status = 'connected';
      this.button.removeClass('btn-info btn-default').addClass('btn-success');
      this.gp_socket.on('close', function() { that.gp_failed(); }).on('data', function(d) { that.gp_data(d) });
      that.display.socket.send('eye', { k: 'tracker', data: { system: 'gazepoint' } });
      if (this.gp_screen_size) {
        this.gp_send('<SET ID="SCREEN_SIZE" X="'+this.gp_screen_size.x+'" Y="'+this.gp_screen_size.y+'" WIDTH="'+this.gp_screen_size.width+'" HEIGHT="'+this.gp_screen_size.height+'" />');
      }
        
      this.gp_send(
        '<SET ID="IMAGE_TX" ADDRESS="'+UDP_IP+'" PORT="'+UDP_PORT+'" />',
        '<SET ID="ENABLE_SEND_IMAGE" STATE="1" />',
        '<SET ID="ENABLE_SEND_TIME" STATE="1" />',
        '<SET ID="ENABLE_SEND_POG_FIX" STATE="1" />',
        '<SET ID="ENABLE_SEND_POG_BEST" STATE="1" />',
        '<SET ID="ENABLE_SEND_DATA" STATE="1" />',
        '<GET ID="CALIBRATE_RESULT_SUMMARY" />',
        '<GET ID="SCREEN_SIZE" />'
      );
    },

    gp_failed: function() {
      this.status = 'off';
      this.button.removeClass('btn-success btn-info').addClass('btn-default');
      delete this.gp_socket;
    },

    gp_calc_fixation: function(fix, prefix) {
      if (!this.screen_size || !this.screen_delta) return;
      var x = (fix[prefix+'pogx'] * this.screen_size.width) + this.screen_size.x;
      x += this.screen_delta.x - this.win.x;
      var y = (fix[prefix+'pogy'] * this.screen_size.height) + this.screen_size.y;
      y += this.screen_delta.y - this.win.y;
      return (this.display.mouse_xy(this.display.viewport, {clientX: x, clientY: y}));
    },

    timeout_calibrating: function() {
      this.is_calibrating = false;
      this.app_calibration = false;
      this.display.socket.send('eye', { k: 'cal_timeout' });
    },
      
    gp_process_data: function() {
      var that=this;

      const write_eye_event_to_file = function(event) {
        delete event.cur_row;
        delete event.cur_col;
        event.t = Date.now();
        fs.appendFileSync('sessions/'+that.display.token+'.eye', JSON.stringify(event) + "\n");
      }

      this.gp_buffer = read_tag(this.gp_buffer, function(tag_name, values) {
        if (values.time) {
          var d = +new Date();
          d/=1000;
          var diff = d-values.time;
        }

        if (tag_name == 'CAL' && values.id == 'CALIB_RESULT') {
          that.is_calibrating = false;
          that.has_calibrated = true;
          that.gp_send('<GET ID="CALIBRATE_RESULT_SUMMARY" />', '<GET ID="SCREEN_SIZE" />');
          CW.async(that, 'timeout_calibrating');
        } else if (tag_name == 'CAL' && values.id == 'CALIB_START_PT') {
          if (!that.is_calibrating) {
            that.display.socket.send('eye', { k: 'cal_start' });
            that.is_calibrating=true;
          }
          CW.async(that, 'timeout_calibrating', 10000);
        } else if (tag_name == 'ACK' && values.id == 'CALIBRATE_RESULT_SUMMARY') {
          that.calibration = values;
          if (that.has_calibrated) {
            if (that.app_calibration && that.gp_auto_accept) {
              that.gp_send('<SET ID="CALIBRATE_SHOW" STATE="0" />');
              that.gp_send('<SET ID="TRACKER_DISPLAY" STATE="0" TRAY="1" />');
              if (values.ave_error <= that.gp_auto_accept) {
                bootbox.alert('<div style="text-align:center;"><div style="font-size:100px;"><i class="fa fa-smile-o"></i></div><div style="font-size:30px;"><b>Calibration complete</b> ('+values.ave_error+')</div><p>Now get ready to begin your writing task<p>Click "OK" to start</div>', function() { setTimeout(function() {$('.cw-btn-start').click();}, 0) });
              } else {
                bootbox.dialog({ title: 'Calibration complete', message: '<div style="text-align:center;">The calibration procedure needs to be repeated. (If you have already tried calibration more than once, and you keep getting this message, please ask the researcher for help.)<div style="font-size: 75px;">'+values.ave_error+'</div><p>Make sure that you can see the reflection of your nose in the eye-tracker below the screen. Click "Repeat" to repeat the calibration procedure, and make sure to closely watch the moving circle.',
                buttons: {
                  retry: { label: "Repeat", className: "btn-success", callback: function() { that.gp_btn_clicked() } }
                }});
              }
            } else
              bootbox.alert('<div style="text-align:center;">Calibration completed<div style="font-size: 100px;">'+values.ave_error+'</div></div>');
            that.app_calibration = false;
          }
          var d0 = CW.extend({}, { k: 'cal', data: values });
          delete that.gp_last_s;
          that.display.socket.send('eye', d0);
        } else if (tag_name == 'ACK' && values.id == 'SCREEN_SIZE') {
          that.screen_size = values;
        } else if (tag_name == 'REC' && that.calibration && that.screen_size && that.screen_delta) {
          if ('bpogx' in values && !(that.gp_sample_throttle && that.gp_sample_throttle <= -2)) {
            var is_ignore = 0;
            if (!that.gp_last_s) that.gp_last_s = 0;
            if (that.gp_sample_throttle && that.gp_sample_throttle > -1 && values.time > that.gp_last_s && values.time - that.gp_last_s < that.gp_sample_throttle/1000) is_ignore = 1;
            else that.gp_last_s = values.time;

            if (values.bpogv) {
              fix = that.gp_calc_fixation(values, 'b');
              CW.extend(fix, { k: 's', start: parseInt(values.time * 1000) });
              if (is_ignore) write_eye_event_to_file(fix);
              else that.display.socket.send('eye', fix);
            } else {
              fix = { k: 's', x: -10000, y: -10000, start: parseInt(values.time * 1000) };
              if (is_ignore) write_eye_event_to_file(fix);
              else that.display.socket.send('eye', fix);
            }
          }
          
          if ('fpogid' in values) {
            if ((!that.fixation && values.fpogv) || (that.fixation && !values.fpogv)) {
              var fix;
              if (that.fixation) {
                fix = that.gp_calc_fixation(that.fixation, 'f');
                CW.extend(fix, { k: 'end', start: parseInt(values.fpogs * 1000), dur: parseInt(values.fpogd * 1000) });
                that.display.socket.send('eye', fix);
                delete that.fixation;
                //console.log("END");
              } else {
                that.fixation = values;
                fix = that.gp_calc_fixation(values, 'f');
                CW.extend(fix, { k: 'fix', start: parseInt(values.fpogs * 1000) });
                that.display.socket.send('eye', fix);
                //console.log("FIX");
              }
            }
            /*if (values.fpogv && values.fpogd && that.fixation) {
              that.fixation.fpogd = values.fpogd;
            }*/
          }
        }
      });
    },

    gp_data: function(d) {
      var str = d.toString();
      if (!"gp_buffer" in this) this.gp_buffer = '';
      this.gp_buffer = this.gp_buffer + str;
      this.gp_process_data();
    },
    
    gp_image_data: function(d) {
      const now = Date.now();
      if (this.gp_image_throttle && now - (this.gp_last_image||0) < this.gp_image_throttle) return;
      this.gp_last_image = now;
      this.display.socket.send_noack('img', { b: d.toString('base64', 8), k: 'gazepoint' });
      
      //alert(d.toString('base64', 8).length);
    },

    gp_btn_clicked: function() {
      var that = this;
      if (!this.udp_server) {
        var dgram = require('dgram');
        var server = dgram.createSocket('udp4');

        server.on('listening', function () {
          var address = server.address();
          console.log('UDP Server listening on ' + address.address + ":" + address.port);
        });

        var last_time = new Date();
        server.on('message', function (message, remote) {
          //console.log(remote.address + ':' + remote.port +' - UDP received - '+message.length);
          if (new Date() - last_time > 1000) {
            that.gp_image_data(message);
            last_time = new Date();
          }
        });

        server.bind(UDP_PORT, UDP_IP);
        this.udp_server = server;
      }

      if (this.status == 'off') this.gp_connect();
      else if (this.status == 'connected') {
        delete this.screen_size;
        delete this.calibration;
        this.gp_send('<SET ID="CALIBRATE_CLEAR" />');
        var a = [
        '<SET ID="CALIBRATE_ADDPOINT" X="0.1" Y="0.1" />',
        '<SET ID="CALIBRATE_ADDPOINT" X="0.5" Y="0.1" />',
        '<SET ID="CALIBRATE_ADDPOINT" X="0.9" Y="0.1" />',
        '<SET ID="CALIBRATE_ADDPOINT" X="0.9" Y="0.5" />',
        '<SET ID="CALIBRATE_ADDPOINT" X="0.5" Y="0.5" />',
        '<SET ID="CALIBRATE_ADDPOINT" X="0.1" Y="0.5" />',
        '<SET ID="CALIBRATE_ADDPOINT" X="0.1" Y="0.9" />',
        '<SET ID="CALIBRATE_ADDPOINT" X="0.5" Y="0.9" />',
        '<SET ID="CALIBRATE_ADDPOINT" X="0.9" Y="0.9" />'
        ];
        _shuffle(a);
        this.gp_send.apply(this, a);
        this.gp_send('<SET ID="CALIBRATE_SHOW" STATE="1" />', '<SET ID="CALIBRATE_START" STATE="1" />');
        this.app_calibration = true;
      }
    },

    el_btn_clicked: function() {
      if (this.status == 'off') this.el_connect();
      else if (this.status == 'connected') {
        if (!that.is_calibrating) {
          that.is_calibrating=true;
          that.el_send('calibrate');
          that.display.socket.send('eye', { k: 'cal_start' });
        }
      }
    },

    el_progress: function() {
      this.status='wait';
      this.button.removeClass('btn-default btn-success').addClass('btn-info');
    },

    el_send: function(what) {
      if (this.el_socket) this.el_socket.send(what);
      return this;
    },

    el_calc_fixation: function(arr) {
      if (!this.screen_delta) return;
      var x = parseInt(arr[3]);
      x += this.screen_delta.x - this.win.x;
      var y = parseInt(arr[4]);
      y += this.screen_delta.y - this.win.y;
      return (this.display.mouse_xy(this.display.viewport, {clientX: x, clientY: y}));
    },

    el_data: function(data) {
      var that=this;

      var arr = data.split(','); // 0-kind,1-t0,2-t9,3-x,4-y

      if (arr[0] === 'timeOffset') {
        that.display.socket.send('eye', {k:'time_offset', start: arr[1], data: { timestamp: arr[2], offset: arr[3] }});
      } else if (arr[0] === 'startFixation') {
        var fix;
        fix = that.el_calc_fixation(arr);
        if (fix) {
          CW.extend(fix, {k:'fix', start: arr[1]});
          that.display.socket.send('eye', fix);
        }
      } else if (arr[0] === 'endFixation') {
        var fix;
        fix = that.el_calc_fixation(arr);
        if (fix) {
          CW.extend(fix, {k:'end', start: arr[1], dur: arr[2]-arr[1]});
          that.display.socket.send('eye', fix);
        }
      } else if (arr[0] === 'currentLocation') {
        var fix;
        fix = that.el_calc_fixation(arr);
        if (fix) {
          CW.extend(fix, {k:'s', start: arr[1]});
          that.display.socket.send('eye', fix);
        }
      } else if (arr[0] === 'calibrationComplete') {
        that.is_calibrating = false;
        that.display.socket.send('eye', { k: 'cal', data: { message: arr[1] } });
        //bootbox.alert('<div style="text-align:center;">Calibration completed<div style="font-size: 50px;">'+arr[1]+'</div></div>');
      }
    },

    el_connected: function() {
      var that=this;
      //var w = gui.Window.get();
      //w.show();
      //w.focus();
      // that.el_send('token,'+that.display.token.slice(-8));
      var tkns = that.display.token.split('-');
      var tkn = tkns[1];
      that.el_send('token,'+tkn);
      that.el_send('start');
      this.status = 'connected';
      this.button.removeClass('btn-info btn-default').addClass('btn-success');
      this.el_socket.addEventListener('message', function(message) { that.el_data(message.data); });
    },

    el_connect: function() {
      var that=this;
      if (this.el_socket) return;
      this.el_socket = new WebSocket("ws://localhost:3000");

      that.el_progress();
      this.el_socket.addEventListener('open', function() {
        that.el_connected();
        that.display.socket.send('eye', { k: 'tracker', data: { system: 'eyelink' } });
      });
      this.el_socket.addEventListener('close', function() {
        that.display.socket.send('eye', { k: 'tracker', data: { system: 'eyelink', event: 'disconnected' } });
        delete that.el_socket;
        window.alert("Connection to EyeLink lost");
        that.status = 'off';
      });
      this.el_socket.addEventListener('error', function() {
        delete that.el_socket;
        window.alert("Could not connect to EyeLink");
        that.status = 'off';
      });
    },

    mouse_handler: function(e) {
      var dx = this.win.x + e.clientX - e.screenX;
      var dy = this.win.y + e.clientY - e.screenY;
      if (!this.screen_delta || dx !== this.screen_delta.x || dy !== this.screen_delta.y) {
        this.screen_delta = { x: dx, y: dy };
        this.display.socket.send('eye', { k: 'screen_delta', data: this.screen_delta });
      }
    },

    btn_clicked: function() {
      if (this.tracker_system === 'gazepoint') this.gp_btn_clicked();
      else if (this.tracker_system === 'eyelink') this.el_btn_clicked();
      else window.alert("No eyetracker system is configured. See cytrack_settings.js.");
    },
  };

})(CW);
