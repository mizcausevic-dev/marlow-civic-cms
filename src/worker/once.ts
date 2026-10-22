import { randomUUID } from 'node:crypto';
import { openDatabase, migrate } from '../db/db.ts';
import { defaultTransport } from '../domain/webhooks.ts';
import { deliverDueWebhooks, processDueJob } from '../services/cms.ts';

const db = openDatabase(process.env.DATABASE_PATH ?? './data/cms.sqlite');
migrate(db);
const workerId = process.env.WORKER_ID || randomUUID();
const job = processDueJob(db, { now: new Date(), workerId, backoffMs: () => 0 });
const hooks = await deliverDueWebhooks(db, new Date(), defaultTransport, undefined, () => 0);
console.log(JSON.stringify({ job, hooks }));
db.close();
