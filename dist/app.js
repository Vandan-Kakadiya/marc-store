'use strict';
const C=window.MarcStoreCore, config=window.MARC_CONFIG;
const $=id=>document.getElementById(id);
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:2}).format(n);
const arrow='<svg class="arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19 19 5M5 5h14v14"/></svg>';
const previews=[{id:'preview-white',name:'MARC Polo',colour:'White',image:'assets/polo-white.png',skus:[]},{id:'preview-maroon',name:'MARC Polo',colour:'Maroon',image:'assets/polo-maroon.png',skus:[]}];
let products=previews,ready=false,maxItems=1,currentFilter='all',bag=[],activeProduct=null,activeSku=null,refreshPromise=null,toastTimer,savedBag=[],checkoutTarget='';
try{savedBag=JSON.parse(localStorage.getItem('marc-polo-bag-v2')||'[]');}catch{}
if(location.hash==='#order-received'){savedBag=[];try{localStorage.removeItem('marc-polo-bag-v2');}catch{}history.replaceState(null,'',location.pathname+location.search);}
function photo(p,className=''){
  const src=C.imageUrl(p.image,document.baseURI);
  return src?`<img class="${className}" src="${esc(src)}" alt="${esc(p.colour+' '+p.name)}" loading="lazy">`:`<div class="photo-placeholder ${className}"><img src="assets/marc-logo.png" alt="MARC"><span>Product photo coming soon</span></div>`;
}
document.addEventListener('error',e=>{const image=e.target;if(image.tagName==='IMG'&&image.closest('.product-image,.detail-art,.bag-thumb'))image.replaceWith(Object.assign(document.createElement('span'),{className:'image-unavailable',textContent:'Product photo coming soon'}));},true);
function count(){return bag.reduce((n,i)=>n+i.qty,0);}
function subtotal(){return bag.reduce((n,i)=>n+(C.skuLookup(products,i.sku)?.variant.price||0)*i.qty,0);}
function saveBag(){savedBag=bag;try{localStorage.setItem('marc-polo-bag-v2',JSON.stringify(bag));}catch{}updateCounts();}
function updateCounts(){$('bag-count').textContent=count();$('drawer-count').textContent=count();$('open-bag').setAttribute('aria-label',`Open shopping bag, ${count()} items`);}
function toast(text){clearTimeout(toastTimer);$('toast').textContent=text;$('toast').classList.add('visible');toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),3200);}
function openDialog(id){$(id).showModal();document.body.classList.add('modal-open');}
function closeDialog(id){$(id).close();}
for(const d of document.querySelectorAll('dialog')){
  d.addEventListener('close',()=>{if(!document.querySelector('dialog[open]'))document.body.classList.remove('modal-open');});
  d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}});
}
function renderCollection(){
  const filters=C.catalogueFilters(products);if(!filters.some(f=>f.key===currentFilter))currentFilter='all';
  $('filters').innerHTML=filters.map(f=>`<button class="filter ${currentFilter===f.key?'active':''}" data-filter="${esc(f.key)}" aria-pressed="${currentFilter===f.key}">${esc(f.label)}</button>`).join('');
  const visible=C.filterProducts(products,currentFilter);$('product-count').textContent=`${visible.length} ${visible.length===1?'product':'products'}`;
  $('product-grid').innerHTML=visible.length?visible.map(p=>{const price=p.skus.length?Math.min(...p.skus.map(s=>s.price)):null;return `<article class="product-card"><button class="product-image ${p.colour.toLowerCase()==='maroon'?'maroon-card':''}" data-product="${p.id}" aria-label="View ${esc(p.colour+' '+p.name)}"><span class="product-label">${esc(p.colour.toUpperCase())}</span>${photo(p)}<span class="product-plus" aria-hidden="true">+</span></button><div class="card-info"><div><button class="product-name" data-product="${p.id}">${esc(p.name)}</button><p>${esc(p.colour)} <span> / </span> IIM Trichy</p></div><span class="card-price">${price===null?'Coming soon':money(price)+(new Set(p.skus.map(s=>s.price)).size>1?' +':'')}</span></div><div class="product-meta">${p.skus.length?esc([...new Set(p.skus.map(s=>s.size))].join(' / ')):'Options and price to be announced'}</div></article>`;}).join(''):'<p class="empty-collection">There are no products in this collection yet. Please check back soon.</p>';
}
function renderProduct(){
  const p=activeProduct;
  $('product-detail').innerHTML=`<div class="product-layout"><div class="detail-art">${photo(p)}</div><div class="detail-copy"><div class="eyebrow muted">MARC / IIM TRICHY</div><h2 id="product-title">${esc(p.name)}</h2><p class="detail-colour">${esc(p.colour)}</p><p class="detail-price">${activeSku?money(activeSku.price):p.skus.length?'Select an option':'Coming soon'}</p><p class="detail-description">Campus merchandise by MARC, IIM Tiruchirappalli.</p>${p.skus.length?`<p class="option-label">Choose an option</p><div class="size-options" role="group" aria-label="Product options">${p.skus.map(s=>`<button class="size-option ${activeSku?.sku===s.sku?'selected':''}" data-sku="${s.sku}" aria-pressed="${activeSku?.sku===s.sku}">${esc(s.size)}</button>`).join('')}</div><button class="button primary full-width" id="add-to-bag" ${!ready||!activeSku||count()>=maxItems?'disabled':''}>${!ready?'Ordering paused':count()>=maxItems?'Your bag is full':activeSku?'Add to bag':'Select an option'} <span aria-hidden="true">+</span></button><p class="detail-note">Maximum ${maxItems} items per order.</p>`:'<div class="coming-soon"><strong>The collection is taking shape.</strong><p>Prices, product options and ordering will appear here when orders open.</p></div>'}</div></div>`;
}
function openProduct(id){activeProduct=products.find(p=>p.id===id);activeSku=activeProduct.skus.length===1?activeProduct.skus[0]:null;renderProduct();openDialog('product-dialog');}
function checkoutUrl(){return C.buildCheckoutUrl(checkoutTarget,bag);}
function renderBag(){
  updateCounts();
  $('bag-content').innerHTML=bag.length?`<div class="bag-items">${bag.map((line,i)=>{const {product:p,variant:s}=C.skuLookup(products,line.sku);return `<div class="bag-item"><div class="bag-thumb">${photo(p)}</div><div class="bag-info"><div class="bag-item-top"><h3>${esc(p.name)}</h3><button data-remove="${i}" class="remove-item" aria-label="Remove ${esc(p.colour+' '+p.name)}">×</button></div><p>${esc(p.colour)} / ${esc(s.size)}</p><div class="bag-item-bottom"><div class="quantity-control"><button data-quantity="${i}" data-delta="-1" aria-label="Decrease ${esc(p.colour)} quantity">−</button><span>${line.qty}</span><button data-quantity="${i}" data-delta="1" aria-label="Increase ${esc(p.colour)} quantity" ${count()>=maxItems?'disabled':''}>+</button></div><span>${money(s.price*line.qty)}</span></div></div></div>`;}).join('')}</div><div class="bag-summary"><div class="subtotal"><span>Subtotal</span><strong>${money(subtotal())}</strong></div><p>Google sign-in is required to continue to checkout. If already signed in, you can continue directly.</p>${ready?`<a class="button primary full-width google-checkout" href="${esc(checkoutUrl())}">Continue with Google ${arrow}</a>`:'<button class="button primary full-width" disabled>Ordering paused</button>'}<small>Prices and availability are checked again at checkout.</small></div>`:`<div class="empty-bag"><span aria-hidden="true">+</span><h3>Your campus essentials<br>are waiting.</h3><p>${ready?'Find your favourites in the collection.':'Your bag will be ready when ordering opens.'}</p><button class="button primary" data-close="bag-dialog">Explore the store ${arrow}</button></div>`;
}
function jsonp(url){return new Promise((resolve,reject)=>{
  const callback='marcCatalog_'+Date.now()+'_'+Math.random().toString(36).slice(2),script=document.createElement('script');let timer;
  const cleanup=()=>{clearTimeout(timer);script.remove();delete window[callback];};window[callback]=data=>{cleanup();resolve(data);};
  script.onerror=()=>{cleanup();reject(Error('Connection failed.'));};timer=setTimeout(()=>{cleanup();reject(Error('Connection timed out.'));},18000);
  const u=new URL(url);u.searchParams.set('action','catalog');u.searchParams.set('callback',callback);u.searchParams.set('_',Date.now());script.src=u.href;document.head.appendChild(script);
});}
async function refreshCatalogue(){
  if(!config.appsScriptUrl)return;if(refreshPromise)return refreshPromise;
  refreshPromise=(async()=>{try{
    const u=new URL(config.appsScriptUrl);if(u.protocol!=='https:'||u.hostname!=='script.google.com'||!/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(u.pathname))throw Error('Invalid Apps Script URL.');
    const data=C.validateCatalogue(await jsonp(u.href)),previous=JSON.stringify(bag);products=data.products;checkoutTarget=C.appsScriptUrl(data.checkoutUrl);ready=data.ready===true&&Boolean(checkoutTarget)&&products.length>0;maxItems=data.maxItems;
    bag=C.reconcileBag(savedBag,products,maxItems);saveBag();
    $('connection-message').textContent=ready?'Ordering is open. Browse the latest campus merchandise.':'Orders are not open yet. Browse the collection while we get ready.';
    $('connection-dot').classList.toggle('live',ready);$('catalogue-footnote').textContent=ready?'Choose a product and option to build your bag.':'Final ordering details will appear when orders open.';
    $('footer-status').textContent=ready?'The Campus Store · Orders open':'The Campus Store · Orders are not open';
    $('about-ordering').textContent=ready?'Choose your products and options, then sign in with Google to continue to checkout. The latest options and prices are checked before your order is saved.':'Prices, product options, payment details and order deadlines will be available when ordering opens.';
    if(previous!==JSON.stringify(bag)&&previous!=='[]')toast('Your bag was updated to match the latest collection.');renderCollection();if($('bag-dialog').open)renderBag();
    if($('product-dialog').open){const match=products.find(p=>p.id===activeProduct?.id);if(match){const old=activeSku?.sku;activeProduct=match;activeSku=match.skus.find(s=>s.sku===old)||null;renderProduct();}else closeDialog('product-dialog');}
  }catch{ready=false;$('connection-dot').classList.remove('live');$('connection-message').textContent='We could not refresh the collection. Ordering is paused. Please try again.';if($('bag-dialog').open)renderBag();if($('product-dialog').open)renderProduct();}})();
  try{await refreshPromise;}finally{refreshPromise=null;}
}
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;
  if(b.dataset.close){closeDialog(b.dataset.close);return;}
  if(b.dataset.filter){currentFilter=b.dataset.filter;renderCollection();[...$('filters').children].find(x=>x.dataset.filter===currentFilter)?.focus({preventScroll:true});return;}
  if(b.dataset.product){openProduct(b.dataset.product);return;}
  if(b.dataset.sku){activeSku=activeProduct.skus.find(s=>s.sku===b.dataset.sku);renderProduct();[...document.querySelectorAll('[data-sku]')].find(x=>x.dataset.sku===activeSku.sku)?.focus({preventScroll:true});return;}
  if(b.id==='add-to-bag'){if(!ready||!activeSku||count()>=maxItems)return;const line=bag.find(i=>i.sku===activeSku.sku);if(line)line.qty++;else bag.push({sku:activeSku.sku,qty:1});saveBag();closeDialog('product-dialog');toast('Added to your bag.');return;}
  if(b.id==='open-bag'){renderBag();openDialog('bag-dialog');return;}
  if(b.dataset.remove!==undefined){bag.splice(Number(b.dataset.remove),1);saveBag();renderBag();$('bag-dialog').querySelector('.remove-item,.empty-bag button')?.focus();return;}
  if(b.dataset.quantity!==undefined){const i=Number(b.dataset.quantity),delta=Number(b.dataset.delta);if(delta>0&&count()>=maxItems)return;bag[i].qty+=delta;if(bag[i].qty<=0)bag.splice(i,1);saveBag();renderBag();$('bag-dialog').querySelector('.quantity-control button:not(:disabled),.empty-bag button')?.focus();return;}
  if(b.id==='about-button'||b.id==='footer-about'){openDialog('about-dialog');return;}if(b.id==='refresh-catalogue')refreshCatalogue();
});
renderCollection();updateCounts();
if(config.appsScriptUrl){$('refresh-catalogue').hidden=false;refreshCatalogue();setInterval(()=>{if(!document.hidden)refreshCatalogue();},Math.max(15000,Number(config.refreshIntervalMs)||60000));window.addEventListener('focus',refreshCatalogue);}
