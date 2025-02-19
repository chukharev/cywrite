"use strict";

// SourceWriteDebug plugin

module.exports = function(CyWrite) {

  return {
    init: (clone) => {
      clone.register_hook('act', function(msg) {
        if (msg.k === 'edit' && msg.repl === '~') {
          let npd = this.cursor_to_frozen().npd;
          CyWrite.worker_add_job({
            student_paragraph: this.paragraphs[npd].text,
            token: clone.token,
            worker_type: 'omar_script',
            result_callback: function(job, res) { console.log('RESULT: ', job, res) }
          });
        }
      });
    }
  }

};
