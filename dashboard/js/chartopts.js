// Shared ECharts option fragments — keeps every chart visually consistent.
// Refined for a "boardroom" institutional look: subtle axes, near-invisible
// gridlines, soft glow under lines, polished glass-style tooltip.

export const PALETTE = [
  '#4f46e5', '#06b6d4', '#10b981', '#f59e0b',
  '#ec4899', '#8b5cf6', '#ef4444', '#14b8a6',
  '#3b82f6', '#f97316',
];

export const UP = '#059669';
export const DOWN = '#dc2626';
export const FLAT = '#94a3b8';

// Polished glass-style tooltip with shadow + backdrop blur
export const TOOLTIP_BASE = {
  trigger: 'axis',
  backgroundColor: 'rgba(15, 23, 42, 0.94)',
  borderWidth: 0,
  borderRadius: 10,
  padding: [11, 14],
  textStyle: {
    color: '#fff',
    fontSize: 12,
    fontFamily: 'Inter, sans-serif',
    fontWeight: 500,
  },
  extraCssText: 'box-shadow: 0 12px 32px rgba(15,23,42,0.22); border-radius: 10px; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);',
  axisPointer: {
    type: 'line',
    lineStyle: { color: '#cbd2dc', type: 'dashed', width: 1 },
  },
};

// Clean X axis — no axis line, no tick marks, soft labels, no gridlines
export const AXIS_X = {
  type: 'category',
  axisLine: { show: false },
  axisTick: { show: false },
  axisLabel: {
    color: '#94a3b8',
    fontSize: 10.5,
    fontWeight: 500,
    fontFamily: 'Inter, sans-serif',
    margin: 14,
  },
  splitLine: { show: false },
};

// Clean Y axis — only faint horizontal split lines for reference
export const AXIS_Y = {
  type: 'value',
  axisLine: { show: false },
  axisTick: { show: false },
  axisLabel: {
    color: '#94a3b8',
    fontSize: 10.5,
    fontWeight: 500,
    fontFamily: 'Inter, sans-serif',
    margin: 14,
  },
  splitLine: {
    show: true,
    lineStyle: { color: '#f1f5f9', type: 'solid', width: 1 },
  },
};

// Area gradient for trend charts — soft, fading to transparent
export function gradientArea(color) {
  return {
    type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
    colorStops: [
      { offset: 0,    color: hexA(color, 0.20) },
      { offset: 0.55, color: hexA(color, 0.06) },
      { offset: 1,    color: hexA(color, 0.00) },
    ],
  };
}

// Soft "premium" line style — adds a subtle coloured shadow under the
// line, giving a refined glow without being noisy.
export function softLineStyle(color, width = 2.4) {
  return {
    color,
    width,
    shadowColor: hexA(color, 0.28),
    shadowBlur: 8,
    shadowOffsetY: 4,
    cap: 'round',
    join: 'round',
  };
}

export function hexA(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

export function compactNum(v) {
  if (v == null || isNaN(v)) return '';
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (abs >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return Number(v.toFixed(2)).toString();
}

// Rebase a series so its first non-null value is 100, then every value is
// expressed as an index relative to that start.
export function indexTo100(values) {
  if (!values || !values.length) return values;
  let base = null;
  for (const v of values) { if (v != null && v !== 0) { base = v; break; } }
  if (base == null) return values;
  return values.map(v => v == null ? null : (v / base) * 100);
}

// ── Play / replay helper ────────────────────────────────────────────────
export const PLAY_ICON =
  `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="7,4 20,12 7,20"/></svg>`;
export const STOP_ICON =
  `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;

// Excel-style export icon — green file with white "X" mark
export const EXCEL_ICON =
  `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
     <defs><linearGradient id="xlg" x1="0" y1="0" x2="0" y2="1">
       <stop offset="0%" stop-color="#22c55e"/><stop offset="100%" stop-color="#15803d"/>
     </linearGradient></defs>
     <rect x="3" y="2" width="18" height="20" rx="3" fill="url(#xlg)"/>
     <path d="M8.5 8l3 4-3 4M15.5 8l-3 4 3 4" stroke="white" stroke-width="1.8"
           stroke-linecap="round" stroke-linejoin="round" fill="none"/>
   </svg>`;

export function playReplay(chart, opts) {
  const {
    seriesData, colors = ['#4f46e5'], durationMs = 2400,
    formatVal,         // optional: (v) => string — shown as a ticker label
    onProgress, onDone,
  } = opts;
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
      const labelText = (formatVal && lastVal != null) ? formatVal(lastVal) : null;
      return {
        data: vals.slice(0, i).concat(new Array(N - i).fill(null)),
        markPoint: (i < N && lastVal != null) ? {
          symbol: 'circle', symbolSize: 14,
          itemStyle: { color: '#fff', borderColor: c, borderWidth: 2.5,
            shadowColor: hexA(c, 0.55), shadowBlur: 16 },
          data: [{
            coord: [i - 1, lastVal],
            label: labelText ? {
              show: true, position: 'right', distance: 12,
              color: c, fontWeight: 700, fontSize: 11,
              fontFamily: 'Inter, sans-serif',
              backgroundColor: '#ffffff',
              padding: [4, 8],
              borderRadius: 8,
              borderColor: c, borderWidth: 1.5,
              shadowColor: hexA(c, 0.25),
              shadowBlur: 8,
              formatter: labelText,
            } : { show: false },
          }],
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
