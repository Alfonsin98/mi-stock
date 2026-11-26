'use strict';

/* =========================================================
   Mi Stock — PWA offline de stock y catastro de ventas
   Datos guardados en IndexedDB (sólo en este dispositivo)
   ========================================================= */

const APP_VERSION = '1.4.0';
const $ = (s) => document.querySelector(s);

const state = {
  products: [],
  sales: [],
  cart: new Map(),        // productId -> qty
  urls: new Map(),        // id -> { url, ts }
  tab: 'stock',
  editingId: null,
  photoBlob: undefined,   // undefined = sin cambios, null = quitada, Blob = nueva
  previewUrl: null,
  onlyLow: false,
  deferredInstall: null,
};

/* ---------- IndexedDB ---------- */
const DB_NAME = 'mi-stock';
const DB_VERSION = 2;
const STORE_PRODUCTS = 'products';
const STORE_SALES = 'sales';
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE_PRODUCTS)) {
        d.createObjectStore(STORE_PRODUCTS, { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains(STORE_SALES)) {
        d.createObjectStore(STORE_SALES, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let result;
    const req = fn(store);
    if (req) req.onsuccess = () => { result = req.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const dbGetAll = (s) => tx(s, 'readonly', (st) => st.getAll());
const dbPut = (s, item) => tx(s, 'readwrite', (st) => st.put(item));
const dbDelete = (s, id) => tx(s, 'readwrite', (st) => st.delete(id));
const dbPutMany = (s, items) => tx(s, 'readwrite', (st) => { items.forEach((x) => st.put(x)); });
const dbClear = (s) => tx(s, 'readwrite', (st) => st.clear());

/* ---------- Utilidades ---------- */
let currency = localStorage.getItem('currency') || 'ARS';
let fmt;
function setCurrency(c) {
  currency = c;
  localStorage.setItem('currency', c);
  fmt = new Intl.NumberFormat('es-AR', { style: 'currency', currency: c, minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
setCurrency(currency);

const money = (n) => fmt.format(Number(n) || 0);
const num = (v) => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) && n >= 0 ? n : 0; };
const int = (v) => Math.max(0, Math.round(num(v)));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const normalize = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => new Date().toISOString().slice(0, 10);
const getSize = (p) => String(p.size || p.sku || '').trim();

function stockStatus(p) {
  if (p.qty <= 0) return 'out';
  if (p.minQty != null && p.qty <= p.minQty) return 'low';
  return '';
}

function profitText(price, cost) {
  if (!cost || !price) return '';
  const gain = price - cost;
  const pct = (gain / cost) * 100;
  return `Ganancia ${money(gain)} (${pct.toFixed(0)}%)`;
}

function photoUrl(p) {
  if (!p.photo) return null;
  const cached = state.urls.get(p.id);
  if (cached && cached.ts === p.updatedAt) return cached.url;
  if (cached) URL.revokeObjectURL(cached.url);
  const url = URL.createObjectURL(p.photo);
  state.urls.set(p.id, { url, ts: p.updatedAt });
  return url;
}
function dropPhotoUrl(id) {
  const cached = state.urls.get(id);
  if (cached) { URL.revokeObjectURL(cached.url); state.urls.delete(id); }
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function buildCsvAndDownload(head, rows, filename) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = '\uFEFF' + [head, ...rows].map((r) => r.map(cell).join(';')).join('\r\n');
  downloadFile(new File([csv], filename, { type: 'text/csv;charset=utf-8' }));
}
const csvDec = (n) => String(Number(n) || 0).replace('.', ',');

/* ---------- Toast ---------- */
let toastTimer;
function toast(msg, action) {
  const el = $('#toast');
  $('#toastMsg').textContent = msg;
  const btn = $('#toastAction');
  clearTimeout(toastTimer);
  if (action) {
    btn.textContent = action.label;
    btn.onclick = () => { el.hidden = true; action.fn(); };
    btn.hidden = false;
    toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
  } else {
    btn.hidden = true;
    toastTimer = setTimeout(() => { el.hidden = true; }, 2500);
  }
  el.hidden = false;
}

/* ---------- Imágenes ---------- */
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

async function compressImage(file, max = 1280, quality = 0.8) {
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { src = await loadImage(file); }
  const w0 = src.width, h0 = src.height;
  const scale = Math.min(1, max / Math.max(w0, h0));
  const w = Math.round(w0 * scale), h = Math.round(h0 * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(src, 0, 0, w, h);
  if (src.close) src.close();
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
  return blob || file;
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
function dataURLToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const mime = (head.match(/:(.*?);/) || [])[1] || 'image/jpeg';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

/* ---------- Pestañas ---------- */
function switchTab(tab) {
  state.tab = tab;
  const isStock = tab === 'stock';
  $('#stockView').hidden = !isStock;
  $('#salesView').hidden = isStock;
  $('#addBtn').hidden = !isStock;
  $('#tabStock').classList.toggle('active', isStock);
  $('#tabSales').classList.toggle('active', !isStock);
  $('#tabStock').setAttribute('aria-selected', String(isStock));
  $('#tabSales').setAttribute('aria-selected', String(!isStock));
  renderCartBar();
  if (isStock) render(); else renderSales();
}
$('#tabStock').addEventListener('click', () => switchTab('stock'));
$('#tabSales').addEventListener('click', () => switchTab('sales'));

/* ---------- Render Stock ---------- */
const sorters = {
  recent: (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
  name: (a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }),
  priceAsc: (a, b) => a.price - b.price,
  priceDesc: (a, b) => b.price - a.price,
  qtyAsc: (a, b) => a.qty - b.qty,
  qtyDesc: (a, b) => b.qty - a.qty,
};

function filtered() {
  const q = normalize($('#search').value.trim());
  const cat = $('#catFilter').value;
  const sizeF = $('#sizeFilter').value;
  return state.products
    .filter((p) => (!cat || p.category === cat)
      && (!sizeF || getSize(p).toUpperCase() === sizeF.toUpperCase())
      && (!state.onlyLow || stockStatus(p))
      && (!q || normalize([p.name, p.category, getSize(p), p.notes].join(' ')).includes(q)))
    .sort(sorters[$('#sort').value] || sorters.recent);
}

function card(p) {
  const el = document.createElement('article');
  const status = stockStatus(p);
  el.className = 'card' + (status ? ' ' + status : '');
  el.dataset.id = p.id;
  const url = photoUrl(p);
  const sizeVal = getSize(p);
  const meta = [p.category, sizeVal ? `Talla ${sizeVal}` : ''].filter(Boolean).join(' · ');
  const badge = status === 'out' ? '<span class="badge out">Agotado</span>'
    : status === 'low' ? '<span class="badge low">Bajo</span>' : '';
  const inCart = state.cart.get(p.id) || 0;
  el.innerHTML = `
    <div class="thumb" data-act="view">${url ? `<img src="${url}" alt="" loading="lazy">` : '<span>📦</span>'}</div>
    <div class="info">
      <h3>${esc(p.name)}${badge}</h3>
      ${meta ? `<div class="meta">${esc(meta)}</div>` : ''}
      <div class="price">${money(p.price)}</div>
      ${p.cost ? `<div class="meta cost">Costo ${money(p.cost)} · ${esc(profitText(p.price, p.cost))}</div>` : ''}
    </div>
    <div class="card-controls">
      <div class="qty">
        <button class="qbtn" data-act="inc" aria-label="Sumar uno">+</button>
        <span class="qnum" data-act="set" title="Tocar para escribir cantidad">${p.qty}</span>
        <button class="qbtn" data-act="dec" aria-label="Restar uno">−</button>
      </div>
      <button class="qbtn cart-add" data-act="cart" title="Agregar a venta" aria-label="Agregar a venta" ${p.qty <= 0 ? 'disabled' : ''}>${inCart ? inCart : '🛒'}</button>
    </div>`;
  return el;
}

function render() {
  const items = filtered();
  $('#list').replaceChildren(...items.map(card));

  const empty = $('#empty');
  if (!state.products.length) {
    empty.innerHTML = 'Todavía no cargaste productos.<br>Tocá <b>＋</b> para agregar el primero con su foto y precio.';
    empty.hidden = false;
  } else if (!items.length) {
    empty.textContent = 'No hay productos que coincidan con la búsqueda.';
    empty.hidden = false;
  } else {
    empty.hidden = true;
  }

  let units = 0, cost = 0, value = 0;
  for (const p of items) { units += p.qty; cost += p.qty * (p.cost || 0); value += p.qty * p.price; }
  $('#sumItems').textContent = items.length;
  $('#sumUnits').textContent = units;
  $('#sumCost').textContent = money(cost);
  $('#sumValue').textContent = money(value);

  renderFilters();
  renderCartBar();
}

function renderFilters() {
  const cats = [...new Set(state.products.map((p) => p.category).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
  const catSel = $('#catFilter');
  const curCat = catSel.value;
  catSel.replaceChildren(new Option('Todas las categorías', ''), ...cats.map((c) => new Option(c, c)));
  catSel.value = cats.includes(curCat) ? curCat : '';
  $('#catList').replaceChildren(...cats.map((c) => { const o = document.createElement('option'); o.value = c; return o; }));

  const baseOrder = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
  const rawSizes = [...new Set(state.products.map(getSize).filter(Boolean))];
  const sizes = rawSizes.sort((a, b) => {
    const ia = baseOrder.indexOf(a.toUpperCase());
    const ib = baseOrder.indexOf(b.toUpperCase());
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' });
  });
  const sizeSel = $('#sizeFilter');
  const curSize = sizeSel.value;
  sizeSel.replaceChildren(new Option('Todas las tallas', ''), ...sizes.map((s) => new Option(s, s)));
  sizeSel.value = sizes.includes(curSize) ? curSize : '';
}

/* ---------- Guardado ---------- */
async function saveProduct(p) {
  await dbPut(STORE_PRODUCTS, p);
  const i = state.products.findIndex((x) => x.id === p.id);
  if (i >= 0) state.products[i] = p; else state.products.push(p);
  requestPersist();
}

async function changeQty(id, delta, absolute) {
  const p = state.products.find((x) => x.id === id);
  if (!p) return;
  const qty = absolute != null ? int(absolute) : Math.max(0, p.qty + delta);
  if (qty === p.qty) return;
  const updated = { ...p, qty, stockAt: Date.now() };
  await saveProduct(updated);
  if ((state.cart.get(id) || 0) > qty) {
    if (qty <= 0) state.cart.delete(id); else state.cart.set(id, qty);
  }
  render();
}

let persistAsked = false;
async function requestPersist() {
  if (persistAsked || !navigator.storage || !navigator.storage.persist) return;
  persistAsked = true;
  try { await navigator.storage.persist(); } catch { /* ignorar */ }
}

/* ---------- Carrito y Cobro ---------- */
function addToCart(id, delta = 1) {
  const p = state.products.find((x) => x.id === id);
  if (!p || p.qty <= 0) return toast('Producto sin stock');
  const cur = state.cart.get(id) || 0;
  const next = cur + delta;
  if (next <= 0) {
    state.cart.delete(id);
  } else if (next > p.qty) {
    toast(`Sólo quedan ${p.qty} u. en stock`);
    return;
  } else {
    state.cart.set(id, next);
  }
  render();
}

function renderCartBar() {
  let count = 0, total = 0;
  for (const [id, q] of state.cart.entries()) {
    const p = state.products.find((x) => x.id === id);
    if (!p || p.qty <= 0) { state.cart.delete(id); continue; }
    const validQ = Math.min(q, p.qty);
    if (validQ !== q) state.cart.set(id, validQ);
    count += validQ;
    total += validQ * p.price;
  }
  const show = count > 0 && state.tab === 'stock';
  $('#cartBar').hidden = !show;
  document.body.classList.toggle('has-cart', show);
  if (show) {
    $('#cartBarCount').textContent = `${count} ${count === 1 ? 'unidad' : 'unidades'}`;
    $('#cartBarTotal').textContent = money(total);
  }
}

function computeCheckoutTotals() {
  let subtotal = 0, costTotal = 0;
  for (const [id, q] of state.cart.entries()) {
    const p = state.products.find((x) => x.id === id);
    if (!p) continue;
    subtotal += q * p.price;
    costTotal += q * (p.cost || 0);
  }
  const discount = Math.min(subtotal, num($('#checkoutDiscount').value));
  const total = Math.max(0, subtotal - discount);
  return { subtotal, discount, total, costTotal };
}

function updateCheckoutSummary() {
  const { total } = computeCheckoutTotals();
  $('#checkoutTotal').textContent = money(total);
  const paidRaw = $('#checkoutPaid').value;
  const changeEl = $('#checkoutChange');
  if (paidRaw !== '') {
    const paid = num(paidRaw);
    const diff = paid - total;
    changeEl.textContent = diff >= 0 ? `Vuelto: ${money(diff)}` : `Faltan ${money(-diff)}`;
    changeEl.hidden = false;
  } else {
    changeEl.hidden = true;
  }
}

function renderCheckoutItems() {
  const wrap = $('#checkoutItems');
  const rows = [];
  for (const [id, q] of state.cart.entries()) {
    const p = state.products.find((x) => x.id === id);
    if (!p) continue;
    const size = getSize(p);
    const row = document.createElement('div');
    row.className = 'checkout-row';
    row.dataset.id = id;
    row.innerHTML = `
      <div class="checkout-row-info">
        <strong>${esc(p.name)}${size ? ` (${esc(size)})` : ''}</strong>
        <span>${money(p.price)} c/u · Subtotal ${money(p.price * q)}</span>
      </div>
      <div class="checkout-row-qty">
        <button type="button" class="qbtn" data-cact="dec">−</button>
        <span>${q}</span>
        <button type="button" class="qbtn" data-cact="inc">+</button>
      </div>`;
    rows.push(row);
  }
  wrap.replaceChildren(...rows);
  updateCheckoutSummary();
}

$('#cartClearBtn').addEventListener('click', () => { state.cart.clear(); render(); });
$('#cartCheckoutBtn').addEventListener('click', () => {
  if (!state.cart.size) return;
  $('#checkoutDiscount').value = '';
  $('#checkoutPaid').value = '';
  $('#checkoutNote').value = '';
  renderCheckoutItems();
  $('#checkoutDialog').showModal();
});
$('#checkoutCancel').addEventListener('click', () => $('#checkoutDialog').close());
$('#checkoutDiscount').addEventListener('input', updateCheckoutSummary);
$('#checkoutPaid').addEventListener('input', updateCheckoutSummary);
$('#checkoutItems').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-cact]');
  if (!btn) return;
  const id = btn.closest('.checkout-row').dataset.id;
  addToCart(id, btn.dataset.cact === 'inc' ? 1 : -1);
  if (!state.cart.size) { $('#checkoutDialog').close(); return; }
  renderCheckoutItems();
});

$('#checkoutForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.cart.size) return;

  const { subtotal, discount, total, costTotal } = computeCheckoutTotals();
  const items = [];
  const updatedProducts = [];

  for (const [id, q] of state.cart.entries()) {
    const p = state.products.find((x) => x.id === id);
    if (!p) continue;
    const soldQty = Math.min(q, p.qty);
    if (soldQty <= 0) continue;
    items.push({
      productId: p.id,
      name: p.name,
      category: p.category || '',
      size: getSize(p),
      price: p.price,
      cost: p.cost || 0,
      qty: soldQty,
    });
    updatedProducts.push({ ...p, qty: p.qty - soldQty, stockAt: Date.now() });
  }

  if (!items.length) return toast('No hay stock para vender');

  const sale = {
    id: uid(),
    createdAt: Date.now(),
    items,
    subtotal,
    discount,
    total,
    costTotal,
    payMethod: $('#checkoutPay').value || 'Efectivo',
    note: $('#checkoutNote').value.trim(),
  };

  try {
    await dbPutMany(STORE_PRODUCTS, updatedProducts);
    await dbPut(STORE_SALES, sale);
    for (const up of updatedProducts) {
      const idx = state.products.findIndex((x) => x.id === up.id);
      if (idx >= 0) state.products[idx] = up;
    }
    state.sales.push(sale);
    state.cart.clear();
    $('#checkoutDialog').close();
    render();
    toast(`✅ Venta registrada (${money(total)})`, {
      label: 'Ver catastro',
      fn: () => switchTab('sales'),
    });
  } catch (err) {
    console.error(err);
    toast('Error al registrar la venta');
  }
});

/* ---------- Catastro de ventas ---------- */
function inSalesRange(ts, range) {
  if (range === 'all') return true;
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (range === 'today') return ts >= startToday;
  if (range === '7d') return ts >= startToday - 6 * 86400000;
  if (range === 'month') return ts >= new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return true;
}

function filteredSales() {
  const q = normalize($('#salesSearch').value.trim());
  const range = $('#salesRange').value;
  const pay = $('#salesPayFilter').value;
  return state.sales
    .filter((s) => inSalesRange(s.createdAt, range)
      && (!pay || s.payMethod === pay)
      && (!q || normalize([
        s.payMethod,
        s.note,
        ...(s.items || []).map((it) => `${it.name} ${it.size} ${it.category}`),
      ].join(' ')).includes(q)))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function saleCard(s) {
  const el = document.createElement('article');
  el.className = 'sale-card';
  el.dataset.id = s.id;
  const dt = new Date(s.createdAt).toLocaleString('es-AR', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const profit = s.total - (s.costTotal || 0);
  const itemsHtml = (s.items || []).map((it) => {
    const label = `${it.qty} × ${it.name}${it.size ? ` (${it.size})` : ''}`;
    return `<li><span class="s-name">${esc(label)}</span><strong>${money(it.price * it.qty)}</strong></li>`;
  }).join('');
  el.innerHTML = `
    <div class="sale-head">
      <div>
        <div class="sale-date">${esc(dt)}</div>
        <span class="sale-pay">${esc(s.payMethod || 'Efectivo')}</span>
        ${s.note ? `<span class="sale-date"> · ${esc(s.note)}</span>` : ''}
      </div>
      <div class="sale-total">
        ${money(s.total)}
        ${s.discount ? `<div class="sale-date">Desc. ${money(s.discount)}</div>` : ''}
      </div>
    </div>
    <ul class="sale-items">${itemsHtml}</ul>
    <div class="sale-foot">
      <span>Ganancia: ${money(profit)}</span>
      <button type="button" class="btn small danger ghost" data-sact="void">Anular</button>
    </div>`;
  return el;
}

function renderSales() {
  const items = filteredSales();
  $('#salesList').replaceChildren(...items.map(saleCard));

  const empty = $('#salesEmpty');
  if (!state.sales.length) {
    empty.innerHTML = 'Todavía no hay ventas registradas.<br>Tocá <b>🛒</b> en cualquier producto del Stock para armar una venta.';
    empty.hidden = false;
  } else if (!items.length) {
    empty.textContent = 'No hay ventas en este período o búsqueda.';
    empty.hidden = false;
  } else {
    empty.hidden = true;
  }

  let units = 0, total = 0, profit = 0;
  for (const s of items) {
    total += s.total || 0;
    profit += (s.total || 0) - (s.costTotal || 0);
    for (const it of (s.items || [])) units += it.qty || 0;
  }
  $('#salesCount').textContent = items.length;
  $('#salesUnits').textContent = units;
  $('#salesTotal').textContent = money(total);
  $('#salesProfit').textContent = money(profit);
}

$('#salesSearch').addEventListener('input', renderSales);
$('#salesRange').addEventListener('change', renderSales);
$('#salesPayFilter').addEventListener('change', renderSales);

$('#salesList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-sact="void"]');
  if (!btn) return;
  const id = btn.closest('.sale-card').dataset.id;
  const s = state.sales.find((x) => x.id === id);
  if (!s) return;
  if (!confirm(`¿Anular esta venta de ${money(s.total)}?`)) return;
  const restore = confirm('¿Devolver también las unidades vendidas al stock?');
  if (restore) {
    const toUpdate = [];
    for (const it of (s.items || [])) {
      const p = state.products.find((x) => x.id === it.productId);
      if (p) {
        const up = { ...p, qty: p.qty + it.qty, stockAt: Date.now() };
        toUpdate.push(up);
        const idx = state.products.findIndex((x) => x.id === up.id);
        if (idx >= 0) state.products[idx] = up;
      }
    }
    if (toUpdate.length) await dbPutMany(STORE_PRODUCTS, toUpdate);
  }
  await dbDelete(STORE_SALES, id);
  state.sales = state.sales.filter((x) => x.id !== id);
  renderSales();
  toast(restore ? 'Venta anulada y stock devuelto' : 'Venta eliminada del catastro');
});

$('#salesCsvBtn').addEventListener('click', () => {
  const items = filteredSales();
  if (!items.length) return toast('No hay ventas para exportar');
  const head = ['Fecha y hora', 'Medio de pago', 'Cliente / Nota', 'Productos', 'Unidades', 'Descuento', 'Total', 'Ganancia'];
  const rows = items.map((s) => {
    const dt = new Date(s.createdAt).toLocaleString('es-AR');
    const prods = (s.items || []).map((it) => `${it.qty}x ${it.name}${it.size ? ` (${it.size})` : ''}`).join(' | ');
    const units = (s.items || []).reduce((acc, it) => acc + (it.qty || 0), 0);
    return [dt, s.payMethod || '', s.note || '', prods, units, csvDec(s.discount || 0), csvDec(s.total), csvDec(s.total - (s.costTotal || 0))];
  });
  buildCsvAndDownload(head, rows, `mi-stock-catastro-${today()}.csv`);
  toast('Catastro exportado');
});

/* ---------- Formulario Producto ---------- */
const form = $('#editForm');
const F = (n) => form.elements.namedItem(n);

function setPreview(blob) {
  if (state.previewUrl) { URL.revokeObjectURL(state.previewUrl); state.previewUrl = null; }
  const img = $('#photoPreview');
  if (blob) {
    state.previewUrl = URL.createObjectURL(blob);
    img.src = state.previewUrl;
    img.hidden = false;
    $('#photoPlaceholder').hidden = true;
    $('#photoRemove').hidden = false;
  } else {
    img.removeAttribute('src');
    img.hidden = true;
    $('#photoPlaceholder').hidden = false;
    $('#photoRemove').hidden = true;
  }
}

function updateMarginInfo() {
  $('#marginInfo').textContent = profitText(num(F('price').value), num(F('cost').value));
}

function updateSizeButtons(val) {
  const norm = String(val || '').trim().toUpperCase();
  document.querySelectorAll('.size-btn').forEach((btn) => {
    const match = btn.dataset.val.toUpperCase() === norm;
    btn.classList.toggle('active', match);
    btn.setAttribute('aria-pressed', String(match));
  });
}

function openEdit(p) {
  state.editingId = p ? p.id : null;
  state.photoBlob = undefined;
  form.reset();
  $('#editTitle').textContent = p ? 'Editar producto' : 'Nuevo producto';
  $('#deleteBtn').hidden = !p;
  $('#dupBtn').hidden = !p;
  $('#shareProdBtn').hidden = !p;
  if (p) {
    F('name').value = p.name;
    F('category').value = p.category || '';
    const s = getSize(p);
    F('size').value = s;
    updateSizeButtons(s);
    F('cost').value = p.cost || '';
    F('price').value = p.price;
    F('qty').value = p.qty;
    F('minQty').value = p.minQty ?? '';
    F('notes').value = p.notes || '';
  } else {
    F('category').value = $('#catFilter').value;
    const s = $('#sizeFilter').value || '';
    F('size').value = s;
    updateSizeButtons(s);
  }
  setPreview(p ? p.photo : null);
  updateMarginInfo();
  $('#editDialog').showModal();
  if (!p) setTimeout(() => F('name').focus(), 50);
}

function closeEdit() {
  $('#editDialog').close();
  setPreview(null);
}

async function onPhotoChosen(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const blob = await compressImage(file);
    state.photoBlob = blob;
    setPreview(blob);
  } catch (err) {
    console.error(err);
    toast('No se pudo leer la imagen');
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = F('name').value.trim();
  if (!name) { F('name').focus(); toast('Falta el nombre'); return; }
  if (F('price').value === '') { F('price').focus(); toast('Falta el precio de venta'); return; }

  const existing = state.products.find((x) => x.id === state.editingId);
  const now = Date.now();
  const sizeVal = (F('size')?.value || '').trim();
  const p = {
    ...(existing || { id: uid(), createdAt: now, photo: null }),
    name,
    category: F('category').value.trim(),
    size: sizeVal,
    sku: sizeVal,
    cost: num(F('cost').value),
    price: num(F('price').value),
    qty: int(F('qty').value),
    minQty: F('minQty').value === '' ? null : int(F('minQty').value),
    notes: F('notes').value.trim(),
    updatedAt: now,
  };
  if (state.photoBlob !== undefined) p.photo = state.photoBlob;

  try {
    await saveProduct(p);
    closeEdit();
    render();
    toast(existing ? 'Cambios guardados' : 'Producto agregado');
  } catch (err) {
    console.error(err);
    toast('Error al guardar: ' + (err && err.name === 'QuotaExceededError' ? 'sin espacio' : (err?.message || err)));
  }
});

$('#deleteBtn').addEventListener('click', async () => {
  const p = state.products.find((x) => x.id === state.editingId);
  if (!p || !confirm(`¿Eliminar "${p.name}"?`)) return;
  await dbDelete(STORE_PRODUCTS, p.id);
  state.products = state.products.filter((x) => x.id !== p.id);
  state.cart.delete(p.id);
  dropPhotoUrl(p.id);
  closeEdit();
  render();
  toast('Producto eliminado', {
    label: 'Deshacer',
    fn: async () => { await saveProduct(p); render(); },
  });
});

$('#dupBtn').addEventListener('click', () => {
  const existing = state.products.find((x) => x.id === state.editingId);
  if (!existing) return;
  if (state.photoBlob === undefined && existing.photo) {
    state.photoBlob = existing.photo;
  }
  state.editingId = null;
  $('#editTitle').textContent = 'Duplicar producto (elegí talla)';
  $('#deleteBtn').hidden = true;
  $('#dupBtn').hidden = true;
  $('#shareProdBtn').hidden = true;
  F('size').value = '';
  updateSizeButtons('');
  F('qty').value = '1';
  F('size').focus();
  toast('Elegí la nueva talla y tocá Guardar');
});

$('#shareProdBtn').addEventListener('click', async () => {
  const name = F('name').value.trim() || 'Producto';
  const size = (F('size').value || '').trim();
  const price = money(num(F('price').value));
  const qty = int(F('qty').value);
  const text = `${name}${size ? ` · Talla ${size}` : ''}\nPrecio: ${price}\n${qty > 0 ? 'Disponible' : 'Sin stock'}`;

  const existing = state.products.find((x) => x.id === state.editingId);
  const blob = state.photoBlob !== undefined ? state.photoBlob : (existing && existing.photo);

  try {
    if (blob && navigator.canShare) {
      const file = new File([blob], 'producto.jpg', { type: blob.type || 'image/jpeg' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: name, text });
        return;
      }
    }
    if (navigator.share) {
      await navigator.share({ title: name, text });
      return;
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
  }

  try {
    await navigator.clipboard.writeText(text);
    toast('Copiado para pegar en WhatsApp');
  } catch {
    toast('No se pudo compartir desde este navegador');
  }
});

$('#cancelBtn').addEventListener('click', closeEdit);
$('#editDialog').addEventListener('cancel', () => setPreview(null));
$('#photoCamera').addEventListener('change', onPhotoChosen);
$('#photoGallery').addEventListener('change', onPhotoChosen);
$('#photoRemove').addEventListener('click', () => { state.photoBlob = null; setPreview(null); });
F('price').addEventListener('input', updateMarginInfo);
F('cost').addEventListener('input', updateMarginInfo);
F('size').addEventListener('input', (e) => updateSizeButtons(e.target.value));

document.querySelectorAll('.size-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const current = (F('size').value || '').trim().toUpperCase();
    const val = (btn.dataset.val || '').toUpperCase();
    if (current === val) {
      F('size').value = '';
      updateSizeButtons('');
    } else {
      F('size').value = btn.dataset.val;
      updateSizeButtons(btn.dataset.val);
    }
  });
});

/* ---------- Lista Stock: eventos ---------- */
$('#list').addEventListener('click', (e) => {
  const cardEl = e.target.closest('.card');
  if (!cardEl) return;
  const id = cardEl.dataset.id;
  const p = state.products.find((x) => x.id === id);
  const act = e.target.closest('[data-act]')?.dataset.act;

  if (act === 'inc') return changeQty(id, +1);
  if (act === 'dec') return changeQty(id, -1);
  if (act === 'cart') return addToCart(id, +1);
  if (act === 'set') {
    const v = prompt(`Cantidad de "${p.name}"`, p.qty);
    if (v !== null && v.trim() !== '') changeQty(id, 0, v);
    return;
  }
  if (act === 'view' && p.photo) {
    $('#viewImg').src = photoUrl(p);
    $('#viewDialog').showModal();
    return;
  }
  openEdit(p);
});

$('#viewDialog').addEventListener('click', () => $('#viewDialog').close());
$('#addBtn').addEventListener('click', () => openEdit(null));
$('#search').addEventListener('input', render);
$('#catFilter').addEventListener('change', render);
$('#sizeFilter').addEventListener('change', render);
$('#sort').addEventListener('change', () => { localStorage.setItem('sort', $('#sort').value); render(); });
$('#lowFilter').addEventListener('click', (e) => {
  state.onlyLow = !state.onlyLow;
  e.currentTarget.setAttribute('aria-pressed', String(state.onlyLow));
  render();
});

for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', (e) => {
    if (e.target === d && d.id !== 'editDialog' && d.id !== 'checkoutDialog') d.close();
  });
}

/* ---------- Ajuste masivo de precios ---------- */
function applyPercent(value, pct, roundStep) {
  const raw = value * (1 + pct / 100);
  const rounded = roundStep > 0 ? Math.round(raw / roundStep) * roundStep : Math.round(raw * 100) / 100;
  return Math.max(0, rounded);
}

function bulkTargetProducts() {
  const cat = $('#bulkCat').value;
  return state.products.filter((p) => !cat || p.category === cat);
}

function updateBulkPreview() {
  const targets = bulkTargetProducts();
  const pct = parseFloat(String($('#bulkPct').value).replace(',', '.'));
  const step = int($('#bulkRound').value);
  if (!targets.length) {
    $('#bulkPreview').textContent = 'No hay productos en esa categoría.';
    return;
  }
  if (!Number.isFinite(pct) || pct === 0) {
    $('#bulkPreview').textContent = `Se modificarán ${targets.length} productos.`;
    return;
  }
  const sample = targets[0];
  const nextPrice = applyPercent(sample.price, pct, step);
  $('#bulkPreview').textContent = `Se actualizarán ${targets.length} productos. Ej: "${sample.name}" ${money(sample.price)} → ${money(nextPrice)}`;
}

$('#bulkPriceBtn').addEventListener('click', () => {
  if (!state.products.length) return toast('Primero cargá algún producto');
  const cats = [...new Set(state.products.map((p) => p.category).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
  $('#bulkCat').replaceChildren(new Option('Todas las categorías', ''), ...cats.map((c) => new Option(c, c)));
  $('#bulkPct').value = '';
  $('#bulkCostToo').checked = false;
  updateBulkPreview();
  $('#menuDialog').close();
  $('#bulkPriceDialog').showModal();
});
$('#bulkCancel').addEventListener('click', () => $('#bulkPriceDialog').close());
$('#bulkCat').addEventListener('change', updateBulkPreview);
$('#bulkPct').addEventListener('input', updateBulkPreview);
$('#bulkRound').addEventListener('change', updateBulkPreview);

$('#bulkPriceForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pct = parseFloat(String($('#bulkPct').value).replace(',', '.'));
  if (!Number.isFinite(pct) || pct === 0) return toast('Ingresá un porcentaje distinto de 0');
  const step = int($('#bulkRound').value);
  const costToo = $('#bulkCostToo').checked;
  const targets = bulkTargetProducts();
  if (!targets.length) return;
  if (!confirm(`¿Aplicar ${pct > 0 ? '+' : ''}${pct}% a ${targets.length} productos?`)) return;

  const now = Date.now();
  const updated = targets.map((p) => ({
    ...p,
    price: applyPercent(p.price, pct, step),
    cost: costToo && p.cost ? applyPercent(p.cost, pct, step) : p.cost,
    updatedAt: now,
  }));

  await dbPutMany(STORE_PRODUCTS, updated);
  for (const up of updated) {
    const idx = state.products.findIndex((x) => x.id === up.id);
    if (idx >= 0) state.products[idx] = up;
  }
  $('#bulkPriceDialog').close();
  render();
  toast(`Precios actualizados en ${updated.length} productos`);
});

/* ---------- Respaldo / exportación ---------- */
async function buildBackupFile() {
  const products = await Promise.all(state.products.map(async (p) => ({
    ...p,
    photo: p.photo ? await blobToDataURL(p.photo) : null,
  })));
  const data = {
    app: 'mi-stock',
    format: 2,
    exportedAt: new Date().toISOString(),
    currency,
    products,
    sales: state.sales,
  };
  return new File([JSON.stringify(data)], `mi-stock-respaldo-${today()}.json`, { type: 'application/json' });
}

$('#exportBtn').addEventListener('click', async () => {
  if (!state.products.length && !state.sales.length) return toast('No hay datos para respaldar');
  downloadFile(await buildBackupFile());
  localStorage.setItem('lastBackup', String(Date.now()));
  updateStorageInfo();
  toast('Respaldo descargado');
});

$('#shareBtn').addEventListener('click', async () => {
  if (!state.products.length && !state.sales.length) return toast('No hay datos para respaldar');
  const file = await buildBackupFile();
  try {
    await navigator.share({ files: [file], title: 'Respaldo Mi Stock' });
    localStorage.setItem('lastBackup', String(Date.now()));
    updateStorageInfo();
  } catch (err) {
    if (err.name !== 'AbortError') toast('No se pudo compartir');
  }
});

$('#importInput').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.products)) throw new Error('Archivo inválido');
    const items = data.products
      .filter((p) => p && p.id && p.name)
      .map((p) => ({
        id: String(p.id),
        name: String(p.name),
        category: p.category || '',
        size: p.size || p.sku || '',
        sku: p.size || p.sku || '',
        cost: num(p.cost),
        price: num(p.price),
        qty: int(p.qty),
        minQty: p.minQty == null || p.minQty === '' ? null : int(p.minQty),
        notes: p.notes || '',
        createdAt: p.createdAt || Date.now(),
        updatedAt: p.updatedAt || Date.now(),
        stockAt: p.stockAt,
        photo: typeof p.photo === 'string' && p.photo.startsWith('data:') ? dataURLToBlob(p.photo) : null,
      }));
    const sales = Array.isArray(data.sales)
      ? data.sales.filter((s) => s && s.id && Array.isArray(s.items))
      : [];
    const msg = sales.length
      ? `Se importarán ${items.length} productos y ${sales.length} ventas.\nLos que ya existan se reemplazarán. ¿Continuar?`
      : `Se importarán ${items.length} productos.\nLos que ya existan (mismo ID) se reemplazarán. ¿Continuar?`;
    if (!confirm(msg)) return;
    await dbPutMany(STORE_PRODUCTS, items);
    if (sales.length) await dbPutMany(STORE_SALES, sales);
    items.forEach((p) => dropPhotoUrl(p.id));
    state.products = await dbGetAll(STORE_PRODUCTS);
    state.sales = await dbGetAll(STORE_SALES);
    $('#menuDialog').close();
    render();
    if (state.tab === 'sales') renderSales();
    toast(`Importados ${items.length} productos` + (sales.length ? ` y ${sales.length} ventas` : ''));
  } catch (err) {
    console.error(err);
    toast('No se pudo importar: ' + (err.message || err));
  }
});

$('#csvBtn').addEventListener('click', () => {
  if (!state.products.length) return toast('No hay productos para exportar');
  const head = ['Nombre', 'Categoría', 'Talla', 'Precio costo', 'Precio venta', 'Cantidad', 'Stock mínimo', 'Valor costo', 'Valor venta', 'Notas'];
  const rows = [...state.products].sort(sorters.name).map((p) => [
    p.name, p.category, getSize(p), csvDec(p.cost), csvDec(p.price), p.qty, p.minQty ?? '',
    csvDec(p.qty * (p.cost || 0)), csvDec(p.qty * p.price), p.notes,
  ]);
  buildCsvAndDownload(head, rows, `mi-stock-${today()}.csv`);
  toast('Planilla exportada');
});

$('#wipeBtn').addEventListener('click', async () => {
  if (!state.products.length && !state.sales.length) return;
  if (!confirm('¿Borrar TODOS los productos y ventas de este dispositivo?')) return;
  if (!confirm('Esta acción no se puede deshacer. ¿Seguro? (Recomendado: descargar un respaldo antes)')) return;
  await dbClear(STORE_PRODUCTS);
  await dbClear(STORE_SALES);
  state.products.forEach((p) => dropPhotoUrl(p.id));
  state.products = [];
  state.sales = [];
  state.cart.clear();
  $('#menuDialog').close();
  render();
  if (state.tab === 'sales') renderSales();
  toast('Se borró todo');
});

/* ---------- Menú ---------- */
async function updateStorageInfo() {
  const parts = [`Versión ${APP_VERSION}`];
  const last = Number(localStorage.getItem('lastBackup'));
  parts.push(last ? `Último respaldo: ${new Date(last).toLocaleDateString('es-AR')}` : 'Sin respaldos todavía');
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const { usage, quota } = await navigator.storage.estimate();
      const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
      parts.push(`Espacio usado: ${mb(usage || 0)} de ${mb(quota || 0)}`);
    } catch { /* ignorar */ }
  }
  if (navigator.storage && navigator.storage.persisted) {
    try { if (await navigator.storage.persisted()) parts.push('Almacenamiento protegido ✔'); } catch { /* ignorar */ }
  }
  $('#storageInfo').textContent = parts.join(' · ');

  const banner = $('#backupBanner');
  const days = last ? (Date.now() - last) / 86400000 : Infinity;
  if ((state.products.length >= 3 || state.sales.length >= 3) && days >= 7) {
    banner.textContent = last
      ? `⚠️ Hace ${Math.floor(days)} días que no hacés respaldo. Descargá uno por seguridad.`
      : '⚠️ Todavía no hiciste un respaldo. Descargá uno para no perder tus datos.';
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

$('#menuBtn').addEventListener('click', () => {
  $('#currencySel').value = currency;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  $('#iosHint').hidden = !(isIOS && !standalone);
  $('#installBtn').hidden = !state.deferredInstall;
  try {
    const probe = new File(['x'], 'x.json', { type: 'application/json' });
    $('#shareBtn').hidden = !(navigator.canShare && navigator.canShare({ files: [probe] }));
  } catch { $('#shareBtn').hidden = true; }
  updateStorageInfo();
  $('#menuDialog').showModal();
});
$('#menuClose').addEventListener('click', () => $('#menuDialog').close());
$('#currencySel').addEventListener('change', (e) => { setCurrency(e.target.value); render(); if (state.tab === 'sales') renderSales(); });

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  state.deferredInstall = e;
});
$('#installBtn').addEventListener('click', async () => {
  const ev = state.deferredInstall;
  if (!ev) return;
  state.deferredInstall = null;
  $('#installBtn').hidden = true;
  ev.prompt();
  await ev.userChoice;
});
window.addEventListener('appinstalled', () => toast('¡App instalada!'));

/* ---------- Conexión ---------- */
function updateNet() { $('#netStatus').hidden = navigator.onLine; }
window.addEventListener('online', updateNet);
window.addEventListener('offline', updateNet);

/* ---------- Service worker y Actualizaciones ---------- */
let swRegistration = null;

async function checkForUpdates(manual = false) {
  if (!('serviceWorker' in navigator)) {
    if (manual) toast('Navegador sin soporte de Service Worker');
    return;
  }
  if (!navigator.onLine) {
    if (manual) toast('Sin conexión para buscar actualizaciones');
    return;
  }

  const btn = $('#updateBtn');
  if (manual && btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Buscando...';
  }

  try {
    const reg = swRegistration || (await navigator.serviceWorker.getRegistration());
    if (!reg) {
      if (manual) toast('No se encontró el Service Worker');
      return;
    }

    await reg.update();

    if (reg.waiting) {
      toast('Actualización lista', {
        label: 'Reiniciar',
        fn: () => reg.waiting.postMessage('SKIP_WAITING'),
      });
      reg.waiting.postMessage('SKIP_WAITING');
      return;
    }

    if (reg.installing) {
      toast('Descargando actualización...');
      reg.installing.addEventListener('statechange', (e) => {
        if (e.target.state === 'installed') {
          e.target.postMessage('SKIP_WAITING');
        }
      });
      return;
    }

    if (manual) {
      toast(`✅ La app está al día (v${APP_VERSION})`);
    }
  } catch (err) {
    console.warn('Error al verificar actualización:', err);
    if (manual) toast('No se pudo verificar la actualización');
  } finally {
    if (manual && btn) {
      btn.disabled = false;
      btn.textContent = '🔄 Buscar actualización';
    }
  }
}

if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let refreshing = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || refreshing) return;
    refreshing = true;
    location.reload();
  });

  window.addEventListener('load', async () => {
    try {
      swRegistration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });

      const offerUpdate = (worker) => toast('Hay una nueva versión', {
        label: 'Actualizar',
        fn: () => worker.postMessage('SKIP_WAITING'),
      });

      if (swRegistration.waiting && navigator.serviceWorker.controller) {
        offerUpdate(swRegistration.waiting);
      }

      swRegistration.addEventListener('updatefound', () => {
        const w = swRegistration.installing;
        if (!w) return;
        w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) {
            offerUpdate(w);
          }
        });
      });
    } catch (err) {
      console.warn('SW no registrado', err);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && navigator.onLine) {
      checkForUpdates(false);
    }
  });
}

$('#updateBtn').addEventListener('click', () => checkForUpdates(true));

/* ---------- Inicio ---------- */
(async function init() {
  updateNet();
  const savedSort = localStorage.getItem('sort');
  if (savedSort && sorters[savedSort]) $('#sort').value = savedSort;
  try {
    db = await openDB();
    [state.products, state.sales] = await Promise.all([
      dbGetAll(STORE_PRODUCTS),
      dbGetAll(STORE_SALES),
    ]);
  } catch (err) {
    console.error(err);
    toast('No se pudo abrir la base de datos local');
  }
  render();
})();
