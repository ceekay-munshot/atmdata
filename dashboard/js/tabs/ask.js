// AI Ask tab (currently NOT mounted as a tab — see chatbot.js for the
// floating-bubble version. Kept here for easy revert: re-register in
// app.js TABS and re-add the tab button in index.html to restore.)

import { CHIPS, applyChip } from '../chips.js';

let _root = null;

const HTML = `
  <div class="ask-wrap">
    <div class="ask-hero">
      <div class="ask-orb"><div class="ask-orb-inner"></div></div>
      <h1 class="ask-title">Ask</h1>
      <p class="ask-tagline">Natural-language analytics for RBI banking data. Coming soon.</p>

      <form class="ask-input-wrap" id="ask-form" autocomplete="off">
        <input class="ask-input" id="ask-input" type="text"
               placeholder="e.g. Which private bank gained the most off-site ATM share last year?" />
        <button class="ask-submit" type="submit" title="Ask (coming soon)"><span>Ask</span></button>
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
    applyChip(+btn.dataset.i);
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
