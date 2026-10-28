'use strict';

const { getStateStore } = require('../src/state-store');

function main() {
  const store = getStateStore();
  try {
    const requestId = process.argv[2];
    if (requestId) {
      const request = store.getRequest(requestId);
      if (!request) {
        console.error('No trace found for request ID: ' + requestId);
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify({
        request,
        events: store.listEvents(requestId, 500),
      }, null, 2));
      return;
    }

    console.log(JSON.stringify({
      hint: 'Run npm run trace -- <request_id> to inspect one request and its events.',
      requests: store.listRecentRequests(20),
    }, null, 2));
  } finally {
    store.close();
  }
}

try {
  main();
} catch (error) {
  console.error('[trace] Could not read the local trace database: ' +
    (error && error.message ? error.message : String(error)));
  process.exitCode = 1;
}
