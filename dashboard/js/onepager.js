// IC one-pager — snapshots the current tab's charts + KPI cards into a
// clean print sheet and opens the browser print dialog (Save as PDF).

import { getState } from './state.js';
import { metric } from './calc.js';
import { latestPeriod } from './data.js';

export function mount(container) {
  container.innerHTML = `<div class="print-sheet" id="print-sheet"></div>`;
  const btn = document.querySelector('#onepager-btn');
  if (btn) btn.addEventListener('click', generate);
  window.addEventListener('afterprint', () => document.body.classList.remove('printing'));
}

function contextLine() {
  const s = getState();
  const freqName = { M: 'Monthly', Q: 'Quarterly', Y: 'Yearly' }[s.freq] || s.freq;
  const viewName = { absolute: 'Absolute', share: 'Market Share', composition: 'Composition' }[s.view] || s.view;
  return [
    metric(s.metric).label,
    s.category === 'all' ? 'All categories' : s.category,
    (s.banks && s.banks.length) ? s.banks[0] : 'All banks',
    `${s.from || '—'} → ${s.to || latestPeriod()}`,
    freqName, viewName,
  ].join('  ·  ');
}

function generate() {
  const sheet = document.querySelector('#print-sheet');
  const main = document.querySelector('#app-main');
  if (!sheet || !main) return;
  const tabName = document.querySelector('#tabs .tab.active')?.textContent || '';

  // KPI cards (CMS / Data Quality tabs use .dq-card)
  const kpis = [...main.querySelectorAll('.dq-card')].map(c => ({
    label: c.querySelector('.dq-label')?.textContent || '',
    value: c.querySelector('.dq-value')?.textContent || '',
    sub: c.querySelector('.dq-sub')?.textContent || '',
  }));

  // Chart canvases → PNG snapshots via the live ECharts instances
  const blocks = [...main.querySelectorAll('.chart')].map(el => {
    const inst = window.echarts && window.echarts.getInstanceByDom(el);
    if (!inst) return null;
    let img;
    try { img = inst.getDataURL({ pixelRatio: 2, backgroundColor: '#ffffff' }); }
    catch (_) { return null; }
    const card = el.closest('.card');
    return {
      img,
      title: card?.querySelector('.card-title')?.textContent || '',
      sub: card?.querySelector('.card-sub')?.textContent || '',
    };
  }).filter(Boolean);

  if (!blocks.length && !kpis.length) {
    alert('Nothing to export on this tab yet — open a tab with charts.');
    return;
  }

  sheet.innerHTML = `
    <div class="ps-head">
      <div class="ps-title">RBI Banking Analytics — ${tabName}</div>
      <div class="ps-ctx">${contextLine()}</div>
      <div class="ps-stamp">Generated ${new Date().toLocaleString('en-IN')} · Source: RBI</div>
    </div>
    ${kpis.length ? `<div class="ps-kpis">${kpis.map(k => `
      <div class="ps-kpi">
        <div class="ps-kpi-label">${k.label}</div>
        <div class="ps-kpi-value">${k.value}</div>
        <div class="ps-kpi-sub">${k.sub}</div>
      </div>`).join('')}</div>` : ''}
    ${blocks.map(b => `
      <div class="ps-chart">
        <div class="ps-chart-title">${b.title}</div>
        ${b.sub ? `<div class="ps-chart-sub">${b.sub}</div>` : ''}
        <img src="${b.img}" alt="${b.title}">
      </div>`).join('')}
    <div class="ps-foot">Reserve Bank of India · Bank-wise ATM/POS/Card Statistics · rbi.org.in</div>
  `;

  // Wait for the snapshot images to decode before invoking print.
  const imgs = [...sheet.querySelectorAll('img')];
  Promise.all(imgs.map(im => im.complete
    ? Promise.resolve()
    : new Promise(res => { im.onload = im.onerror = res; })))
    .then(() => {
      document.body.classList.add('printing');
      window.print();
    });
}
