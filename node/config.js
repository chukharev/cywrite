var os = require('os');

module.exports = {
  node_id: '7100',
  features: {
    hunspell: false, // fixme
    analyze: false // fixme
  },
  delays: {
    heartbeat: 25000,    // server will send heartbeat 'ping' to client every 25 sec
    inactive: 5*60000, // wait for 5 minutes for connection restoring
    silence: 45000, // if no communication is detected on the channel for 45 sec, server and client will disconnect
    client_reconnect: 5000,
    client_disconnect_warn: 60000,
    client_disconnect_err: 120000,
    save_document: 5000,
    analyze_paragraph: 1000,
    spellcheck: 500,
    analyze_loaded_paragraphs: 1000,
    analyze_sentence: 1000
  },
  sqlite_current: __dirname + '/cur',
  sqlite_archive: __dirname + '/arc',
  sqlite_graph: __dirname + '/graph',
  base_url: 'https://cw1.linguatorium.com', // fixme
  log_level_console: '>>>'
};

exports = module.exports;
  