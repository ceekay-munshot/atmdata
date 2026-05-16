// Excel export helper. Each tab calls `exportSheets(filename, sheets, filterMeta)`
// where sheets = [{name, rows: [[...]]}] and filterMeta = list of key-value rows.

import { getState } from './state.js';
import { METRICS } from './calc.js';

const METRIC_LABEL = Object.fromEntries(Object.entries(METRICS).map(([k, m]) => [k, m.label]));
const FREQ_LABEL = { M: 'Monthly', Q: 'Quarterly', Y: 'Yearly' };
const VIEW_LABEL = { absolute: 'Absolute', share: 'Market Share' };

export function currentFilterMeta(extra = {}) {
  const s = getState();
  return [
    ['Generated at', new Date().toISOString()],
    ['Metric', METRIC_LABEL[s.metric] || s.metric],
    ['Category', s.category],
    ['Banks', s.banks.length ? s.banks.join(', ') : 'All'],
    ['From', s.from || 'earliest'],
    ['To', s.to || 'latest'],
    ['Frequency', FREQ_LABEL[s.freq] || s.freq],
    ['View', VIEW_LABEL[s.view] || s.view],
    ['Growth type', s.growthType],
    ...Object.entries(extra).map(([k, v]) => [k, v]),
  ];
}

export function exportSheets(filename, sheets, filterMeta) {
  const wb = XLSX.utils.book_new();

  // Always prepend a Filters sheet
  const filterSheet = XLSX.utils.aoa_to_sheet([
    ['RBI Banking Analytics — Export'],
    [],
    ['Key', 'Value'],
    ...(filterMeta || currentFilterMeta()),
  ]);
  applyHeaderStyle(filterSheet, 2);
  autoWidth(filterSheet);
  XLSX.utils.book_append_sheet(wb, filterSheet, 'Filters');

  for (const sheet of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(sheet.rows);
    applyHeaderStyle(ws, 0);
    autoWidth(ws);
    if (sheet.rows.length > 0) {
      ws['!freeze'] = { xSplit: 0, ySplit: 1 };
    }
    XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31));
  }

  XLSX.writeFile(wb, filename);
}

function applyHeaderStyle(ws, headerRowIdx) {
  // SheetJS community edition doesn't apply cell styles in writeFile by default
  // (Pro feature). We just freeze the header row instead — readers can format.
  ws['!freeze'] = { xSplit: 0, ySplit: headerRowIdx + 1 };
}

function autoWidth(ws) {
  const ref = ws['!ref'];
  if (!ref) return;
  const range = XLSX.utils.decode_range(ref);
  const widths = [];
  for (let C = range.s.c; C <= range.e.c; C++) {
    let max = 8;
    for (let R = range.s.r; R <= range.e.r; R++) {
      const addr = XLSX.utils.encode_cell({ r: R, c: C });
      const cell = ws[addr];
      if (cell && cell.v != null) {
        const len = String(cell.v).length;
        if (len > max) max = len;
      }
    }
    widths.push({ wch: Math.min(max + 2, 50) });
  }
  ws['!cols'] = widths;
}
