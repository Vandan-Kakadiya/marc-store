/* DOM-free catalogue utilities, shared with the Node tests. */
(function (root) {
  'use strict';
  function imageUrl(value, base) {
    if (!value) return '';
    try { const u=new URL(value,base); return ['https:','http:'].includes(u.protocol)?u.href:''; } catch { return ''; }
  }
  function validateCatalogue(data) {
    if (!data || data.apiVersion!==1 || !Array.isArray(data.products)) throw Error('Invalid catalogue.');
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
  const api={imageUrl,validateCatalogue,reconcileBag,skuLookup};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.MarcStoreCore=api;
})(typeof window==='undefined'?globalThis:window);
