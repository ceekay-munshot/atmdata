// Overview tab — 4 hero visuals + bottom bank-wise table.
//   1. Long-term Trend (full width hero)
//   2. Growth / De-growth (responds to Growth Type toggle)
//   3. Bank Ranking (top banks for latest period)
//   4. Market Share Movement (top banks share over time, or single bank if filtered)
//   + Bottom data table: bank-wise latest-period view (Value / Growth / Share / Δpp / Rank)
//
// Every chart and the table respond to ALL global filters/toggles via subscribe().

import { rows, manifest, allBanks, banksInCategory, latestPeriod } from '../data.js';
import { getState, subscribe } from '../state.js';
import {
  series, filterRows, denominatorRows, shareSeries, shareChange,
  growth, rankBanks, metric, fmtCr, fmtInt, fmtPct, fmtPP,
  applyView, isPctView, viewLabelShort, compositionDescription,
  tableGrowthColumns, refPeriodMonthly, computeGrowthPct,
} from '../calc.js';
import { exportSheets, currentFilterMeta } from '../export.js';
import { PALETTE, UP, DOWN, FLAT, TOOLTIP_BASE, AXIS_X, AXIS_Y, gradientArea, compactNum, playReplay, latestGlowMarkPoint, PLAY_ICON, STOP_ICON, setEmptyChart, softLineStyle } from '../chartopts.js';
import { findChartAnnotations } from '../annotations.js';

// Metric key → field name used to look up curated annotations
const METRIC_FIELD = {
  on_site: 'on_site_atms', off_site: 'off_site_atms', micro: 'micro_atms',
  dc_vol: 'dc_vol', dc_val_cr: 'dc_val_thousands',
  cc_vol: 'cc_vol', cc_val_cr: 'cc_val_thousands',
};

let charts = {};      // id → ECharts instance
let _root = null;
let _unsub = null;
let _sortState = { col: 'value', dir: 'desc' };  // for bottom table
let _tableShowAll = false;
let _tableMode = 'growth';     // 'growth' | 'cagr'
let _tableFreq = 'M';          // 'M' | 'Q' | 'Y' (Q/Y land in a follow-up)
let _playing = null;  // active replay handle (for the trend chart)

const HTML = `
  <div class="grid">
    <!-- HERO: Long-term Trend -->
    <div class="card accent" id="card-trend">
      <div class="card-head">
        <div class="card-head-text">
          <div class="card-title">Long-term Trend</div>
          <div class="card-sub" id="trend-sub">—</div>
        </div>
        <div class="card-actions">
          <button class="btn btn-play" data-action="play-trend" title="Replay timeline">${PLAY_ICON}<span>Replay</span></button>
          <button class="btn" data-export="trend">Export</button>
        </div>
      </div>
      <div class="chart tall" id="chart-trend"></div>
    </div>

    <!-- ROW 2: Growth + Ranking -->
    <div class="grid grid-2">
      <div class="card" id="card-growth">
        <div class="card-head">
          <div class="card-head-text">
            <div class="card-title">Growth / De-growth</div>
            <div class="card-sub" id="growth-sub">—</div>
          </div>
          <div class="card-actions">
            <button class="btn" data-export="growth">Export</button>
          </div>
        </div>
        <div class="chart" id="chart-growth"></div>
      </div>

      <div class="card" id="card-rank">
        <div class="card-head">
          <div class="card-head-text">
            <div class="card-title">Bank Ranking</div>
            <div class="card-sub" id="rank-sub">—</div>
          </div>
          <div class="card-actions">
            <button class="btn" data-export="rank">Export</button>
          </div>
        </div>
        <div class="chart" id="chart-rank"></div>
      </div>
    </div>

    <!-- ROW 3: Market Share Movement -->
    <div class="card" id="card-share">
      <div class="card-head">
        <div class="card-head-text">
          <div class="card-title">Market Share Movement</div>
          <div class="card-sub" id="share-sub">—</div>
        </div>
        <div class="card-actions">
          <button class="btn" data-export="share">Export</button>
        </div>
      </div>
      <div class="chart" id="chart-share"></div>
    </div>

    <!-- BOTTOM: Bank-wise table -->
    <div class="card" id="card-table">
      <div class="card-head">
        <div class="card-head-text">
          <div class="card-title">Bank-wise Latest Period</div>
          <div class="card-sub" id="table-sub">—</div>
        </div>
        <div class="card-actions">
          <div class="mini-toggle" id="ov-table-mode" title="Growth = simple % change. CAGR = annualised growth rate.">
            <button class="active" data-v="growth">Growth</button>
            <button data-v="cagr">CAGR</button>
          </div>
          <div class="mini-toggle" id="ov-table-freq" title="Window scale for the growth columns">
            <button class="active" data-v="M">Monthly</button>
            <button data-v="Y">Yearly</button>
          </div>
          <button class="btn primary" data-export="all">Export All to Excel</button>
        </div>
      </div>
      <div class="tbl-wrap" id="table-wrap"></div>
    </div>
  </div>
`;

export function mount(root) {
  _root = root;
  root.innerHTML = HTML;

  charts.trend  = echarts.init(root.querySelector('#chart-trend'));
  charts.growth = echarts.init(root.querySelector('#chart-growth'));
  charts.rank   = echarts.init(root.querySelector('#chart-rank'));
  charts.share  = echarts.init(root.querySelector('#chart-share'));

  window.addEventListener('resize', onResize);

  // Export buttons
  root.querySelectorAll('[data-export]').forEach(btn => {
    btn.addEventListener('click', () => onExport(btn.dataset.export));
  });

  // Replay button on the hero trend chart
  root.querySelector('[data-action="play-trend"]').addEventListener('click', togglePlayTrend);

  // Table-local toggles (Growth / CAGR + Monthly / Q / Y)
  root.querySelector('#ov-table-mode').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    _tableMode = b.dataset.v;
    root.querySelectorAll('#ov-table-mode button').forEach(x => x.classList.toggle('active', x.dataset.v === b.dataset.v));
    redraw();
  });
  root.querySelector('#ov-table-freq').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]'); if (!b || b.disabled) return;
    _tableFreq = b.dataset.v;
    root.querySelectorAll('#ov-table-freq button').forEach(x => x.classList.toggle('active', x.dataset.v === b.dataset.v));
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
  if (btn) { btn.classList.remove('playing'); btn.innerHTML = `${PLAY_ICON}<span>Replay</span>`; }
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
  btn.innerHTML = `${STOP_ICON}<span>Stop</span>`;
  const fmt = (state.view === 'share' || state.view === 'composition') ? (v) => v.toFixed(1) + '%' : m.format;
  _playing = playReplay(charts.trend, {
    seriesData: [values], colors: [color], durationMs: 2500, formatVal: fmt,
    onDone: () => { _playing = null; btn.classList.remove('playing'); btn.innerHTML = `${PLAY_ICON}<span>Replay</span>`; redraw(); },
  });
}

function onResize() { for (const c of Object.values(charts)) c.resize(); }

// ── Master redraw ────────────────────────────────────────────────────────
function redraw() {
  const state = getState();
  const allRows = rows();
  const filtered = filterRows(allRows, state);

  renderTrend(state, allRows, filtered);
  renderGrowth(state, allRows, filtered);
  renderRank(state, allRows, filtered);
  renderShare(state, allRows, filtered);
  renderTable(state, allRows, filtered);
}

// ── 1. Long-term Trend ──────────────────────────────────────────────────
function renderTrend(state, allRows, filtered) {
  const m = metric(state.metric);
  let data = series(filtered, state.metric, state.freq);
  data = applyView(data, allRows, state, state.freq, state.metric);
  const isShare = isPctView(state);

  let subSuffix = '';
  if (state.view === 'share') subSuffix = ' · Market share';
  else if (state.view === 'composition') subSuffix = ` · ${compositionDescription(state.metric)}`;
  _root.querySelector('#trend-sub').textContent =
    `${m.label} · ${freqLabel(state.freq)} · ${m.isStock ? 'As on period-end' : 'For the period'}${subSuffix}`;

  // Empty-state handling: bank picked but metric never reported (e.g.
  // Allahabad Bank merged in 2020, Micro ATMs only reported since 2020 —
  // intersection is empty).
  if (!data.length || data.every(d => d.value == null)) {
    const bankNote = state.banks && state.banks.length
      ? `${state.banks[0]} has no recorded ${m.short} in the selected range`
      : 'No values recorded for this combination in the selected range';
    setEmptyChart(charts.trend, 'No data', bankNote);
    return;
  }

  const xs = data.map(d => d.label);
  const ys = data.map(d => d.value);
  const color = PALETTE[0];
  const valFmt = isShare ? (v => v == null ? '—' : v.toFixed(2) + '%') : m.format;

  // Compute mean for reference line
  const valid = ys.filter(v => v != null);
  const mean = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;

  // Spike annotations — only meaningful in Absolute view
  const annotMarks = (!isShare) ? findChartAnnotations(data, {
    bank: state.banks && state.banks.length === 1 ? state.banks[0] : null,
    metric: METRIC_FIELD[state.metric] || state.metric,
    isStock: m.isStock,
    freq: state.freq,
    formatVal: m.format,
  }) : [];
  const latestGlow = latestGlowMarkPoint(xs, ys, color);

  charts.trend.setOption({
    grid: { left: 70, right: 28, top: 24, bottom: 36 },
    tooltip: { ...TOOLTIP_BASE,
      formatter: (params) => {
        if (params.componentType === 'markPoint' && params.data && params.data._annotation) {
          return `<div style="max-width:320px;line-height:1.5">${params.data._annotation}</div>`;
        }
        const p = Array.isArray(params) ? params[0] : params;
        return `<div style="font-weight:600;margin-bottom:4px">${p.axisValue ?? p.name}</div>
                <div style="display:flex;align-items:center;gap:6px">
                  <span style="width:8px;height:8px;background:${color};border-radius:50%;display:inline-block"></span>
                  ${m.short}: <b>${valFmt(p.value)}</b>
                </div>`;
      },
    },
    xAxis: { ...AXIS_X, data: xs, boundaryGap: false },
    yAxis: { ...AXIS_Y, axisLabel: { ...AXIS_Y.axisLabel,
      formatter: (v) => isShare ? v.toFixed(1) + '%' : compactNum(v) } },
    series: [{
      type: 'line', smooth: true, showSymbol: false,
      lineStyle: softLineStyle(color, 2.6),
      areaStyle: { color: gradientArea(color) },
      emphasis: { focus: 'series' },
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
        data: [...(latestGlow.data || []), ...annotMarks],
        tooltip: {
          trigger: 'item',
          backgroundColor: 'rgba(15,23,42,0.94)', borderWidth: 0, borderRadius: 10,
          padding: [11, 14],
          textStyle: { color: '#fff', fontSize: 12, fontFamily: 'Inter, sans-serif', fontWeight: 500 },
          extraCssText: 'box-shadow: 0 12px 32px rgba(15,23,42,0.22); border-radius: 10px;',
          formatter: (params) => params.data && params.data._annotation
            ? `<div style="max-width:320px;line-height:1.5">${params.data._annotation}</div>`
            : '',
        },
      },
      data: ys,
    }],
    animation: true, animationDuration: 600, animationEasing: 'cubicOut',
  }, true);
}

// ── 2. Growth / De-growth ───────────────────────────────────────────────
function renderGrowth(state, allRows, filtered) {
  const m = metric(state.metric);
  const isShareChange = state.growthType === 'ShareChange';
  // For share-change calculations, we need a % view; if absolute is
  // selected, fall back to Market Share denominator
  const useState = (isShareChange && state.view === 'absolute')
    ? { ...state, view: 'share' } : state;
  const isShare = isPctView(useState);

  // base series: either absolute or share-of-denominator/composition
  let base = series(filtered, state.metric, state.freq);
  base = applyView(base, allRows, useState, state.freq, state.metric);

  let gArr, yLabel, valSuffix, units;
  if (isShareChange) {
    const lookback = state.freq === 'M' ? 12 : state.freq === 'Q' ? 4 : 1;
    gArr = shareChange(base, lookback);
    yLabel = 'Δ pp'; valSuffix = ' pp'; units = 'pp';
  } else {
    gArr = growth(base, state.growthType, state.freq);
    yLabel = '%'; valSuffix = '%'; units = '%';
  }

  let growthBase = '';
  if (isShareChange) growthBase = ' (pp, YoY)';
  else if (state.view === 'share') growthBase = ' · on market share';
  else if (state.view === 'composition') growthBase = ' · on composition %';
  _root.querySelector('#growth-sub').textContent =
    `${m.short} · ${state.growthType === 'ShareChange' ? 'Share Δ' : state.growthType}${growthBase}`;

  if (!base.length || base.every(d => d.value == null)) {
    setEmptyChart(charts.growth, 'No data', 'No values to compute growth on');
    return;
  }

  const xs = base.map(d => d.label);
  const colored = gArr.map(v => {
    if (v == null) return { value: null };
    if (v > 0)  return { value: v, itemStyle: { color: UP   } };
    if (v < 0)  return { value: v, itemStyle: { color: DOWN } };
    return { value: v, itemStyle: { color: FLAT } };
  });

  charts.growth.setOption({
    grid: { left: 60, right: 16, top: 24, bottom: 44 },
    tooltip: { ...TOOLTIP_BASE,
      formatter: (params) => {
        const p = params[0];
        const v = p.value;
        const c = v == null ? '#94a3b8' : v > 0 ? UP : v < 0 ? DOWN : FLAT;
        return `<div style="font-weight:600;margin-bottom:4px">${p.axisValue}</div>
                <div style="display:flex;align-items:center;gap:6px">
                  <span style="width:8px;height:8px;background:${c};border-radius:50%;display:inline-block"></span>
                  ${state.growthType}: <b>${v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + valSuffix}</b>
                </div>`;
      },
    },
    xAxis: { ...AXIS_X, data: xs },
    yAxis: { ...AXIS_Y, name: yLabel, nameTextStyle: { color: '#64748b', fontSize: 11 },
      axisLabel: { ...AXIS_Y.axisLabel, formatter: (v) => v.toFixed(0) + units } },
    series: [{
      type: 'bar', data: colored,
      barMaxWidth: 18,
      itemStyle: { borderRadius: [3, 3, 0, 0] },
      emphasis: { focus: 'series' },
      markLine: {
        symbol: 'none', silent: true,
        lineStyle: { color: '#cbd2dc', type: 'solid', width: 1 },
        label: { show: false },
        data: [{ yAxis: 0 }],
      },
    }],
    animation: true, animationDuration: 500,
  }, true);
}

// ── 3. Bank Ranking ─────────────────────────────────────────────────────
function renderRank(state, allRows, filtered) {
  const m = metric(state.metric);
  const period = state.to || latestPeriod();
  // Ranking should respect category but not bank-single-select (otherwise just 1 bar)
  const baseRows = state.banks.length ? rows().filter(r =>
    (state.category === 'all' || r.category === state.category)) : filtered;
  const ranked = rankBanks(baseRows, state.metric, period).slice(0, 12);

  _root.querySelector('#rank-sub').textContent =
    `Top ${ranked.length} by ${m.short} · ${period}${state.category !== 'all' ? ' · ' + state.category : ''}`;

  const xs = ranked.map(r => r.bank).reverse();      // reverse so largest at top
  const ys = ranked.map(r => r.value).reverse();
  const cats = ranked.map(r => r.category).reverse();

  // Lollipop: thin bar (the stick) + scatter (the head)
  const colorByIdx = cats.map(catColor);

  charts.rank.setOption({
    grid: { left: 170, right: 56, top: 16, bottom: 24 },
    tooltip: { ...TOOLTIP_BASE, trigger: 'item',
      formatter: (p) => {
        const i = ranked.length - 1 - p.dataIndex;
        const r = ranked[i];
        return `<div style="font-weight:600;margin-bottom:4px">${r.bank}</div>
                <div style="color:#cbd2dc;font-size:11px;margin-bottom:6px">${r.category || '—'}</div>
                <div>${m.short}: <b>${m.format(r.value)}</b></div>
                <div>Share: <b>${r.share == null ? '—' : r.share.toFixed(2) + '%'}</b></div>`;
      },
    },
    xAxis: { type: 'value',
      axisLabel: { color: '#94a3b8', fontSize: 10.5, fontWeight: 500, formatter: (v) => compactNum(v) },
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: '#f1f5f9', type: 'solid', width: 1 } },
    },
    yAxis: { type: 'category', data: xs,
      axisLabel: { color: '#334155', fontSize: 11.5, fontWeight: 600,
        formatter: (v) => v.length > 22 ? v.slice(0, 21) + '…' : v },
      axisLine: { show: false }, axisTick: { show: false },
    },
    series: [
      {
        type: 'bar', data: ys,
        barWidth: 2.5,
        itemStyle: {
          color: (params) => colorByIdx[params.dataIndex],
          borderRadius: 2,
        },
        silent: true,
        z: 1,
      },
      {
        type: 'scatter', data: ys.map((v, i) => ({ value: v })),
        symbolSize: 14,
        itemStyle: {
          color: (params) => colorByIdx[params.dataIndex],
          borderColor: '#ffffff', borderWidth: 2,
          shadowColor: 'rgba(15,23,42,0.15)', shadowBlur: 4,
        },
        label: { show: true, position: 'right',
          color: '#334155', fontSize: 11, fontWeight: 600,
          formatter: (p) => '  ' + compactNum(p.value),
        },
        emphasis: { scale: 1.35 },
        z: 2,
      },
    ],
    animation: true, animationDuration: 600,
  }, true);
}

function catColor(cat) {
  switch (cat) {
    case 'Public Sector':     return '#2563eb';
    case 'Private Sector':    return '#7c3aed';
    case 'Foreign Bank':      return '#0891b2';
    case 'Payment Bank':      return '#ea580c';
    case 'Small Finance Bank':return '#059669';
    default:                  return '#64748b';
  }
}

// ── 4. Market Share Movement ────────────────────────────────────────────
// If a single bank is selected: show that bank's share over time.
// Else: pick top 5 banks by latest-period value within the (cat-filtered)
// universe and plot each one's share trend.
function renderShare(state, allRows, filtered) {
  const m = metric(state.metric);
  const denom = denominatorRows(allRows, state);

  let targets = state.banks;
  if (!targets.length) {
    const period = state.to || latestPeriod();
    const universe = state.category === 'all' ? allRows : allRows.filter(r => r.category === state.category);
    targets = rankBanks(universe, state.metric, period).slice(0, 5).map(r => r.bank);
  }

  const periodsList = denom; // not used directly, but ensure denom calc runs
  const denomSeries = series(denom, state.metric, state.freq);
  const denomMap = new Map(denomSeries.map(d => [d.key, d.value]));

  const sets = targets.map(bank => {
    const bankRows = allRows.filter(r => r.bank === bank);
    const bs = series(bankRows, state.metric, state.freq);
    return {
      name: bank,
      data: bs.map(d => {
        const den = denomMap.get(d.key);
        const v = (den == null || den === 0 || d.value == null) ? null : (d.value / den) * 100;
        return { key: d.key, label: d.label, value: v };
      }),
    };
  });

  const xs = (sets[0]?.data || []).map(d => d.label);
  const series_ = sets.map((s, i) => ({
    name: s.name,
    type: 'line', smooth: 0.4, showSymbol: false,
    lineStyle: softLineStyle(PALETTE[i % PALETTE.length], 2),
    itemStyle: { color: PALETTE[i % PALETTE.length] },
    emphasis: { focus: 'series', lineStyle: { width: 3 } },
    data: s.data.map(d => d.value),
    // Highlight the latest data point with a symbol so the tip of each line is visible
    endLabel: { show: true, color: PALETTE[i % PALETTE.length], fontWeight: 600, fontSize: 11,
      formatter: (p) => p.value == null ? '' : ' ' + p.value.toFixed(1) + '%' },
  }));

  _root.querySelector('#share-sub').textContent =
    targets.length ?
      `${m.short} share % · ${targets.length === 1 ? targets[0] : 'top ' + targets.length + ' banks'}${state.category !== 'all' ? ' within ' + state.category : ' of industry'}`
    : 'No data';

  if (!targets.length || !xs.length) {
    charts.share.setOption({
      title: { text: 'No data', left: 'center', top: 'center', textStyle: { color: '#94a3b8', fontWeight: 500, fontSize: 13 } },
      series: [],
    }, true);
    return;
  }

  charts.share.setOption({
    grid: { left: 60, right: 72, top: 40, bottom: 44 },
    legend: { top: 4, textStyle: { color: '#334155', fontSize: 11 }, icon: 'roundRect', itemWidth: 10, itemHeight: 6 },
    tooltip: { ...TOOLTIP_BASE,
      formatter: (params) => {
        let html = `<div style="font-weight:600;margin-bottom:4px">${params[0].axisValue}</div>`;
        for (const p of params.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity))) {
          if (p.value == null) continue;
          html += `<div style="display:flex;align-items:center;gap:6px;margin-top:2px">
            <span style="width:8px;height:8px;background:${p.color};border-radius:50%;display:inline-block"></span>
            ${truncate(p.seriesName, 22)}: <b>${p.value.toFixed(2)}%</b>
          </div>`;
        }
        return html;
      },
    },
    xAxis: { ...AXIS_X, data: xs },
    yAxis: { ...AXIS_Y, axisLabel: { ...AXIS_Y.axisLabel, formatter: v => v.toFixed(1) + '%' } },
    series: series_,
    animation: true, animationDuration: 600,
  }, true);
}

// ── 5. Bottom data table ────────────────────────────────────────────────
function renderTable(state, allRows, filtered) {
  const m = metric(state.metric);
  const period = state.to || latestPeriod();
  const baseRows = state.category === 'all' ? allRows : allRows.filter(r => r.category === state.category);
  const ranked = rankBanks(baseRows, state.metric, period);

  const growthCols = tableGrowthColumns(_tableMode, _tableFreq);

  // Pre-aggregate reference values per ref-period (each bank: sum field)
  const refByMonths = new Map();   // months → Map(bank → rawValue) + total
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

  // Share Δ is anchored to YoY (12M) for stability across both modes.
  const refShareInfo = refByMonths.get(12) || refByMonths.get(9) || refByMonths.get(6) || refByMonths.get(3);

  const enriched = ranked.map((r, i) => {
    const row = { ...r, rank: i + 1 };
    for (const c of growthCols) {
      const info = refByMonths.get(c.months);
      const refRaw = info.bankMap.get(r.bank);
      const refDisp = refRaw == null ? null : m.transform(refRaw);
      row[c.id] = computeGrowthPct(r.value, refDisp, c.months, c.cagr);
    }
    // Share Δ vs YoY base (in pp)
    if (refShareInfo) {
      const refRaw = refShareInfo.bankMap.get(r.bank);
      const refShare = (refRaw != null && refShareInfo.total > 0) ? (refRaw / refShareInfo.total) * 100 : null;
      row.shareDelta = (refShare != null && r.share != null) ? r.share - refShare : null;
    } else {
      row.shareDelta = null;
    }
    return row;
  });

  // sort by current sort state
  const sorted = sortRows(enriched, _sortState);
  const visibleRows = _tableShowAll ? sorted : sorted.slice(0, 10);

  const refLabel = growthCols.length
    ? `${_tableMode === 'cagr' ? 'CAGR' : 'growth'} vs ${growthCols.map(c => refPeriodMonthly(period, c.months)).filter(Boolean).join(', ')}`
    : '';
  const headerSub = `${m.label} · ${period} · ${state.category !== 'all' ? state.category + ' · ' : ''}${enriched.length} banks · ${refLabel}`;
  _root.querySelector('#table-sub').textContent = headerSub;

  const wrap = _root.querySelector('#table-wrap');
  const cols = [
    { id: 'rank',        label: '#',         num: true,  cell: r => `<span class="rank-cell ${r.rank <= 3 ? 'top' : ''}">${r.rank}</span>` },
    { id: 'bank',        label: 'Bank',      num: false, cell: r => r.bank },
    { id: 'category',    label: 'Category',  num: false, cell: r => r.category ? `<span class="chip ${catSlug(r.category)}">${shortCat(r.category)}</span>` : '—' },
    { id: 'value',       label: m.short,     num: true,  cell: r => m.format(r.value) },
    ...growthCols.map(c => ({ id: c.id, label: c.label, num: true, cell: r => deltaCell(r[c.id], '%') })),
    { id: 'share',       label: 'Share',     num: true,  cell: r => r.share == null ? '—' : r.share.toFixed(2) + '%' },
    { id: 'shareDelta',  label: 'Share Δ',   num: true,  cell: r => deltaCell(r.shareDelta, ' pp') },
  ];

  const showMoreNote = enriched.length > 10
    ? `<div class="tbl-foot">
         <button class="btn btn-toggle-more" id="ov-table-more">
           ${_tableShowAll ? `Show top 10` : `Show all ${enriched.length}`}
         </button>
         <span class="tbl-foot-note">${_tableShowAll ? 'Showing all banks' : `Showing top 10 of ${enriched.length}`}</span>
       </div>`
    : '';

  wrap.innerHTML = `
    <table class="tbl">
      <thead><tr>
        ${cols.map(c => {
          const sortClass = _sortState.col === c.id ? (`sort-${_sortState.dir}`) : '';
          const ind = _sortState.col === c.id ? (_sortState.dir === 'asc' ? '▲' : '▼') : '↕';
          return `<th class="sortable ${c.num ? 'num' : ''} ${sortClass}" data-col="${c.id}">${c.label}<span class="sort-ind">${ind}</span></th>`;
        }).join('')}
      </tr></thead>
      <tbody>
        ${visibleRows.map(r => `<tr>${cols.map(c => `<td class="${c.num ? 'num' : ''}">${c.cell(r)}</td>`).join('')}</tr>`).join('')}
      </tbody>
    </table>
    ${showMoreNote}
  `;
  wrap.querySelectorAll('thead th.sortable').forEach(th => {
    th.onclick = () => {
      const col = th.dataset.col;
      _sortState.dir = (_sortState.col === col && _sortState.dir === 'desc') ? 'asc' : 'desc';
      _sortState.col = col;
      renderTable(state, allRows, filtered);
    };
  });
  const moreBtn = wrap.querySelector('#ov-table-more');
  if (moreBtn) moreBtn.onclick = () => { _tableShowAll = !_tableShowAll; renderTable(state, allRows, filtered); };
}

function referencePeriod(period, growthType, freq) {
  if (freq !== 'M') return null;       // table is always latest month
  const [y, m] = period.split('-').map(Number);
  let offset;
  if (growthType === 'MoM') offset = 1;
  else if (growthType === '3M') offset = 3;
  else if (growthType === 'YoY' || growthType === 'ShareChange') offset = 12;
  else offset = 1;
  const date = new Date(Date.UTC(y, m - 1 - offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function sortRows(rs, sortState) {
  const { col, dir } = sortState;
  const sign = dir === 'asc' ? 1 : -1;
  return [...rs].sort((a, b) => {
    let av = a[col], bv = b[col];
    if (typeof av === 'string') return sign * av.localeCompare(bv ?? '');
    if (av == null) return 1;
    if (bv == null) return -1;
    return sign * (av - bv);
  });
}

function deltaCell(v, suffix) {
  if (v == null || isNaN(v)) return '<span class="delta-flat">—</span>';
  const cls = v > 0 ? 'delta-up' : v < 0 ? 'delta-down' : 'delta-flat';
  const sign = v > 0 ? '+' : '';
  return `<span class="${cls}">${sign}${v.toFixed(2)}${suffix}</span>`;
}

function catSlug(cat) {
  if (!cat) return '';
  if (cat.includes('Public'))  return 'public';
  if (cat.includes('Private')) return 'private';
  if (cat.includes('Foreign')) return 'foreign';
  if (cat.includes('Payment')) return 'payment';
  if (cat.includes('Small'))   return 'sfb';
  return '';
}
function shortCat(cat) {
  if (!cat) return '';
  return cat.replace(' Sector', '').replace(' Bank', '').replace('Small Finance', 'SFB');
}

function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function freqLabel(f) { return f === 'M' ? 'Monthly' : f === 'Q' ? 'Quarterly' : 'Yearly'; }

// ── Export ──────────────────────────────────────────────────────────────
function onExport(which) {
  const state = getState();
  const m = metric(state.metric);
  const allRows = rows();
  const filtered = filterRows(allRows, state);
  const stamp = new Date().toISOString().slice(0, 10);
  const sheets = [];

  if (which === 'trend' || which === 'all') {
    let data = series(filtered, state.metric, state.freq);
    data = applyView(data, allRows, state, state.freq, state.metric);
    const headerSuffix = state.view === 'share' ? ' (market share %)'
      : state.view === 'composition' ? ' (composition %)' : '';
    const header = ['Period', m.label + headerSuffix];
    sheets.push({ name: 'Long-term Trend', rows: [header, ...data.map(d => [d.label, d.value])] });
  }

  if (which === 'growth' || which === 'all') {
    let base = series(filtered, state.metric, state.freq);
    const isShareChange = state.growthType === 'ShareChange';
    const useState = (isShareChange && state.view === 'absolute')
      ? { ...state, view: 'share' } : state;
    base = applyView(base, allRows, useState, state.freq, state.metric);
    const g = isShareChange
      ? shareChange(base, state.freq === 'M' ? 12 : state.freq === 'Q' ? 4 : 1)
      : growth(base, state.growthType, state.freq);
    sheets.push({
      name: 'Growth',
      rows: [['Period', isShareChange ? 'Share Δ (pp)' : `${state.growthType} %`],
             ...base.map((d, i) => [d.label, g[i]])],
    });
  }

  if (which === 'rank' || which === 'all') {
    const period = state.to || latestPeriod();
    const baseRows = state.category === 'all' ? allRows : allRows.filter(r => r.category === state.category);
    const ranked = rankBanks(baseRows, state.metric, period);
    sheets.push({
      name: 'Ranking',
      rows: [['Rank', 'Bank', 'Category', m.label, 'Share %'],
             ...ranked.map((r, i) => [i + 1, r.bank, r.category || '—', r.value, r.share])],
    });
  }

  if (which === 'share' || which === 'all') {
    const denom = denominatorRows(allRows, state);
    const denomSeries = series(denom, state.metric, state.freq);
    const denomMap = new Map(denomSeries.map(d => [d.key, d.value]));
    let targets = state.banks;
    if (!targets.length) {
      const period = state.to || latestPeriod();
      const universe = state.category === 'all' ? allRows : allRows.filter(r => r.category === state.category);
      targets = rankBanks(universe, state.metric, period).slice(0, 5).map(r => r.bank);
    }
    const periodList = denomSeries.map(d => d.label);
    const keyList = denomSeries.map(d => d.key);
    const colData = targets.map(bank => {
      const bs = series(allRows.filter(r => r.bank === bank), state.metric, state.freq);
      const bsMap = new Map(bs.map(d => [d.key, d.value]));
      return keyList.map(k => {
        const num = bsMap.get(k);
        const den = denomMap.get(k);
        return (num == null || den == null || den === 0) ? null : (num / den) * 100;
      });
    });
    const header = ['Period', ...targets.map(t => `${t} — share %`)];
    const rowsOut = periodList.map((label, i) => [label, ...colData.map(col => col[i])]);
    sheets.push({ name: 'Market Share', rows: [header, ...rowsOut] });
  }

  if (which === 'all') {
    const period = state.to || latestPeriod();
    const baseRows = state.category === 'all' ? allRows : allRows.filter(r => r.category === state.category);
    const ranked = rankBanks(baseRows, state.metric, period);
    const refPeriod = referencePeriod(period, state.growthType, state.freq);
    const refRowsArr = refPeriod ? baseRows.filter(r => r.period === refPeriod) : [];
    const refMap = new Map();
    for (const r of refRowsArr) {
      const v = r[m.field];
      if (v == null) continue;
      refMap.set(r.bank, (refMap.get(r.bank) ?? 0) + v);
    }
    const refTotal = [...refMap.values()].reduce((s, v) => s + v, 0);
    const tableRows = ranked.map((r, i) => {
      const refValRaw = refMap.get(r.bank);
      const refValDisp = refValRaw == null ? null : m.transform(refValRaw);
      let g = null;
      if (refValDisp != null && refValDisp !== 0 && r.value != null) g = ((r.value - refValDisp) / refValDisp) * 100;
      const refShare = (refValRaw != null && refTotal > 0) ? (refValRaw / refTotal) * 100 : null;
      const sd = (refShare != null && r.share != null) ? r.share - refShare : null;
      return [i + 1, r.bank, r.category || '—', r.value, g, r.share, sd];
    });
    sheets.push({
      name: 'Bank Table',
      rows: [['Rank', 'Bank', 'Category', m.label, `${state.growthType} %`, 'Share %', 'Share Δ pp'], ...tableRows],
    });
  }

  exportSheets(`overview_${which}_${stamp}.xlsx`, sheets, currentFilterMeta());
}
