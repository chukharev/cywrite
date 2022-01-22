// CyWrite viewer module
// See LICENSE.txt
(function() {

  /*** VIEWER ******************************************************************/

  CW.Viewer = function (p) {
    CW.extend(this, {
      active: true,
      font_size: 12,
      interline: 8,
      fb_width: 300,
      margin: 10,
      font_family: 'Courier New, Monaco, Consolas, Lucida Console'
    }, p);

    this.data = {};
    this.init();
    if (this.role === 'research') this.research_connect(); else this.connect();
  }

  CW.Viewer.prototype = {
    research_connect: function() {
      var that=this;
      $.getJSON('/api/research/session/'+this.token, function(x) {
        if (x.ready) that.research_run();
        else {
          var pct = parseInt(x.progress * 100);
          $('.progress-bar').width(pct + '%');
          $('.progress-bar>span').html(pct + '%');
          setTimeout(function() { that.research_connect() }, 1000);
        }
      });
    },

    research_metrics: {
      eyf: { color: 'yellow', title: 'Eye fixation', mode: 'process' },
      cur: { color: '#ff0000', title: 'Cursor location', mode: 'process' },
      top: { color: '#ffaaaa', title: 'Top-left corner of screen', mode: 'process' },
      prc: { color: '#0000ff', title: 'Length of text + deletions (process-1)', mode: 'process' },
      typ: { color: '#aaaaff', title: 'Number of typed characters (process-2)', mode: 'process' },
      prd: { color: '#00ff00', title: 'Length of text (product)', mode: 'process' }, // 00ff00

/*      eyf: { color: '#ff0000', title: 'Eye fixation', mode: 'process' },
      prd: { color: '#0000ff', title: 'Length of text (product)', mode: 'process' }, // 00ff00*/

      dtyp: { color: '#dddddd', title: 'Formulation', mode: 'differential' }, //differential
      aeyf: { color: 'green', title: 'Evaluation', mode: 'differential' },
      drem: { color: '#ff0000', title: 'Revision', mode: 'differential' },
      aeyp: { color: 'blue', title: 'Task Definition', mode: 'differential' },

      eye_fixations: { title: 'Eye fixations', icon: 'fa fa-eye' },
      eye_movements: { title: 'Eye movements', icon: 'fa fa-eye' }
    },

    research_mode: 'process',

    research_play_speed: 0,

    research_z_to_t: function(z) {
      for (var i=0; i<this.all_data.length; i++) {
        if (this.all_data[i].z >= z) {
          return this.all_data[i].t;
        }
      }
    },
    
    research_z_to_interval: function(z) {
      for (var i=0; i<this.intervals.length; i++) {
        if (this.intervals[i] >= z) {
          return i;
        }
      }
    },

    research_jump_to: function(where) {
      if (/^\d+$/.test(where)) {
        var z = parseInt(where);
        for (var i=0; i<this.all_data.length; i++) {
          if (this.all_data[i].z >= z) {
            this.current_t = this.all_data[i].t;
            break;
          }
        }
      } else {
        var sp = where.split(':');
        sp.reverse();
        var seconds = parseInt(sp[0]||0) + 60*parseInt(sp[1]||0) + 60*parseInt(sp[2]||0);
        this.current_t = seconds*1000;
      }
    },

    research_run: function() {
      var that=this;
      $('.progress-bar').width('100%');
      $('.progress-bar>span').html('One moment, please...');
      $.getJSON('/api/research/session/'+this.token+'/data', function(data) {
        var x = data.frames;
        that.summary = data.summary;
        that.html = data.html;
        that.chars_seq = data.chars_seq;
        that.intervals = data.intervals;
        var last = {};
        that.lines = { }; that.line_colors = [];
        for (var o in that.research_metrics) {
          if (that.research_metrics[o].color) {
            that.lines[o] = [];
            that.line_colors.push(that.research_metrics[o].color);
          }
        }
        var overshadow=false;
        var last_values = {};
        var was_overshadow = false;
        for (var i=0; i<x.length; i++) {
          x[i].r = {};
          if (x[i].d.focus && x[i].d.focus.is_focused === false || x[i].d.eye && x[i].d.eye.is_calibrating) overshadow=true;
          if (x[i].d.focus && x[i].d.focus.is_focused === true || x[i].d.eye && x[i].d.eye.is_calibrating === false) overshadow=false;

          if (overshadow) for (var o in that.lines) {
            that.lines[o].push(null);
          }

          for (var o in x[i].d) last[o] = i;
          for (var o in last) if (last[o] < i) x[i].r[o] = last[o];
          for (var o in that.lines) {
            if (o in x[i].d) {
              last_values[o] = x[i].d[o]; //overshadow ? 0 : 
            }
            if (!overshadow && (o in x[i].d || was_overshadow)) that.lines[o].push([x[i].t/60000, last_values[o]]);
          }
          was_overshadow = overshadow;
        }
        for (var o in last_values) {
          that.lines[o].push([x[x.length-1].t/60000+1, last_values[o]]);
        }
        that.all_data = x;
        that.current_t = 0;
        that.current_i = 0;
        CW.async(that, 'research_render', 0);
        $('.progress').remove();
        that.toolbar.addClass('cw-toolbar-graph');
        that.toolbar.append('<div id="cw-ps-toolbar"></div><div id="cw-ps-graph"></div>');
        that.ps_toolbar = $('#cw-ps-toolbar');
        $("#cw-ps-graph").bind("plotclick", function (event, pos, item) {
          that.current_t = parseInt(pos.x * 60000);
          CW.async(that, 'research_render', 1);
        });

        var apnd = '<div class="dropdown" style="float: left;"><button class="btn btn-danger dropdown-toggle" type="button" data-toggle="dropdown">Metrics <span class="caret"></span></button>'+
        '<ul class="dropdown-menu">';
        for (var o in that.research_metrics) {
          var dspl = that.research_metrics[o].hidden ? ' style="display: none;"' : '';
          apnd += '<li><a href="#" class="cw-ps-a-metric" data-metric="'+o+'">'+
          (that.research_metrics[o].color ? '<span class="glyphicon glyphicon-minus" style="color: '+that.research_metrics[o].color+'"></span>' : '') +
          (that.research_metrics[o].icon ? '<span class="'+that.research_metrics[o].icon+'"></span>' : '') +
          ' '+that.research_metrics[o].title+
          ' <span class="glyphicon glyphicon-ok"'+dspl+'></span>' +
          '</a></li>';
        }

        apnd += '</ul></div>';
        that.ps_toolbar.append(apnd);
        that.ps_toolbar.append('<div class="btn-group" role="group" style="float:left; margin-left:10px;">'+
          '<button type="button" class="btn btn-default cw-btn-play cw-btn-play--10" data-play="-10"><i class="fa fa-backward"></i></button>'+
          '<button type="button" class="btn btn-primary cw-btn-play cw-btn-play-0" data-play="0"><i class="fa fa-pause"></i></button>'+
          '<button type="button" class="btn btn-default cw-btn-play cw-btn-play-05" data-play="0.5">0.5x <i class="fa fa-play"></i></button>'+
          '<button type="button" class="btn btn-default cw-btn-play cw-btn-play-1" data-play="1"><i class="fa fa-play"></i></button>'+
          '<button type="button" class="btn btn-default cw-btn-play cw-btn-play-2" data-play="2">2x <i class="fa fa-forward"></i></button>'+
          '<button type="button" class="btn btn-default cw-btn-play cw-btn-play-3" data-play="3">3x <i class="fa fa-forward"></i></button>'+
          '<button type="button" class="btn btn-default cw-btn-play cw-btn-play-10" data-play="10">10x <i class="fa fa-forward"></i></button>'+
          '<button type="button" class="btn btn-default cw-btn-play cw-btn-play-20" data-play="20">20x <i class="fa fa-forward"></i></button>'+
          '<button type="button" class="btn btn-default cw-btn-backward"><i class="fa fa-step-backward"></i></button>'+
          '<button type="button" class="btn btn-default cw-btn-forward"><i class="fa fa-step-forward"></i></button>'+
          '<button type="button" class="btn btn-default cw-btn-find"><i class="fa fa-search"></i></button>'+
        '</div>');
        that.ps_toolbar.append('<div class="dropdown" style="float:left; margin-left:10px;">'+
          '<button type="button" class="btn btn-primary" data-toggle="dropdown">View <span class="caret"></span></button>'+
          '<ul class="dropdown-menu">'+
          '<li><a href="#" class="cw-ps-a-view-summary">Summary</li>'+
          '<li><a href="#" class="cw-ps-a-view-html-final">Final text</li>'+
          '<li><a href="#" class="cw-ps-a-view-mode" id="cw-menu-process" data-mode="process"><u>P</u>rocess graph</li>'+
          '<li><a href="#" class="cw-ps-a-view-mode" id="cw-menu-differential" data-mode="differential"><u>D</u>ifferential graph</li>'+
          '<li><a href="#" class="cw-ps-a-render-mode" id="cw-menu-playback" data-mode="playback">Play<u>b</u>ack</li>'+
          '<li><a href="#" class="cw-ps-a-render-mode" id="cw-menu-product" data-mode="product">Produc<u>t</u></li>'+
          //'<li><a href="#" class="cw-ps-a-view-flip">Flip vertically</li>'+
          //'<li><a href="#" class="cw-ps-a-view-img">Graph as image</li>'+
          '</ul>'+
        '</div>');

        that.ps_toolbar.append('<div class="cw-viewer-timer">00:00:00</div><div class="cw-viewer-label"></div>');
        /*var click_count=0;
        that.ps_toolbar.find(".cw-viewer-timer").click(function() {
          click_count++;
          if (click_count>4) that.ps_toolbar.addClass('cw-tech-show');
        });*/

        that.ps_toolbar.addClass('cw-tech-show');
            
        $('.cw-btn-play').click(function(e) {
          $('.cw-btn-play').removeClass('btn-primary').addClass('btn-default');
          $(this).addClass('btn-primary').removeClass('btn-default');
          var s = parseFloat($(this).data('play'));
          that.research_play_speed = s;
        });
        $('.cw-ps-a-view-mode').click(function(e) {
          var mode = $(this).data('mode');
          that.research_mode = mode;
          CW.async(that, 'research_render', 0);
        });
        $('.cw-ps-a-render-mode').click(function(e) {
          var mode = $(this).data('mode');
          if (mode === 'playback') that.product.hide(); else that.product.show();
          CW.async(that, 'research_render', 0);
        });
        $('.cw-ps-a-view-flip').click(function(e) {
          //that.research_multiplier = -that.research_multiplier;
          /*for (var o in that.lines) {
            for (var j=0; j<o.length; j++) {
              if (that.lines[o][j]) that.lines[o][j][1] = 2*that.lines[o][j][1];
            }
          }
          CW.async(that, 'research_render', 0);*/
        });
        $('.cw-ps-a-metric').click(function(e) {
          e.preventDefault();
          var m = $(this).data('metric');
          var hidden = that.research_metrics[m].hidden = !that.research_metrics[m].hidden;
          $(this).find('.glyphicon-ok').toggle();
          CW.async(that, 'research_render', 1);
        });
        $('.cw-ps-a-view-html-final').click(function(e) {
          bootbox.dialog({
            title: "Final Text",
            message: that.html.final,
            size: 'large',
            buttons: {
              success: {
                label: "Close",
                className: "btn-success"
              }
            }
          });
        });
        $('.cw-btn-find').click(function() {
          var r = window.prompt('Enter Z-number or time in the mm:ss format');
          if (r) that.research_jump_to(r);
        });
        $('.cw-btn-forward').click(function() {
          var i = that.current_i;
          var z = that.all_data[i].z;
          var t = that.all_data[i].t;
          that.toolbar.find('.cw-btn-play-0').click();
          while (i < that.all_data.length && (that.all_data[i].z === z || that.all_data[i].t === t)) i++;
          that.current_t = that.all_data[i].t;
        });
        $('.cw-btn-backward').click(function() {
          var i = that.current_i;
          var z = that.all_data[i].z;
          var t = that.all_data[i].t;
          that.toolbar.find('.cw-btn-play-0').click();
          while (i > 0 && (that.all_data[i].z === z || that.all_data[i].t === t)) i--;
          that.current_t = that.all_data[i].t;
        });
        $('.cw-ps-a-view-summary').click(function(e) {
          var html =
            '<p><b>Process</b><p>'+
            'Typed characters: '+(that.summary.typed_chars||0)+'<br>'+
            'Edited (removed) characters: '+(that.summary.removed_chars||0)+'<br>'+
            'Look-back events: '+(that.summary.lookbacks||0)+'<br>'+
            'Look-back rate: '+Math.round(1000*that.summary.lookbacks/(that.summary.typed_chars||1))/1000+'<br>'+
            '<p><b>Product</b><p>'+
            'Characters: '+(that.summary.chars||0)+'<br>'+
            'Characters (without spaces): '+(that.summary.nospaces||0)+'<br>'+
            'Words: '+(that.summary.words||0)+'<br>'+
            'Paragraphs: '+(that.summary.paragraphs||0)+'<br>';
          bootbox.dialog({
            title: "Statistical Summary",
            message: html,
            size: 'small',
            buttons: {
              success: {
                label: "Close",
                className: "btn-success"
              }
            }
          });
        });

      });
    },

    product_initialize: function() {
      if (this.is_product_initialized) return;

      this.is_product_initialized = true;
      this.product_need_visual = 'pause with-deletions';

      setInterval(function() {
        $('.cw-product').toggleClass('cursor-blinked');
      }, 500);
      
      var that = this;

      var html = '';
      var last_p = 0, last_p_including_deleted = 0, last_csn = 0;
      var prev_csn, this_csn, this_deleted, prev_jid, this_jid;
      var existing_paras = {};
      for (var i=0; i<this.chars_seq.length; i++) {
        var c = this.chars_seq[i];
        if (!c.deleted) existing_paras[c.p9] = 1;
      }
      for (var i=0; i<this.chars_seq.length; i++) {
        var c = this.chars_seq[i];
        var el = '';

        if (c.csn) {
          prev_csn= this_csn;
          this_csn = c.csn;
          this_deleted = c.deleted;
        }
        if (c.ei) {
          prev_jid = this_jid;
          this_jid = c.ei;
        }

        var span_class = 'pause-char ';
        if (this_deleted) {
          span_class += 'deleted ';
        }
        if (c.ivi) span_class += 'ivi-'+c.ivi+' ';
        if (c.ivd) span_class += 'ivd-'+c.ivd+' ';
        if (c.info && c.info.jdi) el += '<span class="jarrow" id="jd-'+c.info.jdi+'">&darr;</span>';
        if (c.info && c.info.jdd) el += '<span class="jarrow deleted" id="jd-'+c.info.jdd+'">&darr;</span>';
        el += '<span class="'+span_class+'" style="cursor:pointer;"'; // this.chars_seq[i].csn
        if (c.ivi) el += 'data-ivi="'+c.ivi+'" ';
        if (c.ivd) el += 'data-ivd="'+c.ivd+'" ';
        if (c.info) {
          el += "data-dur="+c.info.dur+" data-jump=\""+(!!c.info.jump)+"\" title=\""+c.info.dur+"ms; ei="+c.ei+";p0="+c.p0+";p9="+c.p9+"\" ";
        }
        if (c.ei) {
          el += 'data-jid="'+c.ei+'" ';
        }
        el+='>';
        el+=c.c;
        el += "</span>";
        if (c.info && c.info.jud) el += '<span class="jarrow deleted" id="ju-'+c.info.jud+'">&uarr;</span>';
        if (c.info && c.info.jui) el += '<span class="jarrow" id="ju-'+c.info.jui+'">&uarr;</span>';
        if (last_p !== c.p9 && existing_paras[c.p9] && !this_deleted) { if (last_p) html += '<br><br>'; last_p = c.p9; }
        else if (last_p_including_deleted !== c.p0) html += '<span class="deleted">&para;</span>';
        //if (existing_paras[c.p]) last_p = c.p;
        last_p_including_deleted = c.p0;
        html += el;
      }

      this.product.html('<div class="cw-product">'+html+'</div>');

      this.product.prepend('<select id="cw-product-visual"><option selected>pause with-deletions</option><option>jump with-deletions</option><option>pause no-deletions</option><option>jump no-deletions</option></select> <button id="cw-product-cutoff">Hide changes after this point</button> <button id="cw-product-showall" style="display:none;">Show all changes</button>');
      $('#cw-product-visual').change(function() {
        that.product_need_visual = $(this).val();
        that.product_render();
      });
      $('#cw-product-cutoff').click(function() {
        var z = that.all_data[that.current_i].z;
        var iv = that.research_z_to_interval(z);
        
        $('.pause-char').each(function() {
          let ivi = parseInt($(this).data('ivi'));
          if (ivi >= iv) $(this).addClass('product-hidden');
        });

        $('#cw-product-showall').show();
        $(this).hide();
      });
      $('#cw-product-showall').click(function() {
        $('.product-hidden').removeClass('product-hidden');
        $('#cw-product-cutoff').show();
        $(this).hide();
      });

      $('.pause-char').click(function() {
        if ($(this).hasClass('product-cursor-i') && $(this).data('ivd')) {
          that.research_jump_to(that.intervals[parseInt($(this).data('ivd'))]);
        } else {
          that.research_jump_to(that.intervals[parseInt($(this).data('ivi'))]);
        }
      });
      $('.jarrow').click(function() {
        var id = $(this).attr('id');
        if (id) {
          id = id.replace(/^.+-/, "");
          $('.jarrow-matched').removeClass('jarrow-matched');
          $('#ju-'+id).add('#jd-'+id).addClass('jarrow-matched');
        }
      });
    },

    product_render: function() {
      var that=this;
      var z = that.all_data[that.current_i].z;
      $(".product-cursor-i").removeClass("product-cursor-i");
      $(".product-cursor-d").removeClass("product-cursor-d");
      var iv = that.research_z_to_interval(z);
      $('.pause-char.ivi-'+iv).addClass("product-cursor-i");
      $('.pause-char.ivd-'+iv).addClass("product-cursor-d");
      

      if (this.product_need_visual !== this.product_visual) {
        this.product_visual = this.product_need_visual;
        if (/pause/.test(this.product_visual)) {
          $('.jarrow').hide();
          $('.pause-char').each(function() {
            var iki = $(this).data('dur')||0;
            var jump = $(this).data('jump');

            if (jump) {
              $(this).css({backgroundColor: '#ffff00'});
            } else {
              var col = parseInt(iki/5000*255);
              function toHex(d) {
                return ("0"+(Number(d).toString(16))).slice(-2).toUpperCase()
              }
              var c=toHex(255-col);
              $(this).css({backgroundColor: '#ff'+c+c});
            }
          });
        } else if (/jump/.test(this.product_visual)) {
          $('.jarrow').show();
          var jid_colors = [
            '#FF5555', '#FF7F55', '#FFFF55', '#55FF55', '#AAAAFF', '#4B5582', '#9455D3',
            '#FFAAAA', '#FF7FAA', '#FFFFAA', '#AAFFAA', '#EEEEFF', '#4BAA82', '#D3AAD3'
          ];
          $('.pause-char').each(function() {
            var jid = $(this).data('jid') || 0;
            if (jid) {
              $(this).css({backgroundColor: jid_colors[(jid-1)%jid_colors.length]});
            } else {
              $(this).css({backgroundColor: 'white'});
            }
          });
        }

        if (/with-deletions/.test(this.product_visual)) {
          $('.deleted').show();
        } else {
          $('.deleted').hide();
        }
      }
    },

    research_render: function() {
      var that=this;

      this.product_initialize();
      this.product_render();

      for (var o in this.research_metrics) {
        var show = !this.research_metrics[o].mode || this.research_metrics[o].mode === this.research_mode;
        var p = $('a.cw-ps-a-metric').filter(function() { return $(this).data("metric") === o }).parent();
        if (show) p.show(); else p.hide();
      }

      var new_i = that.current_i;
      while (new_i < that.all_data.length-1 && that.all_data[new_i].t < that.current_t) new_i++;
      while (new_i > 0 && that.all_data[new_i].t > that.current_t) new_i--;

      if (!new_i || new_i !== that.current_i) {
        that.current_i = new_i;
        var c = that.all_data[that.current_i];
        for (var o in c.d) {
          if (!/^\d+$/.test(o)) this.data[o] = c.d[o];
        }
        for (var o in c.r) {
          if (!/^\d+$/.test(o)) this.data[o] = this.all_data[c.r[o]].d[o];
        }
        this.data.rows = {};
        for (var i=0; i<this.data.size.rows; i++) this.data.rows[i] = c.d[i] ? c.d[i] : i in c.r ? this.all_data[c.r[i]].d[i] : '';

        this.resize();
        this.draw();
      }

      var t = this.current_t/60000;
      var markings = [ { xaxis: { from: t, to: t }, color: "red" } ];
      for (var o in that.annotations) {
        var a = that.annotations[o];
        for (var i=0; i<a.length; i++) markings.push({ xaxis: {from:a[i][0]/60000, to:a[i][1]/60000}, color: "yellow"});
      }
      var options = {
        grid: {
          backgroundColor: {
            colors: ["#FFF", "#FFF"]
          },
          clickable: true,
          markings: markings
        },
        colors: that.line_colors
      };
      var arr = [];
      for (var o in this.lines) {
        var data1 = (this.research_metrics[o].mode !== this.research_mode || this.research_metrics[o].hidden ? [] : this.lines[o]);
        arr.push({ data: data1, shadowSize: 0, lines: { lineWidth: 2 } });
      }
      $.plot("#cw-ps-graph", arr, options);

      var s = parseInt(t*60);
      var h = parseInt(s/3600); s-=h*3600;
      var m = parseInt(s/60); s-=m*60;
      var t = h+':'+(m<10?'0':'')+m+':'+(s<10?'0':'')+s;

      var z = that.all_data[that.current_i].z;

      $('.cw-viewer-timer').html(t + '<span class="cw-tech"> (z='+z+')</span>');

      CW.async(this, 'research_tick', 100);
    },

    research_tick: function() {
      this.current_t += 100 * this.research_play_speed;
      this.research_render();
    },

    connect: function() {
      var sockjs_url = '/node/sock';
      var sockjs = new SockJS(sockjs_url);
      var that = this;
      sockjs.onopen = function() {
        that.sockjs = sockjs;
        sockjs.send(JSON.stringify( {connect: 'viewer', token: that.token} ));
      }
      sockjs.onclose = function() {
        delete that.sockjs;
        if (that.active) CW.async(that, 'connect', 5000);
      };
      sockjs.onmessage = function(e) { that.on_data(e.data) };
      return this;
    },

    init: function() {
      var t=this;

      // measure scales
      $('body').append('<span id="tmp-measure" style="position: fixed; top: -5000px; font-family: '+this.font_family+'; font-size: 1000px;">WW</span>');
      t.scale_char_width = $('#tmp-measure').width()/2000;
      t.scale_char_height = $('#tmp-measure').height()/1000;
      $('#tmp-measure').remove();

      var id = this.id;

      $(window).keydown(function(e) {
        if (e.which === 39) {
          t.toolbar.find('.cw-btn-forward').click();
        } else if (e.which === 37) {
          t.toolbar.find('.cw-btn-backward').click();
        } else if (e.which === 32) {
          t.toolbar.find(t.research_play_speed ? '.cw-btn-play-0' : '.cw-btn-play-1').click();
          e.preventDefault();
        }
        else if (e.originalEvent.code === 'KeyP') $('#cw-menu-process').click();
        else if (e.originalEvent.code === 'KeyD') $('#cw-menu-differential').click();
        else if (e.originalEvent.code === 'KeyB') $('#cw-menu-playback').click();
        else if (e.originalEvent.code === 'KeyT') $('#cw-menu-product').click();
      });

      this.container.empty();
      CW._make(this, 'canvas', '', 'canvas');
      CW._make(this, 'toolbar', 'btn-toolbar', 'div', 'role="toolbar"');
      CW._make(this, 'product', 'cw-viewer-product');

      this.role = /-X$/.test(this.token) ? 'research' : 'live';
      this.token = this.token.replace(/-X$/, '');

      this.container.append('<form method="GET" target="_blank" class="cw-form-download" action="/node/download"><input type="hidden" name="token" class="token" value=""></form>');
      if (this.role !== 'research')
        this.toolbar.append('<div class="btn-group"><button type="button" class="btn btn-default fa fa-download"></button></div>');
      if (this.role === 'live') {
        this.toolbar.append('<div class="btn-group"><button type="button" class="btn btn-default fa fa-arrows-alt"></button>'+
        '<button type="button" class="btn btn-default fa fa-eye"></button>'+
        '<button type="button" class="btn btn-default fa fa-search"></button>'+
        '</div>');
      }
      if (this.role === 'research')
        this.toolbar.append('<div class="progress" style="height: 35px;"><div class="progress-bar" role="progressbar" style="width:0%; min-width: 2em; line-height:35px;"><span>0%</span></div></div>');
      if (this.role !== 'research')
        this.toolbar.append('<div class="cw-viewer-timer"></div><div class="cw-viewer-label"></div>');
      this.toolbar.find('.fa-download').click(function(){
        var form = t.container.find('.cw-form-download');
        form.find('.token').val(t.token);
        form.submit();
      });
      this.toolbar.find('.fa-eye').click(function(){
        if (window.confirm('Are you sure you want to start re-calibration?'))
          t.sockjs.send(JSON.stringify({ cmd: 'click', data: { button: '.fa-eye' } }));
      });
      this.toolbar.find('.fa-search').click(function(){
        t.container.find('#cw-viewer-img').toggleClass('zoom');
      });
      this.toolbar.find('.fa-arrows-alt').click(function(){
        bootbox.dialog({
          title: "Size",
          message: '<div class="row">  ' +
                    '<div class="col-md-12"> ' +
                    '<form class="form-horizontal"> ' +
                    '<div class="form-group"> ' +
                    '<label class="col-md-4 control-label" for="font-size">Font Size</label> ' +
                    '<div class="col-md-4"> ' +
                    '<input id="font-size" name="font-size" type="text" placeholder="e.g., 16" class="form-control input-md"> ' +
                    '</div> ' +
                    '</div> ' +
                    '<div class="form-group"> ' +
                    '<label class="col-md-4 control-label" for="interline">Interlinear Interval</label> ' +
                    '<div class="col-md-4"> ' +
                    '<input id="interline" name="interline" type="text" placeholder="e.g., 2" class="form-control input-md"> ' +
                    '</div> ' +
                    '</div> ' +
                    '</form> </div>  </div>',
                buttons: {
                    success: {
                        label: "Send",
                        className: "btn-success",
                        callback: function () {
                            var font_size = $('#font-size').val();
                            var interline = $('#interline').val();
                            t.sockjs.send(JSON.stringify({resize: { font_size: font_size, interline: interline} }));
                        }
                    }
                }
            }
        );
      });

      CW._make(this, 'lpane'); CW._make(this, 'viewport'); CW._make(this, 'rpane'); CW._make(this, 'dpane');

      this.container.find('button').tooltip({container: 'body', placement: 'auto bottom'});

      t.window_resize_timer = null;
      $(window).resize(function() {
        clearTimeout(t.window_resize_timer);
        t.window_resize_timer = setTimeout($.proxy(t.resize, t), 500);
      });

      return this;
    },

    resize: function() {
      if (!this.data.size) return;
      var width1 = this.container.width()-this.fb_width-this.margin*2;
      var height1 = this.container.height() - this.toolbar.height() - this.margin*2;
      var height2 = this.container.height() - this.toolbar.height();
      var w_scale = width1/this.data.size.viewport_width;
      var h_scale = height1/this.data.size.viewport_height;
      this.scale = w_scale < h_scale ? w_scale : h_scale;

      this.product.css('height', height2+'px');

      this.viewport_width = parseInt(this.scale * this.data.size.viewport_width);

      var char_width = this.viewport_width / this.data.size.cols;
      this.font_size = parseInt(char_width/this.scale_char_width);
      CW.measure(this);
      while (this.char_width>char_width) {
        this.font_size--;
        CW.measure(this);
      }

      // needed?
      // this.viewpoint_width = parseInt(this.data.size.cols * this.char_width);
      // this.scale = this.viewpoint_width / this.data.size.viewport_width;
      this.viewport_height = parseInt(this.scale * this.data.size.viewport_height);

      this.cols = this.data.size.cols;
      this.rows = this.data.size.rows;
      this.interline = (this.viewport_height/this.rows) - this.char_height;

      var pane_width = this.container.width()-this.margin*2-this.viewport_width;
      var lpane_width=0, rpane_width=this.fb_width;
      if (pane_width > this.fb_width*2) lpane_width = rpane_width = parseInt(pane_width/2);
      else lpane_width = pane_width - rpane_width;

      this.viewport
        .css('margin', this.margin+'px')
        .css('width', this.viewport_width+'px')
        .css('height', this.viewport_height+'px')
        .css('left', (lpane_width+this.margin)+'px');
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
      this.dpane
        .css('width', this.container.width()+'px')
        .css('top', (this.viewport.offset().top+this.viewport_height+this.margin)+'px')
        .css('left', (this.container.offset().left))
        .css('height', (height1 - this.viewport_height)+'px');

      this.draw(); 
      return this;
    },

    draw: function() {
      var d = this.data;

      if (d.img) {
        if (!$('#cw-viewer-img').length) this.container.append('<div id="cw-viewer-img"><img /></div>');
        $('#cw-viewer-img img').attr('src', 'data:image/png;base64, '+d.img.b);
      }

      if (d.config && d.config.label) {
        var lbl = '';
        if (d.config.label) lbl += d.config.label;
        if (d.config.ave_error) lbl += ' '+d.config.ave_error;
        $(".cw-viewer-label").text(lbl);
        document.title = d.config.label;
      }

      var that=this;
      var scale_xy = function(obj) {
        var y = parseInt(obj.y/(that.data.size.char_height+that.data.size.interline)*(that.char_height + that.interline));
        var x = parseInt(obj.x/(that.data.size.char_width)*(that.char_width));
        return { x: x, y: y };
      }

      this.viewport.find('.cw-fixation').remove();

      if (d.eye && 'x' in d.eye && 'y' in d.eye && !(this.research_metrics && this.research_metrics.eye_fixations.hidden)) {
        var xy = scale_xy(d.eye);
        this.viewport.append('<div class="cw-fixation"></div>');
        this.viewport.find('.cw-fixation').css({top: xy.y-20, left: xy.x-20});
        if (d.sr) this.viewport.find('.cw-fixation').addClass('sustained-reading');
      }
      
      this.viewport.find('.cw-saccade').remove();

      if (d.eye_s && 'x' in d.eye_s && 'y' in d.eye_s && !(this.research_metrics && this.research_metrics.eye_movements.hidden)) {
        var xy = scale_xy(d.eye_s);

        this.viewport.append('<div class="cw-saccade"></div>');
        this.viewport.find('.cw-saccade').css({top: xy.y-15, left: xy.x-15});
      }

      if (d.focus && d.focus.is_focused === false || d.eye && d.eye.is_calibrating) d.overshadow=true; else d.overshadow=false;
      $('.cw-viewer-message').remove();
      if (d.overshadow) {
        this.container.addClass('cw-overshadow');
        var msg='';
        if (d.eye && d.eye.is_calibrating) msg = '[CALIBRATING]';
        else if (d.focus && d.focus.is_focused === false && d.focus.app) msg = '['+d.focus.app+']<br>'+d.focus.title;
        this.container.prepend('<div class="cw-viewer-message"><div></div></div>');
        var font_size = this.container.width()/80;
        if (font_size<12) font_size=12;
        $('.cw-viewer-message div').css('font-size', font_size+'px').html(msg);
      } else {
        this.container.removeClass('cw-overshadow');
      }
      //this.container.css({ 'background-color': '#555555' });
      //this.container.addClass('cw-overshadow');

      if (d.position && d.scope) {
        var s = parseInt((d.position.t - d.scope.t0)/1000);
        var pct = s;
        var h = parseInt(s/3600); s-=h*3600;
        var m = parseInt(s/60); s-=m*60;
        var t = h+':'+(m<10?'0':'')+m+':'+(s<10?'0':'')+s;
        this.toolbar.find('.cw-position').html(d.position.z);
        this.toolbar.find('.cw-viewer-timer').html(t);
        var len_t = d.scope.t9 - d.scope.t0;
        if (len_t) {
          pct /= parseInt(len_t/1000);
          pct *= 100;
          this.toolbar.find('.cw-progress-fill').css('width', parseInt(pct)+'%');
        }
        if (d.position.dir) {
          var class1 = d.position.dir == 'pause' ? 'fa-play' : 'fa-pause';
          this.toolbar.find('.cw-btn-dir').removeClass('fa-pause').removeClass('fa-play').addClass(class1);
        }
      }

      if (d.rows) {
        this.viewport.find('.cw-row').remove();
        for (var i=0; i<this.data.size.rows; i++) {
          if (d.rows[i]) {
            var row = $('<div class="cw-row" style="white-space:nowrap; font-size: '+this.font_size+'px; font-family: '+this.font_family+'; position: absolute; top: '+((this.char_height+this.interline)*i)+'px;"></div>')
            row.html(d.rows[i]);
            this.viewport.append(row);
          }
        }
      }

      if (d.block) {
        this.container.find('.cw-block').remove();
        for (var o in d.block) {
          var left = d.block[o][0], right = d.block[o][1];

          var i = parseInt(o);
          var top_shift = this.char_height * 0.2;
          $('<div class="cw-block"></div>').
          css('position', 'absolute').
          css('width', (this.char_width*(right-left))+'px').
          css('height', this.char_height-top_shift+'px').
          css('margin-top', (top_shift/2)+'px').
          css('top', ((this.char_height+this.interline)*i)+'px').
          css('left', (this.char_width*left)+'px').
          appendTo(this.viewport);
        }
      }

      if (d.cursor) {
        this.container.find('.cw-cursor').remove();
        if (d.cursor.cur_row < 0 || d.cursor.cur_row >= this.data.size.rows) {}
        else {
          var top_shift = this.char_height * 0.2;
          $('<div class="cw-cursor"></div>').css('position', 'absolute').css('width', this.char_width+'px').css('height', this.char_height-top_shift+'px').css('margin-top', (top_shift/2)+'px').appendTo(this.viewport)
          .css('top', ((this.char_height+this.interline)*d.cursor.cur_row)+'px').css('left', (this.char_width*d.cursor.cur_col)+'px');
        }
      }

      const scale_font_in_box = (box, it) => {
        if (!it.y0) it.y0 = 0;
        if (!it.height) it.height = it.y1-it.y0;
        box.removeClass('to-remove').css('top', (it.y0*this.scale + this.margin)+'px').css('left', '0px');
        var target_height = it.height*this.scale-5; // 5 is the spacing
        var font_size = parseInt(box.css('font-size'), 10);
        while (box.outerHeight() > target_height && font_size>5) {
          font_size--;
          box.css('font-size', font_size+'px');
        }
        while (box.outerHeight() < target_height && font_size<20) {
          font_size++;
          box.css('font-size', font_size+'px');
        }
      }

      if (d.hint) {
        this.rpane.find('#cw-hint-box').remove();
        if (d.hint.box) {
          if (d.fb && d.fb.hint_box) d.hint.box.y0 = d.fb.hint_box.y0;
          var box = $('<div id="cw-hint-box"></div>').addClass(d.hint.box.kind).html(d.hint.box.message).appendTo(this.rpane);
          scale_font_in_box(box, d.hint.box);
        }
      }

      if (d.fb) {
        this.rpane.find('.cw-fb-box').addClass('to-remove');
        for (var id in d.fb) {
          if (id === 'hint_box') continue;
          var html_id = '';
          var it = d.fb[id];
          if (!it) continue;
          var box;
          if (it.spangroup) {
            html_id = 'cw-'+this.id+'-fb-'+id;
            box = $('#'+html_id);
            if (!$('#'+html_id).length) {
              this.rpane.append($('<div class="cw-fb-box cw-fb-group" id="'+html_id+'"></div>').addClass(it.spangroup.kind).html(it.spangroup.message));
            }
            for (var j=0; j<it.spans.length; j++) {
              var span1 = it.spans[j];
              var id_inner = span1.id;
              var html_id_inner = 'cw-'+this.id+'-fb-'+id_inner+'-inner';
              if (!$('#'+html_id_inner).length && span1.message) {
                box.append($('<div class="cw-fb-inner-box" id="'+html_id_inner+'"></div>').addClass(span1.kind).html(span1.message));
              }
            }
          } else if (it.span && it.span.message) {
            html_id = 'cw-'+this.id+'-fb-'+id;
            box = $('#'+html_id);
            if (!$('#'+html_id).length) {
              this.rpane.append($('<div class="cw-fb-box" id="'+html_id+'"></div>').addClass(it.span.kind).html(it.span.message));
            }
          }
          if (html_id) {
            scale_font_in_box(box, it);
          }
        }
        this.rpane.find('.cw-fb-box.to-remove').remove();
      }

    },

    on_data: function(data) {
      var d = JSON.parse(data);
      CW.extend(this.data, d);
      this.resize();
      this.draw();
      this.sockjs.send(JSON.stringify({ok:1}));
    },

    destroy: function() {
      if (this.deleted) return;
      this.deleted = 1;
      this.active = 0;
      if (this.sockjs) this.sockjs.close();
    }

  };

})();
