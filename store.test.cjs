const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const core = require('../dist/store-core.js');
function proof(mime='image/png',bytes=[137,80,78,71,13,10,26,10]) {
  return {getContentType:()=>mime,getBytes:()=>bytes,copyBlob:()=>proof(mime,bytes),setName(){return this;}};
}

function item(id,type,title,help='',required=false,choices=[]) {
  const q={id,type,title,help,required,choices};
  q.getId=()=>id;q.getType=()=>type;q.getTitle=()=>title;q.getHelpText=()=>help;q.isRequired=()=>required;
  q.getChoices=()=>q.choices.map(value=>({getValue:()=>value,getPageNavigationType:()=>null}));
  q.createResponse=value=>({id,type,value});q.getLowerBound=()=>1;q.getUpperBound=()=>5;
  for(const name of ['asTextItem','asParagraphTextItem','asCheckboxItem','asListItem','asMultipleChoiceItem','asScaleItem'])q[name]=()=>q;
  return q;
}
function backend() {
  const items=[
    item(1,'TEXT','Full name','[marc:name]',true),
    item(2,'TEXT','Email','[marc:email]',true),
    item(3,'CHECKBOX','SKU catalogue','[marc:catalog]',true,['W-M | Official Polo | White | M | 799 | assets/polo-white.png','R-L | Official Polo | Maroon | L | 825.50 | assets/polo-maroon.png']),
    item(4,'PARAGRAPH_TEXT','Order lines','[marc:lines]',true),
    item(5,'TEXT','Total','[marc:total]',true),
    item(6,'LIST','Total quantity','[marc:quantity]',true,['1','2','3','4','5']),
    item(7,'MULTIPLE_CHOICE','Programme','',true,['PGPM','Other']),
    item(8,'TEXT','Payment reference','[marc:transaction]',true),
    item(10,'TEXT','Payment screenshot link','[marc:proof]',true)
  ];
  const values={FORM_ID:'test-form',PAYMENT_QR_URL:'https://owner.github.io/marc-store/assets/payment-qr.png',PAYEE_NAME:'Test MARC',SCREENSHOT_FOLDER_ID:'private-test-folder'},responses=[],uploads=[],state={open:true,throwOnSubmit:false,folderAccess:'PRIVATE'};
  const props={getProperty:k=>values[k]||null,setProperty:(k,v)=>{values[k]=v;},deleteProperty:k=>{delete values[k];},getProperties:()=>({...values})};
  const form={getItems:()=>items,getItemById:id=>items.find(q=>q.id===id),collectsEmail:()=>false,hasLimitOneResponsePerUser:()=>false,isAcceptingResponses:()=>state.open,getDescription:()=>'',createResponse:()=>{
    const answers=[];return {withItemResponse:r=>{answers.push(r);},submit:()=>{if(state.throwOnSubmit)throw Error('Transport uncertain');responses.push(answers);return {getId:()=>String(responses.length)};}};
  }};
  const folder={getSharingAccess:()=>state.folderAccess,createFile:blob=>{const file={getId:()=>String(uploads.length),getUrl:()=>'https://drive.google.com/file/d/private-proof/view',setTrashed(){}};uploads.push({blob,file});return file;}};
  const context=vm.createContext({console:{log(){},error(){}},PropertiesService:{getScriptProperties:()=>props},FormApp:{openById:()=>form},DriveApp:{getFolderById:()=>folder},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},Utilities:{DigestAlgorithm:{SHA_256:'SHA_256'},computeDigest:(_,v)=>[...crypto.createHash('sha256').update(v).digest()],formatDate:date=>date.toISOString().slice(0,10)},ContentService:{MimeType:{JSON:'json',JAVASCRIPT:'js'},createTextOutput:text=>({text,setMimeType(){return this;}})}});
  vm.runInContext(fs.readFileSync(require.resolve('../backend/Code.gs'),'utf8'),context);
  function payload(overrides={}){return {requestId:'12345678-1234-1234-1234-123456789abc',version:context.storeModel_().version,items:[{sku:'W-M',qty:2}],fields:{1:'Student',2:'student@example.com',7:'PGPM',8:'123456789012'},...overrides};}
  const submit=(p,blob=proof())=>context.submitOrder(p,blob);
  return {context,items,responses,uploads,state,values,payload,submit};
}

test('new SKU choices appear without a script change and prices are read from the Form',()=>{
  const b=backend();let m=b.context.storeModel_();assert.equal(m.products.length,2);
  b.items[2].choices.push('W-XL | Official Polo | White | XL | 899 | assets/polo-white.png');
  const next=b.context.storeModel_();assert.equal(next.products[0].skus.length,2);assert.equal(next.products[0].skus[1].price,899);assert.notEqual(m.version,next.version);
  b.items[2].choices.push('B-M | New Polo | Black | M | 900');assert.equal(b.context.storeModel_().products.length,3);
});
test('order writes exact SKU choices, quantities and authoritative total, once',()=>{
  const b=backend(),p=b.payload();p.items[0].price=1;p.total=1;
  const result=b.submit(p);assert.equal(result.ok,true);assert.equal(result.total,1598);assert.equal(b.responses.length,1);
  assert.equal(b.responses[0].find(r=>r.id===5).value,'1598.00');assert.equal(b.responses[0].find(r=>r.id===6).value,'2');
  assert.equal(b.responses[0].find(r=>r.id===3).value[0],b.items[2].choices[0]);assert.match(b.responses[0].find(r=>r.id===4).value,/Qty 2/);
  assert.equal(b.submit(p).ok,true);assert.equal(b.responses.length,1);assert.equal(b.uploads.length,1);
  assert.match(b.responses[0].find(r=>r.id===10).value,/drive.google.com/);
});
test('a changed catalogue, removed SKU or closed Form prevents a new response',()=>{
  const b=backend(),p=b.payload();b.items[2].choices[0]=b.items[2].choices[0].replace('799','800');
  assert.match(b.submit(p).message,/changed/);assert.equal(b.responses.length,0);
  const invalid=b.payload({items:[{sku:'MISSING',qty:1}]});assert.equal(b.submit(invalid).ok,false);
  b.state.open=false;assert.match(b.submit(b.payload()).message,/closed/);assert.equal(b.responses.length,0);
});
test('added required questions appear in checkout and cannot be silently omitted',()=>{
  const b=backend();b.items.push(item(9,'TEXT','Batch year','',true));
  assert.equal(b.context.getCheckoutData().fields.some(q=>q.id==='9'),true);
  assert.match(b.submit(b.payload()).message,/Batch year/);assert.equal(b.responses.length,0);
});
test('quantity caps, duplicate SKU lines and invalid choices are rejected',()=>{
  const b=backend();assert.equal(b.submit(b.payload({items:[{sku:'W-M',qty:6}]})).ok,false);
  assert.equal(b.submit(b.payload({items:[{sku:'W-M',qty:1},{sku:'W-M',qty:1}]})).ok,false);
  const p=b.payload();p.fields[7]='Unlisted';assert.equal(b.submit(p).ok,false);assert.equal(b.responses.length,0);
});
test('formula-like text is protected and reused payment references are blocked',()=>{
  const b=backend(),p=b.payload();p.fields[1]='=1+1';p.fields[8]='123456789012';assert.equal(b.submit(p).ok,true);
  assert.equal(b.responses[0].find(r=>r.id===1).value,"'=1+1");
  const second=b.payload({requestId:'abcdefab-1234-1234-1234-123456789abc'});second.fields[8]='123456789012';
  assert.match(b.submit(second).message,/already been used/);assert.equal(b.responses.length,1);
});
test('an uncertain submit keeps its pending claim and is not repeated on retry',()=>{
  const b=backend(),p=b.payload();b.state.throwOnSubmit=true;assert.equal(b.submit(p).ok,false);
  b.state.throwOnSubmit=false;assert.match(b.submit(p).message,/may already/);assert.equal(b.responses.length,0);
});
test('unsupported item types fail closed and JSONP cannot call arbitrary JavaScript',()=>{
  const b=backend();b.items.push(item(10,'FILE_UPLOAD','Proof'));assert.equal(b.context.getCheckoutData().ok,false);
  const output=b.context.doGet({parameter:{callback:'alert(1)//'}});assert.equal(output.text,'Invalid callback.');assert.equal(b.responses.length,0);
});
test('browser bag reconciliation removes deleted SKUs, rejects bad quantities and caps totals',()=>{
  const products=[{skus:[{sku:'A',price:100,size:'M'},{sku:'B',price:200,size:'L'}]}];
  assert.deepEqual(core.reconcileBag([{sku:'removed',qty:1},{sku:'A',qty:4},{sku:'A',qty:1},{sku:'B',qty:4}],products,5),[{sku:'A',qty:4},{sku:'B',qty:1}]);
  assert.equal(core.imageUrl('javascript:alert(1)','https://store.example/'),'');
  assert.equal(core.imageUrl('assets/photo.png','https://person.github.io/marc-store/'),'https://person.github.io/marc-store/assets/photo.png');
});
test('missing or fake proof is rejected; valid proof is saved privately with its Form link',()=>{
  const b=backend(),p=b.payload();
  assert.equal(b.submit(p,null).ok,false);
  assert.equal(b.context.submitOrder(p).ok,false);
  assert.equal(b.submit(p,proof('image/png',[1,2,3,4])).ok,false);
  assert.equal(b.submit(p,proof('image/heic',[1,2,3,4])).ok,false);
  assert.equal(b.submit(p,proof('image/png',Array(5*1024*1024+1).fill(0))).ok,false);
  b.state.folderAccess='ANYONE';assert.equal(b.submit(p).ok,false);assert.equal(b.uploads.length,0);
  b.state.folderAccess='PRIVATE';
  const result=b.context.submitOrderForm({orderPayload:JSON.stringify(p),paymentProof:proof()});
  assert.equal(result.ok,true);assert.equal(b.uploads.length,1);assert.equal(b.responses.length,1);
  assert.match(b.responses[0].find(r=>r.id===10).value,/drive.google.com/);
  assert.equal(b.context.submitOrderForm({orderPayload:JSON.stringify(p),paymentProof:proof()}).ok,true);
  assert.equal(b.uploads.length,1);
});
test('payment setup and a valid 12-digit transaction ID are required before orders',()=>{
  const b=backend(),p=b.payload();p.fields[8]='abc123';assert.equal(b.submit(p).ok,false);
  p.fields[8]='12345678901';assert.equal(b.submit(p).ok,false);
  delete p.fields[8];assert.equal(b.submit(p).ok,false);
  b.values.PAYMENT_QR_URL='';assert.equal(b.context.storeModel_().ready,false);
  assert.equal(b.responses.length,0);
});
