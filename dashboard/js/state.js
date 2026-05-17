// Global filter / toggle state. Components subscribe; state is the single source of truth.

const DEFAULTS = {
  // Filters
  metric: 'dc_vol',          // see METRICS in calc.js
  category: 'all',           // category label | 'all'
  banks: [],                 // multi-select; [] means "no specific bank filter"
  from: '2014-01',           // default focus = Jan 2014 onwards (pre-2014 is patchy)
  to: null,                  // null = always pin to latest available period
  // Toggles
  freq: 'M',                 // 'M' | 'Q' | 'Y'
  view: 'absolute',          // 'absolute' | 'share'
  growthType: 'MoM',         // 'MoM' | '3M' | 'YoY' | 'ShareChange'
  // Tab-local toggles (Card tab)
  cardSide: 'debit',         // 'debit' | 'credit'
  cardMeasure: 'volume',     // 'volume' | 'value'
};

let _state = { ...DEFAULTS };
const listeners = new Set();

export function getState() { return { ..._state }; }
export function setState(patch) {
  let changed = false;
  for (const k of Object.keys(patch)) {
    if (_state[k] !== patch[k]) {
      _state[k] = patch[k];
      changed = true;
    }
  }
  if (changed) {
    for (const l of listeners) l(_state);
  }
}
export function resetState() { _state = { ...DEFAULTS }; for (const l of listeners) l(_state); }
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
