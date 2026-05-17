// Infrastructure Trends tab — On-site / Off-site / Micro ATM analytics.
//   1. Long-term Trend
//   2. Growth / De-growth
//   3. On-site vs Off-site Mix (stacked area)
//   4. Bank/Category Ranking table
// Rules: stock metric, "As on" labels, period-end aggregation.

import { rows, latestPeriod } from '../data.js';
import { getState, subscribe, setState } from '../state.js';
import {
  series, filterRows, denominatorRows, shareSeries,
  growth, rankBanks, metric, METRICS,
  applyView, isPctView, compositionDescription,
} from '../calc.js';
import { exportSheets, currentFilterMeta } from '../export.js';
import { PALETTE, UP, DOWN, FLAT, TOOLTIP_BASE, AXIS_X, AXIS_Y, gradientArea, compactNum, playReplay, latestGlowMarkPoint, PLAY_ICON, STOP_ICON } from '../chartopts.js';

let charts = {};
let _root = null;
let _unsub = null;
let _sortState = { col: 'value', dir: 'desc' };
let _playing = null;

const INFRA_METRICS = ['on_site', 'off_site', 'micro'];

const HTML = `
  <div class="grid">
    <!-- Local sub-toggle so user can pivot within infra metrics quickly -->
    <div class="card accent">
      <div class="card-head">
        <div class="card-head-text">
          <div class="card-title">Infrastructure Trends</div>
          <div class="card-sub">On-site / Off-site / Micro ATMs · period-end values</div>
        </div>
        <div class="card-actions">
          <button class="btn btn-play" data-action="play-trend" title="Replay timeline">${PLAY_ICON}<span>Replay</span></button>
          <div class="mini-toggle" id="infra-metric"></div>
        </div>
      </div>

      <div class="chart tall" id="chart-infra-trend"></div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <div class="card-head">
          <div class="card-head-text">
            <div class="card-title">Growth / De-growth</div>
            <div class="card-sub" id="infra-growth-sub">—</div>
          </div>
          <div class="card-actions">
            <button class="btn" data-export="growth">Export</button>
          </div>
        </div>
        <div class="chart" id="chart-infra-growth"></div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="card-head-text">
            <div class="card-title">On-site vs Off-site Mix</div>
            <div class="card-sub" id="infra-mix-sub">—</div>
          </div>
          <div class="card-actions">
            <div class="mini-toggle" id="infra-mix-mode">
              <button class="active" data-v="abs">Absolute</button>
              <button data-v="pct">Mix %</button>
            </div>
          </div>
        </div>
        <div class="chart" id="chart-infra-mix"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div class="card-head-text">
          <div class="card-title">Bank Ranking · As on Latest</div>
          <div class="card-sub" id="infra-tbl-sub">—</div>
        </div>
        <div class="card-actions">
          <button class="btn primary" data-export="all">Export All to Excel</button>
        </div>
      </div>
      <div class="tbl-wrap" id="infra-tbl"></div>
    </div>
  </div>
`;

let _mixMode = 'abs';   // 'abs' | 'pct'

export function mount(root) {
  _root = root;
  root.innerHTML = HTML;

  // Force a sensible default infra metric on entry
  if (!INFRA_METRICS.includes(getState().metric)) setState({ metric: 'on_site' });

  renderMetricToggle();
  charts.trend  = echarts.init(root.querySelector('#chart-infra-trend'));
  charts.growth = echarts.init(root.querySelector('#chart-infra-growth'));
  charts.mix    = echarts.init(root.querySelector('#chart-infra-mix'));

  window.addEventListener('resize', onResize);
  root.querySelectorAll('[data-export]').forEach(b => b.onclick = () => onExport(b.dataset.export));
  root.querySelector('[data-action="play-trend"]').addEventListener('click', togglePlayTrend);
  root.querySelector('#infra-mix-mode').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-v]'); if (!btn) return;
    _mixMode = btn.dataset.v;
    root.querySelectorAll('#infra-mix-mode button').forEach(b => b.classList.toggle('active', b.dataset.v === _mixMode));
    redraw();
  });

  redraw();
  _unsub = subscribe(() => { stopPlayTrend(); renderMetricToggle(); redraw(); });
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
  const color = PALETTE[0];
  const btn = _root.querySelector('[data-action="play-trend"]');
  btn.classList.add('playing');
  btn.innerHTML = `${STOP_ICON}<span>Stop</span>`;
  _playing = playReplay(charts.trend, {
    seriesData: [values], colors: [color], durationMs: 2500,
    onDone: () => { _playing = null; btn.classList.remove('playing'); btn.innerHTML = `${PLAY_ICON}<span>Replay</span>`; redraw(); },
  });
}

function onResize() { for (const c of Object.values(charts)) c.resize(); }

function renderMetricToggle() {
  const cur = getState().metric;
  _root.querySelector('#infra-metric').innerHTML = INFRA_METRICS.map(k => {
    const m = metric(k);
    return `<button data-k="${k}" class="${cur === k ? 'active' : ''}">${m.short}</button>`;
  }).join('');
  _root.querySelector('#infra-metric').onclick = (e) => {
    const btn = e.target.closest('button[data-k]'); if (!btn) return;
    setState({ metric: btn.dataset.k });
  };
}

function redraw() {
  const state = getState();
  const allRows = rows();
  const filtered = filterRows(allRows, state);

  renderTrend(state, allRows, filtered);
  renderGrowth(state, allRows, filtered);
  renderMix(state, allRows, filtered);
  renderTable(state, allRows, filtered);
}

// ── Long-term Trend ────────────────────────────────────────────────────
function renderTrend(state, allRows, filtered) {
  const m = metric(state.metric);
  let data = series(filtered, state.metric, state.freq);
  data = applyView(data, allRows, state, state.freq, state.metric);
  const isShare = isPctView(state);
  const xs = data.map(d => d.label);
  const ys = data.map(d => d.value);
  const color = PALETTE[0];
  const valFmt = isShare ? (v => v == null ? '—' : v.toFixed(2) + '%') : m.format;
  const valid = ys.filter(v => v != null);
  const mean = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;

  charts.trend.setOption({
    grid: { left: 70, right: 28, top: 24, bottom: 36 },
    tooltip: { ...TOOLTIP_BASE,
      formatter: (params) => `<div style="font-weight:600;margin-bottom:4px">${params[0].axisValue}</div>
        <div style="display:flex;align-items:center;gap:6px">
          <span style="width:8px;height:8px;background:${color};border-radius:50%;display:inline-block"></span>
          ${m.short} (As on): <b>${valFmt(params[0].value)}</b></div>`,
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

// ── Growth ────────────────────────────────────────────────────────────
function renderGrowth(state, allRows, filtered) {
  const m = metric(state.metric);
  const isShareChange = state.growthType === 'ShareChange';
  const useState = (isShareChange && state.view === 'absolute')
    ? { ...state, view: 'share' } : state;
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

  let suffix = '';
  if (isShareChange) suffix = ' (pp, YoY)';
  else if (state.view === 'share') suffix = ' · on market share';
  else if (state.view === 'composition') suffix = ' · on composition %';
  _root.querySelector('#infra-growth-sub').textContent =
    `${m.short} · ${isShareChange ? 'Share Δ' : state.growthType}${suffix}`;

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

// ── Mix chart: stacked area of on-site / off-site (+ micro when available) ─
function renderMix(state, allRows, filtered) {
  const onS = series(filtered, 'on_site', state.freq);
  const offS = series(filtered, 'off_site', state.freq);
  const microS = series(filtered, 'micro', state.freq);

  // Align by key
  const keys = onS.map(d => d.key);
  const labels = onS.map(d => d.label);
  const onMap = new Map(onS.map(d => [d.key, d.value ?? 0]));
  const offMap = new Map(offS.map(d => [d.key, d.value ?? 0]));
  const microMap = new Map(microS.map(d => [d.key, d.value ?? 0]));

  const onVals    = keys.map(k => onMap.get(k));
  const offVals   = keys.map(k => offMap.get(k));
  const microVals = keys.map(k => microMap.get(k));
  const hasMicro  = microVals.some(v => v > 0);

  let onsiteY, offsiteY, microY;
  if (_mixMode === 'pct') {
    const totals = keys.map((_, i) => onVals[i] + offVals[i] + (hasMicro ? microVals[i] : 0));
    onsiteY  = onVals.map((v, i)  => totals[i] > 0 ? (v / totals[i]) * 100 : null);
    offsiteY = offVals.map((v, i) => totals[i] > 0 ? (v / totals[i]) * 100 : null);
    microY   = microVals.map((v, i)=> totals[i] > 0 ? (v / totals[i]) * 100 : null);
  } else {
    onsiteY = onVals; offsiteY = offVals; microY = microVals;
  }

  _root.querySelector('#infra-mix-sub').textContent =
    `${_mixMode === 'pct' ? '100% stacked share' : 'Absolute count'} · ${freqLabel(state.freq)}`;

  const seriesArr = [
    {
      name: 'On-site', type: 'line', stack: 'mix', smooth: true, showSymbol: false,
      lineStyle: { color: PALETTE[0], width: 0 },
      areaStyle: { color: PALETTE[0], opacity: 0.85 },
      data: onsiteY,
    },
    {
      name: 'Off-site', type: 'line', stack: 'mix', smooth: true, showSymbol: false,
      lineStyle: { color: PALETTE[1], width: 0 },
      areaStyle: { color: PALETTE[1], opacity: 0.85 },
      data: offsiteY,
    },
  ];
  if (hasMicro) {
    seriesArr.push({
      name: 'Micro', type: 'line', stack: 'mix', smooth: true, showSymbol: false,
      lineStyle: { color: PALETTE[2], width: 0 },
      areaStyle: { color: PALETTE[2], opacity: 0.85 },
      data: microY,
    });
  }

  charts.mix.setOption({
    grid: { left: 60, right: 16, top: 36, bottom: 44 },
    legend: { top: 4, textStyle: { color: '#334155', fontSize: 11 }, icon: 'roundRect', itemWidth: 10, itemHeight: 6 },
    tooltip: { ...TOOLTIP_BASE,
      formatter: (params) => {
        let html = `<div style="font-weight:600;margin-bottom:4px">${params[0].axisValue}</div>`;
        for (const p of params) {
          if (p.value == null) continue;
          const v = _mixMode === 'pct' ? p.value.toFixed(1) + '%' : compactNum(p.value);
          html += `<div style="display:flex;align-items:center;gap:6px;margin-top:2px">
            <span style="width:8px;height:8px;background:${p.color};border-radius:50%"></span>
            ${p.seriesName}: <b>${v}</b></div>`;
        }
        return html;
      },
    },
    xAxis: { ...AXIS_X, data: labels, boundaryGap: false },
    yAxis: { ...AXIS_Y,
      max: _mixMode === 'pct' ? 100 : undefined,
      axisLabel: { ...AXIS_Y.axisLabel,
        formatter: (v) => _mixMode === 'pct' ? v.toFixed(0) + '%' : compactNum(v) } },
    series: seriesArr,
    animation: true, animationDuration: 600,
  }, true);
}

// ── Table (similar to overview but only infra metrics) ──────────────────
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

  _root.querySelector('#infra-tbl-sub').textContent =
    `${m.label} · As on ${period} · ${enriched.length} banks · growth vs ${refPeriod || '—'} (${state.growthType})`;

  const cols = [
    { id: 'rank',        label: '#',            num: true,  cell: r => `<span class="rank-cell ${r.rank <= 3 ? 'top' : ''}">${r.rank}</span>` },
    { id: 'bank',        label: 'Bank',         num: false, cell: r => r.bank },
    { id: 'category',    label: 'Category',     num: false, cell: r => r.category ? `<span class="chip ${catSlug(r.category)}">${shortCat(r.category)}</span>` : '—' },
    { id: 'value',       label: m.short,        num: true,  cell: r => m.format(r.value) },
    { id: 'growth',      label: state.growthType, num: true, cell: r => deltaCell(r.growth, '%') },
    { id: 'share',       label: 'Share',        num: true,  cell: r => r.share == null ? '—' : r.share.toFixed(2) + '%' },
    { id: 'shareDelta',  label: 'Share Δ',      num: true,  cell: r => deltaCell(r.shareDelta, ' pp') },
  ];

  const wrap = _root.querySelector('#infra-tbl');
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

// ── Shared helpers (mirrors overview.js — local for tab isolation) ──────
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
function shortCat(c) {
  return c.replace(' Sector', '').replace(' Bank', '').replace('Small Finance', 'SFB');
}
function freqLabel(f) { return f === 'M' ? 'Monthly' : f === 'Q' ? 'Quarterly' : 'Yearly'; }

// ── Export ──────────────────────────────────────────────────────────────
function onExport(which) {
  const state = getState();
  const m = metric(state.metric);
  const allRows = rows();
  const filtered = filterRows(allRows, state);
  const stamp = new Date().toISOString().slice(0, 10);
  const sheets = [];

  if (which === 'growth' || which === 'all') {
    const isShareChange = state.growthType === 'ShareChange';
    const useState = (isShareChange && state.view === 'absolute') ? { ...state, view: 'share' } : state;
    let base = series(filtered, state.metric, state.freq);
    base = applyView(base, allRows, useState, state.freq, state.metric);
    let g;
    if (isShareChange) {
      const lookback = state.freq === 'M' ? 12 : state.freq === 'Q' ? 4 : 1;
      g = []; for (let i = 0; i < base.length; i++) {
        if (i < lookback || base[i].value == null || base[i - lookback].value == null) g.push(null);
        else g.push(base[i].value - base[i - lookback].value);
      }
    } else { g = growth(base, state.growthType, state.freq); }
    sheets.push({ name: 'Growth', rows:
      [['Period', isShareChange ? 'Share Δ (pp)' : `${state.growthType} %`],
       ...base.map((d, i) => [d.label, g[i]])] });
  }

  if (which === 'all') {
    let data = series(filtered, state.metric, state.freq);
    data = applyView(data, allRows, state, state.freq, state.metric);
    const trendHeader = state.view === 'share' ? `${m.short} (share %)`
      : state.view === 'composition' ? `${m.short} (composition %)` : m.label;
    sheets.push({ name: 'Trend', rows: [['Period', trendHeader],
      ...data.map(d => [d.label, d.value])] });

    // Mix
    const onS = series(filtered, 'on_site', state.freq);
    const offS = series(filtered, 'off_site', state.freq);
    const microS = series(filtered, 'micro', state.freq);
    const keys = onS.map(d => d.key);
    const labels = onS.map(d => d.label);
    sheets.push({ name: 'Mix',
      rows: [['Period', 'On-site', 'Off-site', 'Micro'],
        ...keys.map((k, i) => [labels[i],
          onS[i]?.value ?? null, offS[i]?.value ?? null, microS[i]?.value ?? null])] });

    // Table
    const period = state.to || latestPeriod();
    const baseRows = state.category === 'all' ? allRows : allRows.filter(r => r.category === state.category);
    const ranked = rankBanks(baseRows, state.metric, period);
    sheets.push({ name: 'Bank Table',
      rows: [['Rank', 'Bank', 'Category', m.label, 'Share %'],
        ...ranked.map((r, i) => [i + 1, r.bank, r.category || '—', r.value, r.share])] });
  }

  exportSheets(`infrastructure_${which}_${stamp}.xlsx`, sheets, currentFilterMeta());
}
