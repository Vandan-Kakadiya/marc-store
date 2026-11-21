/** MARC server-to-server receiver. Copy this file into a standalone Apps Script project. */
var ORDER_TAB = 'MARC Website Orders';
var HEADINGS = [
  'Order ID',
  'Submitted (UTC)',
  'Payment status',
  'Full name',
  'Verified email',
  'Phone',
  'Affiliation',
  'Roll number',
  'Items',
  'Total INR',
  'UPI transaction ID',
  'Private screenshot',
  'Submission fingerprint'
];
var ORDER_NUMBER_HEADER = 'MARC Order Number';
var SNAPSHOT_HEADER = 'MARC Receipt Snapshot';
var ORDER_ID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
var FORMATS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
var PROOF_LIMIT = 4 * 1024 * 1024;

function properties_() {
  return PropertiesService.getScriptProperties().getProperties();
}
function output_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
function hex_(bytes) {
  return bytes
    .map(function (b) {
      return ('0' + ((b + 256) % 256).toString(16)).slice(-2);
    })
    .join('');
}
function digest_(value) {
  return hex_(
    typeof value === 'string'
      ? Utilities.computeDigest(
          Utilities.DigestAlgorithm.SHA_256,
          value,
          Utilities.Charset.UTF_8
        )
      : Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value)
  );
}
function signedRequest_(raw, p) {
  if (
    !raw ||
    raw.length > 6500000 ||
    !/^[a-f0-9]{64}$/.test(p.MARC_SCRIPT_SECRET || '')
  )
    return null;
  var envelope = JSON.parse(raw);
  if (
    !envelope ||
    !Number.isSafeInteger(envelope.issuedAt) ||
    Math.abs(Date.now() - envelope.issuedAt) > 5 * 60000 ||
    typeof envelope.payload !== 'string' ||
    !/^[a-f0-9]{64}$/.test(envelope.signature || '')
  )
    return null;
  var expected = hex_(
    Utilities.computeHmacSha256Signature(
      String(envelope.issuedAt) + '\n' + envelope.payload,
      p.MARC_SCRIPT_SECRET,
      Utilities.Charset.UTF_8
    )
  );
  var difference = 0;
  for (var i = 0; i < expected.length; i++)
    difference |= expected.charCodeAt(i) ^ envelope.signature.charCodeAt(i);
  return difference === 0 ? JSON.parse(envelope.payload) : null;
}
function doPost(event) {
  var props = properties_(),
    request;
  try {
    request = signedRequest_(
      event && event.postData && event.postData.contents,
      props
    );
  } catch (badRequest) {}
  if (!request) return output_({ ok: false, code: 'unauthorized' });
  try {
    if (request.action === 'placeOrder')
      return output_(saveOrder_(props, request.data));
    if (request.action === 'listOrders')
      return output_(listOrders_(props, request.data));
    if (request.action === 'catalogue')
      return output_({ ok: true, data: catalogue_(props) });
    return output_({ ok: false, code: 'unknown_action' });
  } catch (error) {
    // Egress failures can be retried by order reference. No contact or payment data is logged.
    console.error(
      'MARC ' +
        request.action +
        ' failed (' +
        (error.marcCode || 'storage') +
        ').'
    );
    return output_({ ok: false, code: error.marcCode || 'storage' });
  }
}
function setupError_(message) {
  var error = new Error(message);
  error.marcCode = 'setup';
  throw error;
}
function private_(driveItem) {
  if (driveItem.getSharingAccess() !== DriveApp.Access.PRIVATE)
    setupError_(
      'Set General access to Restricted on the Sheet and the screenshot folder.'
    );
}
function orderBook_(p) {
  if (!p.RESPONSE_SHEET_ID) setupError_('Set RESPONSE_SHEET_ID.');
  private_(DriveApp.getFileById(p.RESPONSE_SHEET_ID));
  return SpreadsheetApp.openById(p.RESPONSE_SHEET_ID);
}
function orderColumns_(tab) {
  var lastColumn = Math.max(HEADINGS.length, tab.getLastColumn());
  var headers = tab.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  if (headers.slice(0, HEADINGS.length).join('|') !== HEADINGS.join('|'))
    setupError_('Restore the original headers in ' + ORDER_TAB + '.');
  var changed = false;
  var columns = [ORDER_NUMBER_HEADER, SNAPSHOT_HEADER].map(function (heading) {
    var existing = headers.indexOf(heading, HEADINGS.length) + 1;
    if (existing) return existing;
    var column = ++lastColumn;
    if (column > tab.getMaxColumns())
      tab.insertColumnsAfter(tab.getMaxColumns(), column - tab.getMaxColumns());
    tab.getRange(1, column).setValues([[heading]]).setFontWeight('bold');
    changed = true;
    return column;
  });
  if (changed) SpreadsheetApp.flush();
  return { number: columns[0], snapshot: columns[1] };
}
function openStorage_(p) {
  if (!p.SCREENSHOT_FOLDER_ID) setupError_('Set SCREENSHOT_FOLDER_ID.');
  var folder = DriveApp.getFolderById(p.SCREENSHOT_FOLDER_ID);
  private_(folder);
  var book = orderBook_(p);
  var tab = book.getSheetByName(ORDER_TAB) || book.insertSheet(ORDER_TAB);
  if (!tab.getLastRow()) {
    tab
      .getRange(1, 1, 1, HEADINGS.length)
      .setValues([HEADINGS])
      .setFontWeight('bold');
    tab.setFrozenRows(1);
    SpreadsheetApp.flush();
  }
  return {
    tab: tab,
    folder: folder,
    legacy: legacy_(book, p),
    columns: orderColumns_(tab)
  };
}
function legacy_(book, p) {
  if (!p.LEGACY_TAB) return null;
  var sheet = book.getSheetByName(p.LEGACY_TAB);
  if (!sheet || sheet.getName() === ORDER_TAB || !sheet.getLastColumn())
    setupError_('Check LEGACY_TAB.');
  var title = p.LEGACY_UTR_HEADER || 'UPI transaction ID (UTR)';
  var col =
    sheet
      .getRange(1, 1, 1, sheet.getLastColumn())
      .getDisplayValues()[0]
      .indexOf(title) + 1;
  if (!col) setupError_('Check the exact LEGACY_UTR_HEADER.');
  return { sheet: sheet, column: col };
}
function locate_(tab, col, value) {
  var n = tab.getLastRow() - 1;
  if (!n) return 0;
  var cell = tab
    .getRange(2, col, n, 1)
    .createTextFinder(value)
    .matchEntireCell(true)
    .findNext();
  return cell ? cell.getRow() : 0;
}
function textCell_(s) {
  return "'" + String(s == null ? '' : s);
}
function orderRow_(o, fingerprint, date, link) {
  var items = o.lines
    .map(function (line) {
      return (
        line.qty +
        ' × ' +
        line.name +
        ' / ' +
        line.colour +
        ' / ' +
        line.size +
        ' [' +
        line.sku +
        ']'
      );
    })
    .join('\n');
  return [
    o.id,
    date,
    date ? 'Under review' : 'Saving proof',
    textCell_(o.contact.name),
    textCell_(o.contact.email),
    textCell_(o.contact.phone),
    textCell_(o.contact.affiliation),
    textCell_(o.contact.roll),
    textCell_(items),
    o.total / 100,
    textCell_(o.utr),
    link,
    fingerprint
  ];
}
function proof_(o) {
  if (
    !o ||
    !ORDER_ID_PATTERN.test(o.id || '') ||
    !/^\d{12}$/.test(o.utr || '') ||
    !o.contact ||
    !o.buyer ||
    !Array.isArray(o.lines) ||
    !o.lines.length ||
    !Number.isSafeInteger(o.total) ||
    o.total <= 0 ||
    !o.proof ||
    !Object.prototype.hasOwnProperty.call(FORMATS, o.proof.mime) ||
    typeof o.proof.base64 !== 'string' ||
    o.proof.base64.length > Math.ceil(PROOF_LIMIT / 3) * 4
  )
    throw Error('Invalid order.');
  var bytes = Utilities.base64Decode(o.proof.base64);
  if (!bytes.length || bytes.length > PROOF_LIMIT)
    throw Error('Invalid screenshot.');
  var hash = digest_(bytes);
  var fingerprint = digest_(
    JSON.stringify([
      o.id,
      o.buyer,
      o.contact,
      o.lines,
      o.total,
      o.payee,
      o.utr,
      o.proof.mime,
      hash
    ])
  );
  return {
    bytes: bytes,
    hash: hash,
    fingerprint: fingerprint,
    mime: o.proof.mime
  };
}
function driveCopy_(folder, o, evidence) {
  var extension = '.' + FORMATS[evidence.mime];
  var name = String(o.contact.name || '')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  var filename =
    [orderGroup_(o.contact.affiliation, o.contact.roll), name || 'Buyer', o.id]
      .join('_') + extension;
  var existing = folder.getFilesByName(filename);
  if (!existing.hasNext())
    existing = folder.getFilesByName('MARC-' + o.id + '-' + evidence.hash + extension);
  var alreadySaved = existing.hasNext();
  var file = alreadySaved
    ? existing.next()
    : folder.createFile(
        Utilities.newBlob(evidence.bytes, evidence.mime, filename)
      );
  private_(file);
  if (
    file.getSize() !== evidence.bytes.length ||
    (alreadySaved && digest_(file.getBlob().getBytes()) !== evidence.hash)
  )
    throw Error('Screenshot could not be confirmed.');
  return file.getUrl();
}
function orderGroup_(affiliation, roll) {
  if (/^[0-9]{6}$/.test(String(roll))) return String(roll);
  return affiliation === 'Staff' ? 'STAFF' : 'OTHER';
}
function buyerKey_(buyer) {
  return digest_('MARC Google account\n' + buyer);
}
function orderSnapshot_(key, lines) {
  var snapshot = JSON.stringify({ key: key, lines: lines });
  return snapshot.length <= 48000
    ? snapshot
    : JSON.stringify({ key: key, lines: [] });
}
function orderRows_(tab, columns) {
  var count = tab.getLastRow() - 1;
  return count > 0
    ? tab.getRange(2, 1, count, Math.max(columns.number, columns.snapshot)).getValues()
    : [];
}
function savedOrder_(row) {
  return ORDER_ID_PATTERN.test(row[0]) && row[1] && row[11];
}
function nextOrderNumber_(tab, columns, contact) {
  var group = orderGroup_(contact.affiliation, contact.roll);
  var prefix = 'MARC_' + group + '_';
  var count = 0, highest = 0;
  orderRows_(tab, columns).forEach(function (row) {
    if (!savedOrder_(row)) return;
    if (orderGroup_(row[6], row[7]) === group) count++;
    var number = row[columns.number - 1];
    if (typeof number === 'string' && number.indexOf(prefix) === 0) {
      var sequence = Number(number.slice(prefix.length));
      if (Number.isSafeInteger(sequence)) highest = Math.max(highest, sequence);
    }
  });
  return prefix + (Math.max(count, highest) + 1);
}
function listOrders_(p, identity) {
  if (!identity || typeof identity.buyer !== 'string' || !identity.buyer)
    return { ok: false, code: 'invalid_buyer' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(4000)) return { ok: false, code: 'busy' };
  try {
    var tab = orderBook_(p).getSheetByName(ORDER_TAB);
    if (!tab || tab.getLastRow() < 2) return { ok: true, data: [] };
    var columns = orderColumns_(tab);
    var key = buyerKey_(identity.buyer);
    var email = String(identity.email || '').trim().toLowerCase();
    var proven = new Set(Array.isArray(identity.orderIds) ? identity.orderIds : []);
    var orders = [], migrated = false;
    orderRows_(tab, columns).forEach(function (row, index) {
      if (!savedOrder_(row)) return;
      var when = row[1] instanceof Date ? row[1].getTime() : Date.parse(row[1]);
      var total = Math.round(Number(row[9]) * 100);
      if (!Number.isFinite(when) || !Number.isSafeInteger(total) || total < 1)
        return;
      var snapshot = row[columns.snapshot - 1];
      var lines = [];
      if (snapshot) {
        var saved;
        try {
          saved = JSON.parse(snapshot);
        } catch (invalidSnapshot) {
          return;
        }
        if (!saved || saved.key !== key) return;
        if (Array.isArray(saved.lines)) lines = saved.lines;
      } else {
        var matchingEmail = email && String(row[4]).trim().toLowerCase() === email;
        if (!proven.has(row[0]) && !matchingEmail)
          return;
        tab.getRange(index + 2, columns.snapshot).setValues([[orderSnapshot_(key, [])]]);
        migrated = true;
      }
      orders.push({
        id: row[0],
        number: String(row[columns.number - 1] || row[0]),
        submittedAt: new Date(when).toISOString(),
        paymentStatus: String(row[2] || 'Under review'),
        total: total,
        lines: lines,
        items: lines.length ? '' : String(row[8] || '')
      });
    });
    if (migrated) SpreadsheetApp.flush();
    orders.sort(function (a, b) {
      return b.submittedAt.localeCompare(a.submittedAt) || a.id.localeCompare(b.id);
    });
    return { ok: true, data: orders };
  } finally {
    lock.releaseLock();
  }
}
function savedReceipt_(id, row, number) {
  return {
    ok: true,
    data: { id: id, number: number || id, submittedAt: row[1], status: 'under_review' }
  };
}
function saveOrder_(p, o) {
  var evidence = proof_(o);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(12000)) return { ok: false, code: 'busy' };
  try {
    var storage = openStorage_(p),
      tab = storage.tab,
      columns = storage.columns,
      row = locate_(tab, 1, o.id);
    if (row) {
      var previous = tab
        .getRange(row, 1, 1, HEADINGS.length)
        .getDisplayValues()[0];
      if (previous[12] !== evidence.fingerprint)
        return { ok: false, code: 'retry_different' };
      if (previous[1] && previous[11]) {
        var previousNumber = tab.getRange(row, columns.number).getDisplayValues()[0][0];
        return savedReceipt_(o.id, previous, previousNumber);
      }
    } else {
      if (
        locate_(tab, 11, o.utr) ||
        (storage.legacy &&
          locate_(storage.legacy.sheet, storage.legacy.column, o.utr))
      )
        return { ok: false, code: 'reference_in_use' };
      row = tab.getLastRow() + 1;
      tab.getRange(row, 2).setNumberFormat('@');
      tab.getRange(row, 11).setNumberFormat('@');
      tab
        .getRange(row, 1, 1, HEADINGS.length)
        .setValues([orderRow_(o, evidence.fingerprint, '', '')]);
      SpreadsheetApp.flush();
    }

    var link = driveCopy_(storage.folder, o, evidence);
    row = locate_(tab, 1, o.id);
    if (!row) throw Error('Order row is unavailable.');
    var when = new Date().toISOString();
    var number = nextOrderNumber_(tab, columns, o.contact);
    var snapshot = orderSnapshot_(buyerKey_(o.buyer), o.lines);
    tab.getRange(row, columns.number).setValues([[number]]);
    tab.getRange(row, columns.snapshot).setValues([[snapshot]]);
    var cells = tab.getRange(row, 1, 1, HEADINGS.length);
    cells.setValues([orderRow_(o, evidence.fingerprint, when, link)]);
    SpreadsheetApp.flush();
    var saved = tab
      .getRange(row, 1, 1, Math.max(columns.number, columns.snapshot))
      .getDisplayValues()[0];
    if (
      saved[0] !== o.id ||
      saved[1] !== when ||
      saved[11] !== link ||
      saved[12] !== evidence.fingerprint ||
      saved[columns.number - 1] !== number ||
      saved[columns.snapshot - 1] !== snapshot
    )
      throw Error('The order row could not be confirmed.');
    return savedReceipt_(o.id, saved, number);
  } finally {
    lock.releaseLock();
  }
}

function taggedItem_(form, type, tag, title, asTyped) {
  var items = form.getItems(type).map(asTyped);
  var tagged = items.filter(function (item) {
    return (item.getHelpText() || '')
      .toLowerCase()
      .includes('[marc:' + tag + ']');
  });
  var found = tagged.length
    ? tagged
    : items.filter(function (item) {
        return item.getTitle().trim().toLowerCase() === title;
      });
  if (found.length !== 1)
    throw Error('Check the ' + title + ' question and its type.');
  return found[0];
}
function localImage_(raw) {
  if (!raw) return '';
  if (safeHTTPS_(raw)) return raw;
  var decoded = decodeURIComponent(raw.replace(/^\.\//, ''));
  if (
    !/^assets\/[A-Za-z0-9_ ./()-]+$/.test(decoded) ||
    decoded.split('/').some(function (part) {
      return !part || part === '.' || part === '..';
    })
  )
    throw Error('Use an assets/ path or a direct HTTPS image URL.');
  return decoded.split('/').map(encodeURIComponent).join('/');
}
function safeHTTPS_(v) {
  return (
    typeof v === 'string' &&
    v.length <= 1500 &&
    /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?\/[^\s<>"]+$/.test(v)
  );
}
function parseSku_(line) {
  var fields = String(line)
    .split('|')
    .map(function (s) {
      return s.trim();
    });
  if (
    fields.length < 5 ||
    fields.length > 6 ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(fields[0]) ||
    !fields[1] ||
    fields[1].length > 140 ||
    !fields[2] ||
    fields[2].length > 100 ||
    !fields[3] ||
    fields[3].length > 60 ||
    /[\x00-\x1f\x7f]/.test(fields.slice(1, 4).join('')) ||
    !/^\d{1,7}(\.\d{1,2})?$/.test(fields[4]) ||
    Number(fields[4]) <= 0 ||
    Number(fields[4]) > 1000000
  )
    throw Error(
      'Check the SKU format and price for ' +
        (fields[0] || 'the empty option') +
        '.'
    );
  var price = fields[4].split('.');
  var image = localImage_(fields[5] || '');
  if (!image && /\bpolos?\b/i.test(fields[1])) {
    if (/^white$/i.test(fields[2])) image = 'assets/polo-white.png';
    if (/^(maroon|burgundy)$/i.test(fields[2]))
      image = 'assets/polo-maroon.png';
  }
  return {
    sku: fields[0],
    name: fields[1],
    colour: fields[2],
    size: fields[3],
    paise:
      Number(price[0]) * 100 + Number(((price[1] || '') + '00').slice(0, 2)),
    image: image
  };
}
function products_(rows) {
  if (rows.length > 1000)
    throw Error('The catalogue has too many SKU options.');
  var codes = new Set(),
    sizes = new Set(),
    groups = new Map();
  rows.forEach(function (choice) {
    var row = parseSku_(choice.getValue());
    var group = JSON.stringify([
      row.name.toLowerCase(),
      row.colour.toLowerCase()
    ]);
    var size = group + ':' + row.size.toLowerCase();
    if (codes.has(row.sku) || sizes.has(size))
      throw Error('Duplicate SKU or size: ' + row.sku);
    codes.add(row.sku);
    sizes.add(size);
    var product = groups.get(group);
    if (!product) {
      product = {
        id: digest_(group).slice(0, 24),
        name: row.name,
        colour: row.colour,
        image: row.image,
        skus: []
      };
      groups.set(group, product);
    }
    if (product.image !== row.image)
      throw Error('Use one photo for each product and colour.');
    product.skus.push({ sku: row.sku, size: row.size, paise: row.paise });
  });
  if (groups.size > 500)
    throw Error('The catalogue has too many product groups.');
  return Array.from(groups.values());
}
function catalogue_(p) {
  if (!p.FORM_ID) setupError_('Set FORM_ID to the existing Google Form.');
  var form = FormApp.openById(p.FORM_ID);
  var draft = {
    apiVersion: 3,
    ready: false,
    products: [],
    maxItems: 5,
    terms: '',
    payment: null
  };
  try {
    var choices = taggedItem_(
      form,
      FormApp.ItemType.CHECKBOX,
      'catalog',
      'sku catalogue',
      function (i) {
        return i.asCheckboxItem();
      }
    ).getChoices();
    var limits = taggedItem_(
      form,
      FormApp.ItemType.LIST,
      'quantity',
      'total quantity',
      function (i) {
        return i.asListItem();
      }
    ).getChoices();
    if (
      !limits.length ||
      limits.length > 100 ||
      limits.some(function (c, i) {
        return Number(c.getValue()) !== i + 1;
      })
    )
      throw Error('Use quantity choices 1, 2, 3 and so on.');
    draft.products = products_(choices);
    draft.maxItems = limits.length;
    draft.terms = (form.getDescription() || '').slice(0, 12000);
    var published =
      !form.supportsAdvancedResponderPermissions() || form.isPublished();
    var payee = (p.PAYEE_NAME || '').trim(),
      upi = (p.UPI_ID || '').trim();
    if (
      !payee ||
      payee.length > 120 ||
      upi.length > 160 ||
      !safeHTTPS_(p.PAYMENT_QR_URL)
    )
      throw Error('Check the configured QR link and payee.');
    draft.payment = { qr: p.PAYMENT_QR_URL, payee: payee, upi: upi };
    draft.ready =
      published && form.isAcceptingResponses() && draft.products.length > 0;
  } catch (error) {
    console.warn('Catalogue paused. ' + error.message);
  }
  draft.version = digest_(JSON.stringify(draft));
  return draft;
}

/** Run in the editor. Checks that your existing Google Form points to the Sheet you configured. */
function checkOrderStorage() {
  var p = properties_();
  if (!/^[a-f0-9]{64}$/.test(p.MARC_SCRIPT_SECRET || ''))
    setupError_('Set MARC_SCRIPT_SECRET to your random 64-character hex key.');
  var form = FormApp.openById(p.FORM_ID);
  if (form.getDestinationId() !== p.RESPONSE_SHEET_ID)
    setupError_('RESPONSE_SHEET_ID must be the Form’s linked spreadsheet ID.');
  var lock = LockService.getScriptLock();
  lock.waitLock(12000);
  try {
    openStorage_(p);
  } finally {
    lock.releaseLock();
  }
  var catalog = catalogue_(p);
  console.log(
    'Order storage is ready. ' +
      catalog.products.length +
      ' products. Ordering is ' +
      (catalog.ready ? 'open' : 'paused') +
      '.'
  );
}

/** Called on an owner-managed timer. Redeploy only when the Form-derived catalogue changes. */
function publishCatalogueIfChanged() {
  var props = PropertiesService.getScriptProperties(),
    p = props.getProperties();
  var address = (p.STOREFRONT_URL || '').replace(/\/+$/, '');
  if (
    !/^https:\/\/[A-Za-z0-9.-]+$/.test(address) ||
    !/^https:\/\/api\.vercel\.com\/v1\/integrations\/deploy\/[A-Za-z0-9/_-]+$/.test(
      p.VERCEL_DEPLOY_HOOK || ''
    )
  )
    throw Error('Check STOREFRONT_URL and VERCEL_DEPLOY_HOOK.');
  var catalog = catalogue_(p);
  var current = UrlFetchApp.fetch(
    address + '/catalogue.json?checked=' + Date.now(),
    { muteHttpExceptions: true, followRedirects: false }
  );
  if (current.getResponseCode() !== 200)
    throw Error('Deploy this release once before installing catalogue sync.');
  if (JSON.parse(current.getContentText()).version === catalog.version) {
    props.deleteProperty('LAST_DEPLOY_REQUEST');
    return;
  }
  var last = JSON.parse(p.LAST_DEPLOY_REQUEST || 'null');
  if (
    last &&
    last.version === catalog.version &&
    Date.now() - last.time < 15 * 60000
  )
    return;
  var response = UrlFetchApp.fetch(p.VERCEL_DEPLOY_HOOK, {
    method: 'post',
    muteHttpExceptions: true,
    followRedirects: false
  });
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300)
    throw Error('Vercel did not accept the catalogue deployment hook.');
  props.setProperty(
    'LAST_DEPLOY_REQUEST',
    JSON.stringify({ version: catalog.version, time: Date.now() })
  );
  console.log('Catalogue deployment requested.');
}
function installCatalogueSync() {
  publishCatalogueIfChanged();
  var triggers = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'publishCatalogueIfChanged';
  });
  if (!triggers.length)
    ScriptApp.newTrigger('publishCatalogueIfChanged')
      .timeBased()
      .everyMinutes(5)
      .create();
  triggers.slice(1).forEach(function (t) {
    ScriptApp.deleteTrigger(t);
  });
  console.log('Five-minute background catalogue check is installed.');
}
