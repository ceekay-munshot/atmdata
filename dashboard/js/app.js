// App entry — boots data, mounts filter bar, routes tabs.

import { load, manifest } from './data.js';
import { mount as mountFilters } from './filters.js';
import * as overview from './tabs/overview.js';

const TABS = {
  overview,
  // Stubs for Parts 3-5; rendered as "coming soon" until then.
  infrastructure: stub('Infrastructure Trends', 'On-site / Off-site / Micro ATM analytics — Part 3.'),
  cards:          stub('Card Withdrawal Trends', 'Debit/Credit × Volume/Value analytics — Part 3.'),
  compare:        stub('Bank Comparison', 'Multi-bank comparison view — Part 4.'),
  market:         stub('Market Share / Proportionate', 'Share heatmap & gainers/losers — Part 4.'),
  ask:            stub('Ask', 'ChatGPT-style query interface — Part 5.'),
  quality:        stub('Data Quality', 'Coverage, gaps, reconciliation — Part 5.'),
};

let currentTab = null;

async function boot() {
  try {
    await load();
  } catch (e) {
    console.error('Data load failed:', e);
    document.querySelector('#loading-veil').innerHTML =
      `<div class="loader"><div class="loader-text">Failed to load data: ${e.message}</div></div>`;
    return;
  }

  mountFilters(document.querySelector('#filter-bar'));
  wireTabs();
  setFooter();
  activateTab('overview');

  // hide veil
  const veil = document.querySelector('#loading-veil');
  veil.classList.add('gone');
  setTimeout(() => veil.remove(), 300);
}

function wireTabs() {
  document.querySelector('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    activateTab(btn.dataset.tab);
  });
}

function activateTab(name) {
  if (currentTab && currentTab.unmount) currentTab.unmount();
  document.querySelectorAll('#tabs .tab').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === name));
  const tab = TABS[name];
  if (!tab) return;
  const main = document.querySelector('#app-main');
  main.innerHTML = '';
  tab.mount(main);
  currentTab = tab;
}

function setFooter() {
  const m = manifest();
  if (!m) return;
  document.querySelector('#foot-meta').textContent =
    `${m.period_count} months · ${m.first_period} → ${m.latest_period} · ${m.bank_count} banks · generated ${m.generated_at.slice(0, 10)}`;
}

function stub(title, msg) {
  return {
    mount(root) {
      root.innerHTML = `
        <div class="card">
          <div class="empty">
            <div class="empty-title">${title}</div>
            <div class="empty-sub">${msg}</div>
          </div>
        </div>
      `;
    },
    unmount() {},
  };
}

boot();
