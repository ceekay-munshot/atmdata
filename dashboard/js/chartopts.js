// Shared ECharts option fragments — keeps every chart visually consistent.

export const PALETTE = [
  '#4f46e5', '#06b6d4', '#10b981', '#f59e0b',
  '#ec4899', '#8b5cf6', '#ef4444', '#14b8a6',
  '#3b82f6', '#f97316',
];

export const UP = '#059669';
export const DOWN = '#dc2626';
export const FLAT = '#94a3b8';

export const TOOLTIP_BASE = {
  trigger: 'axis',
  backgroundColor: 'rgba(15,23,42,0.94)',
  borderWidth: 0,
  padding: [10, 14],
  textStyle: { color: '#fff', fontSize: 12, fontFamily: 'Inter, sans-serif' },
  extraCssText: 'box-shadow: 0 8px 24px rgba(0,0,0,0.18); border-radius: 8px;',
};

export const AXIS_X = {
  type: 'category',
  axisLine: { lineStyle: { color: '#cbd2dc' } },
  axisLabel: { color: '#64748b', fontSize: 11, fontFamily: 'Inter, sans-serif' },
  axisTick: { show: false },
};

export const AXIS_Y = {
  type: 'value',
  axisLine: { show: false },
  splitLine: { lineStyle: { color: '#e3e6ec', type: 'dashed' } },
  axisLabel: { color: '#64748b', fontSize: 11, fontFamily: 'Inter, sans-serif' },
};

export function gradientArea(color) {
  return {
    type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
    colorStops: [
      { offset: 0, color: hexA(color, 0.22) },
      { offset: 1, color: hexA(color, 0.02) },
    ],
  };
}

export function compactNum(v) {
  if (v == null || isNaN(v)) return '';
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (abs >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return Number(v.toFixed(2)).toString();
}

export function hexA(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// ── Play / replay helper ────────────────────────────────────────────────
// Progressively reveals each x-tick of a line chart over `durationMs`,
// drawing a glowing "playhead" at the current frontier. Works for single
// or multi-series. Returns { stop() } so the caller can cancel.
//
//   playReplay(chart, {
//     seriesData: [[v1,v2,...],   // values for series 0
//                  [u1,u2,...]],  // values for series 1 (optional)
//     colors: ['#4f46e5', ...],
//     durationMs: 2400,
//     onProgress(i, N), onDone(),
//   })
export const PLAY_ICON =
  `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="7,4 20,12 7,20"/></svg>`;
export const STOP_ICON =
  `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;

export function playReplay(chart, opts) {
  const { seriesData, colors = ['#4f46e5'], durationMs = 2400, onProgress, onDone } = opts;
  const N = Array.isArray(seriesData[0]) ? seriesData[0].length : 0;
  if (N < 2) { onDone && onDone(); return { stop: () => {} }; }
  const stepMs = Math.max(10, Math.floor(durationMs / N));
  let i = 1;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    const newSeries = seriesData.map((vals, sIdx) => {
      const lastVal = vals[i - 1];
      const c = colors[sIdx % colors.length];
      return {
        data: vals.slice(0, i).concat(new Array(N - i).fill(null)),
        markPoint: (i < N && lastVal != null) ? {
          symbol: 'circle', symbolSize: 14,
          itemStyle: { color: '#fff', borderColor: c, borderWidth: 2.5,
            shadowColor: hexA(c, 0.55), shadowBlur: 16 },
          data: [{ coord: [i - 1, lastVal], label: { show: false } }],
        } : { data: [] },
      };
    });
    chart.setOption({ animation: false, series: newSeries });
    if (onProgress) onProgress(i, N);
    if (i < N) { i++; setTimeout(tick, stepMs); }
    else { onDone && onDone(); }
  };
  tick();
  return { stop: () => { stopped = true; onDone && onDone(); } };
}

// Polished glow-dot at the latest data point — used in baseline render of
// trend charts so the "current" frontier is always visible.
export function latestGlowMarkPoint(xs, values, color) {
  if (!values || !values.length) return { data: [] };
  // Find the last non-null index
  let last = values.length - 1;
  while (last >= 0 && values[last] == null) last--;
  if (last < 0) return { data: [] };
  return {
    symbol: 'circle', symbolSize: 12,
    itemStyle: { color: '#fff', borderColor: color, borderWidth: 2.5,
      shadowColor: hexA(color, 0.55), shadowBlur: 14 },
    data: [{ coord: [last, values[last]], label: { show: false } }],
  };
}

// Render a clean "no data" state inside any chart.
export function setEmptyChart(chart, title = 'No data for this combination', subtitle = '') {
  chart.setOption({
    title: {
      text: title, subtext: subtitle,
      left: 'center', top: 'center',
      textStyle: { color: '#64748b', fontWeight: 600, fontSize: 14 },
      subtextStyle: { color: '#94a3b8', fontSize: 12, lineHeight: 18 },
    },
    xAxis: { show: false }, yAxis: { show: false },
    grid: { show: false },
    series: [],
    legend: { show: false },
    dataZoom: [],
  }, true);
}
