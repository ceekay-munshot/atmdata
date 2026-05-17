"""Year-by-year data sanity report. Run as: python3 year_check.py 2026

For the chosen year:
  - industry totals per month for every metric
  - parser format used per month (modern / transition / legacy / legacy_narrow)
  - source file used per month
  - top 5 banks per metric in the latest month of the year
  - reconciliation against RBI's "Total" row in the raw XLSX where available
"""

import json
import sys
from pathlib import Path

import pandas as pd

YEAR = sys.argv[1] if len(sys.argv) > 1 else "2026"

DATA = json.loads((Path(__file__).parent.parent / "data" / "flat.json").read_text())
RAW = Path(__file__).parent.parent / "data" / "raw"

year_rows = [r for r in DATA if r["period"].startswith(YEAR)]
months = sorted({r["period"] for r in year_rows})

# Load per-month processed JSON to get source_file + format
PROC = Path(__file__).parent.parent / "data" / "processed"
meta_by_month = {}
for m in months:
    p = PROC / f"{m}.json"
    if p.exists():
        meta = json.loads(p.read_text())
        meta_by_month[m] = (meta.get("source_file", "?"), meta.get("format", "?"))

# ── Helpers ──────────────────────────────────────────────────────────────
def fmt_count(v):
    if v >= 1e9: return f"{v/1e9:.2f}B"
    if v >= 1e6: return f"{v/1e6:.2f}M"
    if v >= 1e3: return f"{v/1e3:.2f}K"
    return f"{v:.0f}"

def fmt_cr(v_thou):
    # Rs '000 → Rs Cr (÷ 10,000)
    v = v_thou / 1e4
    if v >= 1e5: return f"₹{v/1e5:.2f} L Cr"
    if v >= 1e3: return f"₹{v/1e3:.2f} K Cr"
    return f"₹{v:.0f} Cr"

print(f"\n{'='*100}")
print(f"YEAR {YEAR} — DATA SANITY REPORT")
print(f"{'='*100}\n")

print(f"Months captured: {len(months)}/12 → {' '.join(m[5:] for m in months)}\n")

# ── Industry totals per month ────────────────────────────────────────────
print(f"{'─'*100}")
print(f"INDUSTRY TOTALS PER MONTH (sum across all banks)")
print(f"{'─'*100}")

hdrs = ["Month", "Banks", "On-site", "Off-site", "Micro", "Debit Vol", "Debit Val", "Credit Vol", "Credit Val", "Format", "Source"]
widths = [9, 6, 10, 10, 10, 12, 14, 11, 14, 14, 50]
print("  " + "  ".join(f"{h:<{w}}" for h, w in zip(hdrs, widths)))

for m in months:
    rows = [r for r in year_rows if r["period"] == m]
    sums = {f: sum(r.get(f, 0) or 0 for r in rows) for f in
            ["on_site_atms", "off_site_atms", "micro_atms", "dc_vol",
             "dc_val_thousands", "cc_vol", "cc_val_thousands"]}
    src, fmt = meta_by_month.get(m, ("?", "?"))
    src_short = src[:48] + "…" if len(src) > 48 else src
    vals = [
        m, str(len(rows)),
        fmt_count(sums["on_site_atms"]),
        fmt_count(sums["off_site_atms"]),
        fmt_count(sums["micro_atms"]),
        fmt_count(sums["dc_vol"]),
        fmt_cr(sums["dc_val_thousands"]),
        fmt_count(sums["cc_vol"]),
        fmt_cr(sums["cc_val_thousands"]),
        fmt,
        src_short,
    ]
    print("  " + "  ".join(f"{v:<{w}}" for v, w in zip(vals, widths)))

# ── Reconciliation against raw file grand-total row ──────────────────────
print(f"\n{'─'*100}")
print(f"RECONCILIATION vs RBI's GRAND TOTAL row in the raw XLSX (latest month)")
print(f"{'─'*100}")

latest = months[-1]
src, fmt = meta_by_month.get(latest, (None, None))
if not src:
    print("No source file recorded for latest month.")
else:
    path = RAW / src
    engine = "xlrd" if path.suffix.lower() == ".xls" else "openpyxl"
    df = pd.read_excel(path, sheet_name=0, header=None, engine=engine)
    # find row whose first cell or col 1 contains "Total"
    total_row = None
    for i in range(len(df)):
        for c in (0, 1, 2):
            if c < df.shape[1]:
                v = df.iat[i, c]
                if isinstance(v, str) and v.strip().lower() in ("total", "grand total"):
                    total_row = i; break
        if total_row is not None: break

    if total_row is None:
        print(f"No Total row found in {src}")
    else:
        print(f"Reading 'Total' row {total_row} from {src}")
        print(f"\nMetric              {'Parser sum':>18}  {'RBI Total':>18}  {'Match':>8}")
        # Map each metric to its column in the raw file (uses parser's column logic)
        rows_latest = [r for r in year_rows if r["period"] == latest]
        sums = {
            "on_site_atms":     sum(r.get("on_site_atms", 0)     or 0 for r in rows_latest),
            "off_site_atms":    sum(r.get("off_site_atms", 0)    or 0 for r in rows_latest),
            "micro_atms":       sum(r.get("micro_atms", 0)       or 0 for r in rows_latest),
            "dc_vol":           sum(r.get("dc_vol", 0)           or 0 for r in rows_latest),
            "dc_val_thousands": sum(r.get("dc_val_thousands", 0) or 0 for r in rows_latest),
            "cc_vol":           sum(r.get("cc_vol", 0)           or 0 for r in rows_latest),
            "cc_val_thousands": sum(r.get("cc_val_thousands", 0) or 0 for r in rows_latest),
        }
        # Pull each column from the Total row
        col_map = {
            "modern":        {"on_site_atms": 3, "off_site_atms": 4, "micro_atms": 6,
                              "dc_vol": 25, "dc_val_thousands": 26, "cc_vol": 17, "cc_val_thousands": 18},
            "transition":    {"on_site_atms": 2, "off_site_atms": 3, "micro_atms": 6,
                              "dc_vol": 14, "dc_val_thousands": 16, "cc_vol": 9,  "cc_val_thousands": 11},
            "legacy":        {"on_site_atms": 3, "off_site_atms": 4, "micro_atms": None,
                              "dc_vol": 13, "dc_val_thousands": 15, "cc_vol": 8,  "cc_val_thousands": 10},
            "legacy_narrow": {"on_site_atms": 2, "off_site_atms": 3, "micro_atms": None,
                              "dc_vol": 12, "dc_val_thousands": 14, "cc_vol": 7,  "cc_val_thousands": 9},
        }
        unit_factor = {"modern": 1, "transition": 100, "legacy": 1000, "legacy_narrow": 100}
        # Detect actual unit from file header for value cols
        head_text = " ".join(str(v) for v in df.head(12).values.flatten() if isinstance(v, str)).lower()
        if "rs'000" in head_text or "rs 000" in head_text: detected_factor = 1
        elif "lakh" in head_text: detected_factor = 100
        elif "million" in head_text: detected_factor = 1000
        else: detected_factor = unit_factor.get(fmt, 1)

        cm = col_map.get(fmt, col_map["modern"])
        for metric_key, parser_sum in sums.items():
            col = cm.get(metric_key)
            if col is None or col >= df.shape[1]:
                rbi_v = "—"; match = "—"
            else:
                raw = df.iat[total_row, col]
                try:
                    raw_num = float(str(raw).replace(",", "")) if not pd.isna(raw) else None
                except Exception:
                    raw_num = None
                if raw_num is None:
                    rbi_v = "—"; match = "—"
                else:
                    # Apply unit normalisation for value columns
                    is_value = metric_key.endswith("_thousands")
                    rbi_normalized = raw_num * detected_factor if is_value else raw_num
                    rbi_v = f"{rbi_normalized:,.0f}"
                    if parser_sum > 0:
                        diff_pct = abs(parser_sum - rbi_normalized) / rbi_normalized * 100
                        match = "✓ exact" if diff_pct < 0.01 else (f"~{diff_pct:.2f}%" if diff_pct < 1 else f"⚠ {diff_pct:.1f}% off")
                    else:
                        match = "—"
            print(f"  {metric_key:<18}  {parser_sum:>18,.0f}  {rbi_v:>18}  {match:>8}")

# ── Top 5 banks per metric in latest month ───────────────────────────────
print(f"\n{'─'*100}")
print(f"TOP 5 BANKS PER METRIC — {latest}")
print(f"{'─'*100}")

latest_rows = [r for r in year_rows if r["period"] == latest]
for metric_key, label, fmtfn in [
    ("on_site_atms",     "On-site ATMs",          fmt_count),
    ("off_site_atms",    "Off-site ATMs",         fmt_count),
    ("micro_atms",       "Micro ATMs",            fmt_count),
    ("dc_vol",           "Debit Cash W/D Volume", fmt_count),
    ("dc_val_thousands", "Debit Cash W/D Value",  fmt_cr),
    ("cc_vol",           "Credit Cash W/D Volume",fmt_count),
    ("cc_val_thousands", "Credit Cash W/D Value", fmt_cr),
]:
    top = sorted(
        [r for r in latest_rows if r.get(metric_key)],
        key=lambda x: -(x.get(metric_key, 0) or 0)
    )[:5]
    if not top: continue
    print(f"\n  {label}:")
    for r in top:
        print(f"    {r['bank']:<40} {fmtfn(r.get(metric_key, 0) or 0):>15}")

print()
