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
var BANK_TRANSFER = 'Bank transfer (NEFT / IMPS / RTGS)';
var PAYMENT_METHODS = ['GPay', 'PhonePe', 'Paytm', 'CRED', BANK_TRANSFER, 'Others'];
var ORDER_ID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
var FORMATS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
var PROOF_LIMIT = 4 * 1024 * 1024;
var PRODUCT_PHOTO_LIMIT = 4 * 1024 * 1024;

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
  var screenshotIndex = HEADINGS.indexOf(PAYMENT_SCREENSHOT_HEADER);
  var renameScreenshot = headers[screenshotIndex] === 'Private screenshot';
  if (renameScreenshot) headers[screenshotIndex] = PAYMENT_SCREENSHOT_HEADER;
  if (headers.slice(0, HEADINGS.length).join('|') !== HEADINGS.join('|'))
    setupError_('Restore the original headers in ' + ORDER_TAB + '.');
  if (renameScreenshot)
    tab.getRange(1, screenshotIndex + 1).setValues([[PAYMENT_SCREENSHOT_HEADER]]);
  var changed = renameScreenshot;
  var columns = {};
  var extraHeaders = {
    number: ORDER_NUMBER_HEADER,
    snapshot: SNAPSHOT_HEADER,
    paidWith: PAID_WITH_HEADER,
    upiReference: UPI_REFERENCE_HEADER,
    printName: PRINT_NAME_HEADER,
    printNumber: PRINT_NUMBER_HEADER
  };
  Object.entries(extraHeaders).forEach(function (entry) {
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
function proof_(o) {
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
    !Object.prototype.hasOwnProperty.call(FORMATS, o.proof.mime) ||
    typeof o.proof.base64 !== 'string' ||
    o.proof.base64.length > Math.ceil(PROOF_LIMIT / 3) * 4
  )
    throw Error('Invalid order.');
  var bytes = Utilities.base64Decode(o.proof.base64);
  if (!bytes.length || bytes.length > PROOF_LIMIT)
    throw Error('Invalid screenshot.');
  var hash = digest_(bytes);
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
    bytes: bytes,
    hash: hash,
    fingerprint: fingerprint,
    earlierSubmission: earlierSubmission,
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
  // The order number is allocated after the new order's provisional row exists.
  var rows = tab.getRange(2, 1, tab.getLastRow() - 1, columns.number).getValues();
  rows.forEach(function (row) {
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
        tab.getRange(entry.row, columns.snapshot).setValues([[orderSnapshot_(key, [])]]);
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
      if (
        previous[12] !== evidence.fingerprint &&
        (!evidence.earlierSubmission || previous[12] !== digest_(evidence.earlierSubmission))
      )
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
      var maxRows = tab.getMaxRows();
      if (row > maxRows) tab.insertRowsAfter(maxRows, 100);
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
    var print = printColumns_(o.lines);
    tab.getRange(row, columns.number).setValues([[number]]);
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
  } finally {
    lock.releaseLock();
  }
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
