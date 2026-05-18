// Data Quality tab — coverage, gaps, reconciliation. Real computations
// against the loaded dataset; no fake numbers.
// Responds to the global From/To and Category filters.

import { rows, manifest, periods as periodsList, firstPeriod, latestPeriod } from '../data.js';
import { getState, subscribe } from '../state.js';
import { exportSheets, currentFilterMeta } from '../export.js';
import { EXCEL_ICON } from '../chartopts.js';

let _root = null;
let _unsub = null;
let _errorsText = '';

const HTML = `
  <div class="grid">
    <div class="dq-banner" id="dq-banner"></div>

    <!-- Validation cards row -->
    <div class="grid grid-3" id="dq-cards"></div>

    <!-- Missing months + Bank issues -->
    <div class="grid grid-2">
      <div class="card">
        <div class="card-head">
          <div class="card-head-text">
            <div class="card-title">Missing Months</div>
            <div class="card-sub" id="dq-miss-sub">—</div>
          </div>
        </div>
        <div class="tbl-wrap" id="dq-missing"></div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="card-head-text">
            <div class="card-title">Bank-name Hygiene</div>
            <div class="card-sub" id="dq-bank-sub">Unmapped categories + potential duplicates (within selected range)</div>
          </div>
        </div>
        <div id="dq-bank-issues"></div>
      </div>
    </div>

    <!-- Outliers -->
    <div class="card">
      <div class="card-head">
        <div class="card-head-text">
          <div class="card-title">Suspicious Month-over-month Moves</div>
          <div class="card-sub" id="dq-out-sub">Industry-total %Δ exceeding ±30% (volume/value) or ±15% (stock)</div>
        </div>
      </div>
      <div class="tbl-wrap" id="dq-outliers"></div>
    </div>

    <!-- Parser error log (global) -->
    <div class="card">
      <div class="card-head">
        <div class="card-head-text">
          <div class="card-title">Parser / Source Log</div>
          <div class="card-sub">Files RBI published that we could not parse — global, not affected by date filter</div>
        </div>
        <div class="card-actions">
          <button class="btn-icon primary" data-export="all" title="Export to Excel">${EXCEL_ICON}</button>
        </div>
      </div>
      <pre id="dq-errors" class="dq-pre"></pre>
    </div>
  </div>
`;

export function mount(root) {
  _root = root;
  root.innerHTML = HTML;
  root.querySelectorAll('[data-export]').forEach(b => b.onclick = () => onExport(b.dataset.export));

  fetch('data/_errors.log')
    .then(r => r.ok ? r.text() : '')
    .catch(() => '')
    .then(t => { _errorsText = t || '(no parser errors logged)'; renderErrorLog(); });

  render();
  _unsub = subscribe(render);
}

export function unmount() {
  if (_unsub) { _unsub(); _unsub = null; }
}

function render() {
  const state = getState();
  const range = resolvedRange(state);
  renderBanner(state, range);
  renderCards(state, range);
  renderMissing(state, range);
  renderBankIssues(state, range);
  renderOutliers(state, range);
  renderErrorLog();
}

function resolvedRange(state) {
  return { from: state.from || firstPeriod(), to: state.to || latestPeriod() };
}

function filteredRows(state, range) {
  let out = rows();
  out = out.filter(r => r.period >= range.from && r.period <= range.to);
  if (state.category && state.category !== 'all') {
    out = out.filter(r => r.category === state.category);
  }
  return out;
}

// ── Banner reminding the user what's currently filtered ─────────────────
function renderBanner(state, range) {
  const banner = _root.querySelector('#dq-banner');
  const catLabel = state.category && state.category !== 'all' ? state.category : 'All categories';
  banner.innerHTML = `
    <div class="dq-banner-inner">
      <span class="dq-banner-tag">Showing</span>
      <span class="dq-banner-val">${range.from}</span> →
      <span class="dq-banner-val">${range.to}</span>
      <span class="dq-banner-sep">·</span>
      <span class="dq-banner-val">${catLabel}</span>
      <span class="dq-banner-sep">·</span>
      <span class="dq-banner-tag">change the From / To / Category in the top bar to refocus</span>
    </div>`;
}

// ── Validation cards ────────────────────────────────────────────────────
function renderCards(state, range) {
  const m = manifest();
  const filt = filteredRows(state, range);

  const expected = monthsBetween(range.from, range.to);
  const have = new Set(filt.map(r => r.period));
  const missing = expected.filter(p => !have.has(p));
  const banks = new Set(filt.map(r => r.bank));
  const unmapped = new Set(filt.filter(r => !r.category).map(r => r.bank));

  const cards = [
    { label: 'Selected latest', value: range.to, tone: 'brand',
      sub: 'latest month in current selection' },
    { label: 'Selected range', value: `${range.from} → ${range.to}`,
      sub: `${have.size} months published / ${expected.length} expected` },
    { label: 'Banks in range',  value: banks.size.toString(),
      sub: unmapped.size ? `${unmapped.size} without category` : 'all categorised',
      tone: unmapped.size > 0 ? 'warn' : null },
    { label: 'Missing months',  value: missing.length.toString(),
      sub: missing.length ? `${(missing.length / expected.length * 100).toFixed(1)}% gap` : 'no gaps',
      tone: missing.length === 0 ? 'up' : missing.length > 12 ? 'down' : 'warn' },
    { label: 'Dataset latest',  value: m.latest_period,
      sub: m.first_period + ' → ' + m.latest_period + ' (' + m.period_count + ' months total)' },
    { label: 'Generated at',    value: m.generated_at.slice(0, 16).replace('T', ' ') + ' UTC',
      sub: 'source: rbi.org.in' },
  ];

  _root.querySelector('#dq-cards').innerHTML = cards.map(c => `
    <div class="card dq-card ${c.tone ? 'tone-' + c.tone : ''}">
      <div class="dq-label">${c.label}</div>
      <div class="dq-value">${c.value}</div>
      ${c.sub ? `<div class="dq-sub">${c.sub}</div>` : ''}
    </div>`).join('');
}

// ── Missing months table ────────────────────────────────────────────────
function renderMissing(state, range) {
  const filt = filteredRows(state, range);
  const expected = monthsBetween(range.from, range.to);
  const have = new Set(filt.map(r => r.period));
  const missing = expected.filter(p => !have.has(p));

  const byYear = new Map();
  for (const p of missing) {
    const y = p.split('-')[0];
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(p.split('-')[1]);
  }
  const years = [...byYear.keys()].sort();

  _root.querySelector('#dq-miss-sub').textContent =
    missing.length ? `${missing.length} of ${expected.length} months not published or unparsed in selected range` : 'No gaps in selected range';

  const wrap = _root.querySelector('#dq-missing');
  if (!missing.length) {
    wrap.innerHTML = `<div class="empty"><div class="empty-title">All months present</div><div class="empty-sub">No gaps between ${range.from} and ${range.to}.</div></div>`;
    return;
  }
  wrap.innerHTML = `
    <table class="tbl">
      <thead><tr><th>Year</th><th class="num">Missing</th><th>Months</th></tr></thead>
      <tbody>${years.map(y => `
        <tr><td><b>${y}</b></td>
            <td class="num">${byYear.get(y).length}</td>
            <td>${byYear.get(y).map(mm => `<span class="chip">${monthName(+mm)}</span>`).join(' ')}</td></tr>
      `).join('')}</tbody>
    </table>`;
}

// ── Bank issues: unmapped + duplicates + reclassifications ─────────────
function renderBankIssues(state, range) {
  const filt = filteredRows(state, range);
  const byBank = new Map();
  for (const r of filt) {
    if (!byBank.has(r.bank)) byBank.set(r.bank, new Set());
    if (r.category) byBank.get(r.bank).add(r.category);
  }
  const unmapped = [];
  for (const [b, cats] of byBank) if (cats.size === 0) unmapped.push(b);

  const normMap = new Map();
  for (const b of byBank.keys()) {
    const k = b.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!normMap.has(k)) normMap.set(k, []);
    normMap.get(k).push(b);
  }
  const dupes = [...normMap.values()].filter(g => g.length > 1);

  const reclassified = [];
  for (const [b, cats] of byBank) if (cats.size > 1) reclassified.push({ bank: b, cats: [...cats] });

  let html = '';
  if (unmapped.length === 0 && dupes.length === 0 && reclassified.length === 0) {
    html = `<div class="empty"><div class="empty-title">Looks clean</div><div class="empty-sub">No unmapped banks, duplicates, or reclassifications detected in the selected range.</div></div>`;
  } else {
    if (unmapped.length) {
      html += `<div class="dq-section">
        <div class="dq-section-head"><span class="badge warn">${unmapped.length}</span> Banks without category</div>
        <div class="dq-chips">${unmapped.map(b => `<span class="chip">${b}</span>`).join('')}</div>
      </div>`;
    }
    if (reclassified.length) {
      html += `<div class="dq-section">
        <div class="dq-section-head"><span class="badge warn">${reclassified.length}</span> Banks with category changes over time</div>
        <table class="tbl mk-mov"><thead><tr><th>Bank</th><th>Categories seen</th></tr></thead>
        <tbody>${reclassified.map(r => `<tr><td>${r.bank}</td><td>${r.cats.join(' → ')}</td></tr>`).join('')}</tbody></table>
      </div>`;
    }
    if (dupes.length) {
      html += `<div class="dq-section">
        <div class="dq-section-head"><span class="badge warn">${dupes.length}</span> Potential duplicate names</div>
        <table class="tbl mk-mov"><thead><tr><th>Normalised key</th><th>Variants</th></tr></thead>
        <tbody>${dupes.map(g => `<tr><td><code>${g[0].toLowerCase().replace(/[^a-z0-9]+/g, '')}</code></td><td>${g.join(' · ')}</td></tr>`).join('')}</tbody></table>
      </div>`;
    }
  }
  _root.querySelector('#dq-bank-issues').innerHTML = html;
}

// ── Suspicious outliers ─────────────────────────────────────────────────
function renderOutliers(state, range) {
  const filt = filteredRows(state, range);
  const periodsInRange = [...new Set(filt.map(r => r.period))].sort();

  const fields = [
    { f: 'on_site_atms',     label: 'On-site ATMs',     thr: 15 },
    { f: 'off_site_atms',    label: 'Off-site ATMs',    thr: 15 },
    { f: 'micro_atms',       label: 'Micro ATMs',       thr: 25 },
    { f: 'dc_vol',           label: 'Debit Cash W/D Vol', thr: 30 },
    { f: 'dc_val_thousands', label: 'Debit Cash W/D Val', thr: 30 },
    { f: 'cc_vol',           label: 'Credit Cash W/D Vol', thr: 30 },
    { f: 'cc_val_thousands', label: 'Credit Cash W/D Val', thr: 30 },
  ];

  const outliers = [];
  for (const { f, label, thr } of fields) {
    const total = new Map();
    for (const r of filt) {
      const v = r[f];
      if (v == null) continue;
      total.set(r.period, (total.get(r.period) ?? 0) + v);
    }
    for (let i = 1; i < periodsInRange.length; i++) {
      const cur = total.get(periodsInRange[i]);
      const prev = total.get(periodsInRange[i - 1]);
      if (cur == null || prev == null || prev === 0) continue;
      const pct = ((cur - prev) / prev) * 100;
      if (Math.abs(pct) >= thr) {
        outliers.push({ period: periodsInRange[i], prev: periodsInRange[i - 1], metric: label, prevVal: prev, curVal: cur, pct });
      }
    }
  }
  outliers.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));

  _root.querySelector('#dq-out-sub').textContent =
    `Within ${range.from} → ${range.to} · ${state.category !== 'all' ? state.category : 'industry'} aggregates · ${outliers.length} flagged`;

  const wrap = _root.querySelector('#dq-outliers');
  if (!outliers.length) {
    wrap.innerHTML = `<div class="empty"><div class="empty-title">No suspicious moves</div><div class="empty-sub">All month-over-month totals are within tolerance for the selected range.</div></div>`;
    return;
  }
  const top = outliers.slice(0, 30);
  wrap.innerHTML = `
    <table class="tbl">
      <thead><tr>
        <th>Month</th><th>vs</th><th>Metric</th>
        <th class="num">Prev</th><th class="num">Current</th><th class="num">Δ %</th>
      </tr></thead>
      <tbody>${top.map(o => `
        <tr>
          <td><b>${o.period}</b></td>
          <td>${o.prev}</td>
          <td>${o.metric}</td>
          <td class="num">${fmtNum(o.prevVal)}</td>
          <td class="num">${fmtNum(o.curVal)}</td>
          <td class="num ${o.pct > 0 ? 'delta-up' : 'delta-down'}">${o.pct > 0 ? '+' : ''}${o.pct.toFixed(1)}%</td>
        </tr>`).join('')}
      </tbody>
    </table>
    ${outliers.length > 30 ? `<div class="dq-foot">…and ${outliers.length - 30} more</div>` : ''}`;
}

function renderErrorLog() {
  const pre = _root && _root.querySelector('#dq-errors');
  if (!pre) return;
  const lines = (_errorsText || '').split(/\r?\n/);
  pre.textContent = lines.slice(0, 200).join('\n') + (lines.length > 200 ? `\n…(${lines.length - 200} more lines)` : '');
}

// ── Helpers ─────────────────────────────────────────────────────────────
function monthsBetween(start, end) {
  const out = [];
  let [y, m] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}
function monthName(m) {
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1];
}
function fmtNum(v) {
  if (v == null) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(0);
}

// ── Export ──────────────────────────────────────────────────────────────
function onExport() {
  const state = getState();
  const range = resolvedRange(state);
  const m = manifest();
  const filt = filteredRows(state, range);

  const expected = monthsBetween(range.from, range.to);
  const have = new Set(filt.map(r => r.period));
  const missing = expected.filter(p => !have.has(p));

  const byBank = new Map();
  for (const r of filt) {
    if (!byBank.has(r.bank)) byBank.set(r.bank, new Set());
    if (r.category) byBank.get(r.bank).add(r.category);
  }
  const unmapped = [...byBank].filter(([_, c]) => c.size === 0).map(([b]) => b);

  const sheets = [
    { name: 'Coverage', rows: [
      ['Field', 'Value'],
      ['Selection — from', range.from],
      ['Selection — to', range.to],
      ['Selection — category', state.category],
      ['Months in selection', have.size],
      ['Expected months', expected.length],
      ['Coverage %', expected.length ? ((have.size / expected.length) * 100).toFixed(2) + '%' : '—'],
      ['Banks in selection', new Set(filt.map(r => r.bank)).size],
      [],
      ['Dataset latest', m.latest_period],
      ['Dataset first', m.first_period],
      ['Dataset total periods', m.period_count],
      ['Manifest generated at', m.generated_at],
      ['Source', 'rbi.org.in — Bankwise ATM/POS/Card Statistics'],
    ]},
    { name: 'Missing Months', rows: [['Period'], ...missing.map(p => [p])] },
    { name: 'Unmapped Banks', rows: [['Bank'], ...unmapped.map(b => [b])] },
    { name: 'Parser Errors', rows: [
      ['Log line'],
      ...(_errorsText || '').split(/\r?\n/).map(l => [l]),
    ]},
  ];

  exportSheets(`data-quality_${new Date().toISOString().slice(0,10)}.xlsx`, sheets, currentFilterMeta({
    'Report type': 'Data Quality',
  }));
}
