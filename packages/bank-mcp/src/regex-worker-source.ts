export const REGEX_WORKER_SOURCE = String.raw`
'use strict';
const { parentPort } = require('node:worker_threads');

// A user-controlled pattern can name thousands of captures that each span the
// whole subject. Selecting only the requested names and refusing oversized
// replies keeps that amplification inside this worker, so the parent thread
// never deserializes a multi-megabyte structured clone.
const MAX_REPLY_CODE_UNITS = 131072;

parentPort.on('message', (job) => {
  try {
    const regex = new RegExp(job.pattern, job.flags);
    let value;
    if (job.operation === 'exec') {
      const match = regex.exec(job.subject);
      if (match === null) {
        value = null;
      } else {
        let size = match[0].length;
        let groups;
        if (match.groups !== undefined) {
          groups = {};
          const requested = Array.isArray(job.captures) ? job.captures : [];
          for (const name of requested) {
            const captured = match.groups[name];
            size += captured === undefined ? 0 : captured.length;
            if (size > MAX_REPLY_CODE_UNITS) {
              parentPort.postMessage({
                id: job.id,
                ok: false,
                code: 'output_too_large',
                message: 'match output exceeds ' + MAX_REPLY_CODE_UNITS + ' UTF-16 code units',
              });
              return;
            }
            groups[name] = captured;
          }
        }
        value = { match: match[0], groups };
      }
    } else if (job.operation === 'test') {
      value = regex.test(job.subject);
    }
    parentPort.postMessage({ id: job.id, ok: true, value });
  } catch (error) {
    parentPort.postMessage({
      id: job.id,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
`;
