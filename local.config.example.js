// local.config.example.js — copy to local.config.js and fill in your table.
//
// local.config.js is gitignored: it names the site you play on and nothing
// else in the repo does. Everything here can also be given as an environment
// variable, which takes precedence.

export default {
  // The live blackjack page to open.            env: TABLE_URL
  tableUrl: 'https://example.com/live-blackjack',

  // Only sockets matching this are read. Keeps other tabs out of the capture
  // when attaching to a browser you are also using.   env: ALLOW_WS
  allowWs: 'example\.com|game-host\.example',

  // Sockets to skip even if allowed: video and chat carry no cards.
  //                                                   env: IGNORE_WS
  ignoreWs: '/ws/chat/|/video/',
};
