import { createAuth } from '../../server/auth.js';

export default { fetch: createAuth({ env: process.env }).callback };
