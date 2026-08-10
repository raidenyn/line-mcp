export const REGEX_WORKER_SOURCE = String.raw`
'use strict';
const { parentPort } = require('node:worker_threads');

parentPort.on('message', (job) => {
  try {
    const regex = new RegExp(job.pattern, job.flags);
    let value;
    if (job.operation === 'exec') {
      const match = regex.exec(job.subject);
      value = match === null ? null : {
        match: match[0],
        groups: match.groups === undefined ? undefined : { ...match.groups },
      };
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