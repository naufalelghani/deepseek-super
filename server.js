'use strict';

// Select the backend before loading src/, because browser/config modules are
// initialized once per Node.js process.
const { parseBackendArgs } = require('./src/backend-selection');

let backend = 'deepseek';
let validArgs = true;

if (require.main === module) {
  try {
    backend = parseBackendArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message || String(error));
    process.exitCode = 1;
    validArgs = false;
  }
}

if (validArgs) {
  process.env.DEEPSEEK_SUPER_BACKEND = backend;
  const library = require('./src');

  if (require.main === module) {
    console.log('Selected backend:', backend);
    library.start();
  }

  module.exports = { ...library, backend };
}
