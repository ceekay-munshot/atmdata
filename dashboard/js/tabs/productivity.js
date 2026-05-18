// Productivity tab — per-ATM efficiency analysis.
//
//   Velocity  = monthly transactions per ATM     (cash withdrawal vol / ATMs)
//   Intensity = monthly ₹ per ATM (in Cr)        (cash withdrawal val / ATMs)
//
// ATM denominator = on_site + off_site (we deliberately exclude Micro ATMs
// because those are banking-correspondent handheld devices, not traditional
// ATMs, and including them would inflate the denominator without raising
// the cash-withdrawal numerator).

import { rows, latestPeriod } from '../data.js';
import { getState, subscribe } from '../state.js';
import { exportSheets, currentFilterMeta } from '../export.js';
import { PALETTE, TOOLTIP_BASE, AXIS_X, AXIS_Y, compactNum, softLineStyle } from '../chartopts.js';

const SIDE_KEYS = {
  debit:  { vol: 'dc_vol', val: 'dc_val_thousands', label: 'Debit' },
  credit: { vol: 'cc_vol', val: 'cc_val_thousands', label: 'Credit' },
  both:   { vol: null,     val: null,               label: 'Debit + Credit' },
};

let charts = {};
let _root = null;
let _unsub = null;
let _side = 'debit';        // 'debit' | 'credit' | 'both'
let _minAtms = 100;         // drop banks with smaller own networks (ratio gets
                            // inflated by interchange usage on other banks' ATMs)

const HTML = `
  <div class="grid">
    <div class="card accent">
      <div class="card-head">
        <div class="card-head-text">
          <div class="card-title">Per-ATM Productivity</div>
          <div class="card-sub" id="prod-sub">—</div>
        </div>
        <div class="card-actions">
          <div class="mini-toggle" id="prod-min" title="Hide banks with fewer than N own-network ATMs — those banks' ratios are inflated by their customers using OTHER banks' ATMs (interchange).">
            <button data-v="0">All</button>
            <button data-v="50">50+</button>
            <button class="active" data-v="100">100+</button>
            <button data-v="500">500+</button>
            <button data-v="1000">1000+</button>
          </div>
          <div class="mini-toggle" id="prod-side">
            <button class="active" data-v="debit">Debit</button>
            <button data-v="credit">Credit</button>
            <button data-v="both">Both</button>
          </div>
          <button class="btn primary" data-export="all">Export to Excel</button>
        </div>
      </div>
      <div class="chart tall" id="chart-prod-scatter"></div>
    </div>

    <div class="card">
      <div class="card-head">
        <div class="card-head-text">
          <div class="card-title">Category Averages</div>
          <div class="card-sub" id="prod-cat-sub">—</div>
        </div>
      </div>
      <div id="prod-cat-strip"></div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <div class="card-head">
          <div class="card-head-text">
            <div class="card-title">Top 10 by Velocity</div>
            <div class="card-sub">Transactions per ATM per month</div>
          </div>
        </div>
        <div class="tbl-wrap" id="prod-tbl-vel"></div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="card-head-text">
            <div class="card-title">Top 10 by Cash Intensity</div>
            <div class="card-sub">₹ Cr per ATM per month</div>
          </div>
        </div>
        <div class="tbl-wrap" id="prod-tbl-int"></div>
      </div>
    </div>
  </div>
`;

export function mount(root) {
  _root = root;
  root.innerHTML = HTML;
  charts.scatter = echarts.init(root.querySelector('#chart-prod-scatter'));

  window.addEventListener('resize', onResize);
  root.querySelectorAll('[data-export]').forEach(b => b.onclick = () => onExport(b.dataset.export));
  root.querySelector('#prod-side').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    _side = b.dataset.v;
    root.querySelectorAll('#prod-side button').forEach(x => x.classList.toggle('active', x.dataset.v === b.dataset.v));
    redraw();
  });
  root.querySelector('#prod-min').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    _minAtms = +b.dataset.v;
    root.querySelectorAll('#prod-min button').forEach(x => x.classList.toggle('active', x.dataset.v === b.dataset.v));
    redraw();
  });

  redraw();
  _unsub = subscribe(redraw);
}

export function unmount() {
  for (const c of Object.values(charts)) c.dispose();
  charts = {};
  window.removeEventListener('resize', onResize);
  if (_unsub) { _unsub(); _unsub = null; }
}

function onResize() { for (const c of Object.values(charts)) c.resize(); }

function bankMetrics(allRows, period, state) {
  const universe = state.category === 'all' ? allRows : allRows.filter(r => r.category === state.category);
  const slice = universe.filter(r => r.period === period);

  const sideCfg = SIDE_KEYS[_side];
  const out = [];
  for (const r of slice) {
    const atms = (r.on_site_atms ?? 0) + (r.off_site_atms ?? 0);
    if (!atms || atms < _minAtms) continue;

    let vol = 0, valThou = 0;
    if (_side === 'both') {
      vol     = (r.dc_vol ?? 0) + (r.cc_vol ?? 0);
      valThou = (r.dc_val_thousands ?? 0) + (r.cc_val_thousands ?? 0);
    } else {
      vol     = r[sideCfg.vol] ?? 0;
      valThou = r[sideCfg.val] ?? 0;
    }
    if (vol <= 0 && valThou <= 0) continue;

    const valCr = valThou / 1e4;
    out.push({
      bank: r.bank,
      category: r.category,
      atms,
      vol, valCr,
      velocity:  vol / atms,           // txns per ATM per month
      intensity: valCr / atms,         // ₹ Cr per ATM per month
    });
  }
  return out;
}

function redraw() {
  const state = getState();
  const period = state.to || latestPeriod();
  const data = bankMetrics(rows(), period, state);
  const sideCfg = SIDE_KEYS[_side];

  const minLabel = _minAtms > 0 ? ` · min ${_minAtms} ATMs` : '';
  _root.querySelector('#prod-sub').textContent =
    `${sideCfg.label} cash withdrawal · ${period} · ATMs = on-site + off-site${minLabel} · ${state.category !== 'all' ? state.category : 'industry'} (${data.length} banks)`;

  renderScatter(data, period, sideCfg);
  renderCategoryStrip(data, period, sideCfg);
  renderTables(data, sideCfg);
}

// ── 1. Bubble scatter ────────────────────────────────────────────────────
function renderScatter(data, period, sideCfg) {
  // Group by category for legend / colour mapping
  const byCat = new Map();
  for (const d of data) {
    if (!byCat.has(d.category || 'Uncategorised')) byCat.set(d.category || 'Uncategorised', []);
    byCat.get(d.category || 'Uncategorised').push(d);
  }
  // Bubble area scales with absolute value (sqrt) so giant banks don't swamp small ones
  const maxVal = Math.max(1, ...data.map(d => d.valCr));
  const sym = (v) => Math.max(8, Math.min(48, Math.sqrt(v / maxVal) * 50 + 6));

  const series = [...byCat.entries()].map(([cat, ds]) => ({
    name: cat,
    type: 'scatter',
    data: ds.map(d => ({
      value: [d.velocity, d.intensity, d.valCr, d.bank, d.atms, d.vol],
      name: d.bank,
    })),
    symbolSize: (val) => sym(val[2]),
    itemStyle: {
      color: catColor(cat),
      opacity: 0.78,
      borderColor: '#fff',
      borderWidth: 1.5,
      shadowColor: 'rgba(15,23,42,0.18)',
      shadowBlur: 6,
    },
    emphasis: {
      itemStyle: { opacity: 1, borderWidth: 2 },
      label: { show: true, formatter: (p) => p.value[3].length > 22 ? p.value[3].slice(0, 21) + '…' : p.value[3] },
    },
    // Label only the biggest 5 by value so chart doesn't get noisy
    label: {
      show: true,
      position: 'top', distance: 6,
      color: '#334155', fontSize: 10, fontWeight: 600,
      formatter: (p) => {
        const ds2 = data.slice().sort((a, b) => b.valCr - a.valCr).slice(0, 5).map(d => d.bank);
        return ds2.includes(p.value[3]) ? truncate(p.value[3], 18) : '';
      },
    },
  }));

  charts.scatter.setOption({
    grid: { left: 76, right: 36, top: 50, bottom: 50 },
    legend: { top: 6, textStyle: { color: '#334155', fontSize: 11 }, icon: 'circle', itemWidth: 10, itemHeight: 10 },
    tooltip: {
      ...TOOLTIP_BASE, trigger: 'item',
      formatter: (p) => {
        const [vel, intCr, valCr, bank, atms, vol] = p.value;
        return `<div style="font-weight:600;margin-bottom:4px">${bank}</div>
          <div style="color:#cbd2dc;font-size:11px;margin-bottom:6px">${p.seriesName}</div>
          <div>ATMs (on + off): <b>${atms.toLocaleString('en-IN')}</b></div>
          <div>${sideCfg.label} Vol: <b>${compactNum(vol)}</b></div>
          <div>${sideCfg.label} Val: <b>₹${valCr.toFixed(0)} Cr</b></div>
          <div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.15)">
            <div>Velocity: <b>${vel.toFixed(0)} txns / ATM / month</b></div>
            <div>Intensity: <b>₹${intCr.toFixed(2)} Cr / ATM / month</b></div>
          </div>`;
      },
    },
    xAxis: { ...AXIS_Y, name: 'Velocity (txns / ATM / month)',
      nameLocation: 'middle', nameGap: 30, nameTextStyle: { color: '#64748b', fontSize: 11, fontWeight: 600 },
      axisLabel: { ...AXIS_Y.axisLabel, formatter: (v) => compactNum(v) } },
    yAxis: { ...AXIS_Y, name: 'Intensity (₹ Cr / ATM / month)',
      nameLocation: 'middle', nameGap: 56, nameTextStyle: { color: '#64748b', fontSize: 11, fontWeight: 600 },
      axisLabel: { ...AXIS_Y.axisLabel, formatter: (v) => v.toFixed(2) } },
    series,
    animation: true, animationDuration: 600,
  }, true);
}

// ── 2. Category averages strip ──────────────────────────────────────────
function renderCategoryStrip(data, period, sideCfg) {
  const byCat = new Map();
  for (const d of data) {
    const k = d.category || 'Uncategorised';
    if (!byCat.has(k)) byCat.set(k, { sumVol: 0, sumVal: 0, sumAtms: 0, n: 0 });
    const a = byCat.get(k);
    a.sumVol += d.vol;
    a.sumVal += d.valCr;
    a.sumAtms += d.atms;
    a.n += 1;
  }
  const cats = [...byCat.entries()].map(([name, a]) => ({
    name,
    n: a.n,
    velocity:  a.sumAtms > 0 ? a.sumVol / a.sumAtms : 0,
    intensity: a.sumAtms > 0 ? a.sumVal / a.sumAtms : 0,
    sumAtms: a.sumAtms,
  })).sort((a, b) => b.intensity - a.intensity);

  _root.querySelector('#prod-cat-sub').textContent =
    `Volume-weighted means per category · ${period} · ${sideCfg.label}`;

  _root.querySelector('#prod-cat-strip').innerHTML = `
    <div class="prod-cat-grid">
      ${cats.map(c => `
        <div class="prod-cat-card" style="--c:${catColor(c.name)}">
          <div class="prod-cat-name">${c.name}</div>
          <div class="prod-cat-row">
            <span class="prod-cat-lbl">Velocity</span>
            <span class="prod-cat-val">${compactNum(c.velocity)}</span>
            <span class="prod-cat-unit">txns/ATM/mo</span>
          </div>
          <div class="prod-cat-row">
            <span class="prod-cat-lbl">Intensity</span>
            <span class="prod-cat-val">₹${c.intensity.toFixed(2)}</span>
            <span class="prod-cat-unit">Cr/ATM/mo</span>
          </div>
          <div class="prod-cat-meta">${c.n} banks · ${compactNum(c.sumAtms)} ATMs</div>
        </div>`).join('')}
    </div>`;
}

// ── 3. Two side-by-side ranking tables ─────────────────────────────────
function renderTables(data, sideCfg) {
  const topVel = [...data].sort((a, b) => b.velocity - a.velocity).slice(0, 10);
  const topInt = [...data].sort((a, b) => b.intensity - a.intensity).slice(0, 10);

  _root.querySelector('#prod-tbl-vel').innerHTML = renderRankTable(topVel, 'velocity', sideCfg);
  _root.querySelector('#prod-tbl-int').innerHTML = renderRankTable(topInt, 'intensity', sideCfg);
}

function renderRankTable(rowsArr, kind, sideCfg) {
  const isVel = kind === 'velocity';
  const valueFmt = (r) => isVel
    ? r.velocity.toLocaleString('en-IN', { maximumFractionDigits: 0 })
    : '₹' + r.intensity.toFixed(2);
  const unit = isVel ? 'txns/ATM/mo' : 'Cr/ATM/mo';
  return `
    <table class="tbl">
      <thead><tr>
        <th>#</th><th>Bank</th><th>Category</th>
        <th class="num">ATMs</th>
        <th class="num">${isVel ? 'Velocity' : 'Intensity'}</th>
      </tr></thead>
      <tbody>
        ${rowsArr.map((r, i) => `
          <tr>
            <td><span class="rank-cell ${i < 3 ? 'top' : ''}">${i + 1}</span></td>
            <td>${r.bank}</td>
            <td>${r.category ? `<span class="chip ${catSlug(r.category)}">${shortCat(r.category)}</span>` : '—'}</td>
            <td class="num">${r.atms.toLocaleString('en-IN')}</td>
            <td class="num"><b>${valueFmt(r)}</b> <span style="color:#94a3b8;font-size:11px">${unit}</span></td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

// ── Helpers ──────────────────────────────────────────────────────────────
function catColor(cat) {
  switch (cat) {
    case 'Public Sector':      return '#2563eb';
    case 'Private Sector':     return '#7c3aed';
    case 'Foreign Bank':       return '#0891b2';
    case 'Payment Bank':       return '#ea580c';
    case 'Small Finance Bank': return '#059669';
    default:                   return '#64748b';
  }
}
function catSlug(c) {
  if (!c) return '';
  if (c.includes('Public'))  return 'public';
  if (c.includes('Private')) return 'private';
  if (c.includes('Foreign')) return 'foreign';
  if (c.includes('Payment')) return 'payment';
  if (c.includes('Small'))   return 'sfb';
  return '';
}
function shortCat(c) { return c.replace(' Sector', '').replace(' Bank', '').replace('Small Finance', 'SFB'); }
function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// ── Export ──────────────────────────────────────────────────────────────
function onExport() {
  const state = getState();
  const period = state.to || latestPeriod();
  const sideCfg = SIDE_KEYS[_side];
  const data = bankMetrics(rows(), period, state);
  const sheets = [{
    name: 'Per-ATM Productivity',
    rows: [
      ['Bank', 'Category', 'ATMs (on+off)', `${sideCfg.label} Vol`, `${sideCfg.label} Val (₹Cr)`,
       'Velocity (txns/ATM/mo)', 'Intensity (₹Cr/ATM/mo)'],
      ...data.sort((a, b) => b.intensity - a.intensity).map(r =>
        [r.bank, r.category || '', r.atms, r.vol, +r.valCr.toFixed(2), +r.velocity.toFixed(2), +r.intensity.toFixed(4)]),
    ],
  }];
  exportSheets(`productivity_${period}_${_side}.xlsx`, sheets,
    currentFilterMeta({ 'Productivity side': sideCfg.label, 'Period': period }));
}
