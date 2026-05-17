// Shared chip catalog used by both the (legacy) Ask tab and the floating
// chatbot. Each chip applies a filter state and (optionally) navigates to
// the tab where the answer lives. Real data, real deep-link — no fake AI.

import { setState } from './state.js';
import { rows } from './data.js';

function pickBanks(preferred) {
  const all = new Set(rows().map(r => r.bank));
  const map = new Map([...all].map(b => [b.toLowerCase(), b]));
  return preferred.map(p => map.get(p.toLowerCase()) || preferred[0]).filter(Boolean);
}

export const CHIPS = [
  {
    label: 'Highest off-site ATM share gain', icon: '↗',
    tabLabel: 'Market Share',
    apply: () => ({ tab: 'market', state: { metric: 'off_site', growthType: 'ShareChange', category: 'all' } }),
  },
  {
    label: 'PSU bank 3M growth', icon: '⏱',
    tabLabel: 'Overview',
    apply: () => ({ tab: 'overview', state: { metric: 'dc_vol', growthType: '3M', category: 'Public Sector' } }),
  },
  {
    label: 'SBI vs Canara vs PNB', icon: '⚖',
    tabLabel: 'Bank Comparison',
    apply: () => ({
      tab: 'compare',
      state: { metric: 'dc_vol', category: 'all',
        banks: pickBanks(['STATE BANK OF INDIA', 'CANARA BANK', 'PUNJAB NATIONAL BANK']) },
    }),
  },
  {
    label: 'HDFC vs ICICI vs Axis (private leaders)', icon: '⚖',
    tabLabel: 'Bank Comparison',
    apply: () => ({
      tab: 'compare',
      state: { metric: 'dc_vol', category: 'all',
        banks: pickBanks(['HDFC BANK LTD', 'ICICI BANK LTD', 'AXIS BANK LTD']) },
    }),
  },
  {
    label: 'Micro ATM share losers', icon: '↘',
    tabLabel: 'Market Share',
    apply: () => ({ tab: 'market', state: { metric: 'micro', growthType: 'ShareChange', category: 'all' } }),
  },
  {
    label: 'Debit cash withdrawal leaders', icon: '★',
    tabLabel: 'Overview',
    apply: () => ({ tab: 'overview', state: { metric: 'dc_vol', view: 'absolute', category: 'all' } }),
  },
  {
    label: 'Credit card spend leaders', icon: '★',
    tabLabel: 'Overview',
    apply: () => ({ tab: 'overview', state: { metric: 'cc_val_cr', view: 'absolute', category: 'all' } }),
  },
  {
    label: 'Top 5 Private bank ATM footprint', icon: '◆',
    tabLabel: 'Market Share',
    apply: () => ({ tab: 'market', state: { metric: 'on_site', category: 'Private Sector' } }),
  },
  {
    label: 'Foreign banks — debit volume share', icon: '⊕',
    tabLabel: 'Market Share',
    apply: () => ({ tab: 'market', state: { metric: 'dc_vol', category: 'Foreign Bank' } }),
  },
  {
    label: 'Payment Banks — Micro ATM rollout', icon: '◈',
    tabLabel: 'Overview',
    apply: () => ({ tab: 'overview', state: { metric: 'micro', category: 'Payment Bank' } }),
  },
  {
    label: 'Small Finance Banks — debit growth YoY', icon: '◇',
    tabLabel: 'Overview',
    apply: () => ({ tab: 'overview', state: { metric: 'dc_vol', growthType: 'YoY', category: 'Small Finance Bank' } }),
  },
];

export function applyChip(i) {
  const def = CHIPS[i].apply();
  if (def.state) setState(def.state);
  if (def.tab && window.navigateTab) window.navigateTab(def.tab);
  return { ...def, label: CHIPS[i].label, tabLabel: CHIPS[i].tabLabel };
}
