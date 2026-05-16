// Data Quality tab — coverage, gaps, reconciliation. Real computations
// against the loaded dataset; no fake numbers.

import { rows, manifest, periods as periodsList, allBanks, allCategories } from '../data.js';
import { METRICS } from '../calc.js';
import { exportSheets, currentFilterMeta } from '../export.js';

let _root = null;
let _errorsText = '';

const HTML = `
  <div class="grid">
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
            <div class="card-sub">Unmapped categories + potential duplicates</div>
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
          <div class="card-sub">Industry-total %Δ exceeding ±30% (volume/value) or ±15% (stock)</div>
        </div>
      </div>
      <div class="tbl-wrap" id="dq-outliers"></div>
    </div>

    <!-- Parser error log -->
    <div class="card">
      <div class="card-head">
        <div class="card-head-text">
          <div class="card-title">Parser / Source Log</div>
          <div class="card-sub">Files RBI published that we could not parse (see data/_errors.log)</div>
        </div>
        <div class="card-actions">
          <button class="btn primary" data-export="all">Export Data Quality Report</button>
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

  // Pull _errors.log (best-effort)
  fetch('data/_errors.log')
    .then(r => r.ok ? r.text() : '')
    .catch(() => '')
    .then(t => { _errorsText = t || '(no parser errors logged)'; renderErrorLog(); });

  render();
}

export function unmount() {}

function render() {
  renderCards();
  renderMissing();
  renderBankIssues();
  renderOutliers();
  renderErrorLog();
}

// ── Validation cards ────────────────────────────────────────────────────
function renderCards() {
  const m = manifest();
  const allRows = rows();

  const expected = monthsBetween(m.first_period, m.latest_period);
  const have = new Set(m.periods);
  const missing = expected.filter(p => !have.has(p));

  const unmapped = new Set();
  const banks = new Set();
  for (const r of allRows) {
    banks.add(r.bank);
    if (!r.category) unmapped.add(r.bank);
  }

  const cards = [
    { label: 'Latest data month',    value: m.latest_period, tone: 'brand' },
    { label: 'Data range',           value: `${m.first_period} → ${m.latest_period}`,
      sub: `${m.period_count} months published / ${expected.length} expected` },
    { label: 'Banks observed',       value: m.bank_count.toString(),
      sub: `${unmapped.size} without category mapping`, tone: unmapped.size > 0 ? 'warn' : null },
    { label: 'Missing months',       value: missing.length.toString(),
      sub: missing.length ? `coverage gap = ${(missing.length/expected.length*100).toFixed(1)}%` : 'no gaps',
      tone: missing.length === 0 ? 'up' : missing.length > 20 ? 'down' : 'warn' },
    { label: 'Generated at',         value: m.generated_at.slice(0, 16).replace('T', ' ') + ' UTC',
      sub: 'auto-refreshed by GitHub Action twice a month' },
    { label: 'Source',               value: 'rbi.org.in',
      sub: 'Bankwise ATM/POS/Card Statistics (Data Releases)' },
  ];

  _root.querySelector('#dq-cards').innerHTML = cards.map(c => `
    <div class="card dq-card ${c.tone ? 'tone-' + c.tone : ''}">
      <div class="dq-label">${c.label}</div>
      <div class="dq-value">${c.value}</div>
      ${c.sub ? `<div class="dq-sub">${c.sub}</div>` : ''}
    </div>`).join('');
}

// ── Missing months table ────────────────────────────────────────────────
function renderMissing() {
  const m = manifest();
  const expected = monthsBetween(m.first_period, m.latest_period);
  const have = new Set(m.periods);
  const missing = expected.filter(p => !have.has(p));

  // Group by year
  const byYear = new Map();
  for (const p of missing) {
    const y = p.split('-')[0];
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(p.split('-')[1]);
  }
  const years = [...byYear.keys()].sort();

  _root.querySelector('#dq-miss-sub').textContent =
    missing.length ? `${missing.length} of ${expected.length} months not published or unparsed` : 'No gaps';

  const wrap = _root.querySelector('#dq-missing');
  if (!missing.length) {
    wrap.innerHTML = `<div class="empty"><div class="empty-title">All months present</div><div class="empty-sub">No gaps between ${m.first_period} and ${m.latest_period}.</div></div>`;
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

// ── Bank issues: unmapped + duplicates ──────────────────────────────────
function renderBankIssues() {
  const allRows = rows();
  const byBank = new Map();   // bank → category set
  for (const r of allRows) {
    if (!byBank.has(r.bank)) byBank.set(r.bank, new Set());
    if (r.category) byBank.get(r.bank).add(r.category);
  }
  const unmapped = [];
  for (const [b, cats] of byBank) if (cats.size === 0) unmapped.push(b);

  // Potential dupes: same normalised name
  const normMap = new Map();
  for (const b of byBank.keys()) {
    const k = b.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!normMap.has(k)) normMap.set(k, []);
    normMap.get(k).push(b);
  }
  const dupes = [...normMap.values()].filter(g => g.length > 1);

  // Banks where category changed across months (data inconsistency)
  const reclassified = [];
  for (const [b, cats] of byBank) if (cats.size > 1) reclassified.push({ bank: b, cats: [...cats] });

  let html = '';

  if (unmapped.length === 0 && dupes.length === 0 && reclassified.length === 0) {
    html = `<div class="empty"><div class="empty-title">Looks clean</div><div class="empty-sub">No unmapped banks, duplicates, or reclassifications detected.</div></div>`;
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
function renderOutliers() {
  const allRows = rows();
  const periods = periodsList();

  const STOCK = new Set(['on_site_atms', 'off_site_atms', 'micro_atms']);
  const fields = [
    { f: 'on_site_atms',     label: 'On-site ATMs',     stock: true,  thr: 15 },
    { f: 'off_site_atms',    label: 'Off-site ATMs',    stock: true,  thr: 15 },
    { f: 'micro_atms',       label: 'Micro ATMs',       stock: true,  thr: 25 },
    { f: 'dc_vol',           label: 'Debit Cash W/D Vol', stock: false, thr: 30 },
    { f: 'dc_val_thousands', label: 'Debit Cash W/D Val', stock: false, thr: 30 },
    { f: 'cc_vol',           label: 'Credit Cash W/D Vol', stock: false, thr: 30 },
    { f: 'cc_val_thousands', label: 'Credit Cash W/D Val', stock: false, thr: 30 },
  ];

  const outliers = [];
  for (const { f, label, thr } of fields) {
    const total = new Map();
    for (const r of allRows) {
      const v = r[f];
      if (v == null) continue;
      total.set(r.period, (total.get(r.period) ?? 0) + v);
    }
    for (let i = 1; i < periods.length; i++) {
      const cur = total.get(periods[i]);
      const prev = total.get(periods[i - 1]);
      if (cur == null || prev == null || prev === 0) continue;
      const pct = ((cur - prev) / prev) * 100;
      if (Math.abs(pct) >= thr) {
        outliers.push({ period: periods[i], prev: periods[i - 1], metric: label, prevVal: prev, curVal: cur, pct });
      }
    }
  }
  outliers.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));

  const wrap = _root.querySelector('#dq-outliers');
  if (!outliers.length) {
    wrap.innerHTML = `<div class="empty"><div class="empty-title">No suspicious moves</div><div class="empty-sub">All month-over-month industry totals are within tolerance.</div></div>`;
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
  // Trim to first ~80 lines, keep size reasonable
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
  const m = manifest();
  const allRows = rows();
  const expected = monthsBetween(m.first_period, m.latest_period);
  const have = new Set(m.periods);
  const missing = expected.filter(p => !have.has(p));

  const byBank = new Map();
  for (const r of allRows) {
    if (!byBank.has(r.bank)) byBank.set(r.bank, new Set());
    if (r.category) byBank.get(r.bank).add(r.category);
  }
  const unmapped = [...byBank].filter(([_, c]) => c.size === 0).map(([b]) => b);

  const sheets = [
    { name: 'Coverage', rows: [
      ['Field', 'Value'],
      ['Latest data month', m.latest_period],
      ['First data month', m.first_period],
      ['Total periods published', m.period_count],
      ['Total expected periods', expected.length],
      ['Coverage %', expected.length ? ((m.period_count / expected.length) * 100).toFixed(2) + '%' : '—'],
      ['Banks observed', m.bank_count],
      ['Categories', m.categories.join(', ')],
      ['Manifest generated at', m.generated_at],
      ['Source', 'rbi.org.in — Bankwise ATM/POS/Card Statistics'],
    ]},
    { name: 'Missing Months', rows: [
      ['Period'],
      ...missing.map(p => [p]),
    ]},
    { name: 'Unmapped Banks', rows: [
      ['Bank'],
      ...unmapped.map(b => [b]),
    ]},
    { name: 'Parser Errors', rows: [
      ['Log line'],
      ...(_errorsText || '').split(/\r?\n/).map(l => [l]),
    ]},
  ];

  exportSheets(`data-quality_${new Date().toISOString().slice(0,10)}.xlsx`, sheets, currentFilterMeta({
    'Report type': 'Data Quality',
  }));
}
