// Centralised calculations: metric extraction, frequency aggregation, growth,
// market share, share-change. ALL visuals/tables/exports must route through here.

// ── METRIC CATALOG ──────────────────────────────────────────────────────
// Each metric defines:
//   field    : key in the flat row
//   label    : display label
//   short    : axis/short label
//   isStock  : true if as-on-date (infra), false if monthly flow (txn)
//   unit     : 'count' | 'currency_cr' (display unit)
//   transform: raw -> display value (e.g. thousands → crores)
//   format   : value -> string for tooltips / tables / axis

const toCr = v => (v == null ? null : v / 1e4); // Rs '000 → Rs Cr (× 1000 → ÷ 1e7 = ÷ 1e4 from thousands)
// Math: 1 crore = 10,000,000 = 10,000 thousands; so value_in_thousands / 10000 = value_in_crores

export const METRICS = {
  on_site: {
    field: 'on_site_atms',
    label: 'On-site ATMs/CRMs', short: 'On-site',
    isStock: true, unit: 'count',
    transform: v => v, format: fmtInt,
  },
  off_site: {
    field: 'off_site_atms',
    label: 'Off-site ATMs/CRMs', short: 'Off-site',
    isStock: true, unit: 'count',
    transform: v => v, format: fmtInt,
  },
  micro: {
    field: 'micro_atms',
    label: 'Micro ATMs', short: 'Micro',
    isStock: true, unit: 'count',
    transform: v => v, format: fmtInt,
  },
  dc_vol: {
    field: 'dc_vol',
    label: 'Debit Card Cash Withdrawal Volume', short: 'Debit Vol',
    isStock: false, unit: 'count',
    transform: v => v, format: fmtInt,
  },
  dc_val_cr: {
    field: 'dc_val_thousands',
    label: 'Debit Card Cash Withdrawal Value (Rs Cr)', short: 'Debit Val (Cr)',
    isStock: false, unit: 'currency_cr',
    transform: toCr, format: fmtCr,
  },
  cc_vol: {
    field: 'cc_vol',
    label: 'Credit Card Cash Withdrawal Volume', short: 'Credit Vol',
    isStock: false, unit: 'count',
    transform: v => v, format: fmtInt,
  },
  cc_val_cr: {
    field: 'cc_val_thousands',
    label: 'Credit Card Cash Withdrawal Value (Rs Cr)', short: 'Credit Val (Cr)',
    isStock: false, unit: 'currency_cr',
    transform: toCr, format: fmtCr,
  },
};

export function metric(key) {
  const m = METRICS[key];
  if (!m) throw new Error('Unknown metric: ' + key);
  return m;
}

// ── FORMATTERS ──────────────────────────────────────────────────────────
export function fmtInt(v) {
  if (v == null || isNaN(v)) return '—';
  return Math.round(v).toLocaleString('en-IN');
}
export function fmtCr(v) {
  if (v == null || isNaN(v)) return '—';
  // Compact for very large; 2 decimals if < 100; commas otherwise
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(2)} L Cr`;
  if (v >= 1e3) return `₹${(v / 1e3).toFixed(2)} K Cr`;
  return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr`;
}
export function fmtCompactInt(v) {
  if (v == null || isNaN(v)) return '—';
  if (Math.abs(v) >= 1e7) return (v / 1e7).toFixed(2) + ' Cr';
  if (Math.abs(v) >= 1e5) return (v / 1e5).toFixed(2) + ' L';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + ' K';
  return Math.round(v).toString();
}
export function fmtPct(v, digits = 2) {
  if (v == null || isNaN(v)) return '—';
  return v.toFixed(digits) + '%';
}
export function fmtPP(v, digits = 2) {
  if (v == null || isNaN(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return sign + v.toFixed(digits) + ' pp';
}

// ── PERIOD / FREQUENCY HELPERS ──────────────────────────────────────────
// Periods stored as 'YYYY-MM' strings.
// Indian Financial Year (FY): April-Y to March-(Y+1) is labelled "FY(Y+1)"
//   e.g. Apr 2023 → Mar 2024 = FY24
export function periodKey(period, freq) {
  if (freq === 'M') return period;
  const [y, m] = period.split('-').map(Number);
  if (freq === 'Q') {
    const q = Math.ceil(m / 3);
    return `${y}-Q${q}`;
  }
  if (freq === 'Y') {
    const fy = m >= 4 ? y + 1 : y;
    return `FY${String(fy).slice(-2)}`;
  }
  return period;
}

export function periodLabel(periodOrKey, freq) {
  if (freq === 'M') {
    // 'YYYY-MM' → 'MMM YY'
    const [y, m] = periodOrKey.split('-').map(Number);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[m - 1]} ${String(y).slice(-2)}`;
  }
  return periodOrKey; // 'YYYY-Q1' / 'FY24' as-is
}

// Compare periods chronologically. Each freq has its own ordering.
function sortKeyForFreq(key, freq) {
  if (freq === 'M') return key; // YYYY-MM sorts naturally
  if (freq === 'Q') {
    const [y, q] = key.split('-Q');
    return `${y}-${q.padStart(2, '0')}`;
  }
  if (freq === 'Y') {
    // FY24 → 2024
    return '20' + key.slice(2);
  }
  return key;
}

// ── CORE AGGREGATION ────────────────────────────────────────────────────
// rows: filtered list of rows
// metricKey: key into METRICS
// freq: 'M' | 'Q' | 'Y'
// returns: [{key, label, value}, ...] sorted chronologically
//
// For stock metrics (infra), aggregation across multiple banks is SUM at each
// period, and across periods within a Q/Y bucket is the LATEST period's sum.
// For flow metrics (txn), aggregation across banks is SUM, and across periods
// within a bucket is SUM as well.
export function series(rows, metricKey, freq) {
  const m = metric(metricKey);
  const field = m.field;

  // Step 1: sum across banks per period (YYYY-MM)
  const perMonth = new Map(); // YYYY-MM → number
  for (const r of rows) {
    const v = r[field];
    if (v == null) continue;
    perMonth.set(r.period, (perMonth.get(r.period) ?? 0) + v);
  }

  // Step 2: bucket by freq
  const buckets = new Map(); // key → array of {period, value} sorted by period
  for (const [period, value] of perMonth.entries()) {
    const k = periodKey(period, freq);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push({ period, value });
  }
  for (const arr of buckets.values()) arr.sort((a, b) => a.period.localeCompare(b.period));

  // Step 3: reduce
  const out = [];
  for (const [key, arr] of buckets.entries()) {
    let v;
    if (freq === 'M') {
      v = arr[arr.length - 1].value;
    } else if (m.isStock) {
      // period-end
      v = arr[arr.length - 1].value;
    } else {
      // sum
      v = arr.reduce((s, x) => s + x.value, 0);
    }
    out.push({ key, label: periodLabel(key, freq), value: m.transform(v) });
  }
  out.sort((a, b) => sortKeyForFreq(a.key, freq).localeCompare(sortKeyForFreq(b.key, freq)));
  return out;
}

// ── GROWTH ──────────────────────────────────────────────────────────────
// Given a series array (output of `series`), return parallel array of growth %
// for the chosen growth type. Returns null when previous reference unavailable.
export function growth(seriesArr, type, freq) {
  const out = seriesArr.map(() => null);
  const map = new Map(seriesArr.map((d, i) => [d.key, i]));

  for (let i = 0; i < seriesArr.length; i++) {
    const cur = seriesArr[i];
    let prevKey = null;
    if (type === 'MoM' || type === 'QoQ' /* alias */) {
      if (i > 0) prevKey = seriesArr[i - 1].key;
    } else if (type === '3M') {
      if (freq === 'M' && i >= 3) prevKey = seriesArr[i - 3].key;
      else if (i > 0) prevKey = seriesArr[i - 1].key;
    } else if (type === 'YoY') {
      const offset = freq === 'M' ? 12 : freq === 'Q' ? 4 : 1;
      if (i >= offset) prevKey = seriesArr[i - offset].key;
    }
    if (!prevKey) continue;
    const prev = seriesArr[map.get(prevKey)].value;
    if (prev == null || prev === 0 || cur.value == null) continue;
    out[i] = ((cur.value - prev) / prev) * 100;
  }
  return out;
}

// ── MARKET SHARE / SHARE CHANGE ─────────────────────────────────────────
// Given two series (numerator, denominator), return numerator/denominator * 100.
export function shareSeries(numerator, denominator) {
  const map = new Map(denominator.map(d => [d.key, d.value]));
  return numerator.map(d => {
    const den = map.get(d.key);
    if (den == null || den === 0 || d.value == null) {
      return { ...d, value: null };
    }
    return { ...d, value: (d.value / den) * 100 };
  });
}

// Share change in PERCENTAGE POINTS between consecutive entries (or YoY etc.).
export function shareChange(shareArr, lookback) {
  const out = shareArr.map(() => null);
  for (let i = lookback; i < shareArr.length; i++) {
    const a = shareArr[i].value;
    const b = shareArr[i - lookback].value;
    if (a == null || b == null) continue;
    out[i] = a - b;
  }
  return out;
}

// ── RANKING ────────────────────────────────────────────────────────────
// For the latest period (or specified period), rank all banks by metric.
// rows: filtered rows
// returns: [{bank, value, share}, ...] sorted desc, with optional category filter.
export function rankBanks(rows, metricKey, period, opts = {}) {
  const m = metric(metricKey);
  const field = m.field;
  const subset = rows.filter(r => r.period === period);
  const byBank = new Map();
  for (const r of subset) {
    const v = r[field];
    if (v == null) continue;
    byBank.set(r.bank, { bank: r.bank, category: r.category, value: (byBank.get(r.bank)?.value ?? 0) + v });
  }
  const arr = [...byBank.values()];
  const total = arr.reduce((s, x) => s + x.value, 0);
  for (const e of arr) {
    e.share = total > 0 ? (e.value / total) * 100 : null;
    e.value = m.transform(e.value);
  }
  arr.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
  return arr;
}

// ── ROW FILTERING (applies global filter state) ─────────────────────────
export function filterRows(rows, state) {
  let out = rows;
  if (state.category && state.category !== 'all') {
    out = out.filter(r => r.category === state.category);
  }
  if (state.banks && state.banks.length) {
    const set = new Set(state.banks);
    out = out.filter(r => set.has(r.bank));
  }
  if (state.from) out = out.filter(r => r.period >= state.from);
  if (state.to) out = out.filter(r => r.period <= state.to);
  return out;
}

// Denominator = either "industry total" (all rows ignoring bank filter) or
// "category total" (rows in selected category) — never bank-filtered.
export function denominatorRows(allRows, state) {
  if (state.category && state.category !== 'all') {
    return allRows.filter(r => r.category === state.category);
  }
  return allRows;
}

// ── COMPOSITION DENOM ─────────────────────────────────────────────────
// When view === 'composition', the denominator is a *bundle* of related
// metrics, not just the same metric.
//   on_site / off_site / micro  → sum of (on_site + off_site + micro)
//   dc_vol  / cc_vol            → sum of (dc_vol + cc_vol)
//   dc_val  / cc_val            → sum of (dc_val + cc_val)
// Category filter applies to the denominator; bank filter does NOT.
const COMPOSITION_BUNDLE = {
  on_site:   ['on_site', 'off_site', 'micro'],
  off_site:  ['on_site', 'off_site', 'micro'],
  micro:     ['on_site', 'off_site', 'micro'],
  dc_vol:    ['dc_vol', 'cc_vol'],
  cc_vol:    ['dc_vol', 'cc_vol'],
  dc_val_cr: ['dc_val_cr', 'cc_val_cr'],
  cc_val_cr: ['dc_val_cr', 'cc_val_cr'],
};

export function compositionBundle(metricKey) {
  return COMPOSITION_BUNDLE[metricKey] || [metricKey];
}

export function compositionDenomSeries(allRows, state, freq, metricKey) {
  const bundle = compositionBundle(metricKey);
  const denomRows = denominatorRows(allRows, state);
  let combined = null;
  for (const k of bundle) {
    const s = series(denomRows, k, freq);
    if (!combined) {
      combined = s.map(d => ({ key: d.key, label: d.label, value: d.value }));
    } else {
      const map = new Map(s.map(d => [d.key, d.value]));
      for (const d of combined) {
        const v2 = map.get(d.key);
        if (d.value == null && v2 == null) continue;
        d.value = (d.value ?? 0) + (v2 ?? 0);
      }
    }
  }
  return combined || [];
}

// One entry point used by every tab: given a numerator series, apply the
// current view (absolute / share / composition) and return the final series.
export function applyView(numerator, allRows, state, freq, metricKey) {
  if (state.view === 'share') {
    return shareSeries(numerator, series(denominatorRows(allRows, state), metricKey, freq));
  }
  if (state.view === 'composition') {
    return shareSeries(numerator, compositionDenomSeries(allRows, state, freq, metricKey));
  }
  return numerator;
}

export function isPctView(state) {
  return state.view === 'share' || state.view === 'composition';
}

export function viewLabelShort(state) {
  if (state.view === 'composition') return 'Composition';
  if (state.view === 'share')       return 'Market share';
  return 'Absolute';
}

// Used by chart tooltips / formatters when in a % view.
export function compositionDescription(metricKey) {
  if (['on_site', 'off_site', 'micro'].includes(metricKey)) {
    return '% of (On-site + Off-site + Micro)';
  }
  if (metricKey === 'dc_vol' || metricKey === 'cc_vol') {
    return '% of total card cash-withdrawal volume';
  }
  if (metricKey === 'dc_val_cr' || metricKey === 'cc_val_cr') {
    return '% of total card cash-withdrawal value';
  }
  return '% of bundle';
}
