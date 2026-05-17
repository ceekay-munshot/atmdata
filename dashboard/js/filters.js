// Global filter bar — renders once, reads/writes state, broadcasts changes.

import { getState, setState, subscribe } from './state.js';
import { allBanks, allCategories, periods, latestPeriod, firstPeriod, banksInCategory } from './data.js';
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
  ['absolute', 'Absolute',     'Raw values (counts / Rs Cr)'],
  ['share',    'Market Share', 'Each bank as % of selected denominator (industry or category total)'],
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
        <select class="fb-select" id="f-bank" style="min-width:220px">
          <option value="">All banks</option>
          ${banks.map(b =>
            `<option value="${b}" ${s.banks[0] === b ? 'selected' : ''}>${b}</option>`).join('')}
        </select>
      </div>

      <div class="fb-group">
        <span class="fb-label">From</span>
        <select class="fb-select" id="f-from" style="min-width:120px">
          ${ps.map(p => `<option value="${p}" ${p === fromVal ? 'selected' : ''}>${p}</option>`).join('')}
        </select>
      </div>
      <div class="fb-group">
        <span class="fb-label">To</span>
        <select class="fb-select" id="f-to" style="min-width:120px">
          ${ps.map(p => `<option value="${p}" ${p === toVal ? 'selected' : ''}>${p}</option>`).join('')}
        </select>
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

      <div class="fb-group">
        <span class="fb-label" title="Drives the Growth/De-growth chart and the growth column in tables">Growth</span>
        ${segmented('f-growth', GROWTH_OPTIONS, s.growthType)}
      </div>

      <div class="fb-group actions no-divider">
        <button class="btn" id="f-reset" title="Reset all filters">Reset</button>
      </div>
    </div>
  `;

  $('#f-metric', _container).onchange = (e) => setState({ metric: e.target.value });
  $('#f-category', _container).onchange = (e) => setState({ category: e.target.value, banks: [] });
  $('#f-bank', _container).onchange = (e) => setState({ banks: e.target.value ? [e.target.value] : [] });
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
  bindSegmented('f-growth', (v) => setState({ growthType: v }));
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
