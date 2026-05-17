// Curated annotations + algorithmic spike detection.
// Charts that want to highlight notable changes import findChartAnnotations()
// which returns markPoint-friendly objects (with .coord and .text).

let _annotations = null;

export async function load() {
  if (_annotations) return _annotations;
  try {
    const r = await fetch('data/annotations.json');
    _annotations = r.ok ? ((await r.json()).annotations || []) : [];
  } catch {
    _annotations = [];
  }
  return _annotations;
}

// Find a curated annotation matching the given context.
//   bank: exact bank name or null (industry/aggregate view)
//   period: 'YYYY-MM'
//   metric: metric key (e.g. 'off_site_atms')
// Specificity (most specific wins):
//   1. bank + period + metric
//   2. bank + period + metric='*'
//   3. period + metric (no bank)
//   4. period + metric='*'
function lookupAnnotation(bank, period, metric) {
  if (!_annotations) return null;
  const tiers = [
    a => a.period === period && a.bank === bank && a.metric === metric,
    a => a.period === period && a.bank === bank && a.metric === '*',
    a => a.period === period && !a.bank      && a.metric === metric,
    a => a.period === period && !a.bank      && a.metric === '*',
  ];
  for (const matchFn of tiers) {
    const hit = _annotations.find(matchFn);
    if (hit) return hit;
  }
  return null;
}

// Auto-detect sharp month-over-month changes in a value series.
//   values: array of numbers/nulls
//   isStock: true → stricter threshold (stock metrics should be smooth)
//   thresholdFactor: e.g. 2.0 means change of ≥ 2x or ≤ 0.5x triggers
function detectSpikes(values, isStock, thresholdFactor) {
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const p = values[i - 1], c = values[i];
    if (p == null || c == null) continue;
    const min = isStock ? 50 : 5000;     // ignore noise on tiny baselines
    if (p < min || c < 0) continue;
    if (p === 0) continue;
    const ratio = c / p;
    if (ratio >= thresholdFactor || ratio <= 1 / thresholdFactor) {
      out.push({ idx: i, prev: p, curr: c, ratio });
    }
  }
  return out;
}

// For a chart that plots `series` (array of {key, label, value}), return
// an array of markPoint definitions for ECharts. Each marker has a text
// blob ready to drop into the tooltip.
//
//   ctx: { bank: '...' | null, metric: 'off_site_atms', isStock: true,
//          formatVal: (v) => '...' }
export function findChartAnnotations(series, ctx) {
  if (!series || series.length < 2) return [];
  const values = series.map(d => d.value);
  const thr = ctx.isStock ? 1.6 : 2.5;   // stock metrics stricter
  const spikes = detectSpikes(values, ctx.isStock, thr);

  return spikes.map(s => {
    const period = series[s.idx].key;
    const curated = lookupAnnotation(ctx.bank, period, ctx.metric);
    const prevLabel = series[s.idx - 1].label;
    const currLabel = series[s.idx].label;
    const dir = s.ratio > 1 ? 'jumped' : 'fell';
    const pct = s.ratio > 1
      ? `+${((s.ratio - 1) * 100).toFixed(0)}%`
      : `-${((1 - s.ratio) * 100).toFixed(0)}%`;
    const fmt = ctx.formatVal || ((v) => String(Math.round(v)));
    const generic = `<b>Sharp change (${pct})</b><br>` +
      `${prevLabel} → ${currLabel}: ${fmt(s.prev)} → ${fmt(s.curr)}<br>` +
      `<span style="color:#cbd2dc;font-size:11px">RBI source value; no curated note yet.</span>`;
    const html = curated
      ? `<b>${curated.title}</b><br>${curated.detail}`
      : generic;
    return {
      coord: [s.idx, s.curr],
      symbol: 'circle', symbolSize: 14,
      itemStyle: { color: '#f59e0b', borderColor: '#fff', borderWidth: 2.5,
                   shadowColor: 'rgba(245, 158, 11, 0.55)', shadowBlur: 12 },
      label: { show: true, formatter: '!', color: '#fff',
               fontSize: 11, fontWeight: 700 },
      // Custom property surfaced via the tooltip formatter
      _annotation: html,
    };
  });
}
