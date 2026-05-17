// App entry — boots data, mounts filter bar, routes tabs.

import { load, manifest } from './data.js';
import { mount as mountFilters } from './filters.js';
import * as overview from './tabs/overview.js';
import * as infrastructure from './tabs/infrastructure.js';
import * as cards from './tabs/cards.js';
import * as compare from './tabs/compare.js';
import * as market from './tabs/market.js';
import * as quality from './tabs/quality.js';
// Ask is now a floating chatbot, not a tab. To revert to a tab:
//   1. `import * as ask from './tabs/ask.js';`
//   2. add `ask` to TABS below
//   3. add <button class="tab" data-tab="ask">Ask</button> in index.html
//   4. remove the chatbot import + mount below
import { mount as mountChatbot } from './chatbot.js';

const TABS = { overview, infrastructure, cards, compare, market, quality };

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
  // Expose so the chatbot (and any tab) can deep-link
  window.navigateTab = activateTab;
  activateTab('overview');
  mountChatbot(document.querySelector('#chatbot-mount'));

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
