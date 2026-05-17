// Floating chatbot (Intercom-style). Bubble bottom-right; click → chat panel.
// Reuses chips.js so the suggestions stay in sync with the Ask tab if it's
// ever re-enabled.

import { CHIPS, applyChip } from './chips.js';

let _open = false;
let _msgEl = null;

const ICON_CHAT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8.5 8.5 0 0 1-12.6 7.5L3 21l1.5-5.4A8.5 8.5 0 1 1 21 12z"/></svg>`;
const ICON_CLOSE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
const ICON_SEND  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;
const ICON_SPARK = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.7 5.5L19 9l-5.3 1.5L12 16l-1.7-5.5L5 9l5.3-1.5z"/></svg>`;

const HTML = `
  <button class="cb-launcher" id="cb-launcher" aria-label="Open assistant" title="Ask the dashboard">
    <span class="cb-launcher-icon">${ICON_CHAT}</span>
    <span class="cb-launcher-pulse"></span>
  </button>

  <div class="cb-panel" id="cb-panel" hidden role="dialog" aria-label="Dashboard assistant">
    <div class="cb-header">
      <div class="cb-header-text">
        <div class="cb-orb">${ICON_SPARK}</div>
        <div>
          <div class="cb-title">Ask the dashboard</div>
          <div class="cb-status"><span class="cb-status-dot"></span> AI in progress</div>
        </div>
      </div>
      <button class="cb-close" id="cb-close" aria-label="Close">${ICON_CLOSE}</button>
    </div>

    <div class="cb-body" id="cb-body"></div>

    <form class="cb-input-wrap" id="cb-form" autocomplete="off">
      <input class="cb-input" id="cb-input" type="text"
             placeholder="Ask anything about RBI bank data…" />
      <button class="cb-send" type="submit" aria-label="Send" title="Send">${ICON_SEND}</button>
    </form>
  </div>
`;

export function mount(container) {
  container.innerHTML = HTML;

  const launcher = container.querySelector('#cb-launcher');
  const panel    = container.querySelector('#cb-panel');
  const closeBtn = container.querySelector('#cb-close');
  const body     = container.querySelector('#cb-body');
  const form     = container.querySelector('#cb-form');
  const input    = container.querySelector('#cb-input');

  _msgEl = body;
  resetConversation();

  launcher.onclick = () => toggle(true, launcher, panel, input);
  closeBtn.onclick = () => toggle(false, launcher, panel, input);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && _open) toggle(false, launcher, panel, input); });

  body.addEventListener('click', (e) => {
    const btn = e.target.closest('.cb-chip'); if (!btn) return;
    handleChip(+btn.dataset.i);
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    addMsg('user', text);
    input.value = '';
    setTimeout(() => {
      addMsg('assistant', `I can't answer free-form questions yet — AI is not wired. Try one of these saved queries:`);
      addChips();
      scrollToBottom();
    }, 280);
  });
}

function toggle(open, launcher, panel, input) {
  _open = open;
  panel.hidden = !open;
  launcher.classList.toggle('hidden', open);
  if (open) {
    panel.classList.add('cb-pop-in');
    setTimeout(() => panel.classList.remove('cb-pop-in'), 220);
    input.focus();
    scrollToBottom();
  }
}

function resetConversation() {
  _msgEl.innerHTML = '';
  addMsg('assistant',
    `Hi — I'm a placeholder for the AI assistant we're wiring up. ` +
    `I can already open the right tab with the right filters for any of the saved queries below.`);
  addChips();
}

function addMsg(role, text) {
  const div = document.createElement('div');
  div.className = `cb-msg ${role}`;
  div.textContent = text;
  _msgEl.appendChild(div);
  scrollToBottom();
}

function addChips() {
  const wrap = document.createElement('div');
  wrap.className = 'cb-chips';
  wrap.innerHTML = CHIPS.map((c, i) => `
    <button class="cb-chip" data-i="${i}" type="button">
      <span class="cb-chip-icon">${c.icon}</span>
      <span class="cb-chip-label">${c.label}</span>
      <span class="cb-chip-tab">${c.tabLabel}</span>
    </button>`).join('');
  _msgEl.appendChild(wrap);
  scrollToBottom();
}

function handleChip(i) {
  const c = CHIPS[i];
  addMsg('user', c.label);
  setTimeout(() => {
    const def = applyChip(i);
    addMsg('assistant',
      `Opened the ${def.tabLabel} tab with the matching filters. ` +
      `You'll see ${c.label.toLowerCase()} reflected there.`);
  }, 200);
}

function scrollToBottom() {
  if (_msgEl) _msgEl.scrollTop = _msgEl.scrollHeight;
}
