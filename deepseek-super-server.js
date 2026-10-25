'use strict';

// Backward-compatible CLI entry point. The implementation lives in src/.
const library = require('./src');

if (require.main === module) {
  library.start();
}

module.exports = library;
