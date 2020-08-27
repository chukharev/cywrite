// CyTrack module
// See LICENSE.txt
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
    //CW.extend(this, w);

    this.status = 'off';

    that = this;

    var monitor = require('active-window');
    monitor.getActiveWindow(function(w) {
      if (that.display) that.display.active_window = w;
    }, -1, 1);

    return this;
  }

  CW.Track.prototype = {
    attach: function(display) {
      this.display = display;
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
      if (this.socket) for (var i=0; i<arguments.length; i++) this.socket.write(arguments[i]+"\r\n");
      return this;
    },

    shutdown: function() {
      if (this.socket) this.socket.end();
      if (this.udp_server) {
        this.udp_server.close();
        this.udp_server.unref();
      }
      gui.App.quit();
    },

    gp_connect: function() {
      var that=this;
      if (this.socket) return;
      this.socket = net.createConnection(4242, 'localhost');
      that.gp_progress();
      this.socket.on('connect', function() { that.gp_connected() })
      .on('error', function() {
        delete that.socket;
        console.log('************** Gazepoint is starting now...');
        var exec_path = '\\gazepoint\\gazepoint\\bin\\gazepoint.exe';
        var try_path = function(path, next) { fs.exists(path, function(yes) { if (yes) { child_process.execFile(path); CW.async(that, 'gp_connect', 10000); } else if (next) next(); return; });};
        if (process.env['ProgramFiles(x86)']) try_path(process.env['ProgramFiles(x86)'] + exec_path, function() {
          if (process.env['ProgramFiles']) try_path(process.env['ProgramFiles'] + exec_path, function() { that.gp_failed(); });
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
      this.socket.on('close', function() { that.gp_failed(); }).on('data', function(d) { that.gp_data(d) });
      this.gp_send(
        '<SET ID="IMAGE_TX" ADDRESS="'+UDP_IP+'" PORT="'+UDP_PORT+'" />',
        '<SET ID="ENABLE_SEND_IMAGE" STATE="1" />',
      '<SET ID="ENABLE_SEND_TIME" STATE="1" />', '<SET ID="ENABLE_SEND_POG_FIX" STATE="1" />', '<SET ID="ENABLE_SEND_DATA" STATE="1" />', '<GET ID="CALIBRATE_RESULT_SUMMARY" />', '<GET ID="SCREEN_SIZE" />');
    },

    gp_failed: function() {
      this.status = 'off';
      this.button.removeClass('btn-success btn-info').addClass('btn-default');
      delete this.socket;
    },

    gp_calc_fixation: function(fix) {
      if (!this.screen_size || !this.screen_delta) return;
      var x = parseInt(fix.fpogx * this.screen_size.width) + this.screen_size.x;
      x += this.screen_delta.x - this.win.x;
      var y = parseInt(fix.fpogy * this.screen_size.height) + this.screen_size.y;
      y += this.screen_delta.y - this.win.y;
      return (this.display.mouse_xy(this.display.viewport, {clientX: x, clientY: y}));
    },

    timeout_calibrating: function() {
      this.is_calibrating = false;
      this.display.socket.send('eye', { k: 'cal_timeout' });
    },
      
    gp_process_data: function() {
      var that=this;

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
            bootbox.alert('<div style="text-align:center;">Calibration completed<div style="font-size: 100px;">'+values.ave_error+'</div></div>');
          }
          var d0 = CW.extend({}, { k: 'cal', data: values });
          that.display.socket.send('eye', d0);
        } else if (tag_name == 'ACK' && values.id == 'SCREEN_SIZE') {
          that.screen_size = values;
        } else if (tag_name == 'REC' && that.calibration && that.screen_size && that.screen_delta) {
          if (!that.fixation || that.fixation.fpogid != values.fpogid) {
            var fix;
            if (that.fixation) {
              fix = that.gp_calc_fixation(that.fixation);
              CW.extend(fix, { k: 'end', start: parseInt(that.fixation.fpogs * 1000), dur: parseInt(that.fixation.fpogd * 1000) });
              that.display.socket.send('eye', fix);
              delete that.fixation;
            }
            if (values.fpogv) {
              that.fixation = values;
              fix = that.gp_calc_fixation(values);
              CW.extend(fix, { k: 'fix', start: parseInt(that.fixation.fpogs * 1000) });
              that.display.socket.send('eye', fix);
            }
          }
          if (values.fpogv && values.fpogd && that.fixation) {
            that.fixation.fpogd = values.fpogd;
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
      this.display.socket.send('img', { b: d.toString('base64', 8), k: 'GP3' });
    },

    mouse_handler: function(e) {
      this.screen_delta = { x: this.win.x + e.clientX - e.screenX, y: this.win.y + e.clientY - e.screenY };
    },

    btn_clicked: function() {
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

      }
    }
  };

})(CW);
