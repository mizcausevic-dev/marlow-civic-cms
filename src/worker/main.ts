import { randomUUID } from 'node:crypto';
import { openDatabase, migrate } from '../db/db.ts';
import { defaultTransport } from '../domain/webhooks.ts';
import { deliverDueWebhooks, processDueJob } from '../services/cms.ts';

const db = openDatabase(process.env.DATABASE_PATH ?? './data/cms.sqlite');
migrate(db);
const workerId = process.env.WORKER_ID || randomUUID();
const poll = Number(process.env.POLL_MS ?? 1000);
let stop = false;
process.on('SIGTERM', () => {
  stop = true;
});
process.on('SIGINT', () => {
  stop = true;
});

console.log(JSON.stringify({ event: 'worker_start', workerId, poll }));

while (!stop) {
  try {
    const job = processDueJob(db, { now: new Date(), workerId });
    const hooks = await deliverDueWebhooks(db, new Date(), defaultTransport);
    if (job) console.log(JSON.stringify({ event: 'job', ...job }));
    if (!job && hooks === 0) await new Promise((resolve) => setTimeout(resolve, poll));
  } catch (error) {
    console.log(JSON.stringify({ event: 'worker_error', message: error instanceof Error ? error.message : 'error' }));
    await new Promise((resolve) => setTimeout(resolve, poll));
  }
}
