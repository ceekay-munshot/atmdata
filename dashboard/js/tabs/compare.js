// Bank Comparison tab — compare 2-5 selected banks.
//   1. Multi-line trend chart (selected metric, each bank a line)
//   2. Market share comparison chart (each bank's share %)
//   3. Comparison table: Latest, 3M, YoY, Share, Share Δ pp, Rank

import { rows, latestPeriod, allBanks, allCategories, banksInCategory } from '../data.js';
import { getState, subscribe, setState } from '../state.js';
import {
  series, filterRows, denominatorRows, shareSeries,
  growth, rankBanks, metric,
} from '../calc.js';
import { exportSheets, currentFilterMeta } from '../export.js';
import { PALETTE, TOOLTIP_BASE, AXIS_X, AXIS_Y, compactNum, playReplay, PLAY_ICON, STOP_ICON, EXCEL_ICON, indexTo100, softLineStyle } from '../chartopts.js';

const ALL_CATEGORIES = ['Public Sector', 'Private Sector', 'Foreign Bank', 'Payment Bank', 'Small Finance Bank'];

let charts = {};
let _root = null;
let _unsub = null;
const MAX_BANKS = 5;
const MIN_BANKS = 2;
let _playing = { trend: null, share: null };
let _cache = { trend: { values: [], colors: [] }, share: { values: [], colors: [] } };
let _indexedTrend = false;   // rebase trend lines to 100

const HTML = `
  <div class="grid">
    <div class="card accent">
      <div class="card-head">
        <div class="card-head-text">
          <div class="card-title" id="cmp-title">Bank Comparison</div>
          <div class="card-sub" id="cmp-head-sub">Pick 2-5 banks to compare side-by-side.</div>
        </div>
        <div class="card-actions">
          <div class="mini-toggle" id="cmp-mode">
            <button data-v="banks" class="active">Banks</button>
            <button data-v="categories">Categories</button>
          </div>
        </div>
      </div>
      <div id="cmp-picker" class="cmp-picker"></div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <div class="card-head">
          <div class="card-head-text">
            <div class="card-title">Trend Comparison</div>
            <div class="card-sub" id="cmp-trend-sub">—</div>
          </div>
          <div class="card-actions">
            <div class="mini-toggle" id="cmp-trend-index" title="Rebase every line to 100 at the first period">
              <button class="active" data-v="raw">Raw</button>
              <button data-v="indexed">Index = 100</button>
            </div>
            <button class="btn-icon btn-icon-play" data-action="play-trend" title="Replay timeline">${PLAY_ICON}</button>
            <button class="btn-icon" data-export="trend" title="Export to Excel">${EXCEL_ICON}</button>
          </div>
        </div>
        <div class="chart" id="chart-cmp-trend"></div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="card-head-text">
            <div class="card-title">Market Share Comparison</div>
            <div class="card-sub" id="cmp-share-sub">—</div>
          </div>
          <div class="card-actions">
            <button class="btn-icon btn-icon-play" data-action="play-share" title="Replay timeline">${PLAY_ICON}</button>
            <button class="btn-icon" data-export="share" title="Export to Excel">${EXCEL_ICON}</button>
          </div>
        </div>
        <div class="chart" id="chart-cmp-share"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div class="card-head-text">
          <div class="card-title">Comparison Table</div>
          <div class="card-sub" id="cmp-tbl-sub">—</div>
        </div>
        <div class="card-actions">
          <button class="btn-icon primary" data-export="all" title="Export to Excel">${EXCEL_ICON}</button>
        </div>
      </div>
      <div class="tbl-wrap" id="cmp-tbl"></div>
    </div>
  </div>
`;

export function mount(root) {
  _root = root;
  root.innerHTML = HTML;

  const s = getState();
  // Auto-seed banks picker (when in banks mode)
  if (s.compareMode === 'banks' && (!s.banks || s.banks.length < MIN_BANKS)) {
    const universe = (s.category && s.category !== 'all')
      ? rows().filter(r => r.category === s.category) : rows();
    const top = rankBanks(universe, s.metric, s.to || latestPeriod()).slice(0, 3).map(r => r.bank);
    setState({ banks: top });
  }
  // Auto-seed categories picker
  if (s.compareMode === 'categories' && (!s.compareCategories || s.compareCategories.length < MIN_BANKS)) {
    setState({ compareCategories: [...ALL_CATEGORIES] });
  }

  charts.trend = echarts.init(root.querySelector('#chart-cmp-trend'));
  charts.share = echarts.init(root.querySelector('#chart-cmp-share'));

  window.addEventListener('resize', onResize);
  root.querySelectorAll('[data-export]').forEach(b => b.onclick = () => onExport(b.dataset.export));
  root.querySelector('[data-action="play-trend"]').addEventListener('click', () => togglePlay('trend'));
  root.querySelector('[data-action="play-share"]').addEventListener('click', () => togglePlay('share'));
  root.querySelector('#cmp-trend-index').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-v]'); if (!btn) return;
    _indexedTrend = btn.dataset.v === 'indexed';
    root.querySelectorAll('#cmp-trend-index button').forEach(b => b.classList.toggle('active', b.dataset.v === btn.dataset.v));
    redraw();
  });
  root.querySelector('#cmp-mode').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-v]'); if (!btn) return;
    const mode = btn.dataset.v;
    if (mode === getState().compareMode) return;
    setState({ compareMode: mode });
    // On first switch to categories, auto-fill all 5
    if (mode === 'categories' && (!getState().compareCategories || !getState().compareCategories.length)) {
      setState({ compareCategories: [...ALL_CATEGORIES] });
    }
  });

  renderPicker();
  redraw();
  _unsub = subscribe(() => { stopAll(); renderPicker(); redraw(); });
}

export function unmount() {
  stopAll();
  for (const c of Object.values(charts)) c.dispose();
  charts = {};
  window.removeEventListener('resize', onResize);
  if (_unsub) { _unsub(); _unsub = null; }
}

function stopAll() { stopPlay('trend'); stopPlay('share'); }

function stopPlay(key) {
  if (_playing[key]) { _playing[key].stop(); _playing[key] = null; }
  const sel = key === 'trend' ? '[data-action="play-trend"]' : '[data-action="play-share"]';
  const btn = _root && _root.querySelector(sel);
  if (btn) { btn.classList.remove('playing'); btn.innerHTML = PLAY_ICON; }
}

function togglePlay(key) {
  if (_playing[key]) { stopPlay(key); redraw(); return; }
  const cache = _cache[key];
  if (!cache.values.length) return;
  const sel = key === 'trend' ? '[data-action="play-trend"]' : '[data-action="play-share"]';
  const chart = key === 'trend' ? charts.trend : charts.share;
  const btn = _root.querySelector(sel);
  btn.classList.add('playing');
  btn.innerHTML = STOP_ICON;
  // Pick the right value formatter for the live label that follows each line tip
  const m = metric(getState().metric);
  let fmt;
  if (key === 'share') fmt = (v) => v.toFixed(1) + '%';
  else if (_indexedTrend) fmt = (v) => v.toFixed(1);
  else fmt = m.format;
  _playing[key] = playReplay(chart, {
    seriesData: cache.values, colors: cache.colors, durationMs: 2500, formatVal: fmt,
    onDone: () => { _playing[key] = null; btn.classList.remove('playing'); btn.innerHTML = PLAY_ICON; redraw(); },
  });
}

function onResize() { for (const c of Object.values(charts)) c.resize(); }

// ── Picker UI ───────────────────────────────────────────────────────────
function renderPicker() {
  const s = getState();
  // Sync mode toggle highlight + title
  _root.querySelectorAll('#cmp-mode button').forEach(b => b.classList.toggle('active', b.dataset.v === s.compareMode));
  _root.querySelector('#cmp-title').textContent =
    s.compareMode === 'categories' ? 'Category Comparison' : 'Bank Comparison';
  _root.querySelector('#cmp-head-sub').textContent =
    s.compareMode === 'categories'
      ? 'Pick 2-5 bank categories to compare side-by-side.'
      : 'Pick 2-5 banks to compare side-by-side.';

  const el = _root.querySelector('#cmp-picker');
  if (s.compareMode === 'categories') {
    const picked = (s.compareCategories || []).slice(0, MAX_BANKS);
    const available = ALL_CATEGORIES.filter(c => !picked.includes(c));
    el.innerHTML = `
      ${picked.map((c, i) => `
        <span class="cmp-chip" style="--c:${PALETTE[i % PALETTE.length]}">
          <span class="cmp-chip-dot"></span>${c}
          <button class="cmp-chip-x" data-rm="${c}" title="Remove">×</button>
        </span>`).join('')}
      ${available.length && picked.length < MAX_BANKS ? `
        <select class="fb-select cmp-add" id="cmp-add">
          <option value="">+ Add category…</option>
          ${available.map(c => `<option value="${c}">${c}</option>`).join('')}
        </select>` : ''}
      ${picked.length < MIN_BANKS ? `<span class="cmp-hint warn">Pick at least ${MIN_BANKS} categories.</span>` : ''}
    `;
    el.querySelectorAll('[data-rm]').forEach(btn => {
      btn.onclick = () => setState({ compareCategories: (getState().compareCategories || []).filter(c => c !== btn.dataset.rm) });
    });
    const add = el.querySelector('#cmp-add');
    if (add) add.onchange = (e) => {
      if (!e.target.value) return;
      const next = [...(getState().compareCategories || []), e.target.value].slice(0, MAX_BANKS);
      setState({ compareCategories: next });
    };
    return;
  }

  // banks mode
  const picked = s.banks.slice(0, MAX_BANKS);
  const universe = banksInCategory(s.category).filter(b => !picked.includes(b));
  el.innerHTML = `
    ${picked.map((b, i) => `
      <span class="cmp-chip" style="--c:${PALETTE[i % PALETTE.length]}">
        <span class="cmp-chip-dot"></span>${b}
        <button class="cmp-chip-x" data-rm="${b}" title="Remove">×</button>
      </span>`).join('')}
    ${picked.length < MAX_BANKS ? `
      <select class="fb-select cmp-add" id="cmp-add">
        <option value="">+ Add bank…</option>
        ${universe.map(b => `<option value="${b}">${b}</option>`).join('')}
      </select>` : `<span class="cmp-hint">Max ${MAX_BANKS} banks. Remove one to add another.</span>`}
    ${picked.length < MIN_BANKS ? `<span class="cmp-hint warn">Pick at least ${MIN_BANKS} banks.</span>` : ''}
  `;
  el.querySelectorAll('[data-rm]').forEach(btn => {
    btn.onclick = () => setState({ banks: getState().banks.filter(b => b !== btn.dataset.rm) });
  });
  const add = el.querySelector('#cmp-add');
  if (add) add.onchange = (e) => {
    if (!e.target.value) return;
    const next = [...getState().banks, e.target.value].slice(0, MAX_BANKS);
    setState({ banks: next });
  };
}

// Entities currently being compared (banks or categories)
function currentEntities(s) {
  return s.compareMode === 'categories' ? (s.compareCategories || []) : (s.banks || []);
}

// For a given entity, return rows that contribute to it
function rowsForEntity(allRows, name, mode) {
  return mode === 'categories'
    ? allRows.filter(r => r.category === name)
    : allRows.filter(r => r.bank === name);
}

function redraw() {
  const s = getState();
  const allRows = rows();
  const entities = currentEntities(s);
  const noun = s.compareMode === 'categories' ? 'categories' : 'banks';
  if (entities.length < MIN_BANKS) {
    setEmpty(charts.trend, `Pick at least 2 ${noun} to compare`);
    setEmpty(charts.share, `Pick at least 2 ${noun} to compare`);
    _root.querySelector('#cmp-tbl').innerHTML = `<div class="empty"><div class="empty-title">No comparison</div><div class="empty-sub">Add ${noun} above to start comparing.</div></div>`;
    return;
  }
  renderTrend(s, allRows);
  renderShare(s, allRows);
  renderTable(s, allRows);
}

function setEmpty(chart, msg) {
  chart.setOption({
    title: { text: msg, left: 'center', top: 'center',
      textStyle: { color: '#94a3b8', fontWeight: 500, fontSize: 13 } },
    series: [],
  }, true);
}

// ── Trend Comparison ────────────────────────────────────────────────────
function renderTrend(state, allRows) {
  const m = metric(state.metric);
  const entities = currentEntities(state);
  const sets = entities.map(name => {
    const r = rowsForEntity(allRows, name, state.compareMode);
    return { name, data: series(r, state.metric, state.freq) };
  });

  _root.querySelector('#cmp-trend-sub').textContent =
    `${m.label} · ${freqLabel(state.freq)} · ${m.isStock ? 'As on period-end' : 'For the period'} · ${state.compareMode === 'categories' ? 'by category' : 'by bank'}${_indexedTrend ? ' · rebased to 100' : ''}`;

  const xs = sets[0].data.map(d => d.label);
  const rawValues = sets.map(s => s.data.map(d => d.value));
  const finalValues = _indexedTrend ? rawValues.map(indexTo100) : rawValues;
  const ss = sets.map((s, i) => ({
    name: s.name,
    type: 'line', smooth: 0.4, showSymbol: false,
    lineStyle: softLineStyle(PALETTE[i % PALETTE.length], 2.2),
    itemStyle: { color: PALETTE[i % PALETTE.length] },
    emphasis: { focus: 'series', lineStyle: { width: 3 } },
    data: finalValues[i],
  }));

  _cache.trend = {
    values: finalValues,
    colors: sets.map((_, i) => PALETTE[i % PALETTE.length]),
  };

  charts.trend.setOption({
    grid: { left: 70, right: 24, top: 40, bottom: 44 },
    legend: { top: 4, textStyle: { color: '#334155', fontSize: 11 },
              icon: 'roundRect', itemWidth: 10, itemHeight: 6 },
    tooltip: { ...TOOLTIP_BASE,
      formatter: (params) => {
        let html = `<div style="font-weight:600;margin-bottom:4px">${params[0].axisValue}</div>`;
        for (const p of params.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity))) {
          if (p.value == null) continue;
          const valStr = _indexedTrend ? p.value.toFixed(1) : m.format(p.value);
          html += `<div style="display:flex;align-items:center;gap:6px;margin-top:2px">
            <span style="width:8px;height:8px;background:${p.color};border-radius:50%"></span>
            ${truncate(p.seriesName, 24)}: <b>${valStr}</b></div>`;
        }
        return html;
      },
    },
    xAxis: { ...AXIS_X, data: xs, boundaryGap: false },
    yAxis: { ...AXIS_Y, axisLabel: { ...AXIS_Y.axisLabel,
      formatter: (v) => _indexedTrend ? v.toFixed(0) : compactNum(v) } },
    series: ss,
    animation: true, animationDuration: 600,
  }, true);
}

// ── Share Comparison ────────────────────────────────────────────────────
function renderShare(state, allRows) {
  const m = metric(state.metric);
  // In categories mode the denominator is always industry (so categories sum
  // to ~100% over time). In banks mode keep current behaviour.
  const denom = state.compareMode === 'categories' ? allRows : denominatorRows(allRows, state);
  const denomSeries = series(denom, state.metric, state.freq);
  const denomMap = new Map(denomSeries.map(d => [d.key, d.value]));

  const entities = currentEntities(state);
  const sets = entities.map(name => {
    const r = rowsForEntity(allRows, name, state.compareMode);
    const s = series(r, state.metric, state.freq);
    return {
      name,
      data: s.map(d => {
        const den = denomMap.get(d.key);
        const v = (den == null || den === 0 || d.value == null) ? null : (d.value / den) * 100;
        return { key: d.key, label: d.label, value: v };
      }),
    };
  });

  _root.querySelector('#cmp-share-sub').textContent =
    state.compareMode === 'categories'
      ? `Each category as % of industry · ${freqLabel(state.freq)}`
      : `Share of ${state.category !== 'all' ? state.category : 'industry'} · ${freqLabel(state.freq)}`;

  const xs = (sets[0]?.data || []).map(d => d.label);
  const ss = sets.map((s, i) => ({
    name: s.name,
    type: 'line', smooth: 0.4, showSymbol: false,
    lineStyle: softLineStyle(PALETTE[i % PALETTE.length], 2.2),
    itemStyle: { color: PALETTE[i % PALETTE.length] },
    emphasis: { focus: 'series', lineStyle: { width: 3 } },
    data: s.data.map(d => d.value),
    endLabel: { show: true, color: PALETTE[i % PALETTE.length], fontWeight: 600, fontSize: 11,
      formatter: (p) => p.value == null ? '' : ' ' + p.value.toFixed(1) + '%' },
  }));

  _cache.share = {
    values: sets.map(s => s.data.map(d => d.value)),
    colors: sets.map((_, i) => PALETTE[i % PALETTE.length]),
  };

  charts.share.setOption({
    grid: { left: 60, right: 60, top: 40, bottom: 44 },
    legend: { top: 4, textStyle: { color: '#334155', fontSize: 11 },
              icon: 'roundRect', itemWidth: 10, itemHeight: 6 },
    tooltip: { ...TOOLTIP_BASE,
      formatter: (params) => {
        let html = `<div style="font-weight:600;margin-bottom:4px">${params[0].axisValue}</div>`;
        for (const p of params.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity))) {
          if (p.value == null) continue;
          html += `<div style="display:flex;align-items:center;gap:6px;margin-top:2px">
            <span style="width:8px;height:8px;background:${p.color};border-radius:50%"></span>
            ${truncate(p.seriesName, 24)}: <b>${p.value.toFixed(2)}%</b></div>`;
        }
        return html;
      },
    },
    xAxis: { ...AXIS_X, data: xs, boundaryGap: false },
    yAxis: { ...AXIS_Y, axisLabel: { ...AXIS_Y.axisLabel, formatter: (v) => v.toFixed(1) + '%' } },
    series: ss,
    animation: true, animationDuration: 600,
  }, true);
}

// ── Comparison Table ────────────────────────────────────────────────────
function renderTable(state, allRows) {
  const m = metric(state.metric);
  const period = state.to || latestPeriod();
  const periods = [...new Set(allRows.map(r => r.period))].sort();
  const idx = periods.indexOf(period);
  const ref3 = idx >= 3 ? periods[idx - 3] : null;
  const ref12 = idx >= 12 ? periods[idx - 12] : null;

  const sumPerPeriod = (rs, per) =>
    rs.filter(r => r.period === per).reduce((s, r) => s + (r[m.field] ?? 0), 0);

  // Categories mode: denominator = whole industry, no per-bank rank
  // Banks mode: denominator = category (current global category filter)
  const isCat = state.compareMode === 'categories';
  const denom = isCat ? allRows : denominatorRows(allRows, state);
  const denomAt = new Map();
  for (const p of periods) denomAt.set(p, sumPerPeriod(denom, p));

  const entities = currentEntities(state);
  let rankMap = new Map();
  if (!isCat) {
    const allRanked = rankBanks(state.category === 'all' ? allRows : allRows.filter(r => r.category === state.category),
                                state.metric, period);
    rankMap = new Map(allRanked.map((r, i) => [r.bank, i + 1]));
  }

  const rowsOut = entities.map((name, i) => {
    const er = rowsForEntity(allRows, name, state.compareMode);
    const raw = sumPerPeriod(er, period);
    const raw3 = ref3 ? sumPerPeriod(er, ref3) : null;
    const raw12 = ref12 ? sumPerPeriod(er, ref12) : null;
    const val = m.transform(raw);
    const val3 = raw3 != null ? m.transform(raw3) : null;
    const val12 = raw12 != null ? m.transform(raw12) : null;
    const g3 = (val3 != null && val3 !== 0) ? ((val - val3) / val3) * 100 : null;
    const gY = (val12 != null && val12 !== 0) ? ((val - val12) / val12) * 100 : null;
    const dNow = denomAt.get(period);
    const dPrev = ref12 ? denomAt.get(ref12) : null;
    const share = (dNow > 0) ? (raw / dNow) * 100 : null;
    const sharePrev = (dPrev > 0 && raw12 != null) ? (raw12 / dPrev) * 100 : null;
    const shareDelta = (share != null && sharePrev != null) ? share - sharePrev : null;
    return {
      name, value: val, g3, gY, share, shareDelta,
      rank: isCat ? (i + 1) : (rankMap.get(name) ?? null),
      category: isCat ? null : ((er[0] || {}).category),
    };
  });

  _root.querySelector('#cmp-tbl-sub').textContent = isCat
    ? `${m.label} · ${period} · 3M vs ${ref3 || '—'} · YoY vs ${ref12 || '—'} · share = of industry`
    : `${m.label} · ${period} · 3M vs ${ref3 || '—'} · YoY vs ${ref12 || '—'} · rank within ${state.category !== 'all' ? state.category : 'industry'}`;

  const cols = isCat ? [
    { id: 'rank',       label: '#',         num: true,  cell: r => `<span class="rank-cell">${r.rank}</span>` },
    { id: 'name',       label: 'Category',  num: false, cell: r => `<span class="chip ${catSlug(r.name)}">${r.name}</span>` },
    { id: 'value',      label: 'Latest',    num: true,  cell: r => m.format(r.value) },
    { id: 'g3',         label: '3M',        num: true,  cell: r => deltaCell(r.g3, '%') },
    { id: 'gY',         label: 'YoY',       num: true,  cell: r => deltaCell(r.gY, '%') },
    { id: 'share',      label: 'Share',     num: true,  cell: r => r.share == null ? '—' : r.share.toFixed(2) + '%' },
    { id: 'shareDelta', label: 'Share Δ',   num: true,  cell: r => deltaCell(r.shareDelta, ' pp') },
  ] : [
    { id: 'rank',       label: 'Rank',     num: true,  cell: r => r.rank ? `<span class="rank-cell ${r.rank <= 3 ? 'top' : ''}">${r.rank}</span>` : '—' },
    { id: 'name',       label: 'Bank',     num: false, cell: r => r.name },
    { id: 'category',   label: 'Category', num: false, cell: r => r.category ? `<span class="chip ${catSlug(r.category)}">${shortCat(r.category)}</span>` : '—' },
    { id: 'value',      label: 'Latest',   num: true,  cell: r => m.format(r.value) },
    { id: 'g3',         label: '3M',       num: true,  cell: r => deltaCell(r.g3, '%') },
    { id: 'gY',         label: 'YoY',      num: true,  cell: r => deltaCell(r.gY, '%') },
    { id: 'share',      label: 'Share',    num: true,  cell: r => r.share == null ? '—' : r.share.toFixed(2) + '%' },
    { id: 'shareDelta', label: 'Share Δ',  num: true,  cell: r => deltaCell(r.shareDelta, ' pp') },
  ];

  const wrap = _root.querySelector('#cmp-tbl');
  wrap.innerHTML = `
    <table class="tbl">
      <thead><tr>${cols.map(c => `<th class="${c.num ? 'num' : ''}">${c.label}</th>`).join('')}</tr></thead>
      <tbody>${rowsOut.map(r => `<tr>${cols.map(c => `<td class="${c.num ? 'num' : ''}">${c.cell(r)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>`;
}

function deltaCell(v, suffix) {
  if (v == null || isNaN(v)) return '<span class="delta-flat">—</span>';
  const cls = v > 0 ? 'delta-up' : v < 0 ? 'delta-down' : 'delta-flat';
  return `<span class="${cls}">${v > 0 ? '+' : ''}${v.toFixed(2)}${suffix}</span>`;
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
function freqLabel(f) { return f === 'M' ? 'Monthly' : f === 'Q' ? 'Quarterly' : 'Yearly'; }

// ── Export ──────────────────────────────────────────────────────────────
function onExport(which) {
  const s = getState();
  const m = metric(s.metric);
  const allRows = rows();
  const stamp = new Date().toISOString().slice(0, 10);
  const sheets = [];

  const entities = currentEntities(s);
  const isCat = s.compareMode === 'categories';
  const entityLabel = isCat ? 'Category' : 'Bank';

  if (which === 'trend' || which === 'all') {
    const sets = entities.map(name => ({
      name, data: series(rowsForEntity(allRows, name, s.compareMode), s.metric, s.freq),
    }));
    const keys = (sets[0]?.data || []).map(d => d.key);
    const labels = (sets[0]?.data || []).map(d => d.label);
    const maps = sets.map(set => new Map(set.data.map(d => [d.key, d.value])));
    sheets.push({ name: 'Trend',
      rows: [['Period', ...sets.map(s => s.name)],
        ...keys.map((k, i) => [labels[i], ...maps.map(m => m.get(k))])] });
  }

  if (which === 'share' || which === 'all') {
    const denom = isCat ? allRows : denominatorRows(allRows, s);
    const denomSeries = series(denom, s.metric, s.freq);
    const denomMap = new Map(denomSeries.map(d => [d.key, d.value]));
    const sets = entities.map(name => {
      const ser = series(rowsForEntity(allRows, name, s.compareMode), s.metric, s.freq);
      const data = ser.map(d => {
        const den = denomMap.get(d.key);
        return { key: d.key, label: d.label, value: (den && d.value != null) ? (d.value / den) * 100 : null };
      });
      return { name, data };
    });
    const keys = (sets[0]?.data || []).map(d => d.key);
    const labels = (sets[0]?.data || []).map(d => d.label);
    const maps = sets.map(set => new Map(set.data.map(d => [d.key, d.value])));
    sheets.push({ name: 'Market Share %',
      rows: [['Period', ...sets.map(s => s.name + ' (%)')],
        ...keys.map((k, i) => [labels[i], ...maps.map(m => m.get(k))])] });
  }

  if (which === 'all') {
    const period = s.to || latestPeriod();
    const periods = [...new Set(allRows.map(r => r.period))].sort();
    const idx = periods.indexOf(period);
    const ref3 = idx >= 3 ? periods[idx - 3] : null;
    const ref12 = idx >= 12 ? periods[idx - 12] : null;
    const denom = isCat ? allRows : denominatorRows(allRows, s);
    const sumPP = (rs, per) => rs.filter(r => r.period === per).reduce((sum, r) => sum + (r[m.field] ?? 0), 0);
    const tbl = entities.map(name => {
      const er = rowsForEntity(allRows, name, s.compareMode);
      const raw = sumPP(er, period);
      const raw3 = ref3 ? sumPP(er, ref3) : null;
      const raw12 = ref12 ? sumPP(er, ref12) : null;
      const val = m.transform(raw);
      const v3 = raw3 != null ? m.transform(raw3) : null;
      const v12 = raw12 != null ? m.transform(raw12) : null;
      const g3 = (v3 != null && v3 !== 0) ? ((val - v3) / v3) * 100 : null;
      const gY = (v12 != null && v12 !== 0) ? ((val - v12) / v12) * 100 : null;
      const dN = sumPP(denom, period);
      const dP = ref12 ? sumPP(denom, ref12) : null;
      const sh = dN > 0 ? (raw / dN) * 100 : null;
      const shP = (dP > 0 && raw12 != null) ? (raw12 / dP) * 100 : null;
      return [name, val, g3, gY, sh, (sh != null && shP != null) ? sh - shP : null];
    });
    sheets.push({ name: 'Comparison Table',
      rows: [[entityLabel, m.label + ' (latest)', '3M %', 'YoY %', 'Share %', 'Share Δ pp'], ...tbl] });
  }

  exportSheets(`bank-comparison_${which}_${stamp}.xlsx`, sheets, currentFilterMeta());
}
