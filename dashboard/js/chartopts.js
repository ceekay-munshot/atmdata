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

function hexA(hex, a) {
  // convert #rrggbb + alpha → rgba(...)
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
