/** MARC server-to-server receiver. Copy this file into a standalone Apps Script project. */
var ORDER_TAB = 'MARC Website Orders';
var PAYMENT_SCREENSHOT_HEADER = 'Payment screenshot';
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
  PAYMENT_SCREENSHOT_HEADER,
  'Submission fingerprint'
];
var ORDER_NUMBER_HEADER = 'MARC Order Number';
var SNAPSHOT_HEADER = 'MARC Receipt Snapshot';
var PAID_WITH_HEADER = 'Paid with';
var UPI_REFERENCE_HEADER = 'UPI order reference';
var PRINT_NAME_HEADER = 'Name to print (optional)';
var PRINT_NUMBER_HEADER = 'Number to print (optional)';
var EXTRA_HEADERS = {
  number: ORDER_NUMBER_HEADER,
  snapshot: SNAPSHOT_HEADER,
  paidWith: PAID_WITH_HEADER,
  upiReference: UPI_REFERENCE_HEADER,
  printName: PRINT_NAME_HEADER,
  printNumber: PRINT_NUMBER_HEADER,
  proofId: 'MARC Proof File ID'
};
var BANK_TRANSFER = 'Bank transfer (NEFT / IMPS / RTGS)';
var PAYMENT_METHODS = ['GPay', 'PhonePe', 'Paytm', 'CRED', BANK_TRANSFER, 'Others'];
var ORDER_ID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
var FORMATS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
var PROOF_LIMIT = 4 * 1024 * 1024;
var PRODUCT_PHOTO_LIMIT = 4 * 1024 * 1024;
var ORDER_ROUTE_FIELDS = [
  'RESPONSE_SHEET_ID', 'SCREENSHOT_FOLDER_ID', 'LEGACY_SHEET_ID', 'LEGACY_TAB', 'LEGACY_UTR_HEADER'
];

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
    if (request.action === 'reserveQueuedOrder')
      return output_(reserveQueuedOrder_(props, request.data));
    if (request.action === 'accountState')
      return output_(accountState_(props, request.data));
    if (request.action === 'listOrders')
      return output_(listOrders_(props, request.data));
    if (request.action === 'findSavedOrder')
      return output_(findSavedOrder_(props, request.data));
    if (request.action === 'catalogue')
      return output_({ ok: true, data: catalogue_(props) });
    if (request.action === 'productPhoto')
      return output_({ ok: true, data: readProductPhoto_(props, request.data) });
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
function activeAccountState_(value, now) {
  var entry = JSON.parse(value || 'null');
  return entry && entry.expires > now ? entry : null;
}
function pruneAccountState_(store, now) {
  if (Number(store.getProperty('MARC_ACCOUNT_SWEEP') || 0) > now) return;
  var properties = store.getProperties();
  Object.keys(properties).forEach(function (key) {
    if (/^MARC_ACCOUNT_(session|bag)_[a-f0-9]{64}$/.test(key) &&
        !activeAccountState_(properties[key], now)) store.deleteProperty(key);
  });
  store.setProperty('MARC_ACCOUNT_SWEEP', String(now + 3600000));
}
function accountState_(properties, request) {
  var kind = request.kind, action = request.action;
  if (!['session', 'bag'].includes(kind) || !/^[a-f0-9]{64}$/.test(request.key || ''))
    return { ok: false, code: 'invalid' };
  var key = 'MARC_ACCOUNT_' + kind + '_' + request.key;
  if (action === 'read') return { ok: true, data: activeAccountState_(properties[key], Date.now()) };

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { ok: false, code: 'busy' };
  try {
    var store = PropertiesService.getScriptProperties(), now = Date.now();
    var current = activeAccountState_(store.getProperty(key), now);
    var version = current ? current.version : null;
    if (request.expected !== undefined && request.expected !== version)
      return { ok: false, code: 'conflict' };
    if (action === 'remove' && typeof request.expected === 'string') {
      store.deleteProperty(key);
      return { ok: true, data: true };
    }
    if (action !== 'write' || !request.value || typeof request.value !== 'object')
      return { ok: false, code: 'invalid' };
    var entry = {
      version: Utilities.getUuid(),
      expires: now + (kind === 'session' ? 3600000 : 30 * 86400000),
      value: request.value
    };
    var encoded = JSON.stringify(entry);
    if (encoded.length > 8700) return { ok: false, code: 'invalid' };
    pruneAccountState_(store, now);
    store.setProperty(key, encoded);
    return { ok: true, data: entry };
  } finally {
    lock.releaseLock();
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
function privateBook_(id) {
  private_(DriveApp.getFileById(id));
  return SpreadsheetApp.openById(id);
}
function orderBook_(p) {
  if (!p.RESPONSE_SHEET_ID) setupError_('Set RESPONSE_SHEET_ID to the order spreadsheet ID.');
  return privateBook_(p.RESPONSE_SHEET_ID);
}
function orderRoute_(p) {
  var route = {};
  ORDER_ROUTE_FIELDS.forEach(function (field) { route[field] = p[field] || ''; });
  return route;
}
function collectionKey_(p, route) {
  return digest_(JSON.stringify(['MARC collection', p.FORM_ID, route]));
}
function orderProperties_(p, collection) {
  var key = collection || p.ORDER_LEGACY_COLLECTION;
  if (!key) return p;
  if (!/^[a-f0-9]{64}$/.test(key) || !p['ORDER_COLLECTION_' + key])
    setupError_('Register the order spreadsheet for this collection.');
  return JSON.parse(p['ORDER_COLLECTION_' + key]);
}
function orderColumns_(tab) {
  var lastColumn = Math.max(HEADINGS.length, tab.getLastColumn());
  var headers = tab.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  var screenshotIndex = HEADINGS.indexOf(PAYMENT_SCREENSHOT_HEADER);
  var renameScreenshot = headers[screenshotIndex] === 'Private screenshot';
  if (renameScreenshot) headers[screenshotIndex] = PAYMENT_SCREENSHOT_HEADER;
  if (headers.slice(0, HEADINGS.length).join('|') !== HEADINGS.join('|'))
    setupError_('Restore the original headers in ' + ORDER_TAB + '.');
  if (renameScreenshot)
    tab.getRange(1, screenshotIndex + 1).setValues([[PAYMENT_SCREENSHOT_HEADER]]);
  var changed = renameScreenshot;
  var columns = {};
  Object.entries(EXTRA_HEADERS).forEach(function (entry) {
    var key = entry[0], heading = entry[1];
    var existing = headers.indexOf(heading, HEADINGS.length) + 1;
    if (existing) {
      columns[key] = existing;
      return;
    }
    var column = ++lastColumn;
    if (column > tab.getMaxColumns())
      tab.insertColumnsAfter(tab.getMaxColumns(), column - tab.getMaxColumns());
    tab.getRange(1, column).setValues([[heading]]).setFontWeight('bold');
    changed = true;
    columns[key] = column;
  });
  if (changed) SpreadsheetApp.flush();
  return columns;
}
function existingOrderColumns_(tab) {
  var headers = tab
    .getRange(1, 1, 1, Math.max(HEADINGS.length, tab.getLastColumn()))
    .getDisplayValues()[0];
  if (headers.slice(0, HEADINGS.length).join('|') !== HEADINGS.join('|')) return null;
  var columns = {};
  var missing = Object.keys(EXTRA_HEADERS).some(function (key) {
    columns[key] = headers.indexOf(EXTRA_HEADERS[key], HEADINGS.length) + 1;
    return !columns[key];
  });
  return missing ? null : columns;
}
/** Drive checks and opening the spreadsheet change nothing, so they run without the lock. */
function storageHandles_(p) {
  if (!p.SCREENSHOT_FOLDER_ID) setupError_('Set SCREENSHOT_FOLDER_ID.');
  var folder = DriveApp.getFolderById(p.SCREENSHOT_FOLDER_ID);
  private_(folder);
  return { folder: folder, book: orderBook_(p) };
}
/** Returns the order tab, creating it on first use. Call with the script lock held. */
function orderTab_(book) {
  var tab = book.getSheetByName(ORDER_TAB) || book.insertSheet(ORDER_TAB);
  if (!tab.getLastRow()) {
    tab
      .getRange(1, 1, 1, HEADINGS.length)
      .setValues([HEADINGS])
      .setFontWeight('bold');
    tab.setFrozenRows(1);
    SpreadsheetApp.flush();
  }
  return tab;
}
function openStorage_(p) {
  var handles = storageHandles_(p);
  var tab = orderTab_(handles.book);
  return {
    tab: tab,
    folder: handles.folder,
    legacy: legacy_(handles.book, p),
    columns: orderColumns_(tab)
  };
}
function legacy_(book, p) {
  if (!p.LEGACY_TAB) {
    if (p.LEGACY_SHEET_ID) setupError_('Set LEGACY_TAB to the archived orders tab name.');
    return null;
  }
  if (p.LEGACY_SHEET_ID && p.LEGACY_SHEET_ID !== p.RESPONSE_SHEET_ID)
    book = privateBook_(p.LEGACY_SHEET_ID);
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
  if (n <= 0) return 0;
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
function orderItems_(lines, legacyPrint) {
  return lines
    .map(function (line) {
      var item = (
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
      if (!legacyPrint || !line.print) return item;
      var details = line.print.map(function (entry, index) {
        var values = [];
        if (entry.name) values.push('Name: ' + entry.name);
        if (entry.number) values.push('Number: ' + entry.number);
        var unit = line.qty > 1 ? 'Item ' + (index + 1) + ' · ' : '';
        return '  ' + unit + values.join(' · ');
      });
      return [item].concat(details).join('\n');
    })
    .join('\n');
}
function printColumns_(lines) {
  var names = [], numbers = [];
  var singleItem = lines.length === 1 && lines[0].qty === 1;
  lines.forEach(function (line) {
    (line.print || []).forEach(function (entry, index) {
      var item = singleItem
        ? ''
        : line.sku + (line.qty > 1 ? ' #' + (index + 1) : '') + ' · ';
      if (entry.name) names.push(item + entry.name);
      if (entry.number) numbers.push(item + entry.number);
    });
  });
  return { name: names.join('\n'), number: numbers.join('\n') };
}
function writePrintColumns_(tab, row, columns, print) {
  if (print.name)
    tab.getRange(row, columns.printName).setValues([[textCell_(print.name)]]);
  if (print.number)
    tab.getRange(row, columns.printNumber)
      .setNumberFormat('@')
      .setValues([[textCell_(print.number)]]);
}
function orderRow_(o, fingerprint, date, link) {
  return [
    o.id,
    date,
    date ? 'Under review' : 'Saving proof',
    textCell_(o.contact.name),
    textCell_(o.contact.email),
    textCell_(o.contact.phone),
    textCell_(o.contact.affiliation),
    textCell_(o.contact.roll),
    textCell_(orderItems_(o.lines)),
    o.total / 100,
    textCell_(o.utr),
    link,
    fingerprint
  ];
}
function validateOrder_(o) {
  var paidWith = (o && o.paidWith) || '';
  var upiReference = (o && o.upiReference) || '';
  var referencePattern = paidWith === BANK_TRANSFER
    ? /^[A-Z0-9]{6,40}$/
    : /^[0-9]{12}$/;
  if (
    !o ||
    !ORDER_ID_PATTERN.test(o.id || '') ||
    typeof o.utr !== 'string' ||
    !referencePattern.test(o.utr) ||
    (paidWith && !PAYMENT_METHODS.includes(paidWith)) ||
    (upiReference && (!paidWith || paidWith === BANK_TRANSFER ||
      typeof upiReference !== 'string' || !/^MARC[A-F0-9]{28}$/.test(upiReference))) ||
    !o.contact ||
    !o.buyer ||
    !Array.isArray(o.lines) ||
    !o.lines.length ||
    !Number.isSafeInteger(o.total) ||
    o.total <= 0 ||
    !o.proof ||
    !Object.prototype.hasOwnProperty.call(FORMATS, o.proof.mime)
  )
    throw Error('Invalid order.');
}
function submissionEvidence_(o, hash) {
  var paidWith = o.paidWith || '';
  var upiReference = o.upiReference || '';
  var submission = [
    o.id, o.buyer, o.contact, o.lines, o.total, o.payee, o.utr, o.proof.mime, hash
  ];
  var earlierSubmission = '';
  if (paidWith) {
    // The earlier receiver accepted the same order without recording its payment method.
    if (!upiReference) earlierSubmission = JSON.stringify(submission);
    submission.push(paidWith);
  }
  if (upiReference) submission.push(upiReference);
  var fingerprint = digest_(JSON.stringify(submission));
  return {
    hash: hash,
    fingerprint: fingerprint,
    earlierSubmission: earlierSubmission,
    mime: o.proof.mime
  };
}
function proof_(o, uploadedBytes) {
  validateOrder_(o);
  if (!uploadedBytes && (typeof o.proof.base64 !== 'string' ||
      o.proof.base64.length > Math.ceil(PROOF_LIMIT / 3) * 4))
    throw Error('Invalid screenshot.');
  var bytes = uploadedBytes || Utilities.base64Decode(o.proof.base64);
  if (!bytes.length || bytes.length > PROOF_LIMIT)
    throw Error('Invalid screenshot.');
  var evidence = submissionEvidence_(o, digest_(bytes));
  evidence.bytes = bytes;
  return evidence;
}
function proofFilename_(o, mime) {
  var name = String(o.contact.name || '')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return [orderGroup_(o.contact.affiliation, o.contact.roll), name || 'Buyer', o.id]
    .join('_') + '.' + FORMATS[mime];
}
function existingProof_(folder, o, evidence) {
  var existing = folder.getFilesByName(proofFilename_(o, evidence.mime));
  if (!existing.hasNext())
    existing = folder.getFilesByName('MARC-' + o.id + '-' + evidence.hash + '.' + FORMATS[evidence.mime]);
  return existing.hasNext() ? existing.next() : null;
}
function driveCopy_(folder, o, evidence, id) {
  return writeDriveFile_(folder, proofFilename_(o, evidence.mime), evidence.bytes,
    evidence.mime, evidence.hash, id);
}
function writeDriveFile_(folder, name, bytes, mime, hash, id) {
  var alreadySaved = false;
  try {
    Drive.Files.create({ id: id, name: name, parents: [folder.getId()] },
      Utilities.newBlob(bytes, mime, name), { fields: 'id', supportsAllDrives: true });
  } catch (error) {
    // The upload may already have committed. Reuse the exact reserved file ID.
    alreadySaved = true;
  }
  var file = DriveApp.getFileById(id);
  private_(file);
  if (
    file.getSize() !== bytes.length ||
    (alreadySaved && digest_(file.getBlob().getBytes()) !== hash)
  )
    throw Error('File could not be confirmed in Drive.');
  return file.getUrl();
}
function orderGroup_(affiliation, roll) {
  if (/^[0-9]{6,7}$/.test(String(roll))) return String(roll);
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
function savedOrder_(row) {
  return ORDER_ID_PATTERN.test(row[0]) && row[1] && row[11];
}
function nextOrderNumber_(tab, columns, contact) {
  var group = orderGroup_(contact.affiliation, contact.roll);
  var prefix = 'MARC_' + group + '_';
  var count = 0, highest = 0;
  var rowCount = tab.getLastRow() - 1;
  if (!rowCount) return prefix + '1';
  // Keep a single Sheet call for small sales. For larger sales read only the
  // columns needed for numbering, leaving names, emails and item text in Sheets.
  var small = rowCount <= 100 ? tab.getRange(2, 1, rowCount, columns.number).getValues() : null;
  function values(column, width) {
    return small ? small.map(function (row) { return row.slice(column - 1, column - 1 + width); })
      : tab.getRange(2, column, rowCount, width).getValues();
  }
  var ids = values(1, 1), groups = values(7, 2), numbers = values(columns.number, 1);
  var matchingRows = [];
  ids.forEach(function (row, index) {
    if (!ORDER_ID_PATTERN.test(row[0])) return;
    if (orderGroup_(groups[index][0], groups[index][1]) === group) matchingRows.push(index);
    var number = numbers[index][0];
    if (typeof number === 'string' && number.indexOf(prefix) === 0) {
      var sequence = Number(number.slice(prefix.length));
      if (Number.isSafeInteger(sequence)) highest = Math.max(highest, sequence);
    }
  });
  // Older rows can predate MARC order numbers. Count completed rows only
  // when their count could actually raise the next number.
  if (matchingRows.length > highest) {
    var dates = values(2, 1), links = values(12, 1);
    matchingRows.forEach(function (index) { if (dates[index][0] && links[index][0]) count++; });
  }
  return prefix + (Math.max(count, highest) + 1);
}
function receiptRows_(tab, columns, key, email, proven) {
  var count = tab.getLastRow() - 1;
  if (count < 1) return [];
  var blocks = [[2, count]];
  if (count > 100) {
    // A snapshot stores the Google account digest as literal JSON text.
    var candidates = new Set(tab.getRange(2, columns.snapshot, count, 1)
      .createTextFinder(key).findAll().map(function (cell) { return cell.getRow(); }));
    if (email)
      tab.getRange(2, 5, count, 1).getValues().forEach(function (row, index) {
        if (String(row[0]).trim().toLowerCase() === email) candidates.add(index + 2);
      });
    if (proven.size)
      tab.getRange(2, 1, count, 1).getValues().forEach(function (row, index) {
        if (proven.has(row[0])) candidates.add(index + 2);
      });
    var sorted = Array.from(candidates).sort(function (a, b) { return a - b; });
    blocks = [];
    sorted.forEach(function (row) {
      var last = blocks[blocks.length - 1];
      if (last && last[0] + last[1] === row) last[1]++;
      else blocks.push([row, 1]);
    });
    // Coalesce widely scattered matches to bound spreadsheet service calls.
    if (blocks.length > 8)
      blocks = [[sorted[0], sorted[sorted.length - 1] - sorted[0] + 1]];
  }
  var width = Math.max(columns.number, columns.snapshot);
  return blocks.flatMap(function (block) {
    return tab.getRange(block[0], 1, block[1], width).getValues().map(function (values, index) {
      return { row: block[0] + index, values: values };
    });
  });
}
function findSavedOrder_(p, identity) {
  if (!identity || !ORDER_ID_PATTERN.test(identity.id || '') ||
      typeof identity.buyer !== 'string' || !identity.buyer)
    return { ok: false, code: 'invalid_buyer' };
  var route = orderProperties_(p, identity.collection);
  var tab = orderBook_(route).getSheetByName(ORDER_TAB);
  var rowNumber = tab && locate_(tab, 1, identity.id);
  if (!rowNumber) return { ok: true, data: null };
  var columns = existingOrderColumns_(tab);
  var width = columns ? Math.max(columns.number, columns.snapshot) : HEADINGS.length;
  var row = tab.getRange(rowNumber, 1, 1, width).getValues()[0];
  if (!savedOrder_(row)) return { ok: true, data: null };
  var snapshot = columns && row[columns.snapshot - 1];
  var owner, lines = [];
  if (snapshot) {
    try {
      var saved = JSON.parse(snapshot);
      owner = saved.key === buyerKey_(identity.buyer);
      if (Array.isArray(saved.lines)) lines = saved.lines;
    } catch (invalidSnapshot) {
      return { ok: true, data: null };
    }
  } else {
    var email = String(identity.email || '').trim().toLowerCase();
    owner = email && String(row[4]).trim().toLowerCase() === email;
  }
  if (!owner) return { ok: true, data: null };
  var receipt = savedReceipt_(row[0], row, columns && row[columns.number - 1]);
  receipt.data.total = Math.round(Number(row[9]) * 100);
  receipt.data.lines = lines;
  if (!lines.length) receipt.data.items = String(row[8] || '');
  return receipt;
}
function listOrders_(p, identity) {
  if (!identity || typeof identity.buyer !== 'string' || !identity.buyer)
    return { ok: false, code: 'invalid_buyer' };
  // Reading needs no lock, so My orders never waits for (or delays) an order
  // being saved. Rows still being saved are skipped by savedOrder_.
  var tab = orderBook_(p).getSheetByName(ORDER_TAB);
  if (!tab || tab.getLastRow() < 2) return { ok: true, data: [] };
  var columns = existingOrderColumns_(tab), lock = null;
  if (!columns) {
    // Adding the newer columns changes the sheet, so that one-off case locks.
    lock = LockService.getScriptLock();
    if (!lock.tryLock(4000)) return { ok: false, code: 'busy' };
  }
  try {
    if (!columns) columns = orderColumns_(tab);
    var key = buyerKey_(identity.buyer);
    var email = String(identity.email || '').trim().toLowerCase();
    var proven = new Set(Array.isArray(identity.orderIds) ? identity.orderIds : []);
    var orders = [], unclaimed = [];
    receiptRows_(tab, columns, key, email, proven).forEach(function (entry) {
      var row = entry.values;
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
        unclaimed.push(entry);
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
    if (unclaimed.length) claimOrders_(tab, columns, key, unclaimed, lock);
    orders.sort(function (a, b) {
      return b.submittedAt.localeCompare(a.submittedAt) || a.id.localeCompare(b.id);
    });
    return { ok: true, data: orders };
  } finally {
    if (lock) lock.releaseLock();
  }
}
/**
 * Links older orders (saved before receipt snapshots existed) to the Google
 * account that proved them, so later visits find them quickly. Best effort: if
 * the lock is busy the orders are still listed and get linked on a later visit.
 */
function claimOrders_(tab, columns, key, entries, heldLock) {
  var lock = heldLock || LockService.getScriptLock();
  if (!heldLock && !lock.tryLock(4000)) return;
  try {
    var snapshot = orderSnapshot_(key, []);
    entries.forEach(function (entry) {
      var current = tab.getRange(entry.row, 1, 1, columns.snapshot).getValues()[0];
      // Skip a row that moved or was linked by another visit in the meantime.
      if (current[0] !== entry.values[0] || current[columns.snapshot - 1]) return;
      tab.getRange(entry.row, columns.snapshot).setValues([[snapshot]]);
    });
    SpreadsheetApp.flush();
  } finally {
    if (!heldLock) lock.releaseLock();
  }
}
function savedReceipt_(id, row, number) {
  return {
    ok: true,
    data: { id: id, number: number || id, submittedAt: row[1], status: 'under_review' }
  };
}
function sameSubmission_(previous, evidence) {
  return (
    previous[12] === evidence.fingerprint ||
    (!!evidence.earlierSubmission && previous[12] === digest_(evidence.earlierSubmission))
  );
}
// The website calls this only after the private queue has stored the proof.
function reserveQueuedOrder_(p, request) {
  var o = request.order;
  validateOrder_(o);
  if (!/^[a-f0-9]{64}$/.test(request.proofHash || '')) throw Error('Invalid screenshot hash.');
  wakeOrderQueue_(PropertiesService.getScriptProperties());
  var evidence = submissionEvidence_(o, request.proofHash);
  var route = orderProperties_(p, o.collection);
  var book = orderBook_(route);
  var legacy = legacy_(book, route);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(12000)) return { ok: false, code: 'busy' };
  try {
    var reservation = reserveOrder_(book, legacy, o, evidence, '', true);
    return reservation.result || { ok: true, data: { number: reservation.number } };
  } finally {
    lock.releaseLock();
  }
}
/**
 * Saves an order in three steps so the script lock (which every order shares)
 * is never held during the slow screenshot upload:
 *   1. locked:   check the UTR and reserve the MARC number in a provisional row
 *   2. unlocked: save and verify the screenshot in Drive
 *   3. locked:   complete the row using the reserved MARC number
 * Retrying with the same details is safe at every step.
 */
function saveOrder_(p, o, uploadedBytes) {
  var evidence = proof_(o, uploadedBytes);
  var route = orderProperties_(p, o.collection);
  var handles = storageHandles_(route);
  var legacy = legacy_(handles.book, route);
  var priorTab = handles.book.getSheetByName(ORDER_TAB);
  var priorRow = priorTab ? locate_(priorTab, 1, o.id) : 0;
  var candidate = '';
  if (priorRow) {
    var prior = priorTab.getRange(priorRow, 1, 1, priorTab.getLastColumn()).getDisplayValues()[0];
    if (!sameSubmission_(prior, evidence)) return { ok: false, code: 'retry_different' };
    var priorColumns = existingOrderColumns_(priorTab);
    if (!savedOrder_(prior) && (!priorColumns || !prior[priorColumns.proofId - 1])) {
      var olderFile = existingProof_(handles.folder, o, evidence);
      if (olderFile) candidate = olderFile.getId();
      else candidate = Drive.Files.generateIds({ count: 1, space: 'drive' }).ids[0];
    }
  } else {
    candidate = Drive.Files.generateIds({ count: 1, space: 'drive' }).ids[0];
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(12000)) return { ok: false, code: 'busy' };
  var reserved;
  try {
    reserved = reserveOrder_(handles.book, legacy, o, evidence, candidate);
  } finally {
    lock.releaseLock();
  }
  if (reserved.result) return reserved.result;
  var link = driveCopy_(handles.folder, o, evidence, reserved.proofId);
  if (!lock.tryLock(12000)) return { ok: false, code: 'busy' };
  try {
    return finishOrder_(reserved.tab, reserved.columns, o, evidence, link);
  } finally {
    lock.releaseLock();
  }
}
function reserveOrder_(book, legacy, o, evidence, candidate, queueAdmission) {
  var tab = orderTab_(book), columns = orderColumns_(tab);
  var previousRow = locate_(tab, 1, o.id), number;
  var width = Math.max(HEADINGS.length, columns.number, columns.proofId);
  if (previousRow) {
    var previous = tab.getRange(previousRow, 1, 1, width).getDisplayValues()[0];
    if (!sameSubmission_(previous, evidence))
      return { result: { ok: false, code: 'retry_different' } };
    number = previous[columns.number - 1];
    if (savedOrder_(previous))
      return { result: savedReceipt_(o.id, previous, number) };
    var proofId = previous[columns.proofId - 1];
    if (!proofId && !candidate && !queueAdmission)
      return { result: { ok: false, code: 'busy' } };
    var changed = false;
    if (!number) {
      number = nextOrderNumber_(tab, columns, o.contact);
      tab.getRange(previousRow, columns.number).setValues([[number]]);
      changed = true;
    }
    if (!proofId && candidate) {
      proofId = candidate;
      tab.getRange(previousRow, columns.proofId).setValues([[proofId]]);
      changed = true;
    }
    if (changed) SpreadsheetApp.flush();
    return { tab: tab, columns: columns, proofId: proofId, number: number };
  }

  if (locate_(tab, 11, o.utr) || (legacy && locate_(legacy.sheet, legacy.column, o.utr)))
    return { result: { ok: false, code: 'reference_in_use' } };
  if (!candidate && !queueAdmission) return { result: { ok: false, code: 'busy' } };
  var row = tab.getLastRow() + 1;
  var maxRows = tab.getMaxRows();
  if (row > maxRows) tab.insertRowsAfter(maxRows, 100);
  tab.getRange(row, 2).setNumberFormat('@');
  tab.getRange(row, 11).setNumberFormat('@');
  number = nextOrderNumber_(tab, columns, o.contact);
  var pending = orderRow_(o, evidence.fingerprint, '', '');
  while (pending.length < width) pending.push('');
  pending[columns.proofId - 1] = candidate;
  pending[columns.number - 1] = number;
  tab.getRange(row, 1, 1, pending.length).setValues([pending]);
  SpreadsheetApp.flush();
  return { tab: tab, columns: columns, proofId: candidate, number: number };
}
function finishOrder_(tab, columns, o, evidence, link) {
  var row = locate_(tab, 1, o.id);
  if (!row) throw Error('Order row is unavailable.');
  var previous = tab.getRange(row, 1, 1, HEADINGS.length).getDisplayValues()[0];
  if (!sameSubmission_(previous, evidence)) return { ok: false, code: 'retry_different' };
  if (previous[1] && previous[11]) {
    var previousNumber = tab.getRange(row, columns.number).getDisplayValues()[0][0];
    return savedReceipt_(o.id, previous, previousNumber);
  }
  var number = tab.getRange(row, columns.number).getDisplayValues()[0][0];
  if (!number) throw Error('Order number is unavailable.');
  var when = new Date().toISOString();
  var snapshot = orderSnapshot_(buyerKey_(o.buyer), o.lines);
  var print = printColumns_(o.lines);
  tab.getRange(row, columns.snapshot).setValues([[snapshot]]);
  if (o.paidWith) tab.getRange(row, columns.paidWith).setValues([[textCell_(o.paidWith)]]);
  if (o.upiReference)
    tab.getRange(row, columns.upiReference).setValues([[textCell_(o.upiReference)]]);
  writePrintColumns_(tab, row, columns, print);
  var cells = tab.getRange(row, 1, 1, HEADINGS.length);
  cells.setValues([orderRow_(o, evidence.fingerprint, when, link)]);
  SpreadsheetApp.flush();
  var saved = tab
    .getRange(row, 1, 1, Math.max.apply(null, Object.values(columns)))
    .getDisplayValues()[0];
  if (
    saved[0] !== o.id ||
    saved[1] !== when ||
    saved[11] !== link ||
    saved[12] !== evidence.fingerprint ||
    saved[columns.number - 1] !== number ||
    saved[columns.snapshot - 1] !== snapshot ||
    (o.paidWith && saved[columns.paidWith - 1] !== o.paidWith) ||
    (o.upiReference && saved[columns.upiReference - 1] !== o.upiReference) ||
    (print.name && saved[columns.printName - 1] !== print.name) ||
    (print.number && saved[columns.printNumber - 1] !== print.number)
  )
    throw Error('The order row could not be confirmed.');
  return savedReceipt_(o.id, saved, number);
}

function taggedItem_(form, type, tag, title, asTyped, optional) {
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
  if (optional && !found.length) return null;
  if (found.length !== 1)
    throw Error('Check the ' + title + ' question and its type.');
  return found[0];
}
function localImage_(raw) {
  if (!raw) return '';
  var drive = raw.match(
    /^https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{10,128})(?:\/view)?\/?(?:[?#][^\s]*)?$/
  );
  if (drive) return 'drive:' + drive[1];
  if (safeHTTPS_(raw)) return raw;
  var decoded = decodeURIComponent(raw.replace(/^\.\//, ''));
  if (
    !/^assets\/[A-Za-z0-9_ ./()-]+$/.test(decoded) ||
    decoded.split('/').some(function (part) {
      return !part || part === '.' || part === '..';
    })
  )
    throw Error('Use an assets/ path, a direct HTTPS image URL, or a Google Drive file link.');
  return decoded.split('/').map(encodeURIComponent).join('/');
}
function safeHTTPS_(v) {
  return (
    typeof v === 'string' &&
    v.length <= 1500 &&
    /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?\/[^\s<>"]+$/.test(v)
  );
}
function homepageBanners_(form) {
  var choices;
  try {
    var question = taggedItem_(
      form,
      FormApp.ItemType.CHECKBOX,
      'banners',
      'homepage banners',
      function (item) { return item.asCheckboxItem(); },
      true
    );
    if (!question) return [];
    choices = question.getChoices();
  } catch (error) {
    console.warn('Could not read Homepage banners. ' + error.message);
    return [];
  }

  var banners = [], usedImages = new Set();
  for (var i = 0; i < choices.length && banners.length < 6; i++) {
    try {
      var fields = choices[i].getValue().split('|').map(function (field) {
        return field.trim();
      });
      var image = localImage_(fields[0]),
        title = fields[1] || 'MARC Store promotion',
        href = fields[2] || '#shop';
      if (
        fields.length > 3 ||
        !image ||
        image.startsWith('drive:') ||
        title.length > 140 ||
        /[\x00-\x1f\x7f]/.test(title) ||
        (href !== '#shop' && !safeHTTPS_(href))
      )
        throw Error('Use a deployed image URL, label and shop link.');
      if (usedImages.has(image)) continue;
      usedImages.add(image);
      banners.push({ image: image, title: title, href: href });
    } catch (error) {
      console.warn('Check Homepage banners option ' + (i + 1) + '.');
    }
  }
  return banners;
}
function optionalSkuImage_(value, label, sku) {
  try {
    return localImage_(value);
  } catch (error) {
    console.warn('Check ' + label + ' for ' + sku + '. ' + error.message);
    return '';
  }
}
function parseSku_(line) {
  var fields = String(line)
    .split('|')
    .map(function (s) {
      return s.trim();
    });
  var metadata = Object.create(null);
  var photoFields = fields.slice(5).filter(function (field) {
    var option = field.match(/^(print|details|details-image|size-chart)\s*=\s*([\s\S]*)$/i);
    if (!option) return true;
    metadata[option[1].toLowerCase()] = option[2];
    return false;
  });
  var printFields = [];
  if (metadata.print !== undefined) {
    var printOptions = metadata.print.split(',').map(function (option) {
      return option.trim().toLowerCase();
    });
    if (printOptions.some(function (option) { return option !== 'name' && option !== 'number'; }))
      throw Error('Use print=name, print=number or print=name,number for ' + fields[0] + '.');
    printFields = ['name', 'number'].filter(function (option) { return printOptions.includes(option); });
  }
  if (
    fields.length < 5 ||
    photoFields.length > 3 ||
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
      'Check the SKU format, price and limit of three photos for ' +
        (fields[0] || 'the empty option') +
        '.'
    );
  var price = fields[4].split('.');
  var images = Array.from(new Set(photoFields.filter(Boolean).map(localImage_)));
  return {
    sku: fields[0],
    name: fields[1],
    colour: fields[2],
    size: fields[3],
    paise:
      Number(price[0]) * 100 + Number(((price[1] || '') + '00').slice(0, 2)),
    images: images,
    printFields: printFields,
    details: (metadata.details || '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 600).trim(),
    detailsImage: optionalSkuImage_(metadata['details-image'], 'details image', fields[0]),
    sizeChart: optionalSkuImage_(metadata['size-chart'], 'size chart', fields[0])
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
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(row);
  });
  if (groups.size > 500)
    throw Error('The catalogue has too many product groups.');
  return Array.from(groups.entries()).map(function (entry) {
    var group = entry[0],
      options = entry[1],
      first = options[0];
    // One size can supply the photos and details for the whole product colour.
    var photoRows = options.filter(function (row) {
      return row.images.length > 1;
    });
    if (!photoRows.length) photoRows = options.filter(function (row) {
      return row.images.length > 0;
    });
    var images = photoRows.length ? photoRows[0].images : [];
    if (photoRows.some(function (row) {
      return row.images.join('|') !== images.join('|');
    }))
      throw Error('Use the same photo list for ' + first.name + ' (' + first.colour + ').');
    if (!images.length && /\bpolos?\b/i.test(first.name)) {
      if (/^white$/i.test(first.colour)) images.push('assets/polo-white.png');
      if (/^(maroon|burgundy)$/i.test(first.colour)) images.push('assets/polo-maroon.png');
    }
    var product = {
      id: digest_(group).slice(0, 24),
      name: first.name,
      colour: first.colour,
      image: images[0] || '',
      skus: options.map(function (row) {
        var sku = { sku: row.sku, size: row.size, paise: row.paise };
        if (row.printFields.length) sku.printFields = row.printFields;
        return sku;
      })
    };
    if (images.length > 1) product.extraImages = images.slice(1);
    ['details', 'detailsImage', 'sizeChart'].forEach(function (field) {
      var row = options.find(function (option) { return option[field]; });
      if (row) product[field] = row[field];
    });
    return product;
  });
}
function productPhoto_(p, id) {
  var folderId = p.PRODUCT_PHOTOS_FOLDER_ID;
  if (
    !folderId ||
    folderId === p.SCREENSHOT_FOLDER_ID ||
    typeof id !== 'string' ||
    !/^[A-Za-z0-9_-]{10,128}$/.test(id)
  )
    setupError_('Set PRODUCT_PHOTOS_FOLDER_ID to the separate product photos folder.');
  var file = DriveApp.getFileById(id);
  var parents = file.getParents();
  var inFolder = false;
  while (parents.hasNext()) {
    if (parents.next().getId() === folderId) {
      inFolder = true;
      break;
    }
  }
  if (!inFolder || file.isTrashed())
    setupError_('Keep the photo in the product photos folder.');
  var mime = file.getMimeType(),
    size = file.getSize();
  if (!FORMATS[mime] || size < 1 || size > PRODUCT_PHOTO_LIMIT)
    setupError_('Use a JPG, PNG or WebP product photo up to 4 MB.');
  return {
    file: file,
    mime: mime,
    size: size,
    revision: file.getLastUpdated().getTime()
  };
}
function readProductPhoto_(p, data) {
  if (!data || !Number.isSafeInteger(data.revision))
    setupError_('Provide a valid product photo revision.');
  var photo = productPhoto_(p, data.id);
  if (photo.revision !== data.revision)
    setupError_('The product photo changed. Rebuild the catalogue.');
  var bytes = photo.file.getBlob().getBytes();
  if (
    bytes.length !== photo.size ||
    photo.file.getLastUpdated().getTime() !== photo.revision
  )
    setupError_('The product photo changed. Rebuild the catalogue.');
  return { mime: photo.mime, content: Utilities.base64Encode(bytes) };
}
function resolveProductPhotos_(products, p) {
  var drive = new Map();
  products.forEach(function (product) {
    function resolvePhoto(src) {
      if (!src.startsWith('drive:')) return src;
      var id = src.slice(6);
      if (!drive.has(id)) {
        try {
          var photo = productPhoto_(p, id);
          var hash = digest_(id + ':' + photo.revision).slice(0, 24);
          drive.set(id, {
            id: id,
            revision: photo.revision,
            src: 'assets/catalogue/' + hash + '.' + FORMATS[photo.mime]
          });
        } catch (error) {
          console.warn(
            'Skipped a Drive photo for ' + product.name + ' (' + product.colour +
            '). Check the product photos folder and the photo link, format and size.'
          );
          drive.set(id, null);
        }
      }
      var asset = drive.get(id);
      return asset ? asset.src : '';
    }
    var photos = [product.image].concat(product.extraImages || []).map(resolvePhoto).filter(Boolean);
    photos = Array.from(new Set(photos));
    product.image = photos[0] || '';
    if (photos.length > 1) product.extraImages = photos.slice(1);
    else delete product.extraImages;
    ['detailsImage', 'sizeChart'].forEach(function (field) {
      if (!product[field]) return;
      var image = resolvePhoto(product[field]);
      if (image) product[field] = image;
      else delete product[field];
    });
  });
  return Array.from(drive.values()).filter(Boolean);
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
    var photoAssets = resolveProductPhotos_(draft.products, p);
    if (photoAssets.length) draft.photoAssets = photoAssets;
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
    var merchantCode = (p.UPI_MERCHANT_CODE || '').trim();
    if (/^[0-9]{4}$/.test(merchantCode)) draft.payment.merchantCode = merchantCode;
    draft.ready =
      published && form.isAcceptingResponses() && draft.products.length > 0;
  } catch (error) {
    console.warn('Catalogue paused. ' + error.message);
  }
  var homepageBanners = homepageBanners_(form);
  if (homepageBanners.length) draft.homepageBanners = homepageBanners;
  var collection = collectionKey_(p, orderRoute_(p));
  if (p['ORDER_COLLECTION_' + collection]) draft.collection = collection;
  draft.version = digest_(JSON.stringify(draft));
  return draft;
}

/** Run in the editor to check the catalogue and the configured order spreadsheet. */
function checkOrderStorage() {
  var props = PropertiesService.getScriptProperties(), p = props.getProperties();
  if (!/^[a-f0-9]{64}$/.test(p.MARC_SCRIPT_SECRET || ''))
    setupError_('Set MARC_SCRIPT_SECRET to your random 64-character hex key.');
  if (typeof Drive === 'undefined') setupError_('Add the Drive API v3 service.');
  var lock = LockService.getScriptLock();
  lock.waitLock(12000);
  try {
    openStorage_(p);
    var route = orderRoute_(p), key = collectionKey_(p, route);
    props.setProperty('ORDER_COLLECTION_' + key, JSON.stringify(route));
    if (!p.ORDER_LEGACY_COLLECTION) props.setProperty('ORDER_LEGACY_COLLECTION', key);
  } finally {
    lock.releaseLock();
  }
  var catalog = catalogue_(props.getProperties());
  console.log(
    'Order storage is ready. ' +
      catalog.products.length +
      ' products. Ordering is ' +
      (catalog.ready ? 'open' : 'paused') +
      '.'
  );
}

function queueRequest_(p, data) {
  var address = (p.STOREFRONT_URL || '').replace(/\/+$/, '');
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(address) || !/^[a-f0-9]{64}$/.test(p.MARC_SCRIPT_SECRET || ''))
    setupError_('Check STOREFRONT_URL and MARC_SCRIPT_SECRET.');
  var payload = JSON.stringify(data), issuedAt = Date.now();
  var signature = hex_(Utilities.computeHmacSha256Signature(
    'MARC order queue\n' + issuedAt + '\n' + payload,
    p.MARC_SCRIPT_SECRET, Utilities.Charset.UTF_8));
  var response = UrlFetchApp.fetch(address + '/api/order-queue', {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ issuedAt: issuedAt, payload: payload, signature: signature }),
    followRedirects: false, muteHttpExceptions: true
  });
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300)
    throw Error('Order queue endpoint returned ' + response.getResponseCode() + '.');
  return response;
}

function queueJob_(response) {
  var bytes = response.getContent();
  var end = bytes.indexOf(10, 65);
  if (bytes[64] !== 10 || end <= 65 || end > 210000)
    throw Error('Could not read the queued order.');
  var fingerprint = Utilities.newBlob(bytes.slice(0, 64)).getDataAsString('UTF-8');
  var order = JSON.parse(Utilities.newBlob(bytes.slice(65, end)).getDataAsString('UTF-8'));
  return { fingerprint: fingerprint, order: order, bytes: bytes.slice(end + 1) };
}

function saveReviewFile_(folder, name, bytes, mime) {
  var existing = folder.getFilesByName(name);
  var id = existing.hasNext()
    ? existing.next().getId()
    : Drive.Files.generateIds({ count: 1, space: 'drive' }).ids[0];
  return writeDriveFile_(folder, name, bytes, mime, digest_(bytes), id);
}
function archivePaymentReview_(p, job, code) {
  var route = orderProperties_(p, job.order.collection);
  var folder = DriveApp.getFolderById(route.SCREENSHOT_FOLDER_ID);
  private_(folder);
  var mime = job.order.proof.mime;
  var prefix = 'REVIEW_' + job.order.id + '_' + job.fingerprint.slice(0, 12);
  var screenshot = saveReviewFile_(folder, prefix + '.' + FORMATS[mime], job.bytes, mime);
  var record = JSON.stringify({ order: job.order, issue: code, screenshot: screenshot });
  var metadata = Utilities.newBlob(record, 'application/json').getBytes();
  saveReviewFile_(folder, prefix + '.json', metadata, 'application/json');
}

/** Check the signed worker endpoint and run one drain every minute. */
function installOrderQueue() {
  checkOrderStorage();
  Drive.Files.generateIds({ count: 1, space: 'drive' });
  queueRequest_(properties_(), { action: 'check' });
  var triggers = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === 'processOrderQueue';
  });
  if (!triggers.length) ScriptApp.newTrigger('processOrderQueue').timeBased().everyMinutes(1).create();
  triggers.slice(1).forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
  console.log('Order queue worker is installed.');
}

function wakeOrderQueue_(props) {
  var now = Date.now();
  if (Number(props.getProperty('ORDER_QUEUE_AWAKE_UNTIL') || 0) < now + 2 * 60000)
    props.setProperty('ORDER_QUEUE_AWAKE_UNTIL', String(now + 5 * 60000));
}

/** This can also be run manually by the Apps Script owner. */
function processOrderQueue(event) {
  var props = PropertiesService.getScriptProperties();
  var lock = LockService.getScriptLock(), lease = Utilities.getUuid();
  // Apps Script executions have a six-minute limit. Only one worker may drain at a time.
  if (!lock.tryLock(3000)) return;
  try {
    var now = Date.now();
    var expires = Number((props.getProperty('ORDER_QUEUE_LEASE') || '').split(':')[0]);
    if (expires > now) return;
    // Use the scheduled execution for new work. Check once an hour while idle
    // in case a proof upload succeeded but its wake-up request was interrupted.
    if (event && event.triggerUid &&
        Number(props.getProperty('ORDER_QUEUE_AWAKE_UNTIL') || 0) <= now &&
        Number(props.getProperty('ORDER_QUEUE_LAST_POLL') || 0) > now - 60 * 60000) return;
    props.setProperty('ORDER_QUEUE_LEASE', (now + 7 * 60000) + ':' + lease);
    props.setProperty('ORDER_QUEUE_LAST_POLL', String(now));
  } finally {
    lock.releaseLock();
  }
  var deadline = Date.now() + 4 * 60000;
  var saved = 0, review = 0, retry = 0, attempted = 0;
  try {
    var cursor, p = props.getProperties();
    do {
      var page = JSON.parse(queueRequest_(p, { action: 'list', cursor: cursor }).getContentText());
      if (page.jobs.length) wakeOrderQueue_(props);
      cursor = page.cursor;
      for (var i = 0; i < page.jobs.length; i++) {
        if (Date.now() >= deadline) return;
        var key = page.jobs[i];
        try {
          var response = queueRequest_(p, { action: 'read', key: key });
          if (response.getResponseCode() === 204) continue;
          attempted++;
          var job = queueJob_(response);
          var result = saveOrder_(p, job.order, job.bytes);
          if (result.ok || result.code === 'reference_in_use' || result.code === 'retry_different') {
            var reviewArchived = false;
            if (!result.ok) {
              archivePaymentReview_(p, job, result.code);
              reviewArchived = true;
            }
            queueRequest_(p, { action: 'finish', key: key, id: job.order.id,
              fingerprint: job.fingerprint, result: result, reviewArchived: reviewArchived });
            if (result.ok) saved++;
            else review++;
          } else retry++;
        } catch (e) {
          retry++;
        }
      }
    } while (cursor && Date.now() < deadline);
  } finally {
    if (lock.tryLock(3000)) {
      try {
        if ((props.getProperty('ORDER_QUEUE_LEASE') || '').split(':')[1] === lease)
          props.deleteProperty('ORDER_QUEUE_LEASE');
      } finally {
        lock.releaseLock();
      }
    }
    console.log('Order queue attempted ' + attempted + ', saved ' + saved +
      ', needs attention ' + review + ', will retry ' + retry + '.');
  }
}

/** Run in the editor to move print details from older orders into their own columns. */
function moveExistingPrintDetails() {
  var lock = LockService.getScriptLock();
  lock.waitLock(12000);
  try {
    var storage = openStorage_(properties_());
    var tab = storage.tab, columns = storage.columns;
    var count = tab.getLastRow() - 1;
    var moved = 0;
    if (count > 0) {
      tab.getRange(2, 9, count, 1).getDisplayValues().forEach(function (row, index) {
        var items = row[0];
        if (!/\n  (?:Item [0-9]+ · )?(?:Name|Number): /.test(items)) return;
        var rowNumber = index + 2;
        var lines;
        try {
          lines = JSON.parse(tab.getRange(rowNumber, columns.snapshot).getValues()[0][0]).lines;
          if (orderItems_(lines, true) !== items) return;
        } catch (invalidSnapshot) {
          return;
        }
        var print = printColumns_(lines);
        var existingName = tab.getRange(rowNumber, columns.printName).getDisplayValues()[0][0];
        var existingNumber = tab.getRange(rowNumber, columns.printNumber).getDisplayValues()[0][0];
        if ((existingName && existingName !== print.name) ||
            (existingNumber && existingNumber !== print.number))
          return;
        writePrintColumns_(tab, rowNumber, columns, print);
        SpreadsheetApp.flush();
        tab.getRange(rowNumber, 9).setValues([[textCell_(orderItems_(lines))]]);
        moved++;
      });
      SpreadsheetApp.flush();
    }
    console.log('Moved print details for ' + moved + ' order(s).');
  } finally {
    lock.releaseLock();
  }
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
