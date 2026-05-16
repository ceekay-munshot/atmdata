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
import { PALETTE, TOOLTIP_BASE, AXIS_X, AXIS_Y, compactNum, UP, DOWN, FLAT } from '../chartopts.js';

let charts = {};
let _root = null;
let _unsub = null;
let _heatmapWindow = 36;   // months
let _topN = 10;

const HTML = `
  <div class="grid">
    <div class="card accent">
      <div class="card-head">
        <div class="card-head-text">
          <div class="card-title">Market Share / Proportionate View</div>
          <div class="card-sub" id="mk-sub">—</div>
        </div>
        <div class="card-actions">
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
            <div class="card-title">Share Change (pp, YoY)</div>
            <div class="card-sub" id="mk-chg-sub">—</div>
          </div>
          <div class="card-actions"><button class="btn" data-export="change">Export</button></div>
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
          <div class="mini-toggle" id="mk-window">
            <button data-v="12">12 m</button>
            <button data-v="24">24 m</button>
            <button class="active" data-v="36">36 m</button>
            <button data-v="60">60 m</button>
          </div>
          <button class="btn primary" data-export="all">Export All to Excel</button>
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

function redraw() {
  const state = getState();
  const allRows = rows();
  const period = state.to || latestPeriod();
  const universe = state.category === 'all' ? allRows : allRows.filter(r => r.category === state.category);

  _root.querySelector('#mk-sub').textContent =
    `${metric(state.metric).label} · share within ${state.category !== 'all' ? state.category : 'industry'}`;

  // Determine top-N banks by latest period
  const ranked = rankBanks(universe, state.metric, period).slice(0, _topN);
  const topBanks = ranked.map(r => r.bank);

  renderTrend(state, allRows, universe, topBanks);
  renderChange(state, allRows, universe, period, topBanks);
  renderMovers(state, allRows, universe, period);
  renderHeatmap(state, universe, period, topBanks);
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
  const ss = sets.map((s, i) => ({
    name: s.name,
    type: 'line', smooth: 0.4, showSymbol: false,
    lineStyle: { width: 2, color: PALETTE[i % PALETTE.length] },
    itemStyle: { color: PALETTE[i % PALETTE.length] },
    emphasis: { focus: 'series', lineStyle: { width: 3 } },
    data: s.data.map(d => d.value),
    endLabel: { show: true, color: PALETTE[i % PALETTE.length], fontWeight: 600, fontSize: 11,
      formatter: (p) => p.value == null ? '' : ' ' + p.value.toFixed(1) + '%' },
  }));

  charts.trend.setOption({
    grid: { left: 60, right: 80, top: 44, bottom: 44 },
    legend: { top: 4, textStyle: { color: '#334155', fontSize: 11 }, icon: 'roundRect', itemWidth: 10, itemHeight: 6 },
    tooltip: { ...TOOLTIP_BASE,
      formatter: (params) => {
        let html = `<div style="font-weight:600;margin-bottom:4px">${params[0].axisValue}</div>`;
        for (const p of params.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity))) {
          if (p.value == null) continue;
          html += `<div style="display:flex;align-items:center;gap:6px;margin-top:2px">
            <span style="width:8px;height:8px;background:${p.color};border-radius:50%"></span>
            ${truncate(p.seriesName, 22)}: <b>${p.value.toFixed(2)}%</b></div>`;
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

// ── 2. Share Change (pp, YoY) — single bar per bank ────────────────────
function renderChange(state, allRows, universe, period, topBanks) {
  const m = metric(state.metric);
  const refPeriod = referencePeriod(period, 'YoY', state.freq);
  const denom = denominatorRows(allRows, state);

  if (!refPeriod) {
    setEmpty(charts.change, 'Not enough history for YoY share change.');
    _root.querySelector('#mk-chg-sub').textContent = 'YoY reference unavailable';
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
      axisLabel: { color: '#64748b', fontSize: 11, formatter: (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' pp' },
      axisLine: { show: false }, splitLine: { lineStyle: { color: '#e3e6ec', type: 'dashed' } } },
    yAxis: { type: 'category', data: xs,
      axisLabel: { color: '#334155', fontSize: 11, fontWeight: 500,
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
  const refPeriod = referencePeriod(period, 'YoY', state.freq);
  if (!refPeriod) {
    _root.querySelector('#mk-mov-sub').textContent = 'YoY reference unavailable';
    _root.querySelector('#mk-movers').innerHTML = '<div class="empty"><div class="empty-title">No data</div><div class="empty-sub">Not enough history for YoY comparison.</div></div>';
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

// ── 4. Heatmap (bank × time → share %) ─────────────────────────────────
function renderHeatmap(state, universe, period, topBanks) {
  const m = metric(state.metric);
  // Determine month range: last _heatmapWindow months ending at `period`
  const allPeriods = [...new Set(universe.map(r => r.period))].sort();
  const endIdx = allPeriods.indexOf(period);
  if (endIdx < 0) { setEmpty(charts.heat, 'No data'); return; }
  const startIdx = Math.max(0, endIdx - _heatmapWindow + 1);
  const periodsWindow = allPeriods.slice(startIdx, endIdx + 1);

  // Need denominator at each window period
  const dN = new Map();
  for (const p of periodsWindow) dN.set(p, sumAt(universe, p, m.field));

  // Values: [xIdx, yIdx, value]
  const ys = topBanks;
  const data = [];
  let maxV = 0;
  for (let yi = 0; yi < ys.length; yi++) {
    const bank = ys[yi];
    const br = universe.filter(r => r.bank === bank);
    for (let xi = 0; xi < periodsWindow.length; xi++) {
      const p = periodsWindow[xi];
      const num = sumAt(br, p, m.field);
      const den = dN.get(p);
      const share = den > 0 ? (num / den) * 100 : null;
      data.push([xi, yi, share == null ? '-' : Number(share.toFixed(2))]);
      if (share != null && share > maxV) maxV = share;
    }
  }

  _root.querySelector('#mk-heat-sub').textContent =
    `Top ${ys.length} banks · last ${periodsWindow.length} months · share % within ${state.category !== 'all' ? state.category : 'industry'}`;

  charts.heat.setOption({
    grid: { left: 170, right: 30, top: 20, bottom: 70 },
    tooltip: { ...TOOLTIP_BASE, trigger: 'item',
      formatter: (p) => {
        const [xi, yi, v] = p.data;
        return `<div style="font-weight:600;margin-bottom:4px">${ys[yi]}</div>
                <div>${periodLabel(periodsWindow[xi])}: <b>${v === '-' ? '—' : v + '%'}</b></div>`;
      },
    },
    xAxis: { type: 'category', data: periodsWindow.map(periodLabel),
      axisLine: { lineStyle: { color: '#cbd2dc' } },
      axisLabel: { color: '#64748b', fontSize: 10, interval: Math.ceil(periodsWindow.length / 18) - 1, rotate: 0 },
      axisTick: { show: false },
      splitArea: { show: false } },
    yAxis: { type: 'category', data: ys,
      axisLine: { show: false }, axisTick: { show: false },
      axisLabel: { color: '#334155', fontSize: 11, fontWeight: 500,
        formatter: (v) => v.length > 22 ? v.slice(0, 21) + '…' : v },
      splitArea: { show: false } },
    visualMap: {
      min: 0, max: Math.max(1, Math.ceil(maxV)),
      orient: 'horizontal', left: 'center', bottom: 6,
      itemWidth: 14, itemHeight: 8,
      textStyle: { color: '#64748b', fontSize: 10 },
      inRange: { color: ['#eef2ff', '#c7d2fe', '#818cf8', '#6366f1', '#4f46e5', '#3730a3'] },
    },
    series: [{
      type: 'heatmap', data,
      label: { show: false },
      emphasis: { itemStyle: { shadowBlur: 6, shadowColor: 'rgba(15,23,42,0.25)' } },
      progressive: 1000, animation: true,
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
    const refPeriod = referencePeriod(period, 'YoY', state.freq);
    if (refPeriod) {
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
