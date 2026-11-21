import { writeFile } from 'node:fs/promises';
import { callScript } from '../server/script-client.js';
import { validateCatalogue } from '../server/catalogue.js';

const result = await callScript(process.env, 'catalogue', {}, fetch, 55000);
if (!result.ok)
  throw Error(
    'Could not synchronize catalogue. Check the Apps Script deployment and property setup.'
  );
const snapshot = validateCatalogue(result.data);
await writeFile(
  new URL('../dist/catalogue.json', import.meta.url),
  JSON.stringify(snapshot) + '\n'
);
console.log(
  'MARC catalogue saved. ' +
    snapshot.products.length +
    ' products, ' +
    (snapshot.ready ? 'ordering open' : 'ordering paused') +
    '.'
);
