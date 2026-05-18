// 12-month forecast helper using Holt-Winters additive method with 12-period
// seasonality (good fit for monthly RBI data). Falls back to a simple linear
// extrapolation when there's < 2 seasons of history.
//
// Returns { history: [...nulls + actuals],
//           forecast: [...nulls + projected values],
//           upper95: [...nulls + upper band],
//           lower95: [...nulls + lower band],
//           futureLabels: [12 future labels] }
//
// The arrays are aligned so they can all be plotted on a combined x-axis
// (history labels + future labels).

const SEASON = 12;
const ALPHA = 0.3, BETA = 0.1, GAMMA = 0.3;
const Z95 = 1.96;

export function forecastSeries(actualValues, monthlyLabels, horizon = 12) {
  // Strip leading/trailing nulls but preserve indices for the history portion
  const cleaned = actualValues.map(v => (v == null || isNaN(v)) ? null : v);
  const validIdxs = cleaned.map((v, i) => v != null ? i : -1).filter(i => i >= 0);
  if (validIdxs.length < 6) return null;     // not enough to bother

  // Work with a continuous dense series (interpolate small gaps if any)
  const dense = [...cleaned];
  for (let i = 1; i < dense.length - 1; i++) {
    if (dense[i] == null && dense[i - 1] != null && dense[i + 1] != null) {
      dense[i] = (dense[i - 1] + dense[i + 1]) / 2;
    }
  }
  // Trim leading nulls so we always start with a real value
  let start = 0;
  while (start < dense.length && dense[start] == null) start++;
  const series = dense.slice(start).map(v => v ?? 0);
  if (series.length < SEASON + 2) {
    return linearFallback(actualValues, monthlyLabels, horizon, validIdxs);
  }

  const n = series.length;
  const seasons = Math.floor(n / SEASON);

  // Initial seasonal indices = avg of each month across seasons, mean-zeroed
  const seasonalAverages = new Array(SEASON).fill(0);
  const seasonalCounts   = new Array(SEASON).fill(0);
  for (let s = 0; s < seasons; s++) {
    for (let i = 0; i < SEASON; i++) {
      seasonalAverages[i] += series[s * SEASON + i];
      seasonalCounts[i]   += 1;
    }
  }
  for (let i = 0; i < SEASON; i++) seasonalAverages[i] /= Math.max(1, seasonalCounts[i]);
  const grandMean = seasonalAverages.reduce((a, b) => a + b, 0) / SEASON;
  const seasonal  = seasonalAverages.map(v => v - grandMean);

  // Initial level + trend
  let level = series.slice(0, SEASON).reduce((a, b) => a + b, 0) / SEASON;
  let trend = 0;
  if (seasons >= 2) {
    let acc = 0;
    for (let i = 0; i < SEASON; i++) acc += (series[SEASON + i] - series[i]) / SEASON;
    trend = acc / SEASON;
  }

  // Smooth
  const fitted = new Array(n).fill(null);
  const residuals = [];
  for (let t = 0; t < n; t++) {
    const lastLevel = level;
    const lastTrend = trend;
    const seasonalIdx = t % SEASON;
    const lastSeasonal = seasonal[seasonalIdx];
    fitted[t] = lastLevel + lastTrend + lastSeasonal;
    const v = series[t];
    level = ALPHA * (v - lastSeasonal) + (1 - ALPHA) * (lastLevel + lastTrend);
    trend = BETA  * (level - lastLevel) + (1 - BETA)  * lastTrend;
    seasonal[seasonalIdx] = GAMMA * (v - level) + (1 - GAMMA) * lastSeasonal;
    if (t > SEASON) residuals.push(v - fitted[t]);
  }

  // Residual std-dev
  const meanRes = residuals.reduce((a, b) => a + b, 0) / Math.max(1, residuals.length);
  const variance = residuals.reduce((a, b) => a + (b - meanRes) ** 2, 0) / Math.max(1, residuals.length);
  const stdDev = Math.sqrt(variance);

  // Forecast horizon steps ahead
  const fcst = new Array(horizon);
  const upper = new Array(horizon);
  const lower = new Array(horizon);
  for (let h = 1; h <= horizon; h++) {
    const seasonalIdx = (n + h - 1) % SEASON;
    const point = level + h * trend + seasonal[seasonalIdx];
    // 95% band — sqrt(h) widens with horizon
    const halfWidth = Z95 * stdDev * Math.sqrt(h);
    fcst[h - 1]  = point;
    upper[h - 1] = point + halfWidth;
    lower[h - 1] = Math.max(0, point - halfWidth);  // never go below zero for stock metrics
  }

  // Generate future month labels (Jan 26, Feb 26, …)
  const lastLabel = monthlyLabels[monthlyLabels.length - 1];   // 'MMM YY'
  const futureLabels = nextMonthLabels(lastLabel, horizon);

  // Pad arrays so everything lines up on a combined x-axis
  const total = actualValues.length + horizon;
  const padded = (arr, leadingNulls) => {
    const out = new Array(total).fill(null);
    for (let i = 0; i < arr.length; i++) out[leadingNulls + i] = arr[i];
    return out;
  };

  return {
    history:  actualValues.concat(new Array(horizon).fill(null)),
    // Forecast starts at the LAST historical point so the dashed line connects smoothly
    forecast: padded([actualValues[actualValues.length - 1], ...fcst], actualValues.length - 1),
    upper95:  padded([actualValues[actualValues.length - 1], ...upper], actualValues.length - 1),
    lower95:  padded([actualValues[actualValues.length - 1], ...lower], actualValues.length - 1),
    futureLabels,
  };
}


function nextMonthLabels(lastLabel, n) {
  // lastLabel format like 'Mar 26'
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const [mAbbr, yy] = lastLabel.split(' ');
  let monthIdx = months.indexOf(mAbbr);
  let year2 = parseInt(yy, 10);
  const out = [];
  for (let i = 0; i < n; i++) {
    monthIdx++;
    if (monthIdx >= 12) { monthIdx = 0; year2 = (year2 + 1) % 100; }
    out.push(`${months[monthIdx]} ${String(year2).padStart(2, '0')}`);
  }
  return out;
}


// Fallback: simple linear regression on the tail
function linearFallback(actualValues, monthlyLabels, horizon, validIdxs) {
  const tail = validIdxs.slice(-Math.min(24, validIdxs.length));
  const xs = tail;
  const ys = tail.map(i => actualValues[i]);
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - meanX) * (ys[i] - meanY); den += (xs[i] - meanX) ** 2; }
  const slope = den ? num / den : 0;
  const intercept = meanY - slope * meanX;
  const residuals = ys.map((y, i) => y - (slope * xs[i] + intercept));
  const variance = residuals.reduce((a, b) => a + b * b, 0) / Math.max(1, n);
  const stdDev = Math.sqrt(variance);
  const startIdx = actualValues.length;
  const fcst = [], upper = [], lower = [];
  for (let h = 1; h <= horizon; h++) {
    const x = startIdx + h - 1;
    const y = slope * x + intercept;
    const half = Z95 * stdDev * Math.sqrt(h);
    fcst.push(y); upper.push(y + half); lower.push(Math.max(0, y - half));
  }
  const total = actualValues.length + horizon;
  const padded = (arr, off) => { const o = new Array(total).fill(null); for (let i = 0; i < arr.length; i++) o[off + i] = arr[i]; return o; };
  return {
    history: actualValues.concat(new Array(horizon).fill(null)),
    forecast: padded([actualValues[actualValues.length - 1], ...fcst], actualValues.length - 1),
    upper95:  padded([actualValues[actualValues.length - 1], ...upper], actualValues.length - 1),
    lower95:  padded([actualValues[actualValues.length - 1], ...lower], actualValues.length - 1),
    futureLabels: nextMonthLabels(monthlyLabels[monthlyLabels.length - 1], horizon),
  };
}
