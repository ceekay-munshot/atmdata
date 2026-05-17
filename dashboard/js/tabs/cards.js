// Card Cash Withdrawal Trends tab — Debit/Credit × Volume/Value.
//   Local toggles: Debit/Credit, Volume/Value (override global metric).
//   1. Transaction Trend
//   2. Debit vs Credit Comparison (dual-line on same axis or share)
//   3. Growth / Momentum
//   4. Bank Ranking table

import { rows, latestPeriod } from '../data.js';
import { getState, subscribe, setState } from '../state.js';
import {
  series, filterRows, denominatorRows, shareSeries,
  growth, rankBanks, metric, METRICS, fmtCr, fmtInt,
  applyView, isPctView, compositionDescription,
} from '../calc.js';
import { exportSheets, currentFilterMeta } from '../export.js';
import { PALETTE, UP, DOWN, FLAT, TOOLTIP_BASE, AXIS_X, AXIS_Y, gradientArea, compactNum, playReplay, latestGlowMarkPoint, PLAY_ICON, STOP_ICON, setEmptyChart } from '../chartopts.js';

let charts = {};
let _root = null;
let _unsub = null;
let _sortState = { col: 'value', dir: 'desc' };
let _playing = null;

const CARD_METRICS = ['dc_vol', 'dc_val_cr', 'cc_vol', 'cc_val_cr'];

// Derive metric key from {side, measure}
const KEY = {
  debit:  { volume: 'dc_vol', value: 'dc_val_cr' },
  credit: { volume: 'cc_vol', value: 'cc_val_cr' },
};
// Inverse map
function keyToToggles(key) {
  for (const side of Object.keys(KEY)) {
    for (const meas of Object.keys(KEY[side])) {
      if (KEY[side][meas] === key) return { side, measure: meas };
    }
  }
  return { side: 'debit', measure: 'volume' };
}

const HTML = `
  <div class="grid">
    <div class="card accent">
      <div class="card-head">
        <div class="card-head-text">
          <div class="card-title">Card Cash Withdrawal Trends</div>
          <div class="card-sub">Monthly flow values · For the month/period</div>
        </div>
        <div class="card-actions">
          <button class="btn btn-play" data-action="play-trend" title="Replay timeline">${PLAY_ICON}<span>Replay</span></button>
          <div class="mini-toggle" id="card-side"></div>
          <div class="mini-toggle" id="card-measure"></div>
        </div>
      </div>
      <div class="chart tall" id="chart-card-trend"></div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <div class="card-head">
          <div class="card-head-text">
            <div class="card-title">Debit vs Credit Comparison</div>
            <div class="card-sub" id="card-cmp-sub">—</div>
          </div>
        </div>
        <div class="chart" id="chart-card-cmp"></div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="card-head-text">
            <div class="card-title">Growth / Momentum</div>
            <div class="card-sub" id="card-growth-sub">—</div>
          </div>
        </div>
        <div class="chart" id="chart-card-growth"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div class="card-head-text">
          <div class="card-title">Bank Ranking · For the Month</div>
          <div class="card-sub" id="card-tbl-sub">—</div>
        </div>
        <div class="card-actions">
          <button class="btn primary" data-export="all">Export All to Excel</button>
        </div>
      </div>
      <div class="tbl-wrap" id="card-tbl"></div>
    </div>
  </div>
`;

export function mount(root) {
  _root = root;
  root.innerHTML = HTML;

  // Force a card metric if the global one isn't a card metric
  if (!CARD_METRICS.includes(getState().metric)) setState({ metric: 'dc_vol' });

  renderToggles();
  charts.trend  = echarts.init(root.querySelector('#chart-card-trend'));
  charts.cmp    = echarts.init(root.querySelector('#chart-card-cmp'));
  charts.growth = echarts.init(root.querySelector('#chart-card-growth'));

  window.addEventListener('resize', onResize);
  root.querySelectorAll('[data-export]').forEach(b => b.onclick = () => onExport(b.dataset.export));
  root.querySelector('[data-action="play-trend"]').addEventListener('click', togglePlayTrend);

  redraw();
  _unsub = subscribe(() => { stopPlayTrend(); renderToggles(); redraw(); });
}

export function unmount() {
  stopPlayTrend();
  for (const c of Object.values(charts)) c.dispose();
  charts = {};
  window.removeEventListener('resize', onResize);
  if (_unsub) { _unsub(); _unsub = null; }
}

function stopPlayTrend() {
  if (_playing) { _playing.stop(); _playing = null; }
  const btn = _root && _root.querySelector('[data-action="play-trend"]');
  if (btn) { btn.classList.remove('playing'); btn.innerHTML = `${PLAY_ICON}<span>Replay</span>`; }
}

function togglePlayTrend() {
  if (_playing) { stopPlayTrend(); redraw(); return; }
  const state = getState();
  const allRows = rows();
  const filtered = filterRows(allRows, state);
  let data = series(filtered, state.metric, state.freq);
  data = applyView(data, allRows, state, state.freq, state.metric);
  const values = data.map(d => d.value);
  const color = state.metric.startsWith('dc_') ? PALETTE[0] : PALETTE[3];
  const btn = _root.querySelector('[data-action="play-trend"]');
  btn.classList.add('playing');
  btn.innerHTML = `${STOP_ICON}<span>Stop</span>`;
  _playing = playReplay(charts.trend, {
    seriesData: [values], colors: [color], durationMs: 2500,
    onDone: () => { _playing = null; btn.classList.remove('playing'); btn.innerHTML = `${PLAY_ICON}<span>Replay</span>`; redraw(); },
  });
}

function onResize() { for (const c of Object.values(charts)) c.resize(); }

function renderToggles() {
  const { side, measure } = keyToToggles(getState().metric);
  _root.querySelector('#card-side').innerHTML = `
    <button data-side="debit"  class="${side === 'debit'  ? 'active' : ''}">Debit</button>
    <button data-side="credit" class="${side === 'credit' ? 'active' : ''}">Credit</button>`;
  _root.querySelector('#card-measure').innerHTML = `
    <button data-meas="volume" class="${measure === 'volume' ? 'active' : ''}">Volume</button>
    <button data-meas="value"  class="${measure === 'value'  ? 'active' : ''}">Value (Cr)</button>`;
  _root.querySelector('#card-side').onclick = (e) => {
    const btn = e.target.closest('button[data-side]'); if (!btn) return;
    const cur = keyToToggles(getState().metric);
    setState({ metric: KEY[btn.dataset.side][cur.measure] });
  };
  _root.querySelector('#card-measure').onclick = (e) => {
    const btn = e.target.closest('button[data-meas]'); if (!btn) return;
    const cur = keyToToggles(getState().metric);
    setState({ metric: KEY[cur.side][btn.dataset.meas] });
  };
}

function redraw() {
  const state = getState();
  const allRows = rows();
  const filtered = filterRows(allRows, state);
  renderTrend(state, allRows, filtered);
  renderCompare(state, allRows, filtered);
  renderGrowth(state, allRows, filtered);
  renderTable(state, allRows);
}

// ── Trend ───────────────────────────────────────────────────────────────
function renderTrend(state, allRows, filtered) {
  const m = metric(state.metric);
  let data = series(filtered, state.metric, state.freq);
  data = applyView(data, allRows, state, state.freq, state.metric);
  const isShare = isPctView(state);

  const xs = data.map(d => d.label);
  const ys = data.map(d => d.value);
  const color = state.metric.startsWith('dc_') ? PALETTE[0] : PALETTE[3];
  const valFmt = isShare ? (v => v == null ? '—' : v.toFixed(2) + '%') : m.format;
  const valid = ys.filter(v => v != null);
  const mean = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;

  if (!data.length || valid.length === 0) {
    const bankNote = state.banks && state.banks.length
      ? `${state.banks[0]} has no recorded ${m.short} in the selected range`
      : 'No values recorded for this combination in the selected range';
    setEmptyChart(charts.trend, 'No data', bankNote);
    return;
  }

  charts.trend.setOption({
    grid: { left: 70, right: 28, top: 24, bottom: 36 },
    tooltip: { ...TOOLTIP_BASE,
      formatter: (params) => `<div style="font-weight:600;margin-bottom:4px">${params[0].axisValue}</div>
        <div style="display:flex;align-items:center;gap:6px">
          <span style="width:8px;height:8px;background:${color};border-radius:50%"></span>
          ${m.short} (For the month): <b>${valFmt(params[0].value)}</b></div>`,
    },
    xAxis: { ...AXIS_X, data: xs, boundaryGap: false },
    yAxis: { ...AXIS_Y, axisLabel: { ...AXIS_Y.axisLabel,
      formatter: (v) => isShare ? v.toFixed(1) + '%' : compactNum(v) } },
    series: [{
      type: 'line', smooth: true, showSymbol: false,
      lineStyle: { color, width: 2.6 },
      areaStyle: { color: gradientArea(color) },
      markLine: mean != null ? {
        symbol: 'none', silent: true,
        lineStyle: { color: '#94a3b8', type: 'dashed', width: 1 },
        label: { color: '#64748b', fontSize: 10, fontWeight: 500,
                 position: 'end', formatter: 'avg ' + (isShare ? mean.toFixed(2) + '%' : compactNum(mean)) },
        data: [{ yAxis: mean }],
      } : undefined,
      markPoint: latestGlowMarkPoint(xs, ys, color),
      data: ys,
    }],
    animation: true, animationDuration: 600,
  }, true);
}

// ── Debit vs Credit Comparison ─────────────────────────────────────────
function renderCompare(state, allRows, filtered) {
  const { measure } = keyToToggles(state.metric);
  const dcKey = measure === 'volume' ? 'dc_vol' : 'dc_val_cr';
  const ccKey = measure === 'volume' ? 'cc_vol' : 'cc_val_cr';

  const dc = series(filtered, dcKey, state.freq);
  const cc = series(filtered, ccKey, state.freq);
  const keys = dc.map(d => d.key);
  const labels = dc.map(d => d.label);
  const dcMap = new Map(dc.map(d => [d.key, d.value]));
  const ccMap = new Map(cc.map(d => [d.key, d.value]));

  const dcVals = keys.map(k => dcMap.get(k));
  const ccVals = keys.map(k => ccMap.get(k));
  const debitM  = metric(dcKey);
  const creditM = metric(ccKey);

  _root.querySelector('#card-cmp-sub').textContent =
    `${measure === 'volume' ? 'Volume (transactions)' : 'Value (Rs Cr)'} · debit vs credit`;

  charts.cmp.setOption({
    grid: { left: 70, right: 70, top: 36, bottom: 44 },
    legend: { top: 4, textStyle: { color: '#334155', fontSize: 11 }, icon: 'roundRect', itemWidth: 10, itemHeight: 6 },
    tooltip: { ...TOOLTIP_BASE,
      formatter: (params) => {
        let html = `<div style="font-weight:600;margin-bottom:4px">${params[0].axisValue}</div>`;
        for (const p of params) {
          if (p.value == null) continue;
          html += `<div style="display:flex;align-items:center;gap:6px;margin-top:2px">
            <span style="width:8px;height:8px;background:${p.color};border-radius:50%"></span>
            ${p.seriesName}: <b>${measure === 'value' ? fmtCr(p.value) : fmtInt(p.value)}</b></div>`;
        }
        return html;
      },
    },
    xAxis: { ...AXIS_X, data: labels, boundaryGap: false },
    yAxis: [
      { type: 'value', name: 'Debit', position: 'left',
        nameTextStyle: { color: PALETTE[0], fontSize: 11, fontWeight: 600 },
        axisLine: { show: false }, splitLine: { lineStyle: { color: '#e3e6ec', type: 'dashed' } },
        axisLabel: { color: '#64748b', fontSize: 11, formatter: (v) => compactNum(v) } },
      { type: 'value', name: 'Credit', position: 'right',
        nameTextStyle: { color: PALETTE[3], fontSize: 11, fontWeight: 600 },
        axisLine: { show: false }, splitLine: { show: false },
        axisLabel: { color: '#64748b', fontSize: 11, formatter: (v) => compactNum(v) } },
    ],
    series: [
      { name: 'Debit', type: 'line', smooth: true, showSymbol: false, yAxisIndex: 0,
        lineStyle: { color: PALETTE[0], width: 2.5 }, itemStyle: { color: PALETTE[0] },
        areaStyle: { color: gradientArea(PALETTE[0]) },
        data: dcVals },
      { name: 'Credit', type: 'line', smooth: true, showSymbol: false, yAxisIndex: 1,
        lineStyle: { color: PALETTE[3], width: 2.5 }, itemStyle: { color: PALETTE[3] },
        data: ccVals },
    ],
    animation: true, animationDuration: 600,
  }, true);
}

// ── Growth ─────────────────────────────────────────────────────────────
function renderGrowth(state, allRows, filtered) {
  const m = metric(state.metric);
  const isShareChange = state.growthType === 'ShareChange';
  const useState = (isShareChange && state.view === 'absolute') ? { ...state, view: 'share' } : state;
  const isShare = isPctView(useState);
  let base = series(filtered, state.metric, state.freq);
  base = applyView(base, allRows, useState, state.freq, state.metric);

  let gArr, units;
  if (isShareChange) {
    const lookback = state.freq === 'M' ? 12 : state.freq === 'Q' ? 4 : 1;
    gArr = []; for (let i = 0; i < base.length; i++) {
      if (i < lookback || base[i].value == null || base[i - lookback].value == null) gArr.push(null);
      else gArr.push(base[i].value - base[i - lookback].value);
    }
    units = 'pp';
  } else {
    gArr = growth(base, state.growthType, state.freq);
    units = '%';
  }

  let growthSuffix = '';
  if (isShareChange) growthSuffix = ' (pp, YoY)';
  else if (state.view === 'share') growthSuffix = ' · on market share';
  else if (state.view === 'composition') growthSuffix = ' · on composition %';
  _root.querySelector('#card-growth-sub').textContent =
    `${m.short} · ${isShareChange ? 'Share Δ' : state.growthType}${growthSuffix}`;

  if (!base.length || base.every(d => d.value == null)) {
    setEmptyChart(charts.growth, 'No data', 'No values to compute growth on');
    return;
  }

  const xs = base.map(d => d.label);
  const colored = gArr.map(v => {
    if (v == null) return { value: null };
    if (v > 0)  return { value: v, itemStyle: { color: UP } };
    if (v < 0)  return { value: v, itemStyle: { color: DOWN } };
    return { value: v, itemStyle: { color: FLAT } };
  });

  charts.growth.setOption({
    grid: { left: 60, right: 16, top: 24, bottom: 44 },
    tooltip: { ...TOOLTIP_BASE,
      formatter: (params) => {
        const p = params[0]; const v = p.value;
        const c = v == null ? '#94a3b8' : v > 0 ? UP : v < 0 ? DOWN : FLAT;
        return `<div style="font-weight:600;margin-bottom:4px">${p.axisValue}</div>
                <div style="display:flex;align-items:center;gap:6px">
                  <span style="width:8px;height:8px;background:${c};border-radius:50%"></span>
                  ${state.growthType}: <b>${v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + units}</b></div>`;
      },
    },
    xAxis: { ...AXIS_X, data: xs },
    yAxis: { ...AXIS_Y, axisLabel: { ...AXIS_Y.axisLabel, formatter: (v) => v.toFixed(0) + units } },
    series: [{
      type: 'bar', data: colored, barMaxWidth: 18,
      itemStyle: { borderRadius: [3, 3, 0, 0] },
      markLine: { symbol: 'none', silent: true,
        lineStyle: { color: '#cbd2dc', width: 1 }, label: { show: false }, data: [{ yAxis: 0 }] },
    }],
    animation: true, animationDuration: 500,
  }, true);
}

// ── Table ──────────────────────────────────────────────────────────────
function renderTable(state, allRows) {
  const m = metric(state.metric);
  const period = state.to || latestPeriod();
  const baseRows = state.category === 'all' ? allRows : allRows.filter(r => r.category === state.category);
  const ranked = rankBanks(baseRows, state.metric, period);

  const refPeriod = referencePeriod(period, state.growthType, state.freq);
  const refMap = new Map();
  if (refPeriod) {
    for (const r of baseRows.filter(r => r.period === refPeriod)) {
      const v = r[m.field];
      if (v == null) continue;
      refMap.set(r.bank, (refMap.get(r.bank) ?? 0) + v);
    }
  }
  const refTotal = [...refMap.values()].reduce((s, v) => s + v, 0);

  const enriched = ranked.map((r, i) => {
    const refRaw = refMap.get(r.bank);
    const refDisp = refRaw == null ? null : m.transform(refRaw);
    const g = (refDisp != null && refDisp !== 0 && r.value != null) ? ((r.value - refDisp) / refDisp) * 100 : null;
    const refShare = (refRaw != null && refTotal > 0) ? (refRaw / refTotal) * 100 : null;
    const shareDelta = (refShare != null && r.share != null) ? r.share - refShare : null;
    return { ...r, growth: g, shareDelta, rank: i + 1 };
  });
  const sorted = sortRows(enriched, _sortState);

  _root.querySelector('#card-tbl-sub').textContent =
    `${m.label} · For the month of ${period} · ${enriched.length} banks · vs ${refPeriod || '—'} (${state.growthType})`;

  const cols = [
    { id: 'rank',        label: '#',            num: true,  cell: r => `<span class="rank-cell ${r.rank <= 3 ? 'top' : ''}">${r.rank}</span>` },
    { id: 'bank',        label: 'Bank',         num: false, cell: r => r.bank },
    { id: 'category',    label: 'Category',     num: false, cell: r => r.category ? `<span class="chip ${catSlug(r.category)}">${shortCat(r.category)}</span>` : '—' },
    { id: 'value',       label: m.short,        num: true,  cell: r => m.format(r.value) },
    { id: 'growth',      label: state.growthType, num: true, cell: r => deltaCell(r.growth, '%') },
    { id: 'share',       label: 'Share',        num: true,  cell: r => r.share == null ? '—' : r.share.toFixed(2) + '%' },
    { id: 'shareDelta',  label: 'Share Δ',      num: true,  cell: r => deltaCell(r.shareDelta, ' pp') },
  ];

  const wrap = _root.querySelector('#card-tbl');
  wrap.innerHTML = `
    <table class="tbl">
      <thead><tr>
        ${cols.map(c => {
          const sc = _sortState.col === c.id ? `sort-${_sortState.dir}` : '';
          const ind = _sortState.col === c.id ? (_sortState.dir === 'asc' ? '▲' : '▼') : '↕';
          return `<th class="sortable ${c.num ? 'num' : ''} ${sc}" data-col="${c.id}">${c.label}<span class="sort-ind">${ind}</span></th>`;
        }).join('')}
      </tr></thead>
      <tbody>${sorted.map(r => `<tr>${cols.map(c => `<td class="${c.num ? 'num' : ''}">${c.cell(r)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>`;
  wrap.querySelectorAll('thead th.sortable').forEach(th => {
    th.onclick = () => {
      const col = th.dataset.col;
      _sortState.dir = (_sortState.col === col && _sortState.dir === 'desc') ? 'asc' : 'desc';
      _sortState.col = col;
      renderTable(state, allRows);
    };
  });
}

// ── Shared (mirrored locally) ───────────────────────────────────────────
function referencePeriod(period, growthType, freq) {
  if (freq !== 'M') return null;
  const [y, m] = period.split('-').map(Number);
  let offset = growthType === 'MoM' ? 1 : growthType === '3M' ? 3 : 12;
  const d = new Date(Date.UTC(y, m - 1 - offset, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function sortRows(rs, ss) {
  const sign = ss.dir === 'asc' ? 1 : -1;
  return [...rs].sort((a, b) => {
    let av = a[ss.col], bv = b[ss.col];
    if (typeof av === 'string') return sign * av.localeCompare(bv ?? '');
    if (av == null) return 1; if (bv == null) return -1;
    return sign * (av - bv);
  });
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

// ── Export ──────────────────────────────────────────────────────────────
function onExport(which) {
  const state = getState();
  const m = metric(state.metric);
  const allRows = rows();
  const filtered = filterRows(allRows, state);
  const stamp = new Date().toISOString().slice(0, 10);
  const sheets = [];

  if (which === 'all') {
    let data = series(filtered, state.metric, state.freq);
    data = applyView(data, allRows, state, state.freq, state.metric);
    const trendHdr = state.view === 'share' ? `${m.short} share %`
      : state.view === 'composition' ? `${m.short} composition %` : m.label;
    sheets.push({ name: 'Trend', rows: [['Period', trendHdr],
      ...data.map(d => [d.label, d.value])] });

    // Comparison
    const { measure } = keyToToggles(state.metric);
    const dcKey = measure === 'volume' ? 'dc_vol' : 'dc_val_cr';
    const ccKey = measure === 'volume' ? 'cc_vol' : 'cc_val_cr';
    const dc = series(filtered, dcKey, state.freq);
    const cc = series(filtered, ccKey, state.freq);
    const dcMap = new Map(dc.map(d => [d.key, d.value]));
    const ccMap = new Map(cc.map(d => [d.key, d.value]));
    sheets.push({ name: 'Debit vs Credit',
      rows: [['Period', `Debit ${measure === 'volume' ? 'Vol' : 'Val Cr'}`, `Credit ${measure === 'volume' ? 'Vol' : 'Val Cr'}`],
        ...dc.map(d => [d.label, d.value, ccMap.get(d.key)])] });

    const isShareChange = state.growthType === 'ShareChange';
    const useState2 = (isShareChange && state.view === 'absolute') ? { ...state, view: 'share' } : state;
    let base = series(filtered, state.metric, state.freq);
    base = applyView(base, allRows, useState2, state.freq, state.metric);
    let g;
    if (isShareChange) {
      const lookback = state.freq === 'M' ? 12 : state.freq === 'Q' ? 4 : 1;
      g = []; for (let i = 0; i < base.length; i++) {
        if (i < lookback || base[i].value == null || base[i - lookback].value == null) g.push(null);
        else g.push(base[i].value - base[i - lookback].value);
      }
    } else g = growth(base, state.growthType, state.freq);
    sheets.push({ name: 'Growth',
      rows: [['Period', isShareChange ? 'Share Δ pp' : `${state.growthType} %`],
        ...base.map((d, i) => [d.label, g[i]])] });

    // Table
    const period = state.to || latestPeriod();
    const baseRows = state.category === 'all' ? allRows : allRows.filter(r => r.category === state.category);
    const ranked = rankBanks(baseRows, state.metric, period);
    sheets.push({ name: 'Bank Table',
      rows: [['Rank', 'Bank', 'Category', m.label, 'Share %'],
        ...ranked.map((r, i) => [i + 1, r.bank, r.category || '—', r.value, r.share])] });
  }

  exportSheets(`cards_${which}_${stamp}.xlsx`, sheets, currentFilterMeta());
}
