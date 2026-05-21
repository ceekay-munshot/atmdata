// Infrastructure Trends tab — On-site / Off-site / Micro ATM analytics.
//   1. Long-term Trend
//   2. Growth / De-growth
//   3. On-site vs Off-site Mix (stacked area)
//   4. Bank/Category Ranking table
// Rules: stock metric, "As on" labels, period-end aggregation.

import { rows, latestPeriod } from '../data.js';
import { getState, subscribe, setState } from '../state.js';
import {
  series, filterRows, denominatorRows, shareSeries, netAdds,
  growth, rankBanks, metric, METRICS, fmtWithUnit,
  applyView, isPctView, compositionDescription,
  tableGrowthColumns, refPeriodMonthly, computeGrowthPct,
} from '../calc.js';
import { exportSheets, currentFilterMeta } from '../export.js';
import { PALETTE, UP, DOWN, FLAT, TOOLTIP_BASE, AXIS_X, AXIS_Y, gradientArea, gradientBar, compactNum, playReplay, latestGlowMarkPoint, PLAY_ICON, STOP_ICON, EXCEL_ICON, setEmptyChart, softLineStyle } from '../chartopts.js';
import { findChartAnnotations } from '../annotations.js';

let charts = {};
let _root = null;
let _unsub = null;
let _sortState = { col: 'value', dir: 'desc' };
let _tableShowAll = false;
let _tableMode = 'growth';     // 'growth' | 'cagr'
let _tableFreq = 'M';          // 'M' | 'Y'
let _growthMode = 'pct';       // 'pct' | 'adds' — Growth chart: % growth vs net adds
let _trendChart = 'line';      // 'line' | 'bar' — Infrastructure Trends chart style
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
          <div class="mini-toggle" id="infra-trend-chart" title="Chart style">
            <button class="active" data-v="line">Line</button>
            <button data-v="bar">Bar</button>
          </div>
          <button class="btn-icon btn-icon-play" data-action="play-trend" title="Replay timeline">${PLAY_ICON}</button>
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
            <div class="mini-toggle" id="infra-growth-mode" title="Percentage change vs absolute units added">
              <button class="active" data-v="pct">% Growth</button>
              <button data-v="adds">Net Adds</button>
            </div>
            <div class="mini-toggle" id="infra-growth-type" title="Reference window for the growth bars">
              <button data-v="MoM">MoM</button>
              <button data-v="3M">3M</button>
              <button class="active" data-v="YoY">YoY</button>
            </div>
            <button class="btn-icon" data-export="growth" title="Export to Excel">${EXCEL_ICON}</button>
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
          <div class="mini-toggle" id="infra-table-mode" title="Growth = simple % change. CAGR = annualised growth rate.">
            <button class="active" data-v="growth">Growth</button>
            <button data-v="cagr">CAGR</button>
          </div>
          <div class="mini-toggle" id="infra-table-freq" title="Window scale for the growth columns">
            <button class="active" data-v="M">Monthly</button>
            <button data-v="Y">Yearly</button>
          </div>
          <button class="btn-icon primary" data-export="all" title="Export to Excel">${EXCEL_ICON}</button>
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
  root.querySelector('#infra-table-mode').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    _tableMode = b.dataset.v;
    root.querySelectorAll('#infra-table-mode button').forEach(x => x.classList.toggle('active', x.dataset.v === b.dataset.v));
    redraw();
  });
  root.querySelector('#infra-table-freq').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]'); if (!b || b.disabled) return;
    _tableFreq = b.dataset.v;
    root.querySelectorAll('#infra-table-freq button').forEach(x => x.classList.toggle('active', x.dataset.v === b.dataset.v));
    redraw();
  });

  const syncGrowthBtns = () => {
    const cur = getState().growthType;
    root.querySelectorAll('#infra-growth-type button').forEach(b => b.classList.toggle('active', b.dataset.v === cur));
  };
  syncGrowthBtns();
  root.querySelector('#infra-growth-type').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    root.querySelectorAll('#infra-growth-type button').forEach(x => x.classList.toggle('active', x === b));
    setState({ growthType: b.dataset.v });
  });

  root.querySelector('#infra-growth-mode').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    _growthMode = b.dataset.v;
    root.querySelectorAll('#infra-growth-mode button').forEach(x => x.classList.toggle('active', x === b));
    redraw();
  });

  root.querySelector('#infra-trend-chart').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    _trendChart = b.dataset.v;
    root.querySelectorAll('#infra-trend-chart button').forEach(x => x.classList.toggle('active', x === b));
    redraw();
  });

  redraw();
  _unsub = subscribe(() => { stopPlayTrend(); renderMetricToggle(); syncGrowthBtns(); redraw(); });
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
  const state = getState();
  const m = metric(state.metric);
  const allRows = rows();
  const filtered = filterRows(allRows, state);
  let data = series(filtered, state.metric, state.freq);
  data = applyView(data, allRows, state, state.freq, state.metric);
  const values = data.map(d => d.value);
  const color = PALETTE[0];
  const btn = _root.querySelector('[data-action="play-trend"]');
  btn.classList.add('playing');
  btn.innerHTML = STOP_ICON;
  const fmt = (state.view === 'share' || state.view === 'composition')
    ? (v) => v.toFixed(1) + '%'
    : (v) => fmtWithUnit(m, v);
  _playing = playReplay(charts.trend, {
    seriesData: [values], colors: [color], durationMs: 2500, formatVal: fmt,
    onDone: () => { _playing = null; btn.classList.remove('playing'); btn.innerHTML = PLAY_ICON; redraw(); },
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
  const valFmt = isShare
    ? (v => v == null ? '—' : v.toFixed(2) + '%')
    : (v => v == null ? '—' : fmtWithUnit(m, v));
  const valid = ys.filter(v => v != null);
  const mean = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;

  if (!data.length || valid.length === 0) {
    const bankNote = state.banks && state.banks.length
      ? `${state.banks[0]} has no recorded ${m.short} in the selected range`
      : 'No values recorded for this combination in the selected range';
    setEmptyChart(charts.trend, 'No data', bankNote);
    return;
  }
  // All zero (vs all null) — bank exists but reports nothing for this metric.
  // E.g. Aditya Birla Idea Payments Bank reporting 0 on-site ATMs.
  if (valid.every(v => v === 0)) {
    setEmptyChart(charts.trend, 'No reported activity', zeroExplanation(filtered, state, m));
    return;
  }

  // Annotations / spike markers — only in absolute view (share view % is
  // hard to interpret without context)
  const annotMarks = (!isShare) ? findChartAnnotations(data, {
    bank: state.banks && state.banks.length === 1 ? state.banks[0] : null,
    metric: state.metric === 'on_site' ? 'on_site_atms'
          : state.metric === 'off_site' ? 'off_site_atms'
          : state.metric === 'micro' ? 'micro_atms' : state.metric,
    isStock: m.isStock,
    freq: state.freq,
    formatVal: m.format,
  }) : [];

  const latestGlow = latestGlowMarkPoint(xs, ys, color);
  const allMarks = [...(latestGlow.data || []), ...annotMarks];

  charts.trend.setOption({
    grid: { left: 70, right: 28, top: 24, bottom: 36 },
    tooltip: { ...TOOLTIP_BASE, confine: true,
      formatter: (params) => {
        // markPoint hover → show annotation
        if (params.componentType === 'markPoint' && params.data && params.data._annotation) {
          return `<div style="width:300px;line-height:1.5;white-space:normal;word-wrap:break-word">${params.data._annotation}</div>`;
        }
        // line series hover → standard tooltip
        const p = Array.isArray(params) ? params[0] : params;
        return `<div style="font-weight:600;margin-bottom:4px">${p.axisValue ?? p.name}</div>
                <div style="display:flex;align-items:center;gap:6px">
                  <span style="width:8px;height:8px;background:${color};border-radius:50%;display:inline-block"></span>
                  ${m.short} (As on): <b>${valFmt(p.value)}</b></div>`;
      },
    },
    xAxis: { ...AXIS_X, data: xs, boundaryGap: _trendChart === 'bar' },
    yAxis: { ...AXIS_Y, axisLabel: { ...AXIS_Y.axisLabel,
      formatter: (v) => isShare ? v.toFixed(1) + '%' : compactNum(v) } },
    series: [{
      ...(_trendChart === 'bar'
        ? { type: 'bar', barMaxWidth: 16,
            itemStyle: { color: gradientBar(color), borderRadius: [3, 3, 0, 0] } }
        : { type: 'line', smooth: true, showSymbol: false,
            lineStyle: softLineStyle(color, 2.6),
            areaStyle: { color: gradientArea(color) } }),
      markLine: mean != null ? {
        symbol: 'none', silent: true,
        lineStyle: { color: '#94a3b8', type: 'dashed', width: 1 },
        label: {
          color: '#64748b', fontSize: 10, fontWeight: 600,
          position: 'insideStartTop', distance: 4,
          backgroundColor: 'rgba(255,255,255,0.92)',
          padding: [3, 7], borderRadius: 6,
          borderColor: '#e3e6ec', borderWidth: 1,
          formatter: 'avg ' + (isShare ? mean.toFixed(2) + '%' : compactNum(mean)),
        },
        data: [{ yAxis: mean }],
      } : undefined,
      markPoint: { ...latestGlow,
        data: allMarks,
        tooltip: {
          trigger: 'item', confine: true,
          backgroundColor: 'rgba(15,23,42,0.94)', borderWidth: 0, borderRadius: 10,
          padding: [11, 14],
          textStyle: { color: '#fff', fontSize: 12, fontFamily: 'Inter, sans-serif', fontWeight: 500 },
          extraCssText: 'box-shadow: 0 12px 32px rgba(15,23,42,0.22); border-radius: 10px; max-width: 320px;',
          formatter: (params) => params.data && params.data._annotation
            ? `<div style="width:300px;line-height:1.5;white-space:normal;word-wrap:break-word">${params.data._annotation}</div>`
            : '',
        },
      },
      data: ys,
    }],
    animation: true, animationDuration: 600,
  }, true);
}

// ── Growth ────────────────────────────────────────────────────────────
function renderGrowth(state, allRows, filtered) {
  const m = metric(state.metric);
  const isAdds = _growthMode === 'adds';
  const isShareChange = !isAdds && state.growthType === 'ShareChange';
  const useState = (isShareChange && state.view === 'absolute')
    ? { ...state, view: 'share' } : state;

  let base, gArr, units, tipFmt;
  if (isAdds) {
    base = series(filtered, state.metric, state.freq);
    const win = state.growthType === 'ShareChange' ? 'YoY' : state.growthType;
    gArr = netAdds(base, win, state.freq);
    tipFmt = (v) => (v > 0 ? '+' : '') + fmtWithUnit(m, v);
  } else {
    base = series(filtered, state.metric, state.freq);
    base = applyView(base, allRows, useState, state.freq, state.metric);
    if (isShareChange) {
      const lookback = state.freq === 'M' ? 12 : state.freq === 'Q' ? 4 : 1;
      gArr = []; for (let i = 0; i < base.length; i++) {
        if (i < lookback || base[i].value == null || base[i - lookback].value == null) gArr.push(null);
        else gArr.push(base[i].value - base[i - lookback].value);
      }
      units = 'pp';
      tipFmt = (v) => (v > 0 ? '+' : '') + v.toFixed(2) + ' pp';
    } else {
      gArr = growth(base, state.growthType, state.freq);
      units = '%';
      tipFmt = (v) => (v > 0 ? '+' : '') + v.toFixed(2) + '%';
    }
  }

  let suffix = '';
  if (isShareChange) suffix = ' (pp, YoY)';
  else if (!isAdds && state.view === 'share') suffix = ' · on market share';
  else if (!isAdds && state.view === 'composition') suffix = ' · on composition %';
  const winLabel = state.growthType === 'ShareChange' ? 'YoY' : state.growthType;
  _root.querySelector('#infra-growth-sub').textContent = isAdds
    ? `${m.short} · Net adds · ${winLabel} window`
    : `${m.short} · ${isShareChange ? 'Share Δ' : state.growthType}${suffix}`;

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
  const gMax = Math.max(0, ...gArr.filter(v => v != null).map(v => Math.abs(v)));
  const gDec = gMax >= 10 ? 0 : gMax >= 1 ? 1 : 2;

  charts.growth.setOption({
    grid: { left: 60, right: 16, top: 24, bottom: 44 },
    tooltip: { ...TOOLTIP_BASE,
      formatter: (params) => {
        const p = params[0]; const v = p.value;
        const c = v == null ? '#94a3b8' : v > 0 ? UP : v < 0 ? DOWN : FLAT;
        return `<div style="font-weight:600;margin-bottom:4px">${p.axisValue}</div>
                <div style="display:flex;align-items:center;gap:6px">
                  <span style="width:8px;height:8px;background:${c};border-radius:50%"></span>
                  ${isAdds ? 'Net adds' : (isShareChange ? 'Share Δ' : state.growthType)}: <b>${v == null ? '—' : tipFmt(v)}</b></div>`;
      },
    },
    xAxis: { ...AXIS_X, data: xs },
    yAxis: { ...AXIS_Y, axisLabel: { ...AXIS_Y.axisLabel,
      formatter: (v) => isAdds ? compactNum(v) : v.toFixed(gDec) + units } },
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

  // Missing periods → 0 (Micro ATMs were only reported from ~2020; treating
  // pre-2020 micro as undefined would poison the Mix-% total to NaN and blank
  // the whole pre-2020 range).
  const onVals    = keys.map(k => onMap.get(k) ?? 0);
  const offVals   = keys.map(k => offMap.get(k) ?? 0);
  const microVals = keys.map(k => microMap.get(k) ?? 0);
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
    `${_mixMode === 'pct' ? '100% stacked share' : 'Absolute count'} · ${freqLabel(state.freq)}` +
    (hasMicro && _mixMode !== 'pct' ? '  ·  Micro ATMs (biometric/POS) dwarf classic on/off-site fleets post-2020' : '');

  // Distinct colors so legend dots can't be confused for adjacent stack bands:
  // indigo (On-site) → amber (Off-site) → emerald (Micro)
  const MIX_COLORS = { on: '#4f46e5', off: '#f59e0b', micro: '#10b981' };
  const seriesArr = [
    {
      name: 'On-site', type: 'line', stack: 'mix', smooth: true, showSymbol: false,
      lineStyle: { color: MIX_COLORS.on, width: 0 },
      itemStyle: { color: MIX_COLORS.on },
      areaStyle: { color: MIX_COLORS.on, opacity: 0.85 },
      data: onsiteY,
    },
    {
      name: 'Off-site', type: 'line', stack: 'mix', smooth: true, showSymbol: false,
      lineStyle: { color: MIX_COLORS.off, width: 0 },
      itemStyle: { color: MIX_COLORS.off },
      areaStyle: { color: MIX_COLORS.off, opacity: 0.85 },
      data: offsiteY,
    },
  ];
  if (hasMicro) {
    seriesArr.push({
      name: 'Micro', type: 'line', stack: 'mix', smooth: true, showSymbol: false,
      lineStyle: { color: MIX_COLORS.micro, width: 0 },
      itemStyle: { color: MIX_COLORS.micro },
      areaStyle: { color: MIX_COLORS.micro, opacity: 0.85 },
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
          const v = _mixMode === 'pct'
            ? p.value.toFixed(1) + '%'
            : p.value.toLocaleString('en-IN') + ' ATMs';
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

// ── Table (Growth/CAGR × Monthly/Yearly) ────────────────────────────────
function renderTable(state, allRows) {
  const m = metric(state.metric);
  const period = state.to || latestPeriod();
  const baseRows = state.category === 'all' ? allRows : allRows.filter(r => r.category === state.category);
  const ranked = rankBanks(baseRows, state.metric, period);

  const growthCols = tableGrowthColumns(_tableMode, _tableFreq);
  const refByMonths = new Map();
  for (const c of growthCols) {
    const rp = refPeriodMonthly(period, c.months);
    const bankMap = new Map();
    if (rp) {
      for (const r of baseRows) {
        if (r.period !== rp) continue;
        const v = r[m.field];
        if (v == null) continue;
        bankMap.set(r.bank, (bankMap.get(r.bank) ?? 0) + v);
      }
    }
    const total = [...bankMap.values()].reduce((s, v) => s + v, 0);
    refByMonths.set(c.months, { ref: rp, bankMap, total });
  }
  const refShareInfo = refByMonths.get(12) || refByMonths.get(36) || refByMonths.get(60) || refByMonths.get(3);

  const enriched = ranked.map((r, i) => {
    const row = { ...r, rank: i + 1 };
    for (const c of growthCols) {
      const info = refByMonths.get(c.months);
      const refRaw = info.bankMap.get(r.bank);
      const refDisp = refRaw == null ? null : m.transform(refRaw);
      row[c.id] = computeGrowthPct(r.value, refDisp, c.months, c.cagr);
    }
    if (refShareInfo) {
      const refRaw = refShareInfo.bankMap.get(r.bank);
      const refShare = (refRaw != null && refShareInfo.total > 0) ? (refRaw / refShareInfo.total) * 100 : null;
      row.shareDelta = (refShare != null && r.share != null) ? r.share - refShare : null;
    } else {
      row.shareDelta = null;
    }
    return row;
  });
  const sorted = sortRows(enriched, _sortState);

  const refLabel = growthCols.length
    ? `${_tableMode === 'cagr' ? 'CAGR' : 'growth'} vs ${growthCols.map(c => refPeriodMonthly(period, c.months)).filter(Boolean).join(', ')}`
    : '';
  _root.querySelector('#infra-tbl-sub').textContent =
    `${m.label} · As on ${period} · ${enriched.length} banks · ${refLabel}`;

  const cols = [
    { id: 'rank',       label: '#',         num: true,  cell: r => `<span class="rank-cell ${r.rank <= 3 ? 'top' : ''}">${r.rank}</span>` },
    { id: 'bank',       label: 'Bank',      num: false, cell: r => r.bank },
    { id: 'category',   label: 'Category',  num: false, cell: r => r.category ? `<span class="chip ${catSlug(r.category)}">${shortCat(r.category)}</span>` : '—' },
    { id: 'value',      label: m.short,     num: true,  cell: r => m.format(r.value) },
    ...growthCols.map(c => ({ id: c.id, label: c.label, num: true, cell: r => deltaCell(r[c.id], '%') })),
    { id: 'share',      label: 'Share',     num: true,  cell: r => r.share == null ? '—' : r.share.toFixed(2) + '%' },
    { id: 'shareDelta', label: 'Share Δ',   num: true,  cell: r => deltaCell(r.shareDelta, ' pp') },
  ];

  const visible = _tableShowAll ? sorted : sorted.slice(0, 10);
  const moreNote = sorted.length > 10
    ? `<div class="tbl-foot">
         <button class="btn btn-toggle-more" id="infra-table-more">
           ${_tableShowAll ? 'Show top 10' : `Show all ${sorted.length}`}
         </button>
         <span class="tbl-foot-note">${_tableShowAll ? 'Showing all banks' : `Showing top 10 of ${sorted.length}`}</span>
       </div>` : '';

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
      <tbody>${visible.map(r => `<tr>${cols.map(c => `<td class="${c.num ? 'num' : ''}">${c.cell(r)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>${moreNote}`;
  wrap.querySelectorAll('thead th.sortable').forEach(th => {
    th.onclick = () => {
      const col = th.dataset.col;
      _sortState.dir = (_sortState.col === col && _sortState.dir === 'desc') ? 'asc' : 'desc';
      _sortState.col = col;
      renderTable(state, allRows);
    };
  });
  const mb = wrap.querySelector('#infra-table-more');
  if (mb) mb.onclick = () => { _tableShowAll = !_tableShowAll; renderTable(state, allRows); };
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

// Context-aware "why all zero" message. Looks at the bank's category in the
// filtered rows + the metric to pick the right explanation.
function zeroExplanation(filteredRowsArr, state, m) {
  const bank = state.banks && state.banks.length === 1 ? state.banks[0] : null;
  const sample = filteredRowsArr.find(r => r.category);
  const category = sample ? sample.category : null;
  const metricLbl = m.short.toLowerCase();
  const isAtmStock = ['on_site', 'off_site'].includes(state.metric);
  const isMicro    = state.metric === 'micro';
  const isCard     = state.metric.startsWith('dc_') || state.metric.startsWith('cc_');
  const isCredit   = state.metric.startsWith('cc_');

  let reason = 'RBI source data matches — this metric was reported as zero throughout.';
  if (category === 'Payment Bank' && isAtmStock) {
    reason = "Payments Banks operate as digital-first and typically don't run physical ATM infrastructure.";
  } else if (category === 'Payment Bank' && isCredit) {
    reason = 'Payments Banks are not authorised by RBI to issue credit cards.';
  } else if (isMicro && state.from && state.from < '2020-06') {
    reason = 'Micro ATMs only began appearing in RBI’s monthly statistics from mid-2020. Earlier rows are typically zero.';
  } else if (category === 'Foreign Bank' && isAtmStock) {
    reason = 'Some Foreign Banks have minimal retail/ATM presence in India and report zero ATMs.';
  }
  const who = bank ? bank : 'This selection';
  return `${who} reported 0 ${metricLbl} throughout the selected range. ${reason}`;
}

// ── Export ──────────────────────────────────────────────────────────────
function onExport(which) {
  const state = getState();
  const m = metric(state.metric);
  const allRows = rows();
  const filtered = filterRows(allRows, state);
  const stamp = new Date().toISOString().slice(0, 10);
  const sheets = [];

  if (which === 'growth' || which === 'all') {
    if (_growthMode === 'adds') {
      const base = series(filtered, state.metric, state.freq);
      const win = state.growthType === 'ShareChange' ? 'YoY' : state.growthType;
      const g = netAdds(base, win, state.freq);
      sheets.push({ name: 'Net Adds', rows:
        [['Period', `Net adds (${win}, ${m.unitShort || 'units'})`],
         ...base.map((d, i) => [d.label, g[i]])] });
    } else {
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
