"use strict";

// SourceWriteDebug plugin

module.exports = function(CyWrite) {
  console.log('INIT OK!');

  return {
    init: (clone) => {
      console.log('attached to clone!!!');
      clone.register_hook('act', function(msg) {
        if (msg.k === 'edit' && msg.repl === '~') {
          let npd = this.cursor_to_frozen().npd;
          console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
          CyWrite.worker_add_job({
            job_id: clone.token+':'+Date.now(),
            student_paragraph: this.paragraphs[npd].text,
            token: clone.token,
            worker_type: 'omar_script',
            result_callback: function(job, res) {
              console.log('RESULT: ', job, res)
              let message = res.matches.map(match => "${match.rst_range} in ${match.source}").join('<br>');
              clone.schedule_hint("SW", { priority: 2, box: { kind: 'yellow animate__animated animate__zoomIn', message: message } });
            }
          });
        }
      });
    }
  }

};
