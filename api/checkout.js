import { createCheckout } from '../server/checkout.js';

export default { fetch: createCheckout({ env: process.env }) };
