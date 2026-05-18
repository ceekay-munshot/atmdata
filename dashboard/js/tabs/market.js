// Market Share / Proportionate tab.
//   1. Market Share Trend (top N banks)
//   2. Share Change chart (in pp, bar chart of top movers)
//   3. Top Gainers / Losers table (split)
//   4. Market Share Heatmap (bank × time → share %)
// Share change is always in PP, NEVER called growth.

import { rows, latestPeriod } from '../data.js';
import { getState, subscribe } from '../state.js';
import {
  series, filterRows, denominatorRows, shareSeries,
  rankBanks, metric,
} from '../calc.js';
import { exportSheets, currentFilterMeta } from '../export.js';
import { PALETTE, TOOLTIP_BASE, AXIS_X, AXIS_Y, compactNum, UP, DOWN, FLAT, playReplay, PLAY_ICON, STOP_ICON, EXCEL_ICON, hexA, indexTo100, softLineStyle } from '../chartopts.js';

let charts = {};
let _root = null;
let _unsub = null;
let _heatmapWindow = 36;   // months
let _heatmapMode = 'share';   // 'share' | 'delta'
let _topN = 10;
let _basePeriod = null;       // null = auto (YoY); otherwise YYYY-MM
let _trendIndexed = false;    // rebase share-trend lines to 100
let _playing = null;
let _trendValuesCache = [];
let _trendColorsCache = [];

const HTML = `
  <div class="grid">
    <div class="card accent">
      <div class="card-head">
        <div class="card-head-text">
          <div class="card-title">Market Share / Proportionate View</div>
          <div class="card-sub" id="mk-sub">—</div>
        </div>
        <div class="card-actions">
          <div class="mini-toggle" id="mk-trend-index" title="Rebase every line to 100 at the first period">
            <button class="active" data-v="raw">Raw</button>
            <button data-v="indexed">Index = 100</button>
          </div>
          <button class="btn-icon btn-icon-play" data-action="play-trend" title="Replay timeline">${PLAY_ICON}</button>
          <div class="mini-toggle" id="mk-topn">
            <button data-v="5">Top 5</button>
            <button class="active" data-v="10">Top 10</button>
            <button data-v="15">Top 15</button>
          </div>
        </div>
      </div>
      <div class="chart tall" id="chart-mk-trend"></div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <div class="card-head">
          <div class="card-head-text">
            <div class="card-title">Share Change (pp)</div>
            <div class="card-sub" id="mk-chg-sub">—</div>
          </div>
          <div class="card-actions">
            <label class="mk-base-lbl">Base:</label>
            <input type="month" id="mk-base" class="fb-input mk-base-input" />
            <button class="btn-icon" data-export="change" title="Export to Excel">${EXCEL_ICON}</button>
          </div>
        </div>
        <div class="chart" id="chart-mk-change"></div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="card-head-text">
            <div class="card-title">Top Gainers / Losers (pp)</div>
            <div class="card-sub" id="mk-mov-sub">—</div>
          </div>
        </div>
        <div id="mk-movers"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div class="card-head-text">
          <div class="card-title">Market Share Heatmap</div>
          <div class="card-sub" id="mk-heat-sub">—</div>
        </div>
        <div class="card-actions">
          <div class="mini-toggle" id="mk-heat-mode">
            <button class="active" data-v="share">Share %</button>
            <button data-v="delta">Δ pp (MoM)</button>
          </div>
          <div class="mini-toggle" id="mk-window">
            <button data-v="12">12 m</button>
            <button data-v="24">24 m</button>
            <button class="active" data-v="36">36 m</button>
            <button data-v="60">60 m</button>
          </div>
          <button class="btn-icon primary" data-export="all" title="Export to Excel">${EXCEL_ICON}</button>
        </div>
      </div>
      <div class="chart tall" id="chart-mk-heat"></div>
    </div>
  </div>
`;

export function mount(root) {
  _root = root;
  root.innerHTML = HTML;

  charts.trend  = echarts.init(root.querySelector('#chart-mk-trend'));
  charts.change = echarts.init(root.querySelector('#chart-mk-change'));
  charts.heat   = echarts.init(root.querySelector('#chart-mk-heat'));

  window.addEventListener('resize', onResize);
  root.querySelectorAll('[data-export]').forEach(b => b.onclick = () => onExport(b.dataset.export));
  root.querySelector('[data-action="play-trend"]').addEventListener('click', togglePlayTrend);
  root.querySelector('#mk-topn').onclick = (e) => {
    const btn = e.target.closest('button[data-v]'); if (!btn) return;
    _topN = +btn.dataset.v;
    root.querySelectorAll('#mk-topn button').forEach(b => b.classList.toggle('active', b.dataset.v === btn.dataset.v));
    redraw();
  };
  root.querySelector('#mk-window').onclick = (e) => {
    const btn = e.target.closest('button[data-v]'); if (!btn) return;
    _heatmapWindow = +btn.dataset.v;
    root.querySelectorAll('#mk-window button').forEach(b => b.classList.toggle('active', b.dataset.v === btn.dataset.v));
    redraw();
  };
  root.querySelector('#mk-heat-mode').onclick = (e) => {
    const btn = e.target.closest('button[data-v]'); if (!btn) return;
    _heatmapMode = btn.dataset.v;
    root.querySelectorAll('#mk-heat-mode button').forEach(b => b.classList.toggle('active', b.dataset.v === btn.dataset.v));
    redraw();
  };
  // Base period picker (Share Change + Top Gainers/Losers use the same base)
  const baseInput = root.querySelector('#mk-base');
  baseInput.addEventListener('change', () => {
    _basePeriod = baseInput.value || null;
    redraw();
  });
  root.querySelector('#mk-trend-index').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-v]'); if (!btn) return;
    _trendIndexed = btn.dataset.v === 'indexed';
    root.querySelectorAll('#mk-trend-index button').forEach(b => b.classList.toggle('active', b.dataset.v === btn.dataset.v));
    redraw();
  });

  redraw();
  _unsub = subscribe(() => { stopPlayTrend(); redraw(); });
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
  if (btn) { btn.classList.remove('playing'); btn.innerHTML = PLAY_ICON; }
}

function togglePlayTrend() {
  if (_playing) { stopPlayTrend(); redraw(); return; }
  if (!_trendValuesCache.length) return;
  const btn = _root.querySelector('[data-action="play-trend"]');
  btn.classList.add('playing');
  btn.innerHTML = STOP_ICON;
  const fmt = _trendIndexed ? (v) => v.toFixed(1) : (v) => v.toFixed(1) + '%';
  _playing = playReplay(charts.trend, {
    seriesData: _trendValuesCache, colors: _trendColorsCache, durationMs: 2500, formatVal: fmt,
    onDone: () => { _playing = null; btn.classList.remove('playing'); btn.innerHTML = PLAY_ICON; redraw(); },
  });
}

function onResize() { for (const c of Object.values(charts)) c.resize(); }

function redraw() {
  const state = getState();
  const allRows = rows();
  const period = state.to || latestPeriod();
  const universe = state.category === 'all' ? allRows : allRows.filter(r => r.category === state.category);

  _root.querySelector('#mk-sub').textContent =
    `${metric(state.metric).label} · share within ${state.category !== 'all' ? state.category : 'industry'}`;

  // Sync base-period picker bounds + value
  syncBaseInput(allRows, period);

  // Determine top-N banks by latest period
  const ranked = rankBanks(universe, state.metric, period).slice(0, _topN);
  const topBanks = ranked.map(r => r.bank);

  renderTrend(state, allRows, universe, topBanks);
  renderChange(state, allRows, universe, period, topBanks);
  renderMovers(state, allRows, universe, period);
  renderHeatmap(state, universe, period, topBanks);
}

function syncBaseInput(allRows, period) {
  const input = _root.querySelector('#mk-base');
  if (!input) return;
  const allPeriods = [...new Set(allRows.map(r => r.period))].sort();
  input.min = allPeriods[0];
  input.max = period;
  // If user hasn't set a base, default to YoY of current period
  if (!_basePeriod) {
    input.value = yoyOf(period);
  } else {
    input.value = _basePeriod;
  }
}

function yoyOf(period) {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(Date.UTC(y - 1, m - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function effectiveBase(period) {
  return _basePeriod || yoyOf(period);
}

// ── 1. Market Share Trend (top N) ───────────────────────────────────────
function renderTrend(state, allRows, universe, topBanks) {
  const m = metric(state.metric);
  const denom = denominatorRows(allRows, state);
  const denomSeries = series(denom, state.metric, state.freq);
  const denomMap = new Map(denomSeries.map(d => [d.key, d.value]));

  const sets = topBanks.map(bank => {
    const br = allRows.filter(r => r.bank === bank);
    const s = series(br, state.metric, state.freq);
    return {
      name: bank,
      data: s.map(d => {
        const den = denomMap.get(d.key);
        return { key: d.key, label: d.label, value: (den && d.value != null) ? (d.value / den) * 100 : null };
      }),
    };
  });

  const xs = (sets[0]?.data || []).map(d => d.label);
  const rawValues = sets.map(s => s.data.map(d => d.value));
  const finalValues = _trendIndexed ? rawValues.map(indexTo100) : rawValues;
  const ss = sets.map((s, i) => ({
    name: s.name,
    type: 'line', smooth: 0.4, showSymbol: false,
    lineStyle: softLineStyle(PALETTE[i % PALETTE.length], 2.2),
    itemStyle: { color: PALETTE[i % PALETTE.length] },
    emphasis: { focus: 'series', lineStyle: { width: 3 } },
    data: finalValues[i],
    endLabel: { show: true, color: PALETTE[i % PALETTE.length], fontWeight: 600, fontSize: 11,
      formatter: (p) => p.value == null ? '' : (_trendIndexed ? ' ' + p.value.toFixed(0) : ' ' + p.value.toFixed(1) + '%') },
  }));

  // Cache for replay button
  _trendValuesCache = finalValues;
  _trendColorsCache = sets.map((_, i) => PALETTE[i % PALETTE.length]);

  charts.trend.setOption({
    grid: { left: 60, right: 80, top: 44, bottom: 44 },
    legend: { top: 4, textStyle: { color: '#334155', fontSize: 11 }, icon: 'roundRect', itemWidth: 10, itemHeight: 6 },
    tooltip: { ...TOOLTIP_BASE, trigger: 'item',
      formatter: (p) => {
        if (p.value == null) return '';
        const v = _trendIndexed ? p.value.toFixed(1) : (p.value.toFixed(2) + '%');
        return `<div style="font-weight:600;margin-bottom:4px">${p.name}</div>
          <div style="display:flex;align-items:center;gap:6px">
            <span style="width:8px;height:8px;background:${p.color};border-radius:50%"></span>
            ${truncate(p.seriesName, 28)}: <b>${v}</b></div>`;
      },
    },
    xAxis: { ...AXIS_X, data: xs, boundaryGap: false },
    yAxis: { ...AXIS_Y, axisLabel: { ...AXIS_Y.axisLabel,
      formatter: (v) => _trendIndexed ? v.toFixed(0) : (v.toFixed(1) + '%') } },
    series: ss,
    animation: true, animationDuration: 600,
  }, true);
}

// ── 2. Share Change (pp) — single bar per bank, custom base period ────
function renderChange(state, allRows, universe, period, topBanks) {
  const m = metric(state.metric);
  const refPeriod = effectiveBase(period);
  const denom = denominatorRows(allRows, state);

  // Validate that refPeriod actually exists in the data
  const allPeriodsSet = new Set(allRows.map(r => r.period));
  if (!refPeriod || !allPeriodsSet.has(refPeriod)) {
    setEmpty(charts.change, 'Pick a valid base period.');
    _root.querySelector('#mk-chg-sub').textContent = `Base ${refPeriod || '—'} not in dataset`;
    return;
  }

  const dNow = sumAt(denom, period, m.field);
  const dRef = sumAt(denom, refPeriod, m.field);

  // Compute share Δ for every bank in universe, then take top movers by |Δ|
  const ent = [];
  for (const bank of new Set(universe.map(r => r.bank))) {
    const br = universe.filter(r => r.bank === bank);
    const vNow = sumAt(br, period, m.field);
    const vRef = sumAt(br, refPeriod, m.field);
    const sNow = dNow > 0 ? (vNow / dNow) * 100 : null;
    const sRef = dRef > 0 ? (vRef / dRef) * 100 : null;
    if (sNow == null || sRef == null) continue;
    ent.push({ bank, delta: sNow - sRef, sNow, sRef });
  }
  // Show top movers by absolute delta — limit to ~12 for readability
  ent.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const top = ent.slice(0, 12).sort((a, b) => b.delta - a.delta);

  _root.querySelector('#mk-chg-sub').textContent =
    `${period} vs ${refPeriod} · ${state.category !== 'all' ? state.category : 'industry'} · top ${top.length} movers by |Δpp|`;

  const xs = top.map(e => e.bank);
  const data = top.map(e => ({
    value: e.delta,
    itemStyle: { color: e.delta > 0 ? UP : e.delta < 0 ? DOWN : FLAT },
  }));

  charts.change.setOption({
    grid: { left: 160, right: 36, top: 16, bottom: 32 },
    tooltip: { ...TOOLTIP_BASE, trigger: 'item',
      formatter: (p) => {
        const e = top[p.dataIndex];
        return `<div style="font-weight:600;margin-bottom:4px">${e.bank}</div>
                <div>${refPeriod}: <b>${e.sRef.toFixed(2)}%</b></div>
                <div>${period}: <b>${e.sNow.toFixed(2)}%</b></div>
                <div>Δ: <b>${(e.delta > 0 ? '+' : '') + e.delta.toFixed(2)} pp</b></div>`;
      },
    },
    xAxis: { type: 'value',
      axisLabel: { color: '#94a3b8', fontSize: 10.5, fontWeight: 500, formatter: (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' pp' },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: '#f1f5f9', type: 'solid', width: 1 } } },
    yAxis: { type: 'category', data: xs,
      axisLabel: { color: '#334155', fontSize: 11.5, fontWeight: 600,
        formatter: (v) => v.length > 22 ? v.slice(0, 21) + '…' : v },
      axisLine: { show: false }, axisTick: { show: false } },
    series: [{
      type: 'bar', data, barMaxWidth: 14,
      itemStyle: { borderRadius: [0, 3, 3, 0] },
      label: { show: true, position: 'right', color: '#334155', fontSize: 10, fontWeight: 600,
        formatter: (p) => (p.value > 0 ? '+' : '') + p.value.toFixed(2) + ' pp' },
      markLine: { symbol: 'none', silent: true, lineStyle: { color: '#cbd2dc', width: 1 },
        label: { show: false }, data: [{ xAxis: 0 }] },
    }],
    animation: true, animationDuration: 500,
  }, true);
}

// ── 3. Top Gainers / Losers (split table) ──────────────────────────────
function renderMovers(state, allRows, universe, period) {
  const m = metric(state.metric);
  const refPeriod = effectiveBase(period);
  const allPeriodsSet = new Set(allRows.map(r => r.period));
  if (!refPeriod || !allPeriodsSet.has(refPeriod)) {
    _root.querySelector('#mk-mov-sub').textContent = `Base ${refPeriod || '—'} not in dataset`;
    _root.querySelector('#mk-movers').innerHTML = '<div class="empty"><div class="empty-title">No data</div><div class="empty-sub">Pick a valid base period.</div></div>';
    return;
  }
  const denom = denominatorRows(allRows, state);
  const dNow = sumAt(denom, period, m.field);
  const dRef = sumAt(denom, refPeriod, m.field);

  const ent = [];
  for (const bank of new Set(universe.map(r => r.bank))) {
    const br = universe.filter(r => r.bank === bank);
    const vNow = sumAt(br, period, m.field);
    const vRef = sumAt(br, refPeriod, m.field);
    const sNow = dNow > 0 ? (vNow / dNow) * 100 : null;
    const sRef = dRef > 0 ? (vRef / dRef) * 100 : null;
    if (sNow == null || sRef == null) continue;
    const cat = (br[0] || {}).category;
    ent.push({ bank, category: cat, sNow, sRef, delta: sNow - sRef });
  }
  ent.sort((a, b) => b.delta - a.delta);
  const gainers = ent.slice(0, 5);
  const losers = ent.slice(-5).reverse();

  _root.querySelector('#mk-mov-sub').textContent =
    `${period} vs ${refPeriod} · top 5 each way`;

  _root.querySelector('#mk-movers').innerHTML = `
    <div class="mk-movers-grid">
      <div>
        <div class="mk-movers-head up">Gainers</div>
        <table class="tbl mk-mov">
          <thead><tr><th>Bank</th><th class="num">Share</th><th class="num">Δ pp</th></tr></thead>
          <tbody>${gainers.map(e => `
            <tr><td>${e.bank}</td>
                <td class="num">${e.sNow.toFixed(2)}%</td>
                <td class="num delta-up">+${e.delta.toFixed(2)}</td></tr>`).join('')}</tbody>
        </table>
      </div>
      <div>
        <div class="mk-movers-head down">Losers</div>
        <table class="tbl mk-mov">
          <thead><tr><th>Bank</th><th class="num">Share</th><th class="num">Δ pp</th></tr></thead>
          <tbody>${losers.map(e => `
            <tr><td>${e.bank}</td>
                <td class="num">${e.sNow.toFixed(2)}%</td>
                <td class="num delta-down">${e.delta.toFixed(2)}</td></tr>`).join('')}</tbody>
        </table>
      </div>
    </div>`;
}

// ── 4. Heatmap (bank × time) ───────────────────────────────────────────
// Two modes:
//   share : absolute market share % — categorical piecewise bins so SBI's
//           33% doesn't flatten the colour scale for everyone else
//   delta : MoM share change in pp — diverging red→white→green so you can
//           literally see who's gaining/losing each month
function renderHeatmap(state, universe, period, topBanks) {
  const m = metric(state.metric);
  const allPeriods = [...new Set(universe.map(r => r.period))].sort();
  const endIdx = allPeriods.indexOf(period);
  if (endIdx < 0) { setEmpty(charts.heat, 'No data'); return; }
  // Respect both the local window AND the top-bar From: take whichever
  // produces the SHORTER range (the more restrictive constraint wins).
  let startIdx = Math.max(0, endIdx - _heatmapWindow + 1);
  const s = getState();
  if (s.from) {
    const fromIdx = allPeriods.indexOf(s.from);
    if (fromIdx > startIdx) startIdx = fromIdx;
  }
  const periodsWindow = allPeriods.slice(startIdx, endIdx + 1);

  const dN = new Map();
  for (const p of periodsWindow) dN.set(p, sumAt(universe, p, m.field));

  // Compute absolute share table first
  const shareTable = new Map();
  const latestShare = new Map();
  for (const bank of topBanks) {
    const br = universe.filter(r => r.bank === bank);
    const row = new Map();
    for (const p of periodsWindow) {
      const num = sumAt(br, p, m.field);
      const den = dN.get(p);
      row.set(p, den > 0 ? (num / den) * 100 : null);
    }
    shareTable.set(bank, row);
    latestShare.set(bank, row.get(periodsWindow[periodsWindow.length - 1]) ?? 0);
  }

  const ys = [...topBanks].sort((a, b) => (latestShare.get(b) ?? 0) - (latestShare.get(a) ?? 0));

  // Build data points for either mode
  const data = [];
  for (let yi = 0; yi < ys.length; yi++) {
    const row = shareTable.get(ys[yi]);
    let prev = null;
    for (let xi = 0; xi < periodsWindow.length; xi++) {
      const s = row.get(periodsWindow[xi]);
      let v;
      if (_heatmapMode === 'delta') {
        v = (s != null && prev != null) ? +(s - prev).toFixed(3) : '-';
      } else {
        v = s == null ? '-' : +s.toFixed(2);
      }
      data.push([xi, yi, v]);
      prev = s;
    }
  }

  // Quarter-start label mask
  const labelMask = periodsWindow.map(p => {
    const mm = +p.split('-')[1];
    return mm === 1 || mm === 4 || mm === 7 || mm === 10;
  });

  _root.querySelector('#mk-heat-sub').textContent =
    _heatmapMode === 'delta'
      ? `Top ${ys.length} banks · last ${periodsWindow.length} months · MoM Δ in pp · ${state.category !== 'all' ? state.category : 'industry'}`
      : `Top ${ys.length} banks · last ${periodsWindow.length} months · share % · ${state.category !== 'all' ? state.category : 'industry'} · sorted by latest`;

  const cellWide = periodsWindow.length <= 24;

  // Piecewise visualMap config
  const visualMap = _heatmapMode === 'delta' ? {
    type: 'piecewise',
    pieces: [
      { lt: -0.5,              color: '#991b1b', label: 'Lost > 0.5' },
      { gte: -0.5, lt: -0.1,   color: '#ef4444', label: '-0.5 to -0.1' },
      { gte: -0.1, lt: -0.05,  color: '#fca5a5', label: '-0.1 to -0.05' },
      { gte: -0.05, lte: 0.05, color: '#f1f5f9', label: 'Flat (±0.05)' },
      { gt: 0.05, lte: 0.1,    color: '#bbf7d0', label: '+0.05 to +0.1' },
      { gt: 0.1, lte: 0.5,     color: '#22c55e', label: '+0.1 to +0.5' },
      { gt: 0.5,               color: '#15803d', label: 'Gained > 0.5' },
    ],
    orient: 'horizontal', left: 'center', bottom: 4,
    itemWidth: 16, itemHeight: 12, itemGap: 6,
    textStyle: { color: '#64748b', fontSize: 10, fontWeight: 500 },
    padding: 0,
  } : {
    type: 'piecewise',
    pieces: [
      { lt: 1,             color: '#eef2ff', label: '< 1%' },
      { gte: 1,  lt: 3,    color: '#c7d2fe', label: '1-3%' },
      { gte: 3,  lt: 6,    color: '#a5b4fc', label: '3-6%' },
      { gte: 6,  lt: 10,   color: '#818cf8', label: '6-10%' },
      { gte: 10, lt: 20,   color: '#4f46e5', label: '10-20%' },
      { gte: 20,           color: '#312e81', label: '> 20%' },
    ],
    orient: 'horizontal', left: 'center', bottom: 4,
    itemWidth: 16, itemHeight: 12, itemGap: 6,
    textStyle: { color: '#64748b', fontSize: 10, fontWeight: 500 },
    padding: 0,
  };

  charts.heat.setOption({
    grid: { left: 180, right: 30, top: 18, bottom: 64 },
    tooltip: { ...TOOLTIP_BASE, trigger: 'item',
      formatter: (p) => {
        const [xi, yi, v] = p.data;
        const label = _heatmapMode === 'delta' ? 'MoM Δ' : 'Share';
        const formatted = v === '-' || v == null ? '—'
          : _heatmapMode === 'delta' ? ((v > 0 ? '+' : '') + v.toFixed(2) + ' pp')
          : (v + '%');
        return `<div style="font-weight:600;margin-bottom:4px">${ys[yi]}</div>
                <div style="color:#cbd2dc;font-size:11px;margin-bottom:6px">${periodLabel(periodsWindow[xi])}</div>
                <div>${label}: <b>${formatted}</b></div>`;
      },
    },
    xAxis: { type: 'category', data: periodsWindow.map(periodLabel),
      axisLine: { lineStyle: { color: '#e3e6ec' } },
      axisTick: { show: false },
      axisLabel: { color: '#64748b', fontSize: 10, fontWeight: 500,
        interval: (idx) => labelMask[idx] },
      splitArea: { show: false } },
    yAxis: { type: 'category', data: ys,
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: '#0f172a', fontSize: 11.5, fontWeight: 600,
        formatter: (v) => v.length > 24 ? v.slice(0, 23) + '…' : v },
      splitArea: { show: false } },
    visualMap,
    series: [{
      type: 'heatmap', data,
      itemStyle: { borderRadius: 3, borderColor: '#ffffff', borderWidth: 1 },
      // No in-cell labels — they collide at high cell counts. Value is in
      // the tooltip on hover and in the Excel export.
      label: { show: false },
      emphasis: {
        itemStyle: { borderColor: '#0f172a', borderWidth: 1.5, shadowBlur: 10, shadowColor: 'rgba(15,23,42,0.28)' },
      },
      animation: true,
    }],
  }, true);
}

// ── Helpers ─────────────────────────────────────────────────────────────
function sumAt(rs, period, field) {
  return rs.filter(r => r.period === period).reduce((s, r) => s + (r[field] ?? 0), 0);
}

function referencePeriod(period, growthType, freq) {
  if (freq !== 'M') return null;
  const [y, m] = period.split('-').map(Number);
  let offset = growthType === 'MoM' ? 1 : growthType === '3M' ? 3 : 12;
  const d = new Date(Date.UTC(y, m - 1 - offset, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function periodLabel(p) {
  const [y, m] = p.split('-').map(Number);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[m - 1]} ${String(y).slice(-2)}`;
}

function setEmpty(chart, msg) {
  chart.setOption({
    title: { text: msg, left: 'center', top: 'center',
      textStyle: { color: '#94a3b8', fontWeight: 500, fontSize: 13 } },
    series: [],
  }, true);
}

function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// ── Export ──────────────────────────────────────────────────────────────
function onExport(which) {
  const state = getState();
  const m = metric(state.metric);
  const allRows = rows();
  const period = state.to || latestPeriod();
  const universe = state.category === 'all' ? allRows : allRows.filter(r => r.category === state.category);
  const stamp = new Date().toISOString().slice(0, 10);
  const sheets = [];

  // Common: top-N share trend
  const topBanks = rankBanks(universe, state.metric, period).slice(0, _topN).map(r => r.bank);

  if (which === 'change' || which === 'all') {
    const refPeriod = effectiveBase(period);
    const allPeriodsSet = new Set(allRows.map(r => r.period));
    if (refPeriod && allPeriodsSet.has(refPeriod)) {
      const denom = denominatorRows(allRows, state);
      const dNow = sumAt(denom, period, m.field);
      const dRef = sumAt(denom, refPeriod, m.field);
      const ent = [];
      for (const bank of new Set(universe.map(r => r.bank))) {
        const br = universe.filter(r => r.bank === bank);
        const vNow = sumAt(br, period, m.field);
        const vRef = sumAt(br, refPeriod, m.field);
        const sNow = dNow > 0 ? (vNow / dNow) * 100 : null;
        const sRef = dRef > 0 ? (vRef / dRef) * 100 : null;
        if (sNow == null || sRef == null) continue;
        ent.push([bank, sRef, sNow, sNow - sRef]);
      }
      ent.sort((a, b) => b[3] - a[3]);
      sheets.push({ name: 'Share Change (pp)',
        rows: [['Bank', `${refPeriod} %`, `${period} %`, 'Δ pp'], ...ent] });
    }
  }

  if (which === 'all') {
    // Share trend (top N over time)
    const denomSeries = series(denominatorRows(allRows, state), state.metric, state.freq);
    const denomMap = new Map(denomSeries.map(d => [d.key, d.value]));
    const sets = topBanks.map(b => {
      const ser = series(allRows.filter(r => r.bank === b), state.metric, state.freq);
      return { name: b, data: ser.map(d => ({ key: d.key, label: d.label,
        value: (denomMap.get(d.key) && d.value != null) ? (d.value / denomMap.get(d.key)) * 100 : null })) };
    });
    const keys = (sets[0]?.data || []).map(d => d.key);
    const labels = (sets[0]?.data || []).map(d => d.label);
    const maps = sets.map(s => new Map(s.data.map(d => [d.key, d.value])));
    sheets.push({ name: 'Share Trend (%)',
      rows: [['Period', ...sets.map(s => s.name)],
        ...keys.map((k, i) => [labels[i], ...maps.map(m => m.get(k))])] });

    // Heatmap data
    const allPeriods = [...new Set(universe.map(r => r.period))].sort();
    const endIdx = allPeriods.indexOf(period);
    const startIdx = Math.max(0, endIdx - _heatmapWindow + 1);
    const periodsWindow = allPeriods.slice(startIdx, endIdx + 1);
    const dN = new Map();
    for (const p of periodsWindow) dN.set(p, sumAt(universe, p, m.field));
    const heatRows = [['Bank', ...periodsWindow]];
    for (const bank of topBanks) {
      const br = universe.filter(r => r.bank === bank);
      const row = [bank, ...periodsWindow.map(p => {
        const num = sumAt(br, p, m.field);
        const den = dN.get(p);
        return den > 0 ? Number(((num / den) * 100).toFixed(4)) : null;
      })];
      heatRows.push(row);
    }
    sheets.push({ name: 'Heatmap', rows: heatRows });
  }

  exportSheets(`market-share_${which}_${stamp}.xlsx`, sheets, currentFilterMeta());
}
