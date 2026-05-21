// CMS Investment Lens — reframes the RBI bank-wise ATM dataset through the
// business of CMS Info Systems (ATM cash management, managed services,
// banking automation). Industry-wide aggregates; follows the global From/To
// and Category filters. The Bank filter is intentionally ignored — this tab
// is about the whole market (CMS's TAM), not a single bank.

import { rows } from '../data.js';
import { getState, subscribe } from '../state.js';
import { series, alignSeries, fmtInt } from '../calc.js';
import { TOOLTIP_BASE, AXIS_X, AXIS_Y, gradientArea, compactNum, setEmptyChart } from '../chartopts.js';

let charts = {};
let _root = null;
let _unsub = null;

const FLEET_COLOR = '#4f46e5';
const OFFSITE_COLOR = '#f59e0b';
const CASH_COLOR = '#10b981';
const DENSITY_COLOR = '#8b5cf6';

const HTML = `
  <div class="grid">
    <div class="card accent">
      <div class="card-head"><div class="card-head-text">
        <div class="card-title">CMS Investment Lens</div>
        <div class="card-sub">RBI bank-wise ATM data read through CMS Info Systems' P&amp;L drivers — fleet size (addressable market), off-site mix (managed-services proxy), cash dispensed (cash-in-transit demand) and cash density per machine. Fleet counts on-site + off-site ATMs/CRMs only; micro/biometric terminals are excluded. Industry-wide; follows the From/To and Category filters.</div>
      </div></div>
    </div>

    <div class="grid grid-4" id="cms-kpis"></div>

    <div class="card">
      <div class="card-head"><div class="card-head-text">
        <div class="card-title">ATM / CRM Fleet — Addressable Market</div>
        <div class="card-sub" id="cms-fleet-sub">—</div>
      </div></div>
      <div class="chart tall" id="cms-fleet"></div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <div class="card-head"><div class="card-head-text">
          <div class="card-title">Off-site ATM Share — Managed-Services Proxy</div>
          <div class="card-sub" id="cms-offsite-sub">—</div>
        </div></div>
        <div class="chart" id="cms-offsite"></div>
      </div>
      <div class="card">
        <div class="card-head"><div class="card-head-text">
          <div class="card-title">Cash Dispensed — Cash-in-Transit Demand</div>
          <div class="card-sub" id="cms-cash-sub">—</div>
        </div></div>
        <div class="chart" id="cms-cash"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><div class="card-head-text">
        <div class="card-title">Cash Intensity per ATM — Revenue Density Proxy</div>
        <div class="card-sub" id="cms-density-sub">—</div>
      </div></div>
      <div class="chart" id="cms-density"></div>
    </div>
  </div>
`;

export function mount(root) {
  _root = root;
  root.innerHTML = HTML;
  charts.fleet   = echarts.init(root.querySelector('#cms-fleet'));
  charts.offsite = echarts.init(root.querySelector('#cms-offsite'));
  charts.cash    = echarts.init(root.querySelector('#cms-cash'));
  charts.density = echarts.init(root.querySelector('#cms-density'));
  window.addEventListener('resize', onResize);
  render();
  _unsub = subscribe(render);
}

export function unmount() {
  for (const c of Object.values(charts)) c.dispose();
  charts = {};
  window.removeEventListener('resize', onResize);
  if (_unsub) { _unsub(); _unsub = null; }
}

function onResize() { for (const c of Object.values(charts)) c.resize(); }

// ── Crore formatting (cash values arrive already in Rs Cr) ──────────────
function crShort(v) {
  if (v == null || isNaN(v)) return '—';
  if (v >= 1e5) return '₹' + (v / 1e5).toFixed(2) + ' L Cr';
  if (v >= 1e3) return '₹' + (v / 1e3).toFixed(1) + 'K Cr';
  if (v >= 100) return '₹' + Math.round(v).toLocaleString('en-IN') + ' Cr';
  return '₹' + v.toFixed(2) + ' Cr';
}

// ── Build the industry aggregate series ─────────────────────────────────
// "Fleet" = on-site + off-site ATMs/CRMs only. Micro-ATMs (biometric/POS
// cash-out terminals deployed by payments banks) are a different segment
// CMS doesn't service, so they're deliberately excluded from the TAM.
function buildSeries(filteredRows, freq) {
  const sets = [
    { name: 'on',  data: series(filteredRows, 'on_site', freq) },
    { name: 'off', data: series(filteredRows, 'off_site', freq) },
    { name: 'dc',  data: series(filteredRows, 'dc_val_cr', freq) },
    { name: 'cc',  data: series(filteredRows, 'cc_val_cr', freq) },
  ];
  const { labels, valuesByEntity } = alignSeries(sets, freq);
  const [onV, offV, dcV, ccV] = valuesByEntity;
  const n = labels.length;
  const fleet = [], offsite = [], offShare = [], cash = [], perAtm = [];
  for (let i = 0; i < n; i++) {
    const on = onV[i] || 0, off = offV[i] || 0;
    const f = on + off;
    const c = (dcV[i] || 0) + (ccV[i] || 0);
    fleet.push(f || null);
    offsite.push(off || null);
    offShare.push(f > 0 ? (off / f) * 100 : null);
    cash.push(c || null);
    perAtm.push(f > 0 ? c / f : null);
  }
  return { labels, fleet, offsite, offShare, cash, perAtm };
}

// Year-ago comparison index step for the active frequency
function yoyStep(freq) { return freq === 'M' ? 12 : freq === 'Q' ? 4 : 1; }

function pctChange(arr, step) {
  let last = null, lastI = -1;
  for (let i = arr.length - 1; i >= 0; i--) { if (arr[i] != null) { last = arr[i]; lastI = i; break; } }
  if (last == null || lastI - step < 0) return null;
  const prev = arr[lastI - step];
  if (prev == null || prev === 0) return null;
  return ((last - prev) / prev) * 100;
}

function lastVal(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
}

function render() {
  const state = getState();
  const filtered = rows().filter(r =>
    (!state.from || r.period >= state.from) &&
    (!state.to || r.period <= state.to) &&
    (state.category === 'all' || r.category === state.category));

  if (!filtered.length) {
    for (const c of Object.values(charts)) setEmptyChart(c, 'No data', 'No rows in the selected range');
    _root.querySelector('#cms-kpis').innerHTML = '';
    return;
  }

  const d = buildSeries(filtered, state.freq);
  renderKpis(d, state.freq);
  renderFleet(d);
  renderOffsite(d);
  renderCash(d);
  renderDensity(d);
}

// ── KPI scorecard ───────────────────────────────────────────────────────
function renderKpis(d, freq) {
  const step = yoyStep(freq);
  const yoyLabel = freq === 'M' ? 'YoY' : freq === 'Q' ? 'YoY' : 'vs prior yr';

  const card = (label, value, arr, { isShare = false } = {}) => {
    const ch = pctChange(arr, step);
    let sub = 'no prior-year point', tone = '';
    if (ch != null) {
      const sign = ch > 0 ? '+' : '';
      sub = `${sign}${ch.toFixed(1)}% ${yoyLabel}`;
      tone = ch > 0.05 ? 'up' : ch < -0.05 ? 'down' : 'warn';
    }
    return { label, value, sub, tone };
  };

  const cards = [
    card('ATM / CRM Fleet', fmtInt(lastVal(d.fleet)), d.fleet),
    card('Off-site ATMs', fmtInt(lastVal(d.offsite)), d.offsite),
    card('Cash Dispensed / mo', crShort(lastVal(d.cash)), d.cash),
    card('Cash per ATM / mo', crShort(lastVal(d.perAtm)), d.perAtm),
  ];

  _root.querySelector('#cms-kpis').innerHTML = cards.map(c => `
    <div class="card dq-card ${c.tone ? 'tone-' + c.tone : ''}">
      <div class="dq-label">${c.label}</div>
      <div class="dq-value">${c.value}</div>
      <div class="dq-sub">${c.sub}</div>
    </div>`).join('');
}

// ── Generic single-series chart ─────────────────────────────────────────
function drawSeries(chart, labels, data, color, { axisFmt, tipFmt, area = true }) {
  chart.setOption({
    grid: { left: 66, right: 26, top: 20, bottom: 38 },
    tooltip: { ...TOOLTIP_BASE,
      formatter: (ps) => {
        const p = Array.isArray(ps) ? ps[0] : ps;
        if (p.value == null) return '';
        return `<div style="font-weight:600;margin-bottom:4px">${p.axisValue}</div>
          <div style="display:flex;align-items:center;gap:6px">
            <span style="width:8px;height:8px;background:${color};border-radius:50%"></span>
            <b>${tipFmt(p.value)}</b></div>`;
      },
    },
    xAxis: { ...AXIS_X, data: labels, boundaryGap: false },
    yAxis: { ...AXIS_Y, axisLabel: { ...AXIS_Y.axisLabel, formatter: axisFmt } },
    series: [{
      type: 'line', smooth: true, showSymbol: false,
      lineStyle: { color, width: 2.6 },
      areaStyle: area ? { color: gradientArea(color) } : undefined,
      data,
    }],
    animation: true, animationDuration: 600,
  }, true);
}

function renderFleet(d) {
  const latest = lastVal(d.fleet);
  _root.querySelector('#cms-fleet-sub').textContent =
    `On-site + off-site ATMs/CRMs operated by banks — the universe CMS can manage. Latest: ${fmtInt(latest)} machines.`;
  drawSeries(charts.fleet, d.labels, d.fleet, FLEET_COLOR, {
    axisFmt: (v) => compactNum(v),
    tipFmt: (v) => fmtInt(v) + ' ATMs',
  });
}

function renderOffsite(d) {
  const latest = lastVal(d.offShare);
  _root.querySelector('#cms-offsite-sub').textContent =
    `Off-site ATMs as a share of the fleet — off-site units are disproportionately outsourced to managed-services vendors. Latest: ${latest != null ? latest.toFixed(1) + '%' : '—'}.`;
  drawSeries(charts.offsite, d.labels, d.offShare, OFFSITE_COLOR, {
    axisFmt: (v) => v.toFixed(0) + '%',
    tipFmt: (v) => v.toFixed(2) + '% of fleet',
    area: false,
  });
}

function renderCash(d) {
  const latest = lastVal(d.cash);
  _root.querySelector('#cms-cash-sub').textContent =
    `Total cash withdrawn from ATMs (debit + credit) — a proxy for cash-in-transit volume. Latest: ${crShort(latest)}.`;
  drawSeries(charts.cash, d.labels, d.cash, CASH_COLOR, {
    axisFmt: (v) => v >= 1e5 ? (v / 1e5).toFixed(1) + 'L' : compactNum(v),
    tipFmt: (v) => crShort(v),
  });
}

function renderDensity(d) {
  const latest = lastVal(d.perAtm);
  _root.querySelector('#cms-density-sub').textContent =
    `Average cash dispensed per machine — higher density supports richer per-ATM service economics. Latest: ${crShort(latest)} per ATM.`;
  drawSeries(charts.density, d.labels, d.perAtm, DENSITY_COLOR, {
    axisFmt: (v) => '₹' + compactNum(v),
    tipFmt: (v) => crShort(v) + ' per ATM',
    area: false,
  });
}
