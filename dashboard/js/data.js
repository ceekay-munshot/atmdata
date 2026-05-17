// Data loader: fetches manifest + flat row table once, exposes accessors.
// flat.json shape: [{period, bank, category, on_site_atms, off_site_atms,
//                    micro_atms, cc_vol, cc_val_thousands, dc_vol, dc_val_thousands}, ...]

let _manifest = null;
let _rows = null;
let _bankList = null;
let _categoryList = null;
let _bankHasField = null;   // bank → Set of fields where any value > 0

export async function load() {
  if (_manifest && _rows) return;
  const [m, r] = await Promise.all([
    fetch('data/manifest.json').then(r => r.json()),
    fetch('data/flat.json').then(r => r.json()),
  ]);
  _manifest = m;
  _rows = r;

  // Pre-compute derived lists
  const banks = new Set();
  const cats = new Set();
  _bankHasField = new Map();
  const fields = ['on_site_atms', 'off_site_atms', 'micro_atms',
                  'dc_vol', 'dc_val_thousands', 'cc_vol', 'cc_val_thousands'];
  for (const row of _rows) {
    banks.add(row.bank);
    if (row.category) cats.add(row.category);
    let set = _bankHasField.get(row.bank);
    if (!set) { set = new Set(); _bankHasField.set(row.bank, set); }
    for (const f of fields) {
      const v = row[f];
      if (v && v > 0) set.add(f);
    }
  }
  _bankList = [...banks].sort();
  _categoryList = [...cats].sort();
}

export function bankHasField(bank, field) {
  if (!_bankHasField) return true;
  const s = _bankHasField.get(bank);
  return s ? s.has(field) : false;
}

export function manifest() { return _manifest; }
export function rows() { return _rows; }
export function periods() { return _manifest?.periods ?? []; }
export function latestPeriod() { return _manifest?.latest_period ?? null; }
export function firstPeriod() { return _manifest?.first_period ?? null; }
export function allBanks() { return _bankList ?? []; }
export function allCategories() { return _categoryList ?? []; }

// Quick query helpers ────────────────────────────────────────────────────
export function rowsInPeriod(period) {
  return _rows.filter(r => r.period === period);
}

export function rowsForBank(bank) {
  return _rows.filter(r => r.bank === bank);
}

export function banksInCategory(category) {
  if (!category || category === 'all') return _bankList;
  const set = new Set(_rows.filter(r => r.category === category).map(r => r.bank));
  return [...set].sort();
}
