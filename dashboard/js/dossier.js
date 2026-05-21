// Bank dossier — a slide-over one-pager for a single bank, openable from any
// ranking table. Everything is computed live from the loaded dataset.

import { rows } from './data.js';
import { series, metric, rankBanks, fmtInt } from './calc.js';
import { getState } from './state.js';
import { TOOLTIP_BASE, AXIS_X, AXIS_Y, gradientArea, compactNum, PALETTE } from './chartopts.js';

let _panel = null, _backdrop = null, _body = null;
let _charts = [];

export function mount(container) {
  container.innerHTML = `
    <div class="dossier-backdrop" id="dossier-backdrop"></div>
    <aside class="dossier" id="dossier" aria-hidden="true">
      <div class="dossier-body" id="dossier-body"></div>
    </aside>
  `;
  _backdrop = container.querySelector('#dossier-backdrop');
  _panel = container.querySelector('#dossier');
  _body = container.querySelector('#dossier-body');
  _backdrop.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _panel.classList.contains('open')) close();
  });
  // Expose globally so any tab can deep-link without importing.
  window.openDossier = openDossier;
}

function close() {
  _panel.classList.remove('open');
  _backdrop.classList.remove('open');
  _panel.setAttribute('aria-hidden', 'true');
  disposeCharts();
}

function disposeCharts() {
  for (const c of _charts) { try { c.dispose(); } catch (_) { /* already gone */ } }
  _charts = [];
}

// ── Data ────────────────────────────────────────────────────────────────
function catSlug(cat) {
  if (!cat) return '';
  if (cat.includes('Public'))  return 'public';
  if (cat.includes('Private')) return 'private';
  if (cat.includes('Foreign')) return 'foreign';
  if (cat.includes('Payment')) return 'payment';
  if (cat.includes('Small'))   return 'sfb';
  return '';
}

export function openDossier(bank) {
  if (!_panel) return;
  const all = rows();
  const br = all.filter(r => r.bank === bank);
  if (!br.length) return;
  const state = getState();
  const m = metric(state.metric);
  const category = br[0].category || '—';

  // Latest period this bank reported anything
  const periods = [...new Set(br.map(r => r.period))].sort();
  const latest = periods[periods.length - 1];
  const latestRow = (field) =>
    br.filter(r => r.period === latest).reduce((s, r) => s + (r[field] ?? 0), 0);

  const onLatest = latestRow('on_site_atms');
  const offLatest = latestRow('off_site_atms');
  const dcLatest = latestRow('dc_vol');

  // Market share + rank for the current metric
  const ranked = rankBanks(all, state.metric, latest);
  const rankIdx = ranked.findIndex(r => r.bank === bank);
  const myRank = rankIdx >= 0 ? rankIdx + 1 : null;
  const myShare = rankIdx >= 0 ? ranked[rankIdx].share : null;

  // Fleet trend (on-site + off-site)
  const onS = series(br, 'on_site', 'M');
  const offS = series(br, 'off_site', 'M');
  const offMap = new Map(offS.map(d => [d.key, d.value ?? 0]));
  const fleetLabels = onS.map(d => d.label);
  const fleetVals = onS.map(d => (d.value ?? 0) + (offMap.get(d.key) ?? 0));

  // Market-share trajectory for the current metric
  const indSeries = series(all, state.metric, 'M');
  const indMap = new Map(indSeries.map(d => [d.key, d.value]));
  const bankSeries = series(br, state.metric, 'M');
  const shareLabels = bankSeries.map(d => d.label);
  const shareVals = bankSeries.map(d => {
    const ind = indMap.get(d.key);
    return (ind && d.value != null) ? (d.value / ind) * 100 : null;
  });

  const stat = (label, value) =>
    `<div class="dossier-stat"><div class="dossier-stat-label">${label}</div>
       <div class="dossier-stat-value">${value}</div></div>`;

  _body.innerHTML = `
    <div class="dossier-head">
      <div>
        <div class="dossier-name">${bank}</div>
        <span class="chip ${catSlug(category)}">${category}</span>
        <span class="dossier-asof">as on ${latest}</span>
      </div>
      <button class="dossier-close" id="dossier-close" aria-label="Close">&times;</button>
    </div>
    <div class="dossier-stats">
      ${stat('On-site ATMs', fmtInt(onLatest))}
      ${stat('Off-site ATMs', fmtInt(offLatest))}
      ${stat(m.short + ' rank', myRank ? '#' + myRank + ' of ' + ranked.length : '—')}
      ${stat(m.short + ' share', myShare != null ? myShare.toFixed(2) + '%' : '—')}
    </div>
    <div class="dossier-section">
      <div class="dossier-section-title">ATM Fleet — on-site + off-site</div>
      <div class="dossier-chart" id="dossier-fleet"></div>
    </div>
    <div class="dossier-section">
      <div class="dossier-section-title">Market Share — ${m.label}</div>
      <div class="dossier-chart" id="dossier-share"></div>
    </div>
  `;

  _body.querySelector('#dossier-close').addEventListener('click', close);

  _panel.classList.add('open');
  _backdrop.classList.add('open');
  _panel.setAttribute('aria-hidden', 'false');
  _body.scrollTop = 0;

  disposeCharts();
  // Defer init one frame so the panel has its final width
  requestAnimationFrame(() => {
    const fleetEl = _body.querySelector('#dossier-fleet');
    const shareEl = _body.querySelector('#dossier-share');
    if (!fleetEl || !shareEl) return;

    const fleet = echarts.init(fleetEl);
    fleet.setOption({
      grid: { left: 52, right: 16, top: 14, bottom: 28 },
      tooltip: { ...TOOLTIP_BASE, formatter: (ps) => {
        const p = Array.isArray(ps) ? ps[0] : ps;
        return `<div style="font-weight:600">${p.axisValue}</div>${fmtInt(p.value)} ATMs`;
      } },
      xAxis: { ...AXIS_X, data: fleetLabels, boundaryGap: false },
      yAxis: { ...AXIS_Y, axisLabel: { ...AXIS_Y.axisLabel, formatter: (v) => compactNum(v) } },
      series: [{ type: 'line', smooth: true, showSymbol: false,
        lineStyle: { color: PALETTE[0], width: 2.4 },
        areaStyle: { color: gradientArea(PALETTE[0]) }, data: fleetVals }],
      animation: false,
    });

    const share = echarts.init(shareEl);
    share.setOption({
      grid: { left: 52, right: 16, top: 14, bottom: 28 },
      tooltip: { ...TOOLTIP_BASE, formatter: (ps) => {
        const p = Array.isArray(ps) ? ps[0] : ps;
        return p.value == null ? '' :
          `<div style="font-weight:600">${p.axisValue}</div>${p.value.toFixed(2)}% of industry`;
      } },
      xAxis: { ...AXIS_X, data: shareLabels, boundaryGap: false },
      yAxis: { ...AXIS_Y, axisLabel: { ...AXIS_Y.axisLabel, formatter: (v) => v.toFixed(1) + '%' } },
      series: [{ type: 'line', smooth: true, showSymbol: false,
        lineStyle: { color: PALETTE[5], width: 2.4 },
        areaStyle: { color: gradientArea(PALETTE[5]) }, data: shareVals }],
      animation: false,
    });

    _charts = [fleet, share];
  });
}
