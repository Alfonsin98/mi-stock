'use strict';

/* =========================================================
   Mi Stock — PWA offline para control de stock con fotos
   Datos guardados en IndexedDB (sólo en este dispositivo)
   ========================================================= */

const APP_VERSION = '1.0.0';
const $ = (s) => document.querySelector(s);

const state = {
  products: [],
  urls: new Map(),        // id -> { url, ts } (URLs de fotos cacheadas)
  editingId: null,
  photoBlob: undefined,   // undefined = sin cambios, null = quitada, Blob = nueva
  previewUrl: null,
  onlyLow: false,
  deferredInstall: null,
};

/* ---------- IndexedDB ---------- */
const DB_NAME = 'mi-stock';
const DB_VERSION = 1;
const STORE = 'products';
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) {
        d.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    const req = fn(store);
    if (req) req.onsuccess = () => { result = req.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const dbGetAll = () => tx('readonly', (s) => s.getAll());
const dbPut = (p) => tx('readwrite', (s) => s.put(p));
const dbDelete = (id) => tx('readwrite', (s) => s.delete(id));
const dbPutMany = (items) => tx('readwrite', (s) => { items.forEach((p) => s.put(p)); });
const dbClear = () => tx('readwrite', (s) => s.clear());

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

// Reduce la foto (máx. 1280px, JPEG) para no llenar el almacenamiento
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

/* ---------- Render ---------- */
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
  return state.products
    .filter((p) => (!cat || p.category === cat)
      && (!state.onlyLow || stockStatus(p))
      && (!q || normalize([p.name, p.category, p.sku, p.notes].join(' ')).includes(q)))
    .sort(sorters[$('#sort').value] || sorters.recent);
}

function card(p) {
  const el = document.createElement('article');
  const status = stockStatus(p);
  el.className = 'card' + (status ? ' ' + status : '');
  el.dataset.id = p.id;
  const url = photoUrl(p);
  const meta = [p.category, p.sku].filter(Boolean).join(' · ');
  const badge = status === 'out' ? '<span class="badge out">Agotado</span>'
    : status === 'low' ? '<span class="badge low">Bajo</span>' : '';
  el.innerHTML = `
    <div class="thumb" data-act="view">${url ? `<img src="${url}" alt="" loading="lazy">` : '<span>📦</span>'}</div>
    <div class="info">
      <h3>${esc(p.name)}${badge}</h3>
      ${meta ? `<div class="meta">${esc(meta)}</div>` : ''}
      <div class="price">${money(p.price)}</div>
      ${p.cost ? `<div class="meta">Costo ${money(p.cost)} · ${esc(profitText(p.price, p.cost))}</div>` : ''}
    </div>
    <div class="qty">
      <button class="qbtn" data-act="inc" aria-label="Sumar uno">+</button>
      <span class="qnum" data-act="set" title="Tocar para escribir cantidad">${p.qty}</span>
      <button class="qbtn" data-act="dec" aria-label="Restar uno">−</button>
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

  // Resumen (de lo que se está mostrando)
  let units = 0, cost = 0, value = 0;
  for (const p of items) { units += p.qty; cost += p.qty * (p.cost || 0); value += p.qty * p.price; }
  $('#sumItems').textContent = items.length;
  $('#sumUnits').textContent = units;
  $('#sumCost').textContent = money(cost);
  $('#sumValue').textContent = money(value);

  renderCategories();
}

function renderCategories() {
  const cats = [...new Set(state.products.map((p) => p.category).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
  const sel = $('#catFilter');
  const current = sel.value;
  sel.replaceChildren(new Option('Todas las categorías', ''), ...cats.map((c) => new Option(c, c)));
  sel.value = cats.includes(current) ? current : '';
  $('#catList').replaceChildren(...cats.map((c) => { const o = document.createElement('option'); o.value = c; return o; }));
}

/* ---------- Guardado ---------- */
async function saveProduct(p) {
  await dbPut(p);
  const i = state.products.findIndex((x) => x.id === p.id);
  if (i >= 0) state.products[i] = p; else state.products.push(p);
  requestPersist();
}

async function changeQty(id, delta, absolute) {
  const p = state.products.find((x) => x.id === id);
  if (!p) return;
  const qty = absolute != null ? int(absolute) : Math.max(0, p.qty + delta);
  if (qty === p.qty) return;
  // updatedAt sólo cambia cuando cambia la foto/datos; para stock usamos stockAt
  const updated = { ...p, qty, stockAt: Date.now() };
  await saveProduct(updated);
  render();
}

let persistAsked = false;
async function requestPersist() {
  if (persistAsked || !navigator.storage || !navigator.storage.persist) return;
  persistAsked = true;
  try { await navigator.storage.persist(); } catch { /* ignorar */ }
}

/* ---------- Formulario ---------- */
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

function openEdit(p) {
  state.editingId = p ? p.id : null;
  state.photoBlob = undefined;
  form.reset();
  $('#editTitle').textContent = p ? 'Editar producto' : 'Nuevo producto';
  $('#deleteBtn').hidden = !p;
  if (p) {
    F('name').value = p.name;
    F('category').value = p.category || '';
    F('sku').value = p.sku || '';
    F('cost').value = p.cost || '';
    F('price').value = p.price;
    F('qty').value = p.qty;
    F('minQty').value = p.minQty ?? '';
    F('notes').value = p.notes || '';
  } else {
    // Mantener la categoría filtrada como sugerencia
    F('category').value = $('#catFilter').value;
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
  const p = {
    ...(existing || { id: uid(), createdAt: now, photo: null }),
    name,
    category: F('category').value.trim(),
    sku: F('sku').value.trim(),
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
  await dbDelete(p.id);
  state.products = state.products.filter((x) => x.id !== p.id);
  dropPhotoUrl(p.id);
  closeEdit();
  render();
  toast('Producto eliminado', {
    label: 'Deshacer',
    fn: async () => { await saveProduct(p); render(); },
  });
});

$('#cancelBtn').addEventListener('click', closeEdit);
$('#editDialog').addEventListener('cancel', () => setPreview(null));
$('#photoCamera').addEventListener('change', onPhotoChosen);
$('#photoGallery').addEventListener('change', onPhotoChosen);
$('#photoRemove').addEventListener('click', () => { state.photoBlob = null; setPreview(null); });
F('price').addEventListener('input', updateMarginInfo);
F('cost').addEventListener('input', updateMarginInfo);

/* ---------- Lista: eventos ---------- */
$('#list').addEventListener('click', (e) => {
  const cardEl = e.target.closest('.card');
  if (!cardEl) return;
  const id = cardEl.dataset.id;
  const p = state.products.find((x) => x.id === id);
  const act = e.target.closest('[data-act]')?.dataset.act;

  if (act === 'inc') return changeQty(id, +1);
  if (act === 'dec') return changeQty(id, -1);
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
$('#sort').addEventListener('change', () => { localStorage.setItem('sort', $('#sort').value); render(); });
$('#lowFilter').addEventListener('click', (e) => {
  state.onlyLow = !state.onlyLow;
  e.currentTarget.setAttribute('aria-pressed', String(state.onlyLow));
  render();
});

// Cerrar diálogos tocando fuera
for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', (e) => {
    if (e.target === d && d.id !== 'editDialog') d.close();
  });
}

/* ---------- Respaldo / exportación ---------- */
async function buildBackupFile() {
  const products = await Promise.all(state.products.map(async (p) => ({
    ...p,
    photo: p.photo ? await blobToDataURL(p.photo) : null,
  })));
  const data = { app: 'mi-stock', format: 1, exportedAt: new Date().toISOString(), currency, products };
  return new File([JSON.stringify(data)], `mi-stock-respaldo-${today()}.json`, { type: 'application/json' });
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

$('#exportBtn').addEventListener('click', async () => {
  if (!state.products.length) return toast('No hay productos para respaldar');
  downloadFile(await buildBackupFile());
  localStorage.setItem('lastBackup', String(Date.now()));
  toast('Respaldo descargado');
});

$('#shareBtn').addEventListener('click', async () => {
  if (!state.products.length) return toast('No hay productos para respaldar');
  const file = await buildBackupFile();
  try {
    await navigator.share({ files: [file], title: 'Respaldo Mi Stock' });
    localStorage.setItem('lastBackup', String(Date.now()));
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
        sku: p.sku || '',
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
    if (!confirm(`Se importarán ${items.length} productos.\nLos que ya existan (mismo ID) se reemplazarán. ¿Continuar?`)) return;
    await dbPutMany(items);
    items.forEach((p) => dropPhotoUrl(p.id));
    state.products = await dbGetAll();
    $('#menuDialog').close();
    render();
    toast(`Importados ${items.length} productos`);
  } catch (err) {
    console.error(err);
    toast('No se pudo importar: ' + (err.message || err));
  }
});

$('#csvBtn').addEventListener('click', () => {
  if (!state.products.length) return toast('No hay productos para exportar');
  const cell = (v) => {
    const s = String(v ?? '');
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const dec = (n) => String(Number(n) || 0).replace('.', ',');
  const head = ['Nombre', 'Categoría', 'Código', 'Precio costo', 'Precio venta', 'Cantidad', 'Stock mínimo', 'Valor costo', 'Valor venta', 'Notas'];
  const rows = [...state.products].sort(sorters.name).map((p) => [
    p.name, p.category, p.sku, dec(p.cost), dec(p.price), p.qty, p.minQty ?? '',
    dec(p.qty * (p.cost || 0)), dec(p.qty * p.price), p.notes,
  ]);
  const csv = '\uFEFF' + [head, ...rows].map((r) => r.map(cell).join(';')).join('\r\n');
  downloadFile(new File([csv], `mi-stock-${today()}.csv`, { type: 'text/csv;charset=utf-8' }));
  toast('Planilla exportada');
});

$('#wipeBtn').addEventListener('click', async () => {
  if (!state.products.length) return;
  if (!confirm('¿Borrar TODOS los productos de este dispositivo?')) return;
  if (!confirm('Esta acción no se puede deshacer. ¿Seguro? (Recomendado: descargar un respaldo antes)')) return;
  await dbClear();
  state.products.forEach((p) => dropPhotoUrl(p.id));
  state.products = [];
  $('#menuDialog').close();
  render();
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
$('#currencySel').addEventListener('change', (e) => { setCurrency(e.target.value); render(); });

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

/* ---------- Service worker ---------- */
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
      const reg = await navigator.serviceWorker.register('./sw.js');
      const offerUpdate = (worker) => toast('Hay una nueva versión', {
        label: 'Actualizar',
        fn: () => worker.postMessage('SKIP_WAITING'),
      });
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        if (!w) return;
        w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(w);
        });
      });
    } catch (err) {
      console.warn('SW no registrado', err);
    }
  });
}

/* ---------- Inicio ---------- */
(async function init() {
  updateNet();
  const savedSort = localStorage.getItem('sort');
  if (savedSort && sorters[savedSort]) $('#sort').value = savedSort;
  try {
    db = await openDB();
    state.products = await dbGetAll();
  } catch (err) {
    console.error(err);
    toast('No se pudo abrir la base de datos local');
  }
  render();
})();
