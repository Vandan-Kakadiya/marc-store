/**
 * MARC store backend. Deploy alongside Checkout.html as an Apps Script web app.
 * Public GET: catalogue only. Orders: google.script.run from Google-hosted checkout.
 * QR/UPI payments are made outside the site; private payment proof is required.
 */

function doGet(e) {
  if (e && e.parameter && e.parameter.page === 'checkout') {
    return HtmlService.createHtmlOutputFromFile('Checkout')
      .setTitle('MARC | Checkout')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  var callback = e && e.parameter && e.parameter.callback;
  if (callback && !/^marcCatalog_[A-Za-z0-9_]{1,100}$/.test(callback)) {
    return ContentService.createTextOutput('Invalid callback.');
  }
  var data;
  try { data = publicCatalogue_(storeModel_()); }
  catch (error) {
    console.error(error);
    data = {apiVersion:1, ready:false, products:[], maxItems:1, version:''};
  }
  var json = JSON.stringify(data).replace(/</g, '\\u003c');
  return ContentService.createTextOutput(callback ? callback + '(' + json + ');' : json)
    .setMimeType(callback ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
}

/** Called by the Google-hosted checkout. Returns structure and public catalogue. */
function getCheckoutData() {
  try {
    var model = storeModel_();
    return {ok:true, catalogue:publicCatalogue_(model), fields:model.fields, payment:model.payment,
      storefront:storefront_(), description:model.form.getDescription() || ''};
  } catch (error) {
    console.error(error);
    return {ok:false, message:'Ordering is not ready yet. Please contact MARC.'};
  }
}

/** The only order-writing endpoint. It never trusts a browser-supplied price. */
function submitOrderForm(formData) {
  var payload;
  try { payload=JSON.parse(formData.orderPayload || ''); }
  catch (error) { return {ok:false,message:'The order could not be read. Reload checkout.'}; }
  return submitOrder(payload,formData.paymentProof);
}

function submitOrder(payload,paymentProof) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return {ok:false, message:'The store is busy. Try again in a moment.'};
  try { return saveOrder_(payload,paymentProof); }
  catch (error) {
    console.error(error);
    return {ok:false, message:error.publicMessage || 'We could not confirm this order. Please contact MARC before trying a new order.'};
  } finally { lock.releaseLock(); }
}

function saveOrder_(payload,paymentProof) {
  if (!payload || JSON.stringify(payload).length > 64000 || !/^[a-fA-F0-9-]{20,80}$/.test(payload.requestId || '')) fail_('Please reload checkout and try again.');
  if (!payload.fields || Array.isArray(payload.fields) || typeof payload.fields !== 'object') fail_('Please check your details.');
  var props = PropertiesService.getScriptProperties();
  var key = 'ORDER_' + payload.requestId;
  var hash = digest_(JSON.stringify({items:payload.items, fields:payload.fields, version:payload.version}));
  var previous = props.getProperty(key);
  if (previous) {
    previous = JSON.parse(previous);
    if (previous.hash !== hash) fail_('This checkout was already used. Start again from your bag.');
    if (previous.state === 'complete') return {ok:true, total:previous.total, itemCount:previous.itemCount};
    fail_('This order may already have been received. Contact MARC before placing it again.');
  }
  var model = storeModel_();
  if (!model.ready) fail_('Orders are currently closed.');
  var proofInfo=checkedProof_(paymentProof,model.payment.maxBytes);
  if (payload.version !== model.version) fail_('The collection changed. Reload checkout and review the latest options and prices.');
  if (!Array.isArray(payload.items) || !payload.items.length || payload.items.length > model.maxItems) fail_('Please check the items in your bag.');
  var lookup = {};
  model.products.forEach(function(p) { p.skus.forEach(function(s) { lookup[s.sku] = {product:p, sku:s}; }); });
  var seen = {}, totalCents = 0, quantity = 0, lines = [], choices = [];
  payload.items.forEach(function(line) {
    if (!line || !lookup[line.sku] || seen[line.sku] || !Number.isInteger(line.qty) || line.qty < 1 || line.qty > model.maxItems) fail_('An item is unavailable or its quantity is invalid. Review your bag.');
    seen[line.sku] = true;
    var found = lookup[line.sku];
    quantity += line.qty;
    totalCents += Math.round(found.sku.price * 100) * line.qty;
    choices.push(found.sku.choice);
    lines.push(found.sku.sku + ' | ' + found.product.name + ' | ' + found.product.colour + ' | ' + found.sku.size + ' | Qty ' + line.qty + ' | INR ' + (found.sku.price * line.qty).toFixed(2));
  });
  if (quantity > model.maxItems) fail_('This order exceeds the Form quantity limit.');
  var total = totalCents / 100;
  var values = {};
  values[model.roles.catalog.id] = choices;
  values[model.roles.lines.id] = lines.join('\n');
  values[model.roles.total.id] = total.toFixed(2);
  values[model.roles.quantity.id] = String(quantity);
  if (model.roles.source) values[model.roles.source.id] = 'MARC website';
  if (model.roles.request) values[model.roles.request.id] = payload.requestId;
  var email = '', transaction = '';
  model.fields.forEach(function(field) {
    var raw = payload.fields[field.id];
    var value = checkedValue_(field, raw);
    if (field.role === 'email') {
      email = String(value || '').trim().toLowerCase();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail_('Please enter a valid email address.');
    }
    if (field.role === 'transaction') transaction = String(value || '').trim().toUpperCase();
    if (value !== null) values[field.id] = value;
  });
  if (!email) fail_('Please enter your email address.');
  if (!/^[0-9]{12}$/.test(transaction)) fail_('Please enter the 12-digit UPI transaction reference.');
  var day = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
  var rateKey = 'RATE_' + day + '_' + digest_(email).slice(0,32);
  var rate = Number(props.getProperty(rateKey) || 0);
  if (rate >= 5) fail_('Please contact MARC to place additional orders today.');
  var txnKey = transaction ? 'TXN_' + digest_(transaction) : '';
  if (txnKey && props.getProperty(txnKey)) fail_('That payment reference has already been used. Please contact MARC.');
  var response = model.form.createResponse();
  model.questions.forEach(function(q) {
    if (Object.prototype.hasOwnProperty.call(values,q.id)) response.withItemResponse(itemResponse_(model.form.getItemById(Number(q.id)),q,values[q.id]));
  });
  var folder=DriveApp.getFolderById(model.proofFolderId);
  if(String(folder.getSharingAccess())!=='PRIVATE')fail_('Payment-proof storage is unavailable. Please contact MARC.');
  var proofFile=folder.createFile(paymentProof.copyBlob().setName('payment-'+payload.requestId+'.'+proofInfo.extension));
  try {
    response.withItemResponse(itemResponse_(model.form.getItemById(Number(model.roles.proof.id)),model.roles.proof,proofFile.getUrl()));
  } catch(error) {
    proofFile.setTrashed(true);
    throw error;
  }
  // Persist a pending claim before the external side effect. An uncertain result is
  // deliberately not auto-retried, preventing duplicate orders after timeouts.
  pruneRecords_(props);
  props.setProperty(key,JSON.stringify({state:'pending',hash:hash,at:Date.now(),proofFileId:proofFile.getId()}));
  if (txnKey) props.setProperty(txnKey,JSON.stringify({at:Date.now(),requestId:payload.requestId}));
  props.setProperty(rateKey,String(rate + 1));
  var submitted = response.submit();
  props.setProperty(key,JSON.stringify({state:'complete',hash:hash,at:Date.now(),responseId:submitted.getId(),total:total,itemCount:quantity}));
  return {ok:true,total:total,itemCount:quantity};
}

function storeModel_() {
  var formId = PropertiesService.getScriptProperties().getProperty('FORM_ID');
  if (!formId) throw Error('Set FORM_ID or run createStarterForm.');
  var form = FormApp.openById(formId), questions = [], roles = {}, fields = [];
  form.getItems().forEach(function(item) {
    var q = describeItem_(item); if (!q) return;
    if (q.unsupported) throw Error('Unsupported Form item: ' + q.title);
    questions.push(q);
    if (q.role) {
      if (roles[q.role]) throw Error('Duplicate role tag: ' + q.role);
      roles[q.role] = q;
    }
    if (!['catalog','lines','total','quantity','source','request','proof'].includes(q.role)) fields.push(q);
  });
  var required = {catalog:'CHECKBOX',lines:'PARAGRAPH_TEXT',total:'TEXT',quantity:'LIST',email:'TEXT',transaction:'TEXT',proof:'TEXT'};
  Object.keys(required).forEach(function(role) { if (!roles[role] || roles[role].type !== required[role]) throw Error('Missing or invalid [marc:' + role + '] question.'); });
  if (!roles.email.required) throw Error('Email question must be required.');
  if (!roles.transaction.required) throw Error('UPI transaction reference must be required.');
  ['source','request'].forEach(function(role) { if (roles[role] && roles[role].type !== 'TEXT') throw Error(role + ' helper must be short answer.'); });
  // Explicit email question is used. Native verified-email or one-per-user settings
  // are incompatible with this public, owner-executed relay and must not be bypassed.
  if (form.collectsEmail() || (typeof form.hasLimitOneResponsePerUser === 'function' && form.hasLimitOneResponsePerUser())) throw Error('Use a required email question; turn off native email collection and response-per-user limits.');
  var quantities = roles.quantity.choices.map(Number);
  if (!quantities.length || quantities.some(function(n,i) { return !Number.isInteger(n) || n !== i+1 || n > 100; })) throw Error('Quantity choices must be 1, 2, 3 ... in order.');
  var maxItems = quantities.length, grouped = {}, skuIds = {};
  roles.catalog.choices.forEach(function(choice) {
    var sku = parseSku_(choice);
    if (skuIds[sku.sku]) throw Error('Duplicate SKU: ' + sku.sku);
    skuIds[sku.sku] = true;
    var id = 'p_' + digest_(sku.name.toLowerCase() + '|' + sku.colour.toLowerCase()).slice(0,18);
    if (!grouped[id]) grouped[id] = {id:id,name:sku.name,colour:sku.colour,image:sku.image,skus:[]};
    if (grouped[id].skus.some(function(s) { return s.size.toLowerCase() === sku.size.toLowerCase(); })) throw Error('Duplicate size in a product/colour.');
    if (grouped[id].image !== sku.image) throw Error('Use the same image for every size of a product/colour.');
    grouped[id].skus.push({sku:sku.sku,size:sku.size,price:sku.price,choice:choice});
  });
  var products = Object.keys(grouped).map(function(k) { return grouped[k]; });
  if (!products.length) throw Error('No valid SKUs configured.');
  var payment=paymentSettings_();
  var model = {form:form,questions:questions,roles:roles,fields:fields,products:products,maxItems:maxItems,payment:payment,proofFolderId:PropertiesService.getScriptProperties().getProperty('SCREENSHOT_FOLDER_ID')};
  model.version = digest_(JSON.stringify({products:products,questions:questions,maxItems:maxItems,payment:payment}));
  var published=true;
  if(typeof form.supportsAdvancedResponderPermissions==='function'&&form.supportsAdvancedResponderPermissions())published=form.isPublished();
  model.ready = published && form.isAcceptingResponses() && payment.ready;
  return model;
}

function parseSku_(choice) {
  var p = String(choice).split('|').map(function(v) { return v.trim(); });
  if (p.length < 5 || p.length > 6 || !/^[A-Za-z0-9_-]{1,64}$/.test(p[0]) || !p[1] || !p[2] || !p[3] || !/^\d{1,7}(\.\d{1,2})?$/.test(p[4]) || Number(p[4]) <= 0 || Number(p[4]) > 1000000) throw Error('SKU format: code | product | colour | size | price | image (optional)');
  var image = p[5] || '';
  if (image && !/^https:\/\//i.test(image) && !/^assets\/[A-Za-z0-9_.\/-]+$/.test(image)) throw Error('Use an HTTPS image URL or an assets/ path.');
  if (!image && /^white$/i.test(p[2])) image = 'assets/polo-white.png';
  if (!image && /^(maroon|burgundy)$/i.test(p[2])) image = 'assets/polo-maroon.png';
  return {sku:p[0],name:p[1],colour:p[2],size:p[3],price:Number(p[4]),image:image};
}

function describeItem_(item) {
  var type = String(item.getType());
  if (['PAGE_BREAK','SECTION_HEADER','IMAGE','VIDEO'].includes(type)) return null;
  var methods = {TEXT:'asTextItem',PARAGRAPH_TEXT:'asParagraphTextItem',MULTIPLE_CHOICE:'asMultipleChoiceItem',LIST:'asListItem',CHECKBOX:'asCheckboxItem',SCALE:'asScaleItem'};
  if (!methods[type]) return {id:String(item.getId()),title:item.getTitle(),unsupported:true};
  var typed = item[methods[type]](), help = typed.getHelpText() || '';
  var match = help.match(/\[marc:(catalog|lines|total|quantity|email|name|phone|transaction|proof|source|request)\]/i);
  var q = {id:String(item.getId()),type:type,title:typed.getTitle(),help:help.replace(/\[marc:[a-z]+\]/gi,'').trim(),required:typed.isRequired(),role:match?match[1].toLowerCase():''};
  if (['CHECKBOX','MULTIPLE_CHOICE','LIST'].includes(type)) {
    var choices = typed.getChoices();
    q.choices = choices.map(function(c) { return c.getValue(); });
    if (type === 'MULTIPLE_CHOICE' && choices.some(function(c) { return typeof c.getPageNavigationType === 'function' && c.getPageNavigationType() && String(c.getPageNavigationType()) !== 'CONTINUE'; })) q.unsupported = true;
    if (typeof typed.hasOtherOption === 'function' && typed.hasOtherOption()) q.unsupported = true;
  }
  if (type === 'SCALE') { q.lower = typed.getLowerBound(); q.upper = typed.getUpperBound(); }
  return q;
}

function checkedValue_(q,raw) {
  if (q.type === 'CHECKBOX') {
    var list = raw === undefined ? [] : raw;
    if (!Array.isArray(list) || list.length > q.choices.length || new Set(list).size !== list.length || list.some(function(v) { return !q.choices.includes(v); })) fail_('Please check ' + q.title + '.');
    if (q.required && !list.length) fail_('Please complete ' + q.title + '.');
    return list.length ? list : null;
  }
  var value = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!value) { if(q.required)fail_('Please complete ' + q.title + '.'); return null; }
  if (value.length > (q.type === 'PARAGRAPH_TEXT' ? 4000 : 250)) fail_('The answer for ' + q.title + ' is too long.');
  if (['LIST','MULTIPLE_CHOICE'].includes(q.type) && !q.choices.includes(value)) fail_('Please choose a valid option for ' + q.title + '.');
  if (q.type === 'SCALE' && (!Number.isInteger(Number(value)) || Number(value)<q.lower || Number(value)>q.upper)) fail_('Please check ' + q.title + '.');
  return value;
}

function itemResponse_(item,q,value) {
  if (q.type === 'TEXT') return item.asTextItem().createResponse(sheetText_(value));
  if (q.type === 'PARAGRAPH_TEXT') return item.asParagraphTextItem().createResponse(sheetText_(value));
  if (q.type === 'CHECKBOX') return item.asCheckboxItem().createResponse(value);
  if (q.type === 'LIST') return item.asListItem().createResponse(String(value));
  if (q.type === 'MULTIPLE_CHOICE') return item.asMultipleChoiceItem().createResponse(String(value));
  if (q.type === 'SCALE') return item.asScaleItem().createResponse(Number(value));
  throw Error('Unsupported writer.');
}
function publicCatalogue_(m) { return {apiVersion:1,ready:m.ready,products:m.products,maxItems:m.maxItems,version:m.version}; }
function paymentSettings_() {
  var props=PropertiesService.getScriptProperties();
  var qr=props.getProperty('PAYMENT_QR_URL')||'',payee=props.getProperty('PAYEE_NAME')||'',upi=props.getProperty('UPI_ID')||'';
  var folder=props.getProperty('SCREENSHOT_FOLDER_ID')||'';
  var validQr=/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[^\s"<>]+$/.test(qr);
  var privateFolder=false;
  if(folder){try{privateFolder=String(DriveApp.getFolderById(folder).getSharingAccess())==='PRIVATE';}catch(error){console.error(error);}}
  return {ready:Boolean(validQr&&payee&&folder&&privateFolder),qrUrl:validQr?qr:'',payeeName:payee,upiId:upi,maxBytes:5*1024*1024};
}
function checkedProof_(blob,maxBytes) {
  if(!blob||typeof blob.getBytes!=='function'||typeof blob.getContentType!=='function')fail_('Please upload your payment screenshot.');
  var raw=blob.getBytes();
  if(!raw.length||raw.length>maxBytes)fail_('Use a payment screenshot under 5 MB.');
  var bytes=raw.slice(0,12).map(function(b){return (b+256)%256;});
  var mime=String(blob.getContentType()||'').toLowerCase();
  var png=bytes.length>=8&&[137,80,78,71,13,10,26,10].every(function(v,i){return bytes[i]===v;});
  var jpg=bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  var webp=bytes.length>=12&&String.fromCharCode.apply(null,bytes.slice(0,4))==='RIFF'&&String.fromCharCode.apply(null,bytes.slice(8,12))==='WEBP';
  if((png&&mime==='image/png'))return {extension:'png'};
  if((jpg&&['image/jpeg','image/jpg'].includes(mime)))return {extension:'jpg'};
  if((webp&&mime==='image/webp'))return {extension:'webp'};
  fail_('Upload a PNG, JPG or WebP screenshot. Convert HEIC or PDF files before uploading.');
}
function sheetText_(v) { var s=String(v); return /^[\s]*[=+@-]/.test(s) ? "'"+s : s; }
function digest_(v) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(v)).map(function(b){return ('0'+((b+256)%256).toString(16)).slice(-2);}).join(''); }
function fail_(message) { var error=new Error(message);error.publicMessage=message;throw error; }
function storefront_() { var u=PropertiesService.getScriptProperties().getProperty('STOREFRONT_URL')||'';return /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[^\s"<>]*)?$/.test(u)?u:''; }
function pruneRecords_(props) {
  var all=props.getProperties(),now=Date.now();
  Object.keys(all).forEach(function(k){
    if(/^ORDER_|^TXN_/.test(k)){try{if(now-JSON.parse(all[k]).at>90*86400000)props.deleteProperty(k);}catch{}}
    if(k.indexOf('RATE_')===0&&k.slice(5,15)<Utilities.formatDate(new Date(now-2*86400000),'Asia/Kolkata','yyyy-MM-dd'))props.deleteProperty(k);
  });
}

/** Run once as the owner. Does not publish or open the Form. No real prices assumed. */
function createStarterForm() {
  var props=PropertiesService.getScriptProperties();
  if(props.getProperty('FORM_ID'))throw Error('FORM_ID already exists. Reuse that Form or clear it deliberately before creating another.');
  var form=FormApp.create('MARC | Polo Orders');
  props.setProperty('FORM_ID',form.getId());
  form.setAcceptingResponses(false);
  form.setCollectEmail(false);
  form.setDescription('MARC polo collection. Ordering details will be announced by MARC.');
  form.addTextItem().setTitle('Full name').setHelpText('[marc:name]').setRequired(true);
  form.addTextItem().setTitle('Email').setHelpText('[marc:email]').setRequired(true);
  form.addTextItem().setTitle('Phone number').setHelpText('[marc:phone]').setRequired(true);
  form.addCheckboxItem().setTitle('SKU catalogue').setHelpText('[marc:catalog] Each choice: SKU | Product name | Colour | Size | Price INR | Image (optional)').setChoiceValues(['SETUP REQUIRED: replace this with your real SKU choices']).setRequired(true);
  form.addParagraphTextItem().setTitle('Order lines').setHelpText('[marc:lines] Filled by the store.').setRequired(true);
  form.addTextItem().setTitle('Total amount INR').setHelpText('[marc:total] Calculated by the store.').setRequired(true);
  form.addTextItem().setTitle('UPI transaction ID (UTR)').setHelpText('[marc:transaction] Enter the 12-digit transaction reference from your UPI app.').setRequired(true);
  form.addTextItem().setTitle('Payment screenshot link').setHelpText('[marc:proof] The website uploads the image to private Drive storage and fills this link.').setRequired(true);
  form.addListItem().setTitle('Total quantity').setHelpText('[marc:quantity] Change these choices to set the order limit.').setChoiceValues(['1','2','3','4','5']).setRequired(true);
  form.addParagraphTextItem().setTitle('Comments').setRequired(false);
  form.addTextItem().setTitle('Source').setHelpText('[marc:source]').setRequired(false);
  form.addTextItem().setTitle('Request reference').setHelpText('[marc:request]').setRequired(false);
  var sheet=SpreadsheetApp.create('MARC Polo Orders');
  form.setDestination(FormApp.DestinationType.SPREADSHEET,sheet.getId());
  var folder=DriveApp.createFolder('MARC Payment Proofs');
  props.setProperty('SCREENSHOT_FOLDER_ID',folder.getId());
  console.log('Form edit: '+form.getEditUrl());console.log('Responses: '+sheet.getUrl());
  console.log('Private payment proof folder: '+folder.getUrl());
  console.log('Form is closed. Configure real SKUs, STOREFRONT_URL, PAYMENT_QR_URL, PAYEE_NAME, deadline and payment details, then run inspectForm.');
}
function inspectForm() {
  var m=storeModel_();
  var mapping={};
  Object.keys(m.roles).forEach(function(role){mapping[role]={id:m.roles[role].id,type:m.roles[role].type};});
  PropertiesService.getScriptProperties().setProperty('FIELD_MAP',JSON.stringify(mapping));
  console.log(JSON.stringify({ready:m.ready,version:m.version,products:m.products,fields:m.fields,roles:m.roles,maxItems:m.maxItems},null,2));
}
