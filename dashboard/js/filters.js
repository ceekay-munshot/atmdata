// Global filter bar — renders once, reads/writes state, broadcasts changes.

import { getState, setState, subscribe } from './state.js';
import { allBanks, allCategories, periods, latestPeriod, firstPeriod, banksInCategory, bankHasField } from './data.js';
import { METRICS } from './calc.js';

const $ = (sel, el = document) => el.querySelector(sel);

const METRIC_OPTIONS = [
  ['on_site',    'On-site ATMs/CRMs'],
  ['off_site',   'Off-site ATMs/CRMs'],
  ['micro',      'Micro ATMs'],
  ['dc_vol',     'Debit Card — Cash W/D Volume'],
  ['dc_val_cr',  'Debit Card — Cash W/D Value (Cr)'],
  ['cc_vol',     'Credit Card — Cash W/D Volume'],
  ['cc_val_cr',  'Credit Card — Cash W/D Value (Cr)'],
];

const GROWTH_OPTIONS = [
  ['MoM',         'MoM',     'Month over Month — current period vs the previous period'],
  ['3M',          '3M',      '3-month — current month vs 3 months ago'],
  ['YoY',         'YoY',     'Year over Year — current period vs same period 1 year ago'],
  ['ShareChange', 'Share Δ', 'Share change in percentage points (pp), YoY — current share minus prior share'],
];

const FREQ_OPTIONS = [
  ['M', 'Monthly',   'One data point per month'],
  ['Q', 'Quarterly', 'Aggregated by calendar quarter (Q1=Jan-Mar etc.)'],
  ['Y', 'Yearly',    'Aggregated by Indian Financial Year (Apr-Mar)'],
];

const VIEW_OPTIONS = [
  ['absolute',    'Absolute',     'Raw values (counts / Rs Cr)'],
  ['share',       'Market Share', 'Each bank as % of selected denominator (industry/category total of the SAME metric)'],
  ['composition', 'Composition',  'Metric as % of its bundle — Micro shown as % of (On-site + Off-site + Micro); Debit Vol as % of total cash-W/D volume etc.'],
];

let _container = null;

export function mount(container) {
  _container = container;
  render();
  subscribe(() => render());
}

function render() {
  if (!_container) return;
  const s = getState();
  const ps = periods();
  const fromVal = s.from || firstPeriod();
  const toVal = s.to || latestPeriod();
  const cats = ['all', ...allCategories()];
  const banks = banksInCategory(s.category);

  _container.innerHTML = `
    <div class="fb-row">
      <div class="fb-group">
        <span class="fb-label">Metric</span>
        <select class="fb-select" id="f-metric" style="min-width:240px">
          ${METRIC_OPTIONS.map(([v, l]) =>
            `<option value="${v}" ${v === s.metric ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>

      <div class="fb-group">
        <span class="fb-label">Category</span>
        <select class="fb-select" id="f-category" style="min-width:160px">
          ${cats.map(c =>
            `<option value="${c}" ${c === s.category ? 'selected' : ''}>${c === 'all' ? 'All categories' : c}</option>`).join('')}
        </select>
      </div>

      <div class="fb-group">
        <span class="fb-label">Bank</span>
        <div class="fb-combo" style="min-width:260px">
          <svg class="fb-combo-search-icon" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/>
          </svg>
          <input type="text" class="fb-select fb-combo-input" id="f-bank-input"
                 placeholder="Type bank name…" autocomplete="off" spellcheck="false"
                 value="${esc(s.banks[0] || '')}">
          <div class="fb-combo-panel" id="f-bank-panel" hidden>
            ${bankOptionsHTML(banks, s)}
            <div class="fb-combo-empty" hidden>No banks match</div>
          </div>
        </div>
      </div>

      <div class="fb-group">
        <span class="fb-label">From</span>
        <input type="month" class="fb-input fb-monthinput" id="f-from"
               min="${firstPeriod()}" max="${latestPeriod()}" value="${fromVal}">
      </div>
      <div class="fb-group">
        <span class="fb-label">To</span>
        <input type="month" class="fb-input fb-monthinput" id="f-to"
               min="${firstPeriod()}" max="${latestPeriod()}" value="${toVal}">
      </div>
    </div>

    <div class="fb-row">
      <div class="fb-group">
        <span class="fb-label" title="How to bucket time">Frequency</span>
        ${segmented('f-freq', FREQ_OPTIONS, s.freq)}
      </div>

      <div class="fb-group">
        <span class="fb-label" title="Show raw values or each bank's % of the chosen denominator">View</span>
        ${segmented('f-view', VIEW_OPTIONS, s.view)}
      </div>

      <div class="fb-group actions no-divider">
        <button class="btn" id="f-reset" title="Reset all filters">Reset</button>
      </div>
    </div>
  `;

  $('#f-metric', _container).onchange = (e) => setState({ metric: e.target.value });
  $('#f-category', _container).onchange = (e) => setState({ category: e.target.value, banks: [] });
  bindBankCombo();
  $('#f-from', _container).onchange = (e) => {
    const v = e.target.value;
    const cur = getState();
    setState({ from: v, to: v > (cur.to || latestPeriod()) ? v : cur.to });
  };
  $('#f-to', _container).onchange = (e) => {
    const v = e.target.value;
    const cur = getState();
    setState({ to: v, from: v < (cur.from || firstPeriod()) ? v : cur.from });
  };
  $('#f-reset', _container).onclick = () => {
    setState({
      metric: 'dc_vol', category: 'all', banks: [],
      from: '2014-01', to: null,
      freq: 'M', view: 'absolute', growthType: 'MoM',
    });
  };

  bindSegmented('f-freq', (v) => setState({ freq: v }));
  bindSegmented('f-view', (v) => setState({ view: v }));
}

function segmented(id, options, currentValue) {
  return `
    <div class="fb-toggle" data-id="${id}">
      ${options.map(([v, l, tip]) =>
        `<button class="fb-toggle-btn ${v === currentValue ? 'active' : ''}" data-value="${v}"${tip ? ` title="${tip}"` : ''}>${l}</button>`).join('')}
    </div>
  `;
}

function bindSegmented(id, onChange) {
  const root = _container.querySelector(`[data-id="${id}"]`);
  if (!root) return;
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('.fb-toggle-btn');
    if (!btn) return;
    const v = btn.dataset.value;
    onChange(v);
  });
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Bank picker option list — banks with data for the current metric first,
// then a separator, then the rest. Each row carries data-value + data-search.
function bankOptionsHTML(banks, s) {
  const field = METRICS[s.metric]?.field;
  const sel = s.banks[0] || '';
  const withData = [], withoutData = [];
  for (const b of banks) {
    if (!field || bankHasField(b, field)) withData.push(b);
    else withoutData.push(b);
  }
  const opt = (val, label, cls = '') =>
    `<div class="fb-combo-opt ${cls} ${val === sel ? 'sel' : ''}" role="option"
          data-value="${esc(val)}" data-search="${esc(label.toLowerCase())}">${esc(label)}</div>`;
  let html = opt('', 'All banks');
  html += withData.map(b => opt(b, b)).join('');
  if (withoutData.length) {
    html += `<div class="fb-combo-sep">no data for this metric</div>`;
    html += withoutData.map(b => opt(b, b, 'muted')).join('');
  }
  return html;
}

// Wire the searchable Bank combobox: focus opens, typing filters, click /
// Enter selects, Escape or click-away cancels.
function bindBankCombo() {
  const input = $('#f-bank-input', _container);
  const panel = $('#f-bank-panel', _container);
  if (!input || !panel) return;
  const opts = [...panel.querySelectorAll('.fb-combo-opt')];
  const seps = [...panel.querySelectorAll('.fb-combo-sep')];
  const emptyMsg = panel.querySelector('.fb-combo-empty');
  const savedValue = input.value;
  let hl = -1;

  const visible = () => opts.filter(o => !o.hidden);
  const paintHl = () => {
    opts.forEach(o => o.classList.remove('hl'));
    const vis = visible();
    if (hl >= 0 && hl < vis.length) {
      vis[hl].classList.add('hl');
      vis[hl].scrollIntoView({ block: 'nearest' });
    }
  };
  const filter = () => {
    const q = input.value.trim().toLowerCase();
    let n = 0;
    for (const o of opts) {
      const hit = !q || o.dataset.search.includes(q);
      o.hidden = !hit;
      if (hit) n++;
    }
    seps.forEach(sep => { sep.hidden = !!q; });
    emptyMsg.hidden = n > 0;
    hl = -1; paintHl();
  };
  const choose = (o) => {
    panel.hidden = true;
    setState({ banks: o.dataset.value ? [o.dataset.value] : [] });
  };

  input.addEventListener('focus', () => { panel.hidden = false; input.select(); });
  input.addEventListener('input', filter);
  input.addEventListener('blur', () => {
    setTimeout(() => { panel.hidden = true; input.value = savedValue; }, 130);
  });
  input.addEventListener('keydown', (e) => {
    const vis = visible();
    if (e.key === 'ArrowDown') { e.preventDefault(); hl = Math.min(hl + 1, vis.length - 1); paintHl(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); hl = Math.max(hl - 1, 0); paintHl(); }
    else if (e.key === 'Enter') { e.preventDefault(); const o = hl >= 0 ? vis[hl] : vis[0]; if (o) choose(o); }
    else if (e.key === 'Escape') { input.value = savedValue; panel.hidden = true; input.blur(); }
  });
  panel.addEventListener('mousedown', (e) => {
    const o = e.target.closest('.fb-combo-opt');
    if (!o) return;
    e.preventDefault();   // keep input focused, avoid blur race
    choose(o);
  });
}
