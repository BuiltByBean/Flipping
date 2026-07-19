/* ============================================================
   Flips — personal resale / flip tracker
   Vanilla JS, IndexedDB (localStorage fallback), zero deps.
   All data lives on-device; JSON backup via Settings.
   ============================================================ */
'use strict';

const APP_VERSION = '1.0.0';

/* ---------------- constants ---------------- */
const SOURCES = [
  ['facebook', 'FB Marketplace'],
  ['estate', 'Estate sale'],
  ['garage', 'Garage sale'],
  ['thrift', 'Thrift store'],
  ['auction', 'Auction'],
  ['online', 'Online'],
  ['other', 'Other'],
];
const CATS = [
  ['furniture', 'Furniture', '🛋️'],
  ['electronics', 'Electronics', '🎮'],
  ['tools', 'Tools', '🛠️'],
  ['appliances', 'Appliances', '🫖'],
  ['collectibles', 'Collectibles', '🏺'],
  ['sports', 'Sports & Outdoors', '🚲'],
  ['toys', 'Toys & Games', '🧸'],
  ['clothing', 'Clothing & Shoes', '👟'],
  ['home', 'Home & Decor', '🪞'],
  ['other', 'Other', '📦'],
];
const PLATFORMS = [
  ['facebook', 'FB Marketplace'],
  ['ebay', 'eBay'],
  ['offerup', 'OfferUp'],
  ['craigslist', 'Craigslist'],
  ['mercari', 'Mercari'],
  ['local', 'Local / cash'],
  ['other', 'Other'],
];
const srcLabel = (k) => (SOURCES.find((s) => s[0] === k) || ['', 'Other'])[1];
const catLabel = (k) => (CATS.find((c) => c[0] === k) || ['', 'Other'])[1];
const catEmoji = (k) => (CATS.find((c) => c[0] === k) || ['', '', '📦'])[2];
const viaLabel = (k) => (PLATFORMS.find((p) => p[0] === k) || ['', 'Other'])[1];

/* ---------------- tiny utils ---------------- */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function uid() {
  try { return crypto.randomUUID(); } catch (e) {
    return 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  }
}
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };
function parseMoney(v) {
  if (v == null) return null;
  const s = String(v).replace(/[^0-9.\-]/g, '');
  if (!s) return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : Math.round(n * 100) / 100;
}
function money(n, sign) {
  if (n == null || isNaN(n)) return '—';
  n = Math.round(n * 100) / 100;
  const neg = n < 0;
  const v = Math.abs(n);
  const hasCents = Math.round(v * 100) % 100 !== 0;
  const s = '$' + v.toLocaleString('en-US', {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  });
  return (neg ? '−' : (sign && n > 0 ? '+' : '')) + s;
}
/* Dates are plain 'YYYY-MM-DD' strings, always parsed as LOCAL time —
   never new Date('YYYY-MM-DD'), which parses UTC and shifts a day. */
function todayYMD() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
const validYMD = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
function parseYMD(s) {
  if (!validYMD(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function fmtShort(s) {
  const d = parseYMD(s);
  if (!d) return '—';
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-US', opts);
}
const monthKey = (s) => (validYMD(s) ? s.slice(0, 7) : null);
function monthLong(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
function lastMonths(n) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const t = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0'));
  }
  return out;
}
function daysBetween(a, b) {
  const da = parseYMD(a), db = parseYMD(b);
  if (!da || !db) return null;
  return Math.max(0, Math.round((db - da) / 86400000));
}
const daysHeld = (it) => {
  const d = daysBetween(it.buyDate, it.status === 'sold' && it.sellDate ? it.sellDate : todayYMD());
  return d == null ? 0 : d;
};

/* ---------------- item model ---------------- */
function normItem(r) {
  r = r || {};
  return {
    id: r.id ? String(r.id) : uid(),
    name: String(r.name || '').slice(0, 120),
    category: CATS.some((c) => c[0] === r.category) ? r.category : 'other',
    source: SOURCES.some((s) => s[0] === r.source) ? r.source : 'other',
    buyPrice: num(r.buyPrice),
    buyDate: validYMD(r.buyDate) || todayYMD(),
    extraCosts: num(r.extraCosts),
    listPrice: r.listPrice == null || r.listPrice === '' ? null : num(r.listPrice),
    status: r.status === 'sold' ? 'sold' : 'inventory',
    sellPrice: r.sellPrice == null || r.sellPrice === '' ? null : num(r.sellPrice),
    sellDate: validYMD(r.sellDate),
    soldVia: r.soldVia || null,
    fees: num(r.fees),
    notes: String(r.notes || '').slice(0, 4000),
    photo: typeof r.photo === 'string' && r.photo.startsWith('data:image') ? r.photo : null,
    demo: !!r.demo,
    createdAt: r.createdAt || Date.now(),
  };
}
const isSold = (it) => it.status === 'sold';
const costOf = (it) => num(it.buyPrice) + num(it.extraCosts);           // what you have into it
const totalCostOf = (it) => costOf(it) + num(it.fees);                  // incl. selling fees
const profitOf = (it) => num(it.sellPrice) - totalCostOf(it);           // only meaningful when sold
function roiOf(it) {
  const c = totalCostOf(it);
  return c > 0 ? (profitOf(it) / c) * 100 : null;
}

/* ---------------- storage (IndexedDB, localStorage fallback) ---------------- */
const store = (() => {
  const LS_KEY = 'flips.items.v1';
  let db = null;
  let useLS = false;

  function init() {
    return new Promise((resolve) => {
      if (!('indexedDB' in window)) { useLS = true; return resolve(); }
      let req;
      try { req = indexedDB.open('flips-db', 1); } catch (e) { useLS = true; return resolve(); }
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('items')) {
          req.result.createObjectStore('items', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => { db = req.result; resolve(); };
      req.onerror = () => { useLS = true; resolve(); };
    });
  }
  const os = (mode) => db.transaction('items', mode).objectStore('items');
  const lsWrite = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(items)); } catch (e) { toast('Storage full — remove photos or export a backup', 'bad'); } };

  return {
    init,
    get mode() { return useLS ? 'localStorage' : 'IndexedDB'; },
    loadAll() {
      if (useLS) {
        try { return Promise.resolve(JSON.parse(localStorage.getItem(LS_KEY) || '[]')); }
        catch (e) { return Promise.resolve([]); }
      }
      return new Promise((res) => {
        const r = os('readonly').getAll();
        r.onsuccess = () => res(r.result || []);
        r.onerror = () => res([]);
      });
    },
    save(item) {
      if (useLS) { lsWrite(); return Promise.resolve(); }
      return new Promise((res) => {
        const r = os('readwrite').put(item);
        r.onsuccess = res;
        r.onerror = () => { toast('Could not save — storage error', 'bad'); res(); };
      });
    },
    remove(id) {
      if (useLS) { lsWrite(); return Promise.resolve(); }
      return new Promise((res) => {
        const r = os('readwrite').delete(id);
        r.onsuccess = res; r.onerror = () => res();
      });
    },
    replaceAll(arr) {
      if (useLS) { lsWrite(); return Promise.resolve(); }
      return new Promise((res) => {
        const t = db.transaction('items', 'readwrite');
        const o = t.objectStore('items');
        o.clear();
        arr.forEach((it) => o.put(it));
        t.oncomplete = res; t.onerror = () => res(); t.onabort = () => res();
      });
    },
  };
})();

/* ---------------- state ---------------- */
let items = [];
let view = 'dashboard';
let invQuery = '', invSort = 0;      // 0 newest · 1 oldest · 2 highest cost
let soldQuery = '', soldSort = 0;    // 0 recent · 1 top profit
let deferredPrompt = null;
let persistAsked = false;
let pendingPhoto; // undefined = untouched · null = removed · 'data:...' = new

const INV_SORTS = ['Newest', 'Oldest', 'Highest cost'];
const SOLD_SORTS = ['Recent', 'Top profit'];

/* ---------------- toasts ---------------- */
function toast(msg, kind) {
  const root = $('#toast-root');
  while (root.children.length >= 2) root.firstChild.remove();
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, 2400);
}

/* ---------------- derived stats ---------------- */
function computeStats() {
  const sold = items.filter(isSold);
  const inv = items.filter((i) => !isSold(i));
  const profit = sold.reduce((a, i) => a + profitOf(i), 0);
  const revenue = sold.reduce((a, i) => a + num(i.sellPrice), 0);
  const costSold = sold.reduce((a, i) => a + totalCostOf(i), 0);
  const roi = costSold > 0 ? (profit / costSold) * 100 : null;

  const keys2 = lastMonths(2);
  const mprofit = (k) => sold.filter((i) => monthKey(i.sellDate) === k).reduce((a, i) => a + profitOf(i), 0);
  const msales = (k) => sold.filter((i) => monthKey(i.sellDate) === k).length;
  const cur = mprofit(keys2[1]);
  const prev = mprofit(keys2[0]);
  let delta = '';
  if (msales(keys2[0]) > 0 && prev !== 0) {
    const pct = Math.round(((cur - prev) / Math.abs(prev)) * 100);
    delta = (pct >= 0 ? '▲ ' : '▼ ') + Math.abs(pct) + '% vs last mo';
  } else if (msales(keys2[1]) > 0) {
    delta = 'first sales month';
  }

  const invested = inv.reduce((a, i) => a + costOf(i), 0);
  const withDays = sold.filter((i) => i.sellDate && i.buyDate);
  const avgDays = withDays.length
    ? Math.round(withDays.reduce((a, i) => a + (daysBetween(i.buyDate, i.sellDate) || 0), 0) / withDays.length)
    : null;
  const avgFlip = sold.length ? profit / sold.length : null;

  const byMonth = {};
  sold.forEach((i) => { const k = monthKey(i.sellDate); if (k) byMonth[k] = (byMonth[k] || 0) + profitOf(i); });
  let bestMonth = null;
  Object.entries(byMonth).forEach(([k, v]) => { if (!bestMonth || v > bestMonth.v) bestMonth = { k, v }; });

  const top = sold.slice().sort((a, b) => profitOf(b) - profitOf(a)).slice(0, 3);
  return { sold, inv, profit, revenue, roi, cur, delta, invested, avgDays, avgFlip, bestMonth, top };
}

function groupBy(soldItems, keyFn, labelFn) {
  const m = new Map();
  soldItems.forEach((i) => {
    const k = keyFn(i);
    if (!m.has(k)) m.set(k, { label: labelFn(k), v: 0, count: 0 });
    const g = m.get(k);
    g.v += profitOf(i); g.count++;
  });
  return Array.from(m.values()).sort((a, b) => b.v - a.v);
}

/* ---------------- monthly chart ---------------- */
let chartData = [];
function chartSVG() {
  const keys = lastMonths(12);
  const sold = items.filter(isSold);
  chartData = keys.map((k) => {
    let v = 0, n = 0;
    sold.forEach((i) => { if (monthKey(i.sellDate) === k) { v += profitOf(i); n++; } });
    return { k, v, n };
  });
  const hasData = chartData.some((d) => d.n > 0);
  const W = 360, H = 172, padT = 18, padB = 24;
  const plotH = H - padT - padB;
  const slot = W / 12;
  const bw = Math.min(20, slot * 0.58);

  let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg">';
  svg += '<defs><linearGradient id="gpos" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="#34d399"/><stop offset="1" stop-color="#0d9488"/></linearGradient>' +
    '<linearGradient id="gneg" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="#e11d48"/><stop offset="1" stop-color="#fb7185"/></linearGradient></defs>';

  if (!hasData) {
    const ghost = [28, 52, 38, 66, 44, 78, 50, 88, 58, 72, 46, 82];
    ghost.forEach((g, i) => {
      const h = (g / 100) * plotH;
      const x = i * slot + (slot - bw) / 2;
      svg += '<rect x="' + x.toFixed(1) + '" y="' + (padT + plotH - h).toFixed(1) + '" width="' + bw.toFixed(1) +
        '" height="' + h.toFixed(1) + '" rx="4.5" fill="rgba(255,255,255,.05)"/>';
    });
    keys.forEach((k, i) => {
      const mi = Number(k.slice(5)) - 1;
      svg += '<text class="axm" x="' + (i * slot + slot / 2).toFixed(1) + '" y="' + (H - 7) + '" text-anchor="middle">' +
        'JFMAMJJASOND'[mi] + '</text>';
    });
    return svg + '</svg>';
  }

  let max = Math.max(0, ...chartData.map((d) => d.v));
  let min = Math.min(0, ...chartData.map((d) => d.v));
  if (max === 0 && min === 0) max = 1;
  const range = max - min;
  const y = (v) => padT + ((max - v) / range) * plotH;
  const zeroY = y(0);

  if (max > 0) {
    svg += '<line x1="0" x2="' + W + '" y1="' + y(max).toFixed(1) + '" y2="' + y(max).toFixed(1) +
      '" stroke="rgba(255,255,255,.06)" stroke-dasharray="3 4"/>' +
      '<text class="axv" x="' + W + '" y="' + (y(max) - 4).toFixed(1) + '" text-anchor="end">' + money(max) + '</text>';
  }
  svg += '<line x1="0" x2="' + W + '" y1="' + zeroY.toFixed(1) + '" y2="' + zeroY.toFixed(1) + '" stroke="rgba(255,255,255,.12)"/>';

  chartData.forEach((d, i) => {
    const x = i * slot + (slot - bw) / 2;
    let yy, h, fill;
    if (d.v >= 0) {
      yy = y(d.v); h = zeroY - yy; fill = 'url(#gpos)';
      if (h < 3) { h = d.n ? 3 : 2; yy = zeroY - h; if (!d.n) fill = 'rgba(255,255,255,.08)'; }
    } else {
      yy = zeroY; h = Math.max(3, y(d.v) - zeroY); fill = 'url(#gneg)';
    }
    const rx = Math.min(4.5, h / 2);
    svg += '<rect id="bar-' + i + '" class="bar' + (i === 11 ? ' sel' : '') + '" x="' + x.toFixed(1) +
      '" y="' + yy.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="' + rx.toFixed(1) +
      '" fill="' + fill + '"/>';
  });
  keys.forEach((k, i) => {
    const mi = Number(k.slice(5)) - 1;
    const cur = i === 11 ? ' cur' : '';
    svg += '<text class="axm' + cur + '" x="' + (i * slot + slot / 2).toFixed(1) + '" y="' + (H - 7) +
      '" text-anchor="middle">' + 'JFMAMJJASOND'[mi] + '</text>';
  });
  chartData.forEach((d, i) => {
    svg += '<rect data-mi="' + i + '" x="' + (i * slot).toFixed(1) + '" y="0" width="' + slot.toFixed(1) +
      '" height="' + H + '" fill="rgba(0,0,0,0)" style="cursor:pointer"/>';
  });
  return svg + '</svg>';
}
function mdetailHTML(i) {
  const d = chartData[i];
  if (!d) return '';
  const cls = d.v >= 0 ? 'pos' : 'neg';
  return '<b>' + monthLong(d.k) + '</b> &nbsp;·&nbsp; <b class="' + cls + '" style="color:var(--' + cls + ')">' +
    money(d.v, true) + '</b> profit &nbsp;·&nbsp; ' + d.n + ' sold';
}
function selectChartBar(i) {
  $$('.bar.sel').forEach((b) => b.classList.remove('sel'));
  const bar = $('#bar-' + i);
  if (bar) bar.classList.add('sel');
  const md = $('#mdetail');
  if (md) md.innerHTML = mdetailHTML(i);
}

/* ---------------- brand mark ---------------- */
const MARK_SVG = '<svg class="mark" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">' +
  '<defs><linearGradient id="mg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#34d399"/><stop offset="1" stop-color="#0d9488"/></linearGradient></defs>' +
  '<rect width="64" height="64" rx="15" fill="#122019"/>' +
  '<circle cx="32" cy="32" r="19" fill="none" stroke="url(#mg)" stroke-width="5" stroke-linecap="round" stroke-dasharray="72 48"/>' +
  '<text x="32" y="43" font-family="Arial,sans-serif" font-size="30" font-weight="bold" fill="#ecfdf5" text-anchor="middle">$</text></svg>';

/* ---------------- dashboard view ---------------- */
function renderDashboard() {
  const s = computeStats();
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  let h = '<div class="brand rise">' + MARK_SVG + '<b>Flips</b><span class="date">' + dateStr + '</span></div>';

  if (!items.length) {
    h += '<div class="card hero rise" style="text-align:center;padding:34px 20px">' +
      '<div class="big" style="font-size:46px">🏷️</div>' +
      '<h3 style="margin:10px 0 5px;font-size:20px;font-weight:800">Start flipping</h3>' +
      '<p style="margin:0 auto 20px;color:var(--sub);font-size:14px;max-width:280px">Log what you buy at garage sales, estate sales and FB Marketplace — then watch the profit stack up.</p>' +
      '<button class="btn btn-primary btn-big" data-action="add" style="max-width:260px">+ Add your first flip</button>' +
      '<div style="margin-top:14px"><button class="btn btn-ghost" data-action="sample" style="color:var(--sub);font-size:13px">or load sample data to explore</button></div>' +
      '</div>';
    $('#view').innerHTML = h;
    return;
  }

  const heroCls = s.profit >= 0 ? 'pos' : 'neg';
  h += '<div class="card hero rise">' +
    '<div class="lbl">Total profit</div>' +
    '<div class="num ' + heroCls + '" id="hero-num" data-target="' + s.profit + '">' + money(s.profit, true) + '</div>' +
    '<div class="sub">' + s.sold.length + ' sold · ' + s.inv.length + ' in inventory · ' + money(s.revenue) + ' total sales</div>' +
    '</div>';

  h += '<div class="stats rise" style="animation-delay:.05s">' +
    '<div class="stat"><div class="k">This month</div><div class="v ' + (s.cur > 0 ? 'pos' : s.cur < 0 ? 'neg' : '') + '">' + money(s.cur, true) + '</div><div class="d">' + (s.delta ? esc(s.delta) : '&nbsp;') + '</div></div>' +
    '<div class="stat"><div class="k">Avg ROI</div><div class="v">' + (s.roi == null ? '—' : Math.round(s.roi) + '%') + '</div><div class="d">on sold items</div></div>' +
    '<div class="stat"><div class="k">Avg / flip</div><div class="v">' + (s.avgFlip == null ? '—' : money(s.avgFlip, true)) + '</div><div class="d">' + (s.avgDays == null ? 'no sales yet' : s.avgDays + 'd avg to sell') + '</div></div>' +
    '</div>';

  h += '<div class="card rise" style="animation-delay:.1s" id="chartcard">' +
    '<h2>Profit by month <span class="hint">tap a bar</span></h2>' +
    '<div class="chart-wrap">' + chartSVG() + '</div>' +
    '<div id="mdetail">' + mdetailHTML(11) + '</div>' +
    '</div>';

  h += '<div class="stats two rise" style="animation-delay:.14s">' +
    '<div class="stat"><div class="k">Tied up in inventory</div><div class="v">' + money(s.invested) + '</div><div class="d">' + s.inv.length + ' item' + (s.inv.length === 1 ? '' : 's') + ' waiting</div></div>' +
    '<div class="stat"><div class="k">Best month</div><div class="v">' + (s.bestMonth ? money(s.bestMonth.v, true) : '—') + '</div><div class="d">' + (s.bestMonth ? monthLong(s.bestMonth.k) : 'sell something!') + '</div></div>' +
    '</div>';

  if (s.sold.length) {
    const cats = groupBy(s.sold, (i) => i.category, catLabel).slice(0, 6);
    const srcs = groupBy(s.sold, (i) => i.source, srcLabel).slice(0, 6);
    const maxAbs = (g) => Math.max(...g.map((x) => Math.abs(x.v)), 1);
    const hbars = (g) => {
      const m = maxAbs(g);
      return g.map((x) => {
        const w = Math.max(3, Math.round((Math.abs(x.v) / m) * 100));
        return '<div class="hrow"><div class="hlab">' + esc(x.label) + '<i>' + x.count + ' sold</i></div>' +
          '<div class="hval ' + (x.v >= 0 ? 'pos' : 'neg') + '">' + money(x.v, true) + '</div>' +
          '<div class="htrack"><div class="hfill' + (x.v < 0 ? ' neg' : '') + '" style="--w:' + w + '%"></div></div></div>';
      }).join('');
    };
    h += '<div class="card rise" style="animation-delay:.18s"><h2>Where the money is</h2>' + hbars(srcs) + '</div>';
    h += '<div class="card rise" style="animation-delay:.22s"><h2>Profit by category</h2>' + hbars(cats) + '</div>';

    if (s.top.length) {
      const medals = ['🥇', '🥈', '🥉'];
      h += '<div class="card rise" style="animation-delay:.26s"><h2>Best flips</h2>' +
        s.top.map((it, i) => {
          const d = daysBetween(it.buyDate, it.sellDate);
          return '<div class="toprow"><span class="medal">' + medals[i] + '</span>' +
            '<div class="n">' + esc(it.name) + '<small>' + money(it.buyPrice) + ' → ' + money(it.sellPrice) +
            (d != null ? ' · ' + d + ' days' : '') + '</small></div>' +
            '<span class="p">' + money(profitOf(it), true) + '</span></div>';
        }).join('') + '</div>';
    }
  } else {
    h += '<div class="card rise" style="animation-delay:.18s;text-align:center;padding:26px 18px">' +
      '<div style="font-size:30px;margin-bottom:8px">📈</div>' +
      '<div style="color:var(--sub);font-size:13.5px;max-width:300px;margin:0 auto">Mark your first item sold and this turns into source &amp; category analytics.</div></div>';
  }

  $('#view').innerHTML = h;
  animateHero();
}

function animateHero() {
  const el = $('#hero-num');
  if (!el) return;
  const target = parseFloat(el.dataset.target);
  if (isNaN(target) || Math.abs(target) < 0.01) return;
  const t0 = performance.now(), dur = 650;
  function step(t) {
    const p = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = money(target * e, true);
    if (p < 1) requestAnimationFrame(step);
    else el.textContent = money(target, true);
  }
  requestAnimationFrame(step);
}

/* ---------------- list filtering ---------------- */
function matchesQuery(it, q) {
  if (!q) return true;
  q = q.toLowerCase();
  return (it.name || '').toLowerCase().includes(q) ||
    (it.notes || '').toLowerCase().includes(q) ||
    catLabel(it.category).toLowerCase().includes(q) ||
    srcLabel(it.source).toLowerCase().includes(q);
}

/* ---------------- inventory view ---------------- */
function invItemHTML(it) {
  const held = daysHeld(it);
  return '<article class="item card" data-open="' + it.id + '">' +
    '<div class="thumb">' + (it.photo ? '<img src="' + it.photo + '" alt="">' : '<span>' + catEmoji(it.category) + '</span>') + '</div>' +
    '<div class="mid"><h3>' + esc(it.name) + '</h3>' +
    '<div class="meta">' + money(costOf(it)) + ' · ' + srcLabel(it.source) + ' · ' + fmtShort(it.buyDate) + '</div>' +
    '<div class="badges">' +
    (it.listPrice != null ? '<span class="badge amber">Listed ' + money(it.listPrice) + '</span>' : '') +
    '<span class="badge">' + held + 'd held</span>' +
    (it.demo ? '<span class="badge">sample</span>' : '') +
    '</div></div>' +
    '<button class="btn btn-mini btn-primary" data-sold="' + it.id + '">Sold</button>' +
    '</article>';
}
function renderInvList() {
  const box = $('#inv-list');
  if (!box) return;
  let list = items.filter((i) => !isSold(i)).filter((i) => matchesQuery(i, invQuery));
  if (invSort === 0) list.sort((a, b) => (b.buyDate || '').localeCompare(a.buyDate || '') || b.createdAt - a.createdAt);
  else if (invSort === 1) list.sort((a, b) => (a.buyDate || '').localeCompare(b.buyDate || '') || a.createdAt - b.createdAt);
  else list.sort((a, b) => costOf(b) - costOf(a));

  const invested = list.reduce((a, i) => a + costOf(i), 0);
  const sum = $('#inv-sum');
  if (sum) sum.textContent = list.length + ' item' + (list.length === 1 ? '' : 's') + ' · ' + money(invested) + ' invested';

  if (!list.length) {
    box.innerHTML = '<div class="empty"><div class="big">📦</div><h3>' +
      (invQuery ? 'No matches' : 'Nothing in inventory') + '</h3><p>' +
      (invQuery ? 'Try a different search.' : 'Hit the + button when you pick something up.') + '</p>' +
      (invQuery ? '' : '<button class="btn btn-primary" data-action="add">+ Add a flip</button>') + '</div>';
    return;
  }
  box.innerHTML = list.map(invItemHTML).join('');
}
function renderInventory() {
  $('#view').innerHTML =
    '<div class="lt rise"><h1>Inventory</h1><div class="sub">Stuff you’re holding, waiting to sell</div></div>' +
    '<div class="toolbar rise">' +
    '<div class="search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></svg>' +
    '<input id="inv-q" type="search" placeholder="Search inventory" value="' + esc(invQuery) + '" autocomplete="off"></div>' +
    '<button class="sortbtn" data-cycle="inv">' + INV_SORTS[invSort] + ' ▾</button>' +
    '</div>' +
    '<div class="sumline" id="inv-sum"></div>' +
    '<div class="list" id="inv-list"></div>';
  renderInvList();
}

/* ---------------- sold view ---------------- */
function soldItemHTML(it) {
  const p = profitOf(it);
  const roi = roiOf(it);
  const d = daysBetween(it.buyDate, it.sellDate);
  return '<article class="item card" data-open="' + it.id + '">' +
    '<div class="thumb">' + (it.photo ? '<img src="' + it.photo + '" alt="">' : '<span>' + catEmoji(it.category) + '</span>') + '</div>' +
    '<div class="mid"><h3>' + esc(it.name) + '</h3>' +
    '<div class="meta">' + money(totalCostOf(it)) + ' → ' + money(it.sellPrice) + ' · ' + viaLabel(it.soldVia) + '</div>' +
    '<div class="badges"><span class="badge">' + fmtShort(it.sellDate) + '</span>' +
    (d != null ? '<span class="badge">' + d + 'd flip</span>' : '') +
    (it.demo ? '<span class="badge">sample</span>' : '') +
    '</div></div>' +
    '<div class="pl ' + (p >= 0 ? 'pos' : 'neg') + '"><b>' + money(p, true) + '</b>' +
    (roi != null ? '<i>' + Math.round(roi) + '% ROI</i>' : '') + '</div>' +
    '</article>';
}
function renderSoldList() {
  const box = $('#sold-list');
  if (!box) return;
  let list = items.filter(isSold).filter((i) => matchesQuery(i, soldQuery));
  const total = list.reduce((a, i) => a + profitOf(i), 0);
  const sum = $('#sold-sum');
  if (sum) sum.textContent = list.length + ' sold · ' + money(total, true) + ' total profit';

  if (!list.length) {
    box.innerHTML = '<div class="empty"><div class="big">🏆</div><h3>' +
      (soldQuery ? 'No matches' : 'No sales yet') + '</h3><p>' +
      (soldQuery ? 'Try a different search.' : 'When something sells, tap "Sold" on it in Inventory.') + '</p></div>';
    return;
  }
  if (soldSort === 1) {
    list.sort((a, b) => profitOf(b) - profitOf(a));
    box.innerHTML = list.map(soldItemHTML).join('');
    return;
  }
  list.sort((a, b) => (b.sellDate || '').localeCompare(a.sellDate || '') || b.createdAt - a.createdAt);
  let h = '', lastK = null;
  list.forEach((it) => {
    const k = monthKey(it.sellDate) || 'unknown';
    if (k !== lastK) {
      lastK = k;
      const mine = list.filter((x) => (monthKey(x.sellDate) || 'unknown') === k);
      const mp = mine.reduce((a, x) => a + profitOf(x), 0);
      h += '<div class="mgroup"><b>' + (k === 'unknown' ? 'Undated' : monthLong(k)) + '</b><span>' +
        money(mp, true) + ' · ' + mine.length + ' sold</span></div>';
    }
    h += soldItemHTML(it);
  });
  box.innerHTML = h;
}
function renderSold() {
  $('#view').innerHTML =
    '<div class="lt rise"><h1>Sold</h1><div class="sub">Every flip you’ve closed out</div></div>' +
    '<div class="toolbar rise">' +
    '<div class="search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></svg>' +
    '<input id="sold-q" type="search" placeholder="Search sales" value="' + esc(soldQuery) + '" autocomplete="off"></div>' +
    '<button class="sortbtn" data-cycle="sold">' + SOLD_SORTS[soldSort] + ' ▾</button>' +
    '</div>' +
    '<div class="sumline" id="sold-sum"></div>' +
    '<div class="list" id="sold-list"></div>';
  renderSoldList();
}

/* ---------------- settings view ---------------- */
function renderSettings() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const hasDemo = items.some((i) => i.demo);

  let installRow;
  if (standalone) {
    installRow = '<div class="srow"><div class="ic">✅</div><div class="tx"><b>Installed</b><small>Running as an app — nice.</small></div></div>';
  } else if (deferredPrompt) {
    installRow = '<div class="srow"><div class="ic">📲</div><div class="tx"><b>Install on this device</b><small>Full-screen, offline, on your home screen</small></div><button class="btn btn-mini btn-primary" data-action="install">Install</button></div>';
  } else if (isIOS) {
    installRow = '<div class="srow"><div class="ic">📲</div><div class="tx"><b>Install on iPhone</b><small>Tap Share <span style="opacity:.8">⬆︎</span> → "Add to Home Screen"</small></div></div>';
  } else {
    installRow = '<div class="srow"><div class="ic">📲</div><div class="tx"><b>Install as app</b><small>In your browser menu: "Install app" / "Add to Home screen"</small></div></div>';
  }

  $('#view').innerHTML =
    '<div class="lt rise"><h1>Settings</h1><div class="sub">Your data lives on this device only</div></div>' +

    '<div class="card rise"><h2>Backup &amp; export</h2>' +
    '<div class="srow"><div class="ic">💾</div><div class="tx"><b>Export backup</b><small>Full JSON — photos included</small></div><button class="btn btn-mini" data-action="export-json">Export</button></div>' +
    '<div class="srow"><div class="ic">📥</div><div class="tx"><b>Import backup</b><small>Restore or merge a JSON backup</small></div><button class="btn btn-mini" data-action="import">Import</button></div>' +
    '<div class="srow"><div class="ic">📊</div><div class="tx"><b>Export CSV</b><small>Open in Excel / Google Sheets</small></div><button class="btn btn-mini" data-action="export-csv">Export</button></div>' +
    '<input type="file" id="import-in" accept="application/json,.json" class="hidden">' +
    '</div>' +

    '<div class="card rise" style="animation-delay:.05s"><h2>App</h2>' +
    installRow +
    '<div class="srow"><div class="ic">🗄️</div><div class="tx"><b>Storage</b><small id="storage-est">' + items.length + ' items · ' + store.mode + '</small></div></div>' +
    '<div class="srow"><div class="ic">🔄</div><div class="tx"><b>Check for updates</b><small>Version ' + APP_VERSION + '</small></div><button class="btn btn-mini" data-action="update">Check</button></div>' +
    '</div>' +

    '<div class="card rise" style="animation-delay:.1s"><h2>Sample data</h2>' +
    (hasDemo
      ? '<div class="srow"><div class="ic">🧹</div><div class="tx"><b>Remove sample data</b><small>Clears only the demo items</small></div><button class="btn btn-mini" data-action="sample-remove">Remove</button></div>'
      : '<div class="srow"><div class="ic">✨</div><div class="tx"><b>Load sample data</b><small>See the analytics with example flips</small></div><button class="btn btn-mini" data-action="sample">Load</button></div>') +
    '</div>' +

    '<div class="card rise" style="animation-delay:.15s"><h2>Danger zone</h2>' +
    '<div class="srow"><div class="ic">⚠️</div><div class="tx"><b>Delete everything</b><small>Wipes all items on this device</small></div><button class="btn btn-mini btn-danger" data-action="wipe">Delete</button></div>' +
    '</div>' +

    '<div class="foot">Flips v' + APP_VERSION + ' · built by <b>Bean</b><br>No accounts. No cloud. Your numbers stay yours.</div>';

  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then((e) => {
      const el = $('#storage-est');
      if (el && e && e.usage != null) {
        const mb = e.usage / 1048576;
        el.textContent = items.length + ' items · ' + (mb < 0.1 ? '<0.1' : mb.toFixed(1)) + ' MB · ' + store.mode;
      }
    }).catch(() => {});
  }
}

/* ---------------- sheets ---------------- */
function openSheet(inner) {
  const root = $('#sheet-root');
  root.innerHTML = '<div class="sheet-wrap"><div class="backdrop" data-close-sheet></div>' +
    '<div class="sheet"><div class="grab"></div>' + inner + '</div></div>';
  document.body.classList.add('locked');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const w = $('.sheet-wrap');
    if (w) w.classList.add('open');
  }));
}
function closeSheet() {
  const w = $('.sheet-wrap');
  if (!w) return;
  w.classList.remove('open');
  document.body.classList.remove('locked');
  setTimeout(() => { $('#sheet-root').innerHTML = ''; }, 300);
}
function sheetHead(title) {
  return '<div class="sheet-head"><h2>' + esc(title) + '</h2><button class="x" data-close-sheet aria-label="Close">✕</button></div>';
}
function chipsHTML(name, options, selected) {
  return '<div class="chips" data-chips="' + name + '">' +
    '<input type="hidden" name="' + name + '" value="' + esc(selected || '') + '">' +
    options.map((o) => '<button type="button" class="chip' + (o[0] === selected ? ' sel' : '') + '" data-val="' + o[0] + '">' + esc(o[1]) + '</button>').join('') +
    '</div>';
}

/* -------- add / edit sheet -------- */
function openItemSheet(id) {
  const it = id ? items.find((x) => x.id === id) : null;
  pendingPhoto = undefined;
  const editSold = it && isSold(it);

  let saleSec = '';
  if (editSold) {
    saleSec =
      '<label class="sec">Sale details</label>' +
      '<div class="frow">' +
      '<div class="money"><input class="in" name="sellPrice" inputmode="decimal" placeholder="0" value="' + (it.sellPrice != null ? it.sellPrice : '') + '"></div>' +
      '<input class="in" type="date" name="sellDate" value="' + (it.sellDate || todayYMD()) + '">' +
      '</div>' +
      '<label class="sec">Sold via</label>' + chipsHTML('soldVia', PLATFORMS, it.soldVia || 'other') +
      '<label class="sec">Fees &amp; shipping</label>' +
      '<div class="money"><input class="in" name="fees" inputmode="decimal" placeholder="0" value="' + (it.fees || '') + '"></div>';
  }

  openSheet(
    sheetHead(it ? 'Edit flip' : 'New flip') +
    '<div class="sheet-body"><form id="f-item" data-id="' + (it ? it.id : '') + '" autocomplete="off" novalidate>' +

    '<div class="photo-pick"><div class="pv" id="photo-pv">' +
    (it && it.photo ? '<img src="' + it.photo + '" alt="">' : '📷') + '</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<button type="button" class="btn btn-mini" data-action="pick-photo">' + (it && it.photo ? 'Change photo' : 'Add photo') + '</button>' +
    ((it && it.photo) ? '<button type="button" class="btn btn-mini btn-ghost" data-action="remove-photo" style="color:var(--faint)">Remove</button>' : '') +
    '</div>' +
    '<input type="file" id="photo-in" accept="image/*" class="hidden"></div>' +

    '<label class="sec">What is it?</label>' +
    '<input class="in" name="name" placeholder="Mid-century dresser" maxlength="120" value="' + esc(it ? it.name : '') + '" ' + (it ? '' : 'autofocus') + '>' +

    '<div class="frow" style="margin-top:10px">' +
    '<div><label class="sec" style="margin-top:0">Paid</label>' +
    '<div class="money"><input class="in" name="buyPrice" inputmode="decimal" placeholder="0" value="' + (it ? it.buyPrice : '') + '"></div></div>' +
    '<div><label class="sec" style="margin-top:0">Bought on</label>' +
    '<input class="in" type="date" name="buyDate" value="' + (it ? it.buyDate : todayYMD()) + '"></div>' +
    '</div>' +

    '<label class="sec">Where you found it</label>' + chipsHTML('source', SOURCES, it ? it.source : 'facebook') +
    '<label class="sec">Category</label>' + chipsHTML('category', CATS.map((c) => [c[0], c[2] + ' ' + c[1]]), it ? it.category : 'other') +

    saleSec +

    '<details class="more"' + (it && (it.listPrice != null || it.extraCosts || it.notes) ? ' open' : '') + '><summary>More — list price, extra costs, notes</summary>' +
    '<div class="frow" style="margin-top:6px">' +
    '<div><label class="sec" style="margin-top:0">Asking / listed at</label>' +
    '<div class="money"><input class="in" name="listPrice" inputmode="decimal" placeholder="—" value="' + (it && it.listPrice != null ? it.listPrice : '') + '"></div></div>' +
    '<div><label class="sec" style="margin-top:0">Extra costs</label>' +
    '<div class="money"><input class="in" name="extraCosts" inputmode="decimal" placeholder="0" value="' + (it && it.extraCosts ? it.extraCosts : '') + '"></div></div>' +
    '</div>' +
    '<label class="sec">Notes</label>' +
    '<textarea class="in" name="notes" placeholder="Condition, model, who to sell to…">' + esc(it ? it.notes : '') + '</textarea>' +
    '</details>' +

    '<div style="margin-top:18px"><button class="btn btn-primary btn-big" type="submit">' + (it ? 'Save changes' : 'Add to inventory') + '</button></div>' +
    '</form></div>'
  );
  const nameIn = $('#f-item input[name=name]');
  if (!it && nameIn) setTimeout(() => { try { nameIn.focus(); } catch (e) {} }, 350);
}

/* -------- mark-sold sheet -------- */
function openSoldSheet(id) {
  const it = items.find((x) => x.id === id);
  if (!it) return;
  openSheet(
    sheetHead('Mark sold') +
    '<div class="sheet-body">' +
    '<div class="minirow"><div class="thumb">' + (it.photo ? '<img src="' + it.photo + '" alt="">' : catEmoji(it.category)) + '</div>' +
    '<div style="flex:1;min-width:0"><b>' + esc(it.name) + '</b><small>' + money(costOf(it)) + ' into it · held ' + daysHeld(it) + ' days</small></div></div>' +
    '<form id="f-sold" data-id="' + it.id + '" autocomplete="off" novalidate>' +
    '<div class="frow" style="margin-top:12px">' +
    '<div><label class="sec" style="margin-top:0">Sold for</label>' +
    '<div class="money"><input class="in" name="sellPrice" inputmode="decimal" placeholder="0" value="' + (it.listPrice != null ? it.listPrice : '') + '" autofocus></div></div>' +
    '<div><label class="sec" style="margin-top:0">Sold on</label>' +
    '<input class="in" type="date" name="sellDate" value="' + todayYMD() + '"></div>' +
    '</div>' +
    '<label class="sec">Sold via</label>' + chipsHTML('soldVia', PLATFORMS, it.source === 'facebook' ? 'facebook' : 'local') +
    '<label class="sec">Fees &amp; shipping <span style="opacity:.6;text-transform:none;letter-spacing:0">(optional)</span></label>' +
    '<div class="money"><input class="in" name="fees" inputmode="decimal" placeholder="0"></div>' +
    '<div class="preview-line" id="profit-preview">Enter a price to see your profit</div>' +
    '<div style="margin-top:16px"><button class="btn btn-primary btn-big" type="submit">Confirm sale</button></div>' +
    '</form></div>'
  );
  updateProfitPreview();
  const priceIn = $('#f-sold input[name=sellPrice]');
  if (priceIn) setTimeout(() => { try { priceIn.focus(); priceIn.select(); } catch (e) {} }, 350);
}
function updateProfitPreview() {
  const f = $('#f-sold');
  const box = $('#profit-preview');
  if (!f || !box) return;
  const it = items.find((x) => x.id === f.dataset.id);
  if (!it) return;
  const sp = parseMoney(new FormData(f).get('sellPrice'));
  const fees = parseMoney(new FormData(f).get('fees')) || 0;
  if (sp == null) { box.textContent = 'Enter a price to see your profit'; return; }
  const p = sp - costOf(it) - fees;
  const c = costOf(it) + fees;
  const roi = c > 0 ? Math.round((p / c) * 100) : null;
  box.innerHTML = 'Profit: <b class="' + (p >= 0 ? 'pos' : 'neg') + '">' + money(p, true) + '</b>' +
    (roi != null ? ' &nbsp;·&nbsp; ' + roi + '% ROI' : '') +
    ' &nbsp;·&nbsp; ' + daysHeld(it) + ' day flip';
}

/* -------- detail sheet -------- */
function openDetailSheet(id) {
  const it = items.find((x) => x.id === id);
  if (!it) return;
  const sold = isSold(it);
  const p = profitOf(it);
  const roi = roiOf(it);

  let kv = '';
  const cell = (k, v) => '<div class="cell"><span>' + k + '</span><b>' + v + '</b></div>';
  kv += cell('Paid', money(it.buyPrice) + (it.extraCosts ? ' <small style="color:var(--faint)">+' + money(it.extraCosts) + ' extra</small>' : ''));
  kv += cell('Bought', fmtShort(it.buyDate));
  if (sold) {
    kv += cell('Sold for', money(it.sellPrice));
    kv += cell('Sold', fmtShort(it.sellDate));
    if (it.fees) kv += cell('Fees', money(it.fees));
    kv += cell('Time to sell', (daysBetween(it.buyDate, it.sellDate) != null ? daysBetween(it.buyDate, it.sellDate) + ' days' : '—'));
    kv += cell('Sold via', esc(viaLabel(it.soldVia)));
  } else {
    if (it.listPrice != null) kv += cell('Asking', money(it.listPrice));
    kv += cell('Held', daysHeld(it) + ' days');
  }
  kv += cell('Source', esc(srcLabel(it.source)));
  kv += cell('Category', catEmoji(it.category) + ' ' + esc(catLabel(it.category)));

  openSheet(
    sheetHead(sold ? 'Sold flip' : 'In inventory') +
    '<div class="sheet-body">' +
    (it.photo ? '<img class="dphoto" src="' + it.photo + '" alt="">' : '') +
    '<div class="dhead"><h3>' + esc(it.name) + '</h3>' +
    '<span class="pstat ' + (sold ? 'sold' : 'inv') + '">' + (sold ? 'SOLD' : 'HOLDING') + '</span></div>' +
    (sold ? '<div class="dprofit ' + (p >= 0 ? 'pos' : 'neg') + '">' + money(p, true) +
      '<small>' + (roi != null ? Math.round(roi) + '% ROI' : '') + '</small></div>' : '') +
    '<div class="kv">' + kv + '</div>' +
    (it.notes ? '<div class="dnotes">' + esc(it.notes) + '</div>' : '') +
    '<div class="btnrow">' +
    (sold
      ? '<button class="btn" data-edit="' + it.id + '">Edit</button><button class="btn" data-revert="' + it.id + '">Back to inventory</button>'
      : '<button class="btn" data-edit="' + it.id + '">Edit</button><button class="btn btn-primary" data-sold="' + it.id + '">Mark sold</button>') +
    '<button class="btn btn-danger full" data-del="' + it.id + '">Delete this flip</button>' +
    '</div>' +
    '</div>'
  );
}

/* ---------------- photo handling ---------------- */
async function compressImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    const max = 900;
    const s = Math.min(1, max / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    const w = Math.max(1, Math.round((img.naturalWidth || 1) * s));
    const h = Math.max(1, Math.round((img.naturalHeight || 1) * s));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.72);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ---------------- saving ---------------- */
async function askPersist() {
  if (persistAsked) return;
  persistAsked = true;
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
}

async function saveItemForm(f) {
  const fd = new FormData(f);
  const id = f.dataset.id;
  const name = String(fd.get('name') || '').trim();
  const buy = parseMoney(fd.get('buyPrice'));
  if (!name) { toast('Give it a name', 'warn'); const i = $('input[name=name]', f); if (i) { i.classList.add('err'); i.focus(); } return; }
  if (buy == null) { toast('Enter what you paid', 'warn'); const i = $('input[name=buyPrice]', f); if (i) { i.classList.add('err'); i.focus(); } return; }

  let it = id ? items.find((x) => x.id === id) : null;
  const base = it ? it : normItem({});
  base.name = name.slice(0, 120);
  base.buyPrice = buy;
  base.buyDate = validYMD(fd.get('buyDate')) || base.buyDate || todayYMD();
  base.source = String(fd.get('source') || 'other');
  base.category = String(fd.get('category') || 'other');
  base.listPrice = parseMoney(fd.get('listPrice'));
  base.extraCosts = parseMoney(fd.get('extraCosts')) || 0;
  base.notes = String(fd.get('notes') || '').trim().slice(0, 4000);
  if (pendingPhoto !== undefined) base.photo = pendingPhoto;
  if (it && isSold(it)) {
    const sp = parseMoney(fd.get('sellPrice'));
    if (sp != null) base.sellPrice = sp;
    base.sellDate = validYMD(fd.get('sellDate')) || base.sellDate;
    base.soldVia = String(fd.get('soldVia') || base.soldVia || 'other');
    const fe = parseMoney(fd.get('fees'));
    if (fe != null) base.fees = fe;
  }
  if (!it) items.unshift(base);
  await store.save(base);
  closeSheet();
  toast(it ? 'Saved' : 'Added to inventory', 'good');
  render();
  askPersist();
}

async function saveSoldForm(f) {
  const it = items.find((x) => x.id === f.dataset.id);
  if (!it) return;
  const fd = new FormData(f);
  const sp = parseMoney(fd.get('sellPrice'));
  if (sp == null) { toast('What did it sell for?', 'warn'); const i = $('input[name=sellPrice]', f); if (i) { i.classList.add('err'); i.focus(); } return; }
  it.status = 'sold';
  it.sellPrice = sp;
  it.sellDate = validYMD(fd.get('sellDate')) || todayYMD();
  it.soldVia = String(fd.get('soldVia') || 'other');
  it.fees = parseMoney(fd.get('fees')) || 0;
  await store.save(it);
  closeSheet();
  const p = profitOf(it);
  toast('Sold for ' + money(sp) + ' — ' + money(p, true) + ' profit' + (p > 0 ? ' 🎉' : ''), p >= 0 ? 'good' : 'warn');
  setView('sold');
  askPersist();
}

async function deleteItem(id) {
  const idx = items.findIndex((x) => x.id === id);
  if (idx === -1) return;
  items.splice(idx, 1);
  await store.remove(id);
  closeSheet();
  toast('Deleted');
  render();
}

async function revertItem(id) {
  const it = items.find((x) => x.id === id);
  if (!it) return;
  it.status = 'inventory';
  it.sellPrice = null;
  it.sellDate = null;
  it.soldVia = null;
  it.fees = 0;
  await store.save(it);
  closeSheet();
  toast('Moved back to inventory');
  setView('inventory');
}

/* two-tap confirm for destructive buttons */
function armConfirm(btn, label) {
  if (btn.dataset.armed) return true;
  btn.dataset.armed = '1';
  btn.dataset.prev = btn.textContent;
  btn.textContent = label;
  btn.classList.add('armed');
  setTimeout(() => {
    if (btn.isConnected) {
      delete btn.dataset.armed;
      btn.textContent = btn.dataset.prev;
      btn.classList.remove('armed');
    }
  }, 2600);
  return false;
}

/* ---------------- export / import ---------------- */
function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
async function shareOrDownload(filename, text, mime) {
  try {
    if (navigator.canShare && matchMedia('(pointer:coarse)').matches) {
      const file = new File([text], filename, { type: mime });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return;
      }
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return; // user closed the share sheet
  }
  download(filename, text, mime);
}
function exportJSON() {
  const payload = { app: 'flips', version: APP_VERSION, exportedAt: new Date().toISOString(), items };
  shareOrDownload('flips-backup-' + todayYMD() + '.json', JSON.stringify(payload, null, 1), 'application/json');
  toast('Backup exported', 'good');
}
function exportCSV() {
  const cols = ['Name', 'Category', 'Source', 'Status', 'Buy Price', 'Buy Date', 'Extra Costs', 'List Price',
    'Sell Price', 'Sell Date', 'Sold Via', 'Fees', 'Profit', 'ROI %', 'Days Held', 'Notes'];
  const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const rows = items.map((it) => {
    const sold = isSold(it);
    return [
      it.name, catLabel(it.category), srcLabel(it.source), it.status,
      it.buyPrice, it.buyDate, it.extraCosts || '', it.listPrice != null ? it.listPrice : '',
      sold && it.sellPrice != null ? it.sellPrice : '', sold ? (it.sellDate || '') : '',
      sold ? viaLabel(it.soldVia) : '', sold ? (it.fees || '') : '',
      sold ? profitOf(it).toFixed(2) : '', sold && roiOf(it) != null ? Math.round(roiOf(it)) : '',
      daysHeld(it), it.notes,
    ].map(q).join(',');
  });
  const csv = '\uFEFF' + cols.map(q).join(',') + '\r\n' + rows.join('\r\n');
  shareOrDownload('flips-' + todayYMD() + '.csv', csv, 'text/csv');
  toast('CSV exported', 'good');
}
async function doImport(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch (e) { toast('That file isn’t valid JSON', 'bad'); return; }
  const arr = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : null);
  if (!arr) { toast('No items found in that file', 'bad'); return; }
  const map = new Map(items.map((i) => [i.id, i]));
  let added = 0, updated = 0;
  arr.forEach((r) => {
    const it = normItem(r);
    if (map.has(it.id)) { Object.assign(map.get(it.id), it); updated++; }
    else { map.set(it.id, it); added++; }
  });
  items = Array.from(map.values());
  await store.replaceAll(items);
  toast('Imported — ' + added + ' new, ' + updated + ' updated', 'good');
  render();
}

/* ---------------- sample data ---------------- */
function daysAgoYMD(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function buildSample() {
  const S = (id, name, category, source, buy, boughtAgo, sell, soldAgo, via, fees, extra, notes) => normItem({
    id: 'demo-' + id, name, category, source,
    buyPrice: buy, buyDate: daysAgoYMD(boughtAgo), extraCosts: extra || 0,
    status: sell != null ? 'sold' : 'inventory',
    sellPrice: sell, sellDate: soldAgo != null ? daysAgoYMD(soldAgo) : null,
    soldVia: via || null, fees: fees || 0, notes: notes || '', demo: true,
  });
  return [
    S(1, 'Mid-century dresser', 'furniture', 'estate', 45, 160, 210, 148, 'facebook', 0, 12, 'Needed new drawer pulls'),
    S(2, 'DeWalt drill combo kit', 'tools', 'garage', 25, 150, 95, 141, 'facebook', 0, 0),
    S(3, 'KitchenAid stand mixer', 'appliances', 'estate', 40, 132, 160, 118, 'offerup', 0, 0, 'Deep cleaned, ran perfect'),
    S(4, 'PS4 + 6 games', 'electronics', 'facebook', 80, 121, 150, 109, 'facebook', 0, 0),
    S(5, 'Vintage Coleman lantern', 'collectibles', 'garage', 8, 104, 55, 76, 'ebay', 9, 0),
    S(6, 'Patio table + 4 chairs', 'furniture', 'facebook', 60, 92, 180, 71, 'facebook', 0, 0),
    S(7, 'Trek road bike', 'sports', 'garage', 90, 79, 260, 43, 'facebook', 0, 15, 'New tubes + brake pads'),
    S(8, 'LEGO bulk lot 12 lbs', 'toys', 'estate', 30, 63, 120, 39, 'ebay', 16, 0),
    S(9, 'Milwaukee M18 batteries x2', 'tools', 'facebook', 35, 47, 110, 26, 'offerup', 0, 0),
    S(10, 'Le Creuset dutch oven', 'home', 'thrift', 22, 38, 95, 17, 'facebook', 0, 0),
    S(11, 'Ninja blender', 'appliances', 'thrift', 12, 33, 8, 20, 'local', 0, 0, 'Lesson learned — check demand first'),
    S(12, 'Nintendo Switch OLED', 'electronics', 'facebook', 140, 12, 235, 4, 'facebook', 0, 0),
    S(13, 'Oak bookshelf', 'furniture', 'estate', 35, 21, null, null, null, 0, 0, 'Solid oak, heavy — local pickup only'),
    S(14, 'Xbox controllers x4', 'electronics', 'garage', 40, 15, null, null, null, 0, 0),
    S(15, 'Craftsman rolling toolbox', 'tools', 'garage', 20, 9, null, null, null, 0, 0),
    S(16, 'Antique wall mirror', 'home', 'estate', 25, 6, null, null, null, 0, 0),
  ].map((it, i) => { it.listPrice = [null, null, null, null, null, null, null, null, null, null, null, null, 85, 90, 65, 80][i]; return it; });
}
async function loadSample() {
  const sample = buildSample();
  const map = new Map(items.map((i) => [i.id, i]));
  sample.forEach((s) => map.set(s.id, s));
  items = Array.from(map.values());
  await store.replaceAll(items);
  toast('Sample data loaded — explore, then remove it in Settings', 'good');
  setView('dashboard');
}
async function removeSample() {
  items = items.filter((i) => !i.demo);
  await store.replaceAll(items);
  toast('Sample data removed', 'good');
  render();
}

/* ---------------- view dispatch ---------------- */
function render() {
  if (view === 'dashboard') renderDashboard();
  else if (view === 'inventory') renderInventory();
  else if (view === 'sold') renderSold();
  else renderSettings();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    $$('.hfill').forEach((f) => f.classList.add('go'));
  }));
}
function setView(v) {
  view = v;
  $$('#tabbar .tab').forEach((t) => t.classList.toggle('on', t.dataset.view === v));
  window.scrollTo(0, 0);
  render();
}

/* ---------------- event delegation ---------------- */
document.addEventListener('click', (e) => {
  const t = e.target;

  const closeBtn = t.closest('[data-close-sheet]');
  if (closeBtn) { closeSheet(); return; }

  const tab = t.closest('[data-view]');
  if (tab) { setView(tab.dataset.view); return; }

  const chip = t.closest('.chip');
  if (chip) {
    const group = chip.closest('[data-chips]');
    if (group) {
      $$('.chip', group).forEach((c) => c.classList.remove('sel'));
      chip.classList.add('sel');
      const hidden = $('input[type=hidden]', group);
      if (hidden) hidden.value = chip.dataset.val;
      if (chip.closest('#f-sold')) updateProfitPreview();
      return;
    }
  }

  const soldBtn = t.closest('[data-sold]');
  if (soldBtn) { closeSheet(); openSoldSheet(soldBtn.dataset.sold); return; }

  const editBtn = t.closest('[data-edit]');
  if (editBtn) { closeSheet(); setTimeout(() => openItemSheet(editBtn.dataset.edit), 80); return; }

  const revBtn = t.closest('[data-revert]');
  if (revBtn) { if (armConfirm(revBtn, 'Tap again to confirm')) revertItem(revBtn.dataset.revert); return; }

  const delBtn = t.closest('[data-del]');
  if (delBtn) { if (armConfirm(delBtn, 'Tap again to delete')) deleteItem(delBtn.dataset.del); return; }

  const bar = t.closest('[data-mi]');
  if (bar) { selectChartBar(Number(bar.dataset.mi)); return; }

  const cyc = t.closest('[data-cycle]');
  if (cyc) {
    if (cyc.dataset.cycle === 'inv') { invSort = (invSort + 1) % INV_SORTS.length; renderInventory(); }
    else { soldSort = (soldSort + 1) % SOLD_SORTS.length; renderSold(); }
    return;
  }

  const openCard = t.closest('[data-open]');
  if (openCard) { openDetailSheet(openCard.dataset.open); return; }

  const act = t.closest('[data-action]');
  if (!act) return;
  const a = act.dataset.action;
  if (a === 'add') openItemSheet();
  else if (a === 'pick-photo') { const i = $('#photo-in'); if (i) i.click(); }
  else if (a === 'remove-photo') {
    pendingPhoto = null;
    const pv = $('#photo-pv');
    if (pv) pv.innerHTML = '📷';
    act.remove();
  }
  else if (a === 'export-json') exportJSON();
  else if (a === 'export-csv') exportCSV();
  else if (a === 'import') { const i = $('#import-in'); if (i) i.click(); }
  else if (a === 'sample') loadSample();
  else if (a === 'sample-remove') removeSample();
  else if (a === 'wipe') { if (armConfirm(act, 'Tap again — deletes ALL')) { items = []; store.replaceAll([]); toast('Everything deleted'); render(); } }
  else if (a === 'install') {
    if (deferredPrompt) { deferredPrompt.prompt(); deferredPrompt.userChoice.finally(() => { deferredPrompt = null; render(); }); }
  }
  else if (a === 'update') checkForUpdate();
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'inv-q') { invQuery = t.value; renderInvList(); }
  else if (t.id === 'sold-q') { soldQuery = t.value; renderSoldList(); }
  else if (t.closest && t.closest('#f-sold')) updateProfitPreview();
  if (t.classList && t.classList.contains('err')) t.classList.remove('err');
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.id === 'photo-in' && t.files && t.files[0]) {
    try {
      const dataUrl = await compressImage(t.files[0]);
      pendingPhoto = dataUrl;
      const pv = $('#photo-pv');
      if (pv) pv.innerHTML = '<img src="' + dataUrl + '" alt="">';
    } catch (err) {
      toast('Couldn’t read that photo', 'bad');
    }
    t.value = '';
  } else if (t.id === 'import-in' && t.files && t.files[0]) {
    doImport(t.files[0]);
    t.value = '';
  }
});

document.addEventListener('submit', (e) => {
  const f = e.target;
  if (f.id === 'f-item') { e.preventDefault(); saveItemForm(f); }
  else if (f.id === 'f-sold') { e.preventDefault(); saveSoldForm(f); }
});

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (view === 'settings') render();
});
window.addEventListener('appinstalled', () => toast('Installed — check your home screen', 'good'));

/* ---------------- service worker ---------------- */
function swAllowed() {
  return 'serviceWorker' in navigator &&
    (location.protocol === 'https:' || new URLSearchParams(location.search).has('sw'));
}
function checkForUpdate() {
  if (!swAllowed()) { toast('Updates apply automatically'); return; }
  navigator.serviceWorker.getRegistration().then((reg) => {
    if (!reg) { toast('You’re on the latest version', 'good'); return; }
    reg.update().then(() => {
      setTimeout(() => {
        if (reg.waiting) {
          reg.waiting.postMessage('SKIP_WAITING');
          navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
          toast('Updating…', 'good');
        } else {
          toast('You’re on the latest version', 'good');
        }
      }, 800);
    }).catch(() => toast('Couldn’t check right now', 'warn'));
  });
}

/* ---------------- boot ---------------- */
(async function boot() {
  await store.init();
  const raw = await store.loadAll();
  items = raw.map(normItem);
  render();
  if (swAllowed()) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();
