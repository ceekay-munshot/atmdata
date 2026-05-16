// AI Ask tab — placeholder UI for future natural-language queries.
// No fake AI responses. Example chips deep-link to the relevant tab
// with the appropriate filters already applied — useful right now.

import { setState } from '../state.js';
import { rows } from '../data.js';
import { rankBanks } from '../calc.js';

let _root = null;

const CHIPS = [
  {
    label: 'Highest off-site ATM share gain',
    icon: '↗',
    apply: () => ({ tab: 'market', state: { metric: 'off_site', growthType: 'ShareChange', category: 'all' } }),
  },
  {
    label: 'PSU bank 3M growth',
    icon: '⏱',
    apply: () => ({ tab: 'overview', state: { metric: 'dc_vol', growthType: '3M', category: 'Public Sector' } }),
  },
  {
    label: 'SBI vs Canara vs PNB',
    icon: '⚖',
    apply: () => ({
      tab: 'compare',
      state: { metric: 'dc_vol', category: 'all',
        banks: pickBanks(['STATE BANK OF INDIA', 'CANARA BANK', 'PUNJAB NATIONAL BANK']) },
    }),
  },
  {
    label: 'Micro ATM share losers',
    icon: '↘',
    apply: () => ({ tab: 'market', state: { metric: 'micro', growthType: 'ShareChange', category: 'all' } }),
  },
  {
    label: 'Debit cash withdrawal leaders',
    icon: '★',
    apply: () => ({ tab: 'overview', state: { metric: 'dc_vol', view: 'absolute', category: 'all' } }),
  },
  {
    label: 'Top 5 Private bank ATM footprint',
    icon: '◆',
    apply: () => ({ tab: 'market', state: { metric: 'on_site', category: 'Private Sector' } }),
  },
];

const HTML = `
  <div class="ask-wrap">
    <div class="ask-hero">
      <div class="ask-orb">
        <div class="ask-orb-inner"></div>
      </div>
      <h1 class="ask-title">Ask</h1>
      <p class="ask-tagline">Natural-language analytics for RBI banking data. Coming soon.</p>

      <form class="ask-input-wrap" id="ask-form" autocomplete="off">
        <input class="ask-input" id="ask-input" type="text"
               placeholder="e.g. Which private bank gained the most off-site ATM share last year?" />
        <button class="ask-submit" type="submit" title="Ask (coming soon)">
          <span>Ask</span>
        </button>
      </form>
      <div class="ask-state" id="ask-state">
        <span class="ask-state-dot"></span> AI integration in progress · queries are not yet answered
      </div>
    </div>

    <div class="ask-chips-section">
      <div class="ask-chips-head">Try one of these · they apply filters and open the right tab</div>
      <div class="ask-chips" id="ask-chips"></div>
    </div>
  </div>
`;

export function mount(root) {
  _root = root;
  root.innerHTML = HTML;

  root.querySelector('#ask-chips').innerHTML = CHIPS.map((c, i) => `
    <button class="ask-chip" data-i="${i}">
      <span class="ask-chip-icon">${c.icon}</span>
      <span class="ask-chip-label">${c.label}</span>
    </button>`).join('');

  root.querySelector('#ask-chips').onclick = (e) => {
    const btn = e.target.closest('.ask-chip'); if (!btn) return;
    const def = CHIPS[+btn.dataset.i].apply();
    if (def.state) setState(def.state);
    if (def.tab) window.navigateTab && window.navigateTab(def.tab);
  };

  root.querySelector('#ask-form').onsubmit = (e) => {
    e.preventDefault();
    const input = root.querySelector('#ask-input');
    const state = root.querySelector('#ask-state');
    state.innerHTML = `<span class="ask-state-dot warn"></span> Not yet wired to an AI backend. Try a quick query chip below — they work today.`;
    input.classList.add('shake');
    setTimeout(() => input.classList.remove('shake'), 400);
  };
}

export function unmount() {}

function pickBanks(preferred) {
  const all = new Set(rows().map(r => r.bank));
  // Match case-insensitively to deal with mixed-case names in the dataset
  const map = new Map([...all].map(b => [b.toLowerCase(), b]));
  return preferred.map(p => map.get(p.toLowerCase()) || preferred[0]).filter(Boolean);
}
