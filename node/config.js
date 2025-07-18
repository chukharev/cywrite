var os = require('os');

module.exports = {
  node_id: '7200',
  port: 9998,
  features: {
    hunspell: false, // fixme
    analyze: false // fixme
  },
  plugins: [ 'SourceWrite_RST' ],
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
  workers: {
    timeout_long_polling: 10000,
    worker_types: {
      worker1: {
        isStateful: true,
        doNotAssignTokensAfter: 5000,
        treatAsDeadAfter: 10000,
      },
      worker2: {
        isStateful: false,
        doNotAssignTokensAfter: 4000,
        treatAsDeadAfter: 6000,
      }
    },
    //api_secret: 'sdkfsfjskld' - in a production environment, add an api_secret here so that the endpoint URLs are like /api/worker/<api_secret>/register, etc.
  },
  
  dir_current: __dirname + '/cur',
  dir_archive: __dirname + '/arc',
  dir_graph: __dirname + '/graph',
  dir_summary: __dirname + '/summary',
  dir_logs: __dirname + '/logs',
  log_level_console: '>>>',
  log_level_file: '>>>',
//  api_secret: 'MIfnu5v8yt'
};

exports = module.exports;
  
