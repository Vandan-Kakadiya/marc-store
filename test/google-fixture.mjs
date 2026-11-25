import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash, createHmac, randomUUID } from 'node:crypto';
const body = await readFile(
  new URL('../apps-script/Code.gs', import.meta.url),
  'utf8'
);

function sheet(name, rows = []) {
  let maxColumns = 26;
  let maxRows = Math.max(1000, rows.length);
  const reads = { enabled: false, cells: 0, textBytes: 0 };
  return {
    rows,
    reads,
    getName: () => name,
    getLastRow: () => rows.length,
    getLastColumn: () => Math.max(0, ...rows.map((row) => row.length)),
    getMaxColumns: () => maxColumns,
    getMaxRows: () => maxRows,
    insertColumnsAfter(_column, count) { maxColumns += count; },
    insertRowsAfter(afterRow, count) {
      if (afterRow !== maxRows || count < 1) throw Error('Invalid grid expansion');
      maxRows += count;
    },
    setFrozenRows() {},
    getRange(row, col, height = 1, width = 1) {
      if (row < 1 || height < 1 || row + height - 1 > maxRows)
        throw Error('The requested range is outside the rows of the sheet.');
      const cellValue = (value) =>
        typeof value === 'string' && value.startsWith("'")
          ? value.slice(1)
          : value ?? '';
      const visible = (value) => String(cellValue(value));
      return {
        setNumberFormat() {
          return this;
        },
        setFontWeight() {
          return this;
        },
        setValues(values) {
          for (let r = 0; r < height; r++) {
            rows[row - 1 + r] ??= [];
            for (let c = 0; c < width; c++)
              rows[row - 1 + r][col - 1 + c] = values[r][c];
          }
          return this;
        },
        getDisplayValues() {
          return Array.from({ length: height }, (_, r) =>
            Array.from({ length: width }, (_, c) =>
              visible(rows[row - 1 + r]?.[col - 1 + c])
            )
          );
        },
        getValues() {
          const result = Array.from({ length: height }, (_, r) =>
            Array.from({ length: width }, (_, c) =>
              cellValue(rows[row - 1 + r]?.[col - 1 + c])
            )
          );
          if (reads.enabled) {
            reads.cells += height * width;
            for (const line of result)
              for (const value of line)
                if (typeof value === 'string') reads.textBytes += Buffer.byteLength(value);
          }
          return result;
        },
        createTextFinder(value) {
          let entire = false;
          const target = String(value).toLowerCase();
          function* matches() {
            for (let i = 0; i < height; i++) {
              const line = row + i;
              const text = visible(rows[line - 1]?.[col - 1]).toLowerCase();
              if (entire ? text === target : text.includes(target))
                yield { getRow: () => line };
            }
          }
          return {
            matchEntireCell(exact) {
              entire = exact;
              return this;
            },
            findNext() {
              return matches().next().value ?? null;
            },
            findAll() {
              return [...matches()];
            }
          };
        }
      };
    }
  };
}
export function googleFixture(site = 'https://marc-test.example') {
  const env = {
    MARC_SITE_URL: site,
    MARC_ORDER_QUEUE_ENABLED: '0',
    MARC_SCRIPT_URL: 'https://script.google.com/macros/s/marc-test/exec',
    MARC_SCRIPT_SECRET: 'a'.repeat(64),
    MARC_SESSION_KEY: 'b'.repeat(64),
    GOOGLE_CLIENT_ID: 'marc-test.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-secret'
  };
  const state = {
    orderCalls: 0,
    catalogueCalls: 0,
    driveFailure: false,
    flushFailureAfterDrive: false,
    confirmFailure: false,
    lostReply: false,
    publicFolder: false,
    locked: false,
    open: true,
    redeploys: 0,
    bannerChoices: null,
    videoChoices: null,
    choices: [
      'POLO-W-M | MARC Polo | White | M | 799',
      'POLO-W-L | MARC Polo | White | L | 799',
      'TOTE | Campus Tote | Navy | One size | 249.50 | ./assets/blue tote.webp'
    ],
    sizes: ['1', '2', '3', '4', '5'],
    profile: {
      sub: 'buyer-1',
      email: 'buyer@iimtrichy.ac.in',
      email_verified: true,
      hd: 'iimtrichy.ac.in',
      name: 'Campus Buyer'
    }
  };
  const orders = sheet('MARC Website Orders');
  const old = sheet('Form Responses 1', [
    ['UPI transaction ID (UTR)'],
    ['001234560001']
  ]);
  const files = new Map(),
    filesById = new Map(),
    photos = new Map(),
    messages = [],
    triggers = [];
  const props = {
    MARC_SCRIPT_SECRET: env.MARC_SCRIPT_SECRET,
    FORM_ID: 'form',
    RESPONSE_SHEET_ID: 'sheet',
    SCREENSHOT_FOLDER_ID: 'folder',
    STOREFRONT_URL: site,
    PAYMENT_QR_URL: site + '/assets/payment-qr.jpeg',
    PAYEE_NAME: 'IIMT MART',
    UPI_ID: 'fixture-merchant@examplebank',
    LEGACY_TAB: old.getName(),
    VERCEL_DEPLOY_HOOK:
      'https://api.vercel.com/v1/integrations/deploy/prj_test/fake-hook'
  };
  const sheetByName = new Map([
    [orders.getName(), orders],
    [old.getName(), old]
  ]);
  const book = {
    getSheetByName: (n) => sheetByName.get(n),
    insertSheet(n) {
      const s = sheet(n);
      sheetByName.set(n, s);
      return s;
    }
  };
  const books = new Map([['sheet', book]]);
  function newBook(id) {
    const tabs = new Map();
    const next = {
      getSheetByName: (name) => tabs.get(name),
      insertSheet(name) {
        const tab = sheet(name);
        tabs.set(name, tab);
        return tab;
      }
    };
    books.set(id, next);
    return next;
  }
  const makeItem = (tag, title, get) => ({
    asCheckboxItem() {
      return this;
    },
    asListItem() {
      return this;
    },
    getHelpText: () => tag,
    getTitle: () => title,
    getChoices: () => get().map((value) => ({ getValue: () => value }))
  });
  const form = {
    getDestinationId: () => props.RESPONSE_SHEET_ID,
    getItems: (type) =>
      type === 'c'
        ? [
            makeItem('[marc:catalog]', 'SKU catalogue', () => state.choices),
            ...(state.bannerChoices === null
              ? []
              : [makeItem('', 'Homepage banners', () => state.bannerChoices)]),
            ...(state.videoChoices === null
              ? []
              : [makeItem('[marc:hero-videos]', 'Campaign playlist', () => state.videoChoices)])
          ]
        : [makeItem('[marc:quantity]', 'Total quantity', () => state.sizes)],
    getDescription: () => 'Campus pickup',
    supportsAdvancedResponderPermissions: () => true,
    isPublished: () => true,
    isAcceptingResponses: () => state.open
  };
  const privateFile = {
    getSharingAccess: () => 'PRIVATE'
  };
  const folder = {
    getId: () => 'folder',
    getSharingAccess: () => (state.publicFolder ? 'ANYONE' : 'PRIVATE'),
    getFilesByName: (n) => ({
      hasNext: () => files.has(n),
      next: () => files.get(n)
    })
  };
  let nextDriveId = 0;
  const drive = {
    generateIds({ count }) {
      if (state.locked || count !== 1) throw Error('Generate proof IDs outside of the sheet lock.');
      return { ids: ['screenshot-' + ++nextDriveId] };
    },
    create(metadata, blob) {
      if (state.driveFailure) throw Error('Drive unavailable');
      if (state.locked) throw Error('The screenshot upload should not hold the sheet lock.');
      if (filesById.has(metadata.id)) throw Error('File already exists');
      const url = 'https://drive.google.com/file/d/' + metadata.id + '/view';
      const file = {
        ...privateFile,
        getId: () => metadata.id,
        getBlob: () => blob,
        getSize: () => blob.getBytes().length,
        getUrl: () => url
      };
      files.set(blob.name, file);
      filesById.set(metadata.id, file);
      if (state.driveLostReply) {
        state.driveLostReply = false;
        throw Error('Drive wrote the screenshot but the response was lost.');
      }
      return { id: metadata.id };
    }
  };
  const keyStore = {
    getProperties: () => ({ ...props }),
    getProperty: (k) => props[k] || null,
    setProperty: (k, v) => {
      props[k] = v;
    },
    deleteProperty: (k) => {
      delete props[k];
    }
  };
  const previousDigest = (value) =>
    createHash('sha256')
      .update(typeof value === 'string' ? value : Buffer.from(value))
      .digest();
  const script = vm.createContext({
    console: {
      log: (m) => messages.push(m),
      warn: (m) => messages.push(m),
      error: (m) => messages.push(m)
    },
    PropertiesService: { getScriptProperties: () => keyStore },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (txt) => ({
        text: txt,
        setMimeType() {
          return this;
        }
      })
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => {
          if (state.locked) return false;
          state.locked = true;
          return true;
        },
        waitLock: () => {
          state.locked = true;
        },
        releaseLock: () => {
          state.locked = false;
        }
      })
    },
    SpreadsheetApp: {
      openById: (id) => {
        if (!books.has(id)) throw Error('Spreadsheet does not exist.');
        return books.get(id);
      },
      flush: () => {
        if (files.size && state.flushFailureAfterDrive) {
          state.flushFailureAfterDrive = false;
          for (const row of orders.rows.slice(1)) {
            if (row[2] === 'Under review') {
              row[1] = '';
              row[2] = 'Saving proof';
              row[11] = '';
            }
          }
          throw Error('Pending Sheets write');
        }
      }
    },
    Drive: { Files: drive },
    DriveApp: {
      Access: { PRIVATE: 'PRIVATE' },
      getFolderById: () => folder,
      getFileById: (id) => {
        if (id.startsWith('screenshot-')) {
          if (!filesById.has(id)) throw Error('Screenshot does not exist.');
          return filesById.get(id);
        }
        return photos.get(id) ?? privateFile;
      }
    },
    FormApp: { ItemType: { CHECKBOX: 'c', LIST: 'l' }, openById: () => form },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: previousDigestAsBytes,
      getUuid: randomUUID,
      computeHmacSha256Signature: (data, key) =>
        Array.from(createHmac('sha256', key).update(data).digest()),
      base64Decode: (b) => Array.from(Buffer.from(b, 'base64')),
      base64Encode: (bytes) => Buffer.from(bytes).toString('base64'),
      newBlob: (bytes, mime, name) => {
        const data = Buffer.from(bytes);
        return { name, mime, getBytes: () => data, getDataAsString: () => data.toString('utf8') };
      }
    },
    UrlFetchApp: {
      fetch: (url, options) => {
        if (url === site + '/api/order-queue' && state.fetchQueue)
          return state.fetchQueue(options);
        if (url === props.VERCEL_DEPLOY_HOOK && options.method === 'post') {
          state.redeploys++;
          return { getResponseCode: () => 201, getContentText: () => '{}' };
        }
        if (url.startsWith(site + '/catalogue.json'))
          return {
            getResponseCode: () => 200,
            getContentText: () => JSON.stringify(state.deployed)
          };
        throw Error('Unexpected catalogue sync request.');
      }
    },
    ScriptApp: {
      getProjectTriggers: () => triggers,
      newTrigger: (name) => ({
        timeBased() {
          return this;
        },
        everyMinutes(n) {
          if (n !== (name === 'processOrderQueue' ? 1 : 5)) throw Error('wrong interval');
          return this;
        },
        create() {
          triggers.push({ getHandlerFunction: () => name });
        }
      }),
      deleteTrigger: (t) => {
        triggers.splice(triggers.indexOf(t), 1);
      }
    }
  });
  function previousDigestAsBytes(algorithm, value) {
    return Array.from(previousDigest(value));
  }
  vm.runInContext(body, script);
  const catalogue = () => JSON.parse(JSON.stringify(script.catalogue_(props)));
  state.deployed = catalogue();
  const replies = new Map();
  let receiptNumber = 0;
  async function fetcher(url, options = {}) {
    if (url === env.MARC_SCRIPT_URL) {
      const envelope = JSON.parse(options.body);
      const { action } = JSON.parse(envelope.payload);
      if (action === 'placeOrder') state.orderCalls++;
      if (action === 'catalogue') state.catalogueCalls++;
      const reply = JSON.parse(
        script.doPost({ postData: { contents: options.body } }).text
      );
      if (action === 'placeOrder' && state.lostReply) {
        state.lostReply = false;
        throw Error('Connection lost after storage responded');
      }
      if (action === 'placeOrder' && state.confirmFailure) {
        state.confirmFailure = false;
        return Response.json({
          ok: true,
          data: { ...reply.data, id: 'unmatched-id' }
        });
      }
      const location =
        'https://script.googleusercontent.com/macros/echo?receipt=' + ++receiptNumber;
      replies.set(location, reply);
      return new Response(null, { status: 302, headers: { location } });
    }
    if (url.startsWith('https://script.googleusercontent.com/')) {
      if (options.method !== 'GET' || options.body !== undefined)
        throw Error('Do not forward the signed POST to the redirect.');
      const reply = replies.get(url);
      replies.delete(url);
      return Response.json(reply);
    }
    if (url === site + '/catalogue.json') return Response.json(state.deployed);
    if (url === 'https://oauth2.googleapis.com/token') {
      state.lastOAuthTokenRequest = options.body;
      return Response.json({ access_token: 'test-google-token' });
    }
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo')
      return Response.json(state.profile);
    throw Error('Unexpected request ' + url);
  }
  return {
    env,
    state,
    script,
    orders,
    newBook,
    files,
    photos,
    props,
    fetcher,
    catalogue,
    triggers,
    messages
  };
}
