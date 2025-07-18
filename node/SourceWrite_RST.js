"use strict";

// SourceWrite_RST plugin

const fs = require('fs');
const path = require('path');


module.exports = function(CyWrite) {
  console.log('SourceWrite RST init ok');

  return {
    init: (clone) => {
      console.log('SourceWrite RST attached to clone');
      clone.register_hook('document_loaded', () => {
        clone.rst_annotations = {};
        const sources = read_in_rst_files();
        for (let i=0; i<clone.tabs.length; i++) {
          rst_annotate_tab(clone, i, sources);
        }
        //console.log(JSON.stringify(clone.rst_annotations));
        console.log('RST annotations complete');
      });

      clone.register_hook('incremental_eye_fix', (eye) => {
        if (eye.is_text_fixated && clone.rst_annotations[eye.tab]) {
          for (let i = clone.rst_annotations[eye.tab].edus.length-1; i>=0; i--) {
            const edu = clone.rst_annotations[eye.tab].edus[i];
            if (edu.global_offset <= eye.fixation_offset) {
              eye.edu = edu.edu;
              eye.source = clone.rst_annotations[eye.tab].source;
              break;
            }
          }
        }
      });
    }
  }
};

function read_in_rst_files() {
  const folder = 'rst_tsv';
  const files = fs.readdirSync(folder);

  const all_lines = {};

  for (const file of files) {
    if (path.extname(file) === '.tsv') {
      const lines = fs.readFileSync(path.join(folder, file), 'binary').split(/[\r\n]+/);
      for (let line of lines) {
        const cols = line.split("\t");
        if (cols[1] === 'edu') {
          if (!all_lines[cols[0]]) {
            all_lines[cols[0]] = [];
          }
          all_lines[cols[0]].push(cols);
        }
      }
    }
  }
  console.log('RST files loaded');
  return all_lines;
}


function rst_annotate_tab_with_file(clone, tab_id, rst_file_lines) {
  const edu_offsets = [];
  let normalized_offset = 0;
  
  let normalized_string_file = '';

  for (let cols of rst_file_lines) {
    let edu = cols[3];
    let txt = cols[5].replace(/\W/g, '');
    edu_offsets.push({ edu: edu, normalized_offset: normalized_offset });
    normalized_string_file += txt;
    normalized_offset += txt.length;
  }

  const normalized_to_global = {};
  let clone_global_offset = 0;
  let clone_normalized_offset = 0;

  let normalized_string_clone = '';

  for (let p of clone.paragraphs) {
    if (p.tab !== tab_id || /^\s*Text \d+\s*\$$/.test(p.text)) {
      clone_global_offset += p.text.length;
      continue;
    }
    //console.log(p.text);
    for (let i=0; i<p.text.length; i++) {
      let chr = p.text[i];
      if (/\w/.test(chr)) {
        normalized_string_clone += chr;
        normalized_to_global[clone_normalized_offset] = clone_global_offset;
        clone_normalized_offset++;
      }
      clone_global_offset++;
    }
  }

  if (normalized_string_file === normalized_string_clone) {
    for (let o of edu_offsets) {
      o.global_offset = normalized_to_global[o.normalized_offset];
    }
    return edu_offsets;
  } else {
    return false;
  }
}

function rst_annotate_tab(clone, tab_id, sources) {
  if (!clone.rst_annotations) clone.rst_annotations = {};

  for (const source in sources) {
    const result = rst_annotate_tab_with_file(clone, tab_id, sources[source]);
    if (result) {
      clone.rst_annotations[tab_id] = {
        source: source,
        edus: result
      };
      break;
    }
  }
}
