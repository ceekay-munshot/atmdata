"""Data audit: hunt for parse bugs and data anomalies across every bank and
every metric in data/flat.json.

Three classes of checks:

  1. Per-transaction sanity (unit-bug detector)
     For card cash-withdrawal: value (Rs '000) / volume = avg per-txn in '000.
     Expect Rs 500 - 25,000 per txn = 0.5 - 25 in '000. Anything outside the
     0.3 - 50 range almost certainly means the value column was parsed with
     the wrong unit (Lakh vs Millions vs '000).

  2. Sudden monthly jumps (stock + flow)
     Stock metrics (on/off/micro ATMs) should move gradually. >5× MoM is
     either a merger, a parse bug, or RBI reclassification.
     Flow metrics (dc_vol/val, cc_vol/val) can be volatile but >10× MoM
     usually points at a unit issue.

  3. Pair-consistency
     For each bank-month, value moves with volume. If avg-per-txn ratio
     changes >5× MoM, the value column was probably parsed with a different
     unit than the surrounding months.
"""

import json
from collections import defaultdict
from pathlib import Path

DATA = json.loads((Path(__file__).parent.parent / "data" / "flat.json").read_text())

# Thresholds
PER_TXN_LOW = 0.3       # < Rs 300 / txn = suspicious low (raw Rs treated as '000?)
PER_TXN_HIGH = 50.0     # > Rs 50,000 / txn = suspicious high (Lakh treated as Million?)
STOCK_JUMP = 5.0        # > 5× MoM change on stock metric = suspicious
FLOW_JUMP = 8.0         # > 8× MoM change on flow metric (more volatile)
PAIR_JUMP = 5.0         # avg-per-txn MoM ratio out of bounds


def _g(r, k):
    v = r.get(k)
    return v if (v is not None and v != 0) else None


def per_txn_check():
    """Flag bank-months where the value/volume ratio is outside sane bounds."""
    flags = []
    for r in DATA:
        for prefix in ("dc", "cc"):
            vol = _g(r, f"{prefix}_vol")
            val = _g(r, f"{prefix}_val_thousands")
            if not vol or not val or vol < 1000:
                continue
            per_txn_thou = val / vol
            if per_txn_thou < PER_TXN_LOW or per_txn_thou > PER_TXN_HIGH:
                flags.append({
                    "kind": "per_txn",
                    "period": r["period"], "bank": r["bank"],
                    "metric": prefix,
                    "vol": int(vol),
                    "val_thou": val,
                    "per_txn_thou": round(per_txn_thou, 2),
                    "implied_per_txn_Rs": round(per_txn_thou * 1000, 0),
                })
    return flags


def mom_jump_check():
    """Flag bank-months where a metric jumps by >Nx vs the previous month."""
    by_bank = defaultdict(list)
    for r in DATA:
        by_bank[r["bank"]].append(r)
    flags = []
    for bank, rows in by_bank.items():
        rows.sort(key=lambda x: x["period"])
        for i in range(1, len(rows)):
            prev, curr = rows[i - 1], rows[i]
            # Skip non-consecutive months
            py, pm = map(int, prev["period"].split("-"))
            cy, cm = map(int, curr["period"].split("-"))
            months_apart = (cy - py) * 12 + (cm - pm)
            if months_apart != 1:
                continue
            for field, label, threshold, kind in [
                ("on_site_atms",     "on-site",  STOCK_JUMP, "stock_jump"),
                ("off_site_atms",    "off-site", STOCK_JUMP, "stock_jump"),
                ("micro_atms",       "micro",    STOCK_JUMP, "stock_jump"),
                ("dc_vol",           "dc-vol",   FLOW_JUMP,  "flow_jump"),
                ("dc_val_thousands", "dc-val",   FLOW_JUMP,  "flow_jump"),
                ("cc_vol",           "cc-vol",   FLOW_JUMP,  "flow_jump"),
                ("cc_val_thousands", "cc-val",   FLOW_JUMP,  "flow_jump"),
            ]:
                pv = _g(prev, field)
                cv = _g(curr, field)
                if not pv or not cv:
                    continue
                # Skip trivially small baselines — noise
                if pv < 1000 or cv < 1000:
                    continue
                ratio = cv / pv
                if ratio >= threshold or ratio <= 1 / threshold:
                    flags.append({
                        "kind": kind,
                        "bank": bank, "metric": label,
                        "prev_period": prev["period"], "curr_period": curr["period"],
                        "prev": int(pv), "curr": int(cv),
                        "ratio_x": round(ratio, 2),
                    })
    return flags


def pair_consistency_check():
    """Flag bank-months where avg-per-txn ratio changes >Nx MoM."""
    by_bank = defaultdict(list)
    for r in DATA:
        by_bank[r["bank"]].append(r)
    flags = []
    for bank, rows in by_bank.items():
        rows.sort(key=lambda x: x["period"])
        for prefix in ("dc", "cc"):
            for i in range(1, len(rows)):
                prev, curr = rows[i - 1], rows[i]
                py, pm = map(int, prev["period"].split("-"))
                cy, cm = map(int, curr["period"].split("-"))
                if (cy - py) * 12 + (cm - pm) != 1:
                    continue
                pv_vol = _g(prev, f"{prefix}_vol")
                pv_val = _g(prev, f"{prefix}_val_thousands")
                cv_vol = _g(curr, f"{prefix}_vol")
                cv_val = _g(curr, f"{prefix}_val_thousands")
                if not (pv_vol and pv_val and cv_vol and cv_val):
                    continue
                if pv_vol < 1000 or cv_vol < 1000:
                    continue
                prev_ratio = pv_val / pv_vol
                curr_ratio = cv_val / cv_vol
                r_ratio = curr_ratio / prev_ratio
                if r_ratio >= PAIR_JUMP or r_ratio <= 1 / PAIR_JUMP:
                    flags.append({
                        "kind": "pair_ratio_jump",
                        "bank": bank, "metric": prefix,
                        "prev_period": prev["period"], "curr_period": curr["period"],
                        "prev_per_txn_thou": round(prev_ratio, 2),
                        "curr_per_txn_thou": round(curr_ratio, 2),
                        "ratio_x": round(r_ratio, 2),
                    })
    return flags


def summarise(flags, name, sample=10):
    print(f"\n=== {name}: {len(flags)} flagged ===")
    # Group by month to find file-level vs bank-level issues
    by_period = defaultdict(int)
    by_bank = defaultdict(int)
    for f in flags:
        p = f.get("curr_period") or f.get("period")
        by_period[p] += 1
        by_bank[f.get("bank", "?")] += 1
    print(f"  by month (top 12): " + ", ".join(
        f"{p}={n}" for p, n in sorted(by_period.items(), key=lambda x: -x[1])[:12]))
    print(f"  by bank  (top 8):  " + ", ".join(
        f"{b[:20]}={n}" for b, n in sorted(by_bank.items(), key=lambda x: -x[1])[:8]))
    print(f"  sample:")
    for f in flags[:sample]:
        bits = [f"{k}={v}" for k, v in f.items() if k != "kind"]
        print(f"    - {' | '.join(bits)}")


print(f"Auditing {len(DATA)} rows across {len({r['bank'] for r in DATA})} banks "
      f"and {len({r['period'] for r in DATA})} periods\n")

per_txn = per_txn_check()
mom = mom_jump_check()
pair = pair_consistency_check()

summarise(per_txn, "Per-transaction value out of sane bounds (UNIT BUG)", 12)
summarise([f for f in mom if f["kind"] == "stock_jump"], "Stock metric sudden jump (>5x MoM)", 12)
summarise([f for f in mom if f["kind"] == "flow_jump"],  "Flow metric sudden jump (>8x MoM)", 12)
summarise(pair, "Avg-per-txn changed >5x MoM (unit bug for that month)", 12)
