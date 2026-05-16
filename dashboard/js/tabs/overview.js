// Overview tab — Part 1 stub: long-term trend chart only.
// Part 2 will flesh out the remaining 3 hero visuals + bottom table.

import { rows, manifest } from '../data.js';
import { getState, subscribe } from '../state.js';
import { series, filterRows, denominatorRows, shareSeries, metric } from '../calc.js';
import { exportSheets, currentFilterMeta } from '../export.js';

let chart = null;
let _root = null;
let _unsub = null;

const HTML = `
  <div class="grid">
    <div class="card">
      <div class="card-head">
        <div class="card-head-text">
          <div class="card-title" id="ov-title">Long-term Trend</div>
          <div class="card-sub" id="ov-sub">—</div>
        </div>
        <div class="card-actions">
          <button class="btn" id="ov-export">Export to Excel</button>
        </div>
      </div>
      <div class="chart tall" id="ov-chart"></div>
    </div>

    <div class="card">
      <div class="empty">
        <div class="empty-title">Part 2 — coming next</div>
        <div class="empty-sub">Growth / Ranking / Market-share Movement visuals will land here. The plumbing is in place.</div>
      </div>
    </div>
  </div>
`;

export function mount(root) {
  _root = root;
  root.innerHTML = HTML;
  chart = echarts.init(root.querySelector('#ov-chart'));
  window.addEventListener('resize', onResize);
  root.querySelector('#ov-export').onclick = onExport;
  redraw();
  _unsub = subscribe(redraw);
}

export function unmount() {
  if (chart) { chart.dispose(); chart = null; }
  window.removeEventListener('resize', onResize);
  if (_unsub) { _unsub(); _unsub = null; }
}

function onResize() { if (chart) chart.resize(); }

function redraw() {
  const state = getState();
  const m = metric(state.metric);
  const allRows = rows();
  const filtered = filterRows(allRows, state);

  let data = series(filtered, state.metric, state.freq);
  let yLabel = m.short;
  let titleSub = `${m.label} · ${freqLabel(state.freq)} · ${m.isStock ? 'As on period-end' : 'For the period'}`;

  if (state.view === 'share') {
    const denom = denominatorRows(allRows, state);
    const denomSeries = series(denom, state.metric, state.freq);
    data = shareSeries(data, denomSeries);
    yLabel = 'Share %';
    titleSub += ' · Market share (%)';
  }

  _root.querySelector('#ov-sub').textContent = titleSub;

  const xs = data.map(d => d.label);
  const ys = data.map(d => d.value);

  chart.setOption(option(xs, ys, yLabel, m, state.view), true);
}

function option(xs, ys, yLabel, m, view) {
  const isShare = view === 'share';
  const valueFormatter = isShare
    ? (v) => v == null ? '—' : v.toFixed(2) + '%'
    : m.format;

  return {
    grid: { left: 70, right: 24, top: 30, bottom: 50 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(15,23,42,0.92)',
      borderWidth: 0,
      textStyle: { color: '#fff', fontSize: 12 },
      formatter: (params) => {
        const p = params[0];
        return `<div style="font-weight:500;margin-bottom:4px">${p.axisValue}</div>
                <div>${m.short}: <b>${valueFormatter(p.value)}</b></div>`;
      },
    },
    xAxis: {
      type: 'category', data: xs,
      axisLine: { lineStyle: { color: '#cbd2dc' } },
      axisLabel: { color: '#64748b', fontSize: 11 },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      name: yLabel, nameGap: 18, nameTextStyle: { color: '#64748b', fontSize: 11 },
      axisLine: { show: false },
      splitLine: { lineStyle: { color: '#e3e6ec', type: 'dashed' } },
      axisLabel: {
        color: '#64748b', fontSize: 11,
        formatter: (v) => isShare ? v.toFixed(1) + '%' : compactNum(v),
      },
    },
    series: [{
      type: 'line', smooth: true, showSymbol: false,
      lineStyle: { color: '#2563eb', width: 2.5 },
      areaStyle: {
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: 'rgba(37,99,235,0.22)' },
            { offset: 1, color: 'rgba(37,99,235,0.02)' },
          ],
        },
      },
      emphasis: { focus: 'series' },
      data: ys,
    }],
    animation: true,
    animationDuration: 600,
    animationEasing: 'cubicOut',
  };
}

function compactNum(v) {
  if (v == null) return '';
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (abs >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toString();
}

function freqLabel(f) {
  return f === 'M' ? 'Monthly' : f === 'Q' ? 'Quarterly' : 'Yearly';
}

function onExport() {
  const state = getState();
  const m = metric(state.metric);
  const allRows = rows();
  const filtered = filterRows(allRows, state);
  let data = series(filtered, state.metric, state.freq);
  let header = ['Period', m.label];
  if (state.view === 'share') {
    const denom = denominatorRows(allRows, state);
    const denomSeries = series(denom, state.metric, state.freq);
    data = shareSeries(data, denomSeries);
    header = ['Period', `${m.short} — Market share %`];
  }
  const sheetRows = [header, ...data.map(d => [d.label, d.value])];
  exportSheets(
    `overview_long-term-trend_${new Date().toISOString().slice(0,10)}.xlsx`,
    [{ name: 'Long-term Trend', rows: sheetRows }],
    currentFilterMeta(),
  );
}
