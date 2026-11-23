import { createQueueWorker } from '../server/order-queue.js';

export default { fetch: createQueueWorker({ env: process.env }) };
