/* DOM-free catalogue utilities, shared with the Node tests. */
(function (root) {
  'use strict';
  function imageUrl(value, base) {
    if (!value) return '';
    try {
      const u=new URL(value,base);
      if(!['https:','http:'].includes(u.protocol))return '';
      // Keep existing Form image paths working while serving smaller copies of
      // these two supplied assets. Other merchandise URLs are unchanged.
      for(const name of ['polo-white','polo-maroon']){
        if(u.href===new URL('assets/'+name+'.png',base).href)return new URL('assets/'+name+'.webp?v=speed1',base).href;
      }
      return u.href;
    } catch { return ''; }
  }
  function appsScriptUrl(value) {
    if(typeof value!=='string'||!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(value))return '';
    return value;
  }
  function buildCheckoutUrl(target,items) {
    if(!appsScriptUrl(target)||!Array.isArray(items)||!items.length)throw Error('Checkout is not configured.');
    const u=new URL(target);
    u.searchParams.set('page','checkout');
    // Query parameters survive Google's sign-in redirect. Only SKU/quantity,
    // never contact details, payment references or files, travel in this URL.
    u.searchParams.set('cart',JSON.stringify({items:items.map(line=>({sku:line.sku,qty:line.qty}))}));
    return u.href;
  }
  function buildBuyNowUrl(target,sku) {
    if(typeof sku!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(sku))throw Error('Choose a product option first.');
    const u=new URL(buildCheckoutUrl(target,[{sku,qty:1}]));
    u.searchParams.set('flow','buy-now');
    return u.href;
  }
  function validateCatalogue(data) {
    if (!data || data.apiVersion!==2 || !Array.isArray(data.products)) throw Error('Invalid catalogue.');
    if (!data.auth || data.auth.required!==true || data.auth.provider!=='google-account') throw Error('Google sign-in checkout is required.');
    if (data.ready===true&&!appsScriptUrl(data.checkoutUrl)) throw Error('Invalid checkout URL.');
    const seen=new Set();
    for (const p of data.products) {
      if (!p || !/^[a-zA-Z0-9_-]{1,80}$/.test(p.id) || typeof p.name!=='string' || typeof p.colour!=='string' || !Array.isArray(p.skus)) throw Error('Invalid product.');
      for (const s of p.skus) {
        if (!s || !/^[a-zA-Z0-9_-]{1,64}$/.test(s.sku) || seen.has(s.sku) || typeof s.size!=='string' || !Number.isFinite(s.price) || s.price<=0 || s.price>1000000 || Math.abs(s.price*100-Math.round(s.price*100))>0.00001) throw Error('Invalid SKU.');
        seen.add(s.sku);
      }
    }
    if (!Number.isInteger(data.maxItems)||data.maxItems<1||data.maxItems>100) throw Error('Invalid quantity limit.');
    return data;
  }
  function reconcileBag(bag,products,maxItems) {
    const available=new Set(products.flatMap(p=>p.skus.map(s=>s.sku))), result=[], seen=new Set();
    let remaining=maxItems;
    for (const line of Array.isArray(bag)?bag:[]) {
      if (!line||!available.has(line.sku)||seen.has(line.sku)||!Number.isInteger(line.qty)||line.qty<1) continue;
      const qty=Math.min(line.qty,remaining); if(qty>0)result.push({sku:line.sku,qty});
      remaining-=qty;seen.add(line.sku);
    }
    return result;
  }
  function skuLookup(products,sku) {
    for(const product of products){const variant=product.skus.find(s=>s.sku===sku);if(variant)return {product,variant};}
    return null;
  }
  function productFilterKey(product) { return 'product:'+product.name.trim().toLowerCase(); }
  function catalogueFilters(products) {
    const options=new Map();
    for(const product of products){const key=productFilterKey(product);if(!options.has(key))options.set(key,{key,label:product.name.trim()});}
    return [{key:'all',label:'All products'},...options.values()];
  }
  function filterProducts(products,key) { return key==='all'?products:products.filter(p=>productFilterKey(p)===key); }
  const api={imageUrl,appsScriptUrl,buildCheckoutUrl,buildBuyNowUrl,validateCatalogue,reconcileBag,skuLookup,catalogueFilters,filterProducts};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.MarcStoreCore=api;
})(typeof window==='undefined'?globalThis:window);
