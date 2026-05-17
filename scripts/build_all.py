"""Parse every file in data/raw/ and write one JSON per month to data/processed/.

Also writes two dashboard-facing artifacts:
  data/manifest.json - list of all available periods + meta
  data/flat.json     - denormalised flat array of {period, bank, ...fields}
                       for fast client-side filtering/aggregation

Errors during parsing are caught and appended to data/_errors.log so a single
bad file (e.g. an unfamiliar pre-2017 layout) cannot fail the whole run.
"""

import json
import re
import traceback
from datetime import datetime, timezone
from pathlib import Path

from parser import detect_period, parse_file

DATA_DIR = Path(__file__).parent.parent / "data"
RAW_DIR = DATA_DIR / "raw"
OUT_DIR = DATA_DIR / "processed"
ERR_LOG = DATA_DIR / "_errors.log"
MANIFEST = DATA_DIR / "manifest.json"
FLAT = DATA_DIR / "flat.json"
OVERRIDES = DATA_DIR / "overrides.json"


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    files = sorted(p for p in RAW_DIR.iterdir() if p.suffix.lower() in (".xls", ".xlsx"))
    if not files:
        print(f"No files in {RAW_DIR}")
        return

    by_period: dict[str, Path] = {}
    unknown_period: list[Path] = []
    for path in files:
        period = detect_period(path)
        if not period:
            unknown_period.append(path)
            continue
        existing = by_period.get(period)
        if existing is None or path.stat().st_mtime > existing.stat().st_mtime:
            by_period[period] = path

    errors: list[str] = []
    for p in unknown_period:
        msg = f"SKIP {p.name}: could not detect period from filename"
        print(msg)
        errors.append(msg)

    ok = 0
    for period, path in sorted(by_period.items()):
        try:
            result = parse_file(path)
            banks = result.get("banks") or []
            if not banks:
                msg = f"FAIL {path.name} (period={period}): 0 banks extracted (unrecognised layout?)"
                print(msg)
                errors.append(msg)
                continue
            out_path = OUT_DIR / f"{period}.json"
            out_path.write_text(json.dumps(result, indent=2, default=str))
            print(f"OK   {path.name} -> data/processed/{period}.json  ({len(banks)} banks)")
            ok += 1
        except Exception as e:
            tb = traceback.format_exc()
            msg = f"FAIL {path.name} (period={period}): {type(e).__name__}: {e}\n{tb}"
            print(msg)
            errors.append(msg)

    print(f"\nParsed OK: {ok}/{len(by_period)}")
    if errors:
        ERR_LOG.parent.mkdir(parents=True, exist_ok=True)
        ERR_LOG.write_text("\n\n".join(errors))
        print(f"Wrote {len(errors)} error(s) to {ERR_LOG}")
    elif ERR_LOG.exists():
        ERR_LOG.unlink()

    _write_dashboard_artifacts()


_PERIOD_RE = re.compile(r"^\d{4}-\d{2}$")


def _write_dashboard_artifacts() -> None:
    """Emit manifest.json + flat.json that the web dashboard consumes."""
    # Manual category overrides — only filled in for banks the source files
    # didn't tag. Never overwrites an existing category. Lookup is
    # case/punctuation insensitive ("Axis Bank Ltd." == "AXIS BANK LTD").
    SUFFIX_TOKENS = {"ltd", "limited", "plc", "inc", "corp", "corporation", "company"}

    def _norm(s: str) -> str:
        if not s:
            return ""
        # Tokenise, replace & with "and", drop trailing punctuation, then
        # filter out generic corporate-suffix tokens so "Federal Bank Ltd",
        # "FEDERAL BANK LTD" and "Federal Bank Limited" all collapse to the
        # same key.
        out: list[str] = []
        for tok in s.lower().replace("&", " and ").replace(".", " ").replace(",", " ").split():
            clean = "".join(c for c in tok if c.isalnum())
            if not clean or clean in SUFFIX_TOKENS:
                continue
            out.append(clean)
        return "".join(out)

    cat_overrides: dict[str, str] = {}
    if OVERRIDES.exists():
        try:
            ov = json.loads(OVERRIDES.read_text())
            for name, cat in (ov.get("categories") or {}).items():
                cat_overrides[_norm(name)] = cat
        except Exception as e:
            print(f"WARN: could not load {OVERRIDES.name}: {e}")

    period_files: list[tuple[str, Path]] = []
    for p in sorted(OUT_DIR.iterdir()):
        if p.suffix != ".json":
            continue
        if not _PERIOD_RE.match(p.stem):
            continue
        period_files.append((p.stem, p))

    flat: list[dict] = []
    banks: set[str] = set()
    categories: set[str] = set()
    override_hits = 0
    for period, path in period_files:
        try:
            data = json.loads(path.read_text())
        except Exception:
            continue
        for b in data.get("banks", []):
            bank = (b.get("bank") or "").strip()
            if not bank:
                continue
            banks.add(bank)
            cat = b.get("category")
            if not cat:
                fallback = cat_overrides.get(_norm(bank))
                if fallback:
                    cat = fallback
                    override_hits += 1
            if cat:
                categories.add(cat)
            flat.append({
                "period": period,
                "bank": bank,
                "category": cat,
                "on_site_atms": b.get("on_site_atms"),
                "off_site_atms": b.get("off_site_atms"),
                "micro_atms": b.get("micro_atms"),
                "cc_vol": b.get("credit_card_atm_withdrawal_volume"),
                "cc_val_thousands": b.get("credit_card_atm_withdrawal_value_thousands"),
                "dc_vol": b.get("debit_card_atm_withdrawal_volume"),
                "dc_val_thousands": b.get("debit_card_atm_withdrawal_value_thousands"),
            })

    periods = [pf[0] for pf in period_files]
    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "periods": periods,
        "period_count": len(periods),
        "first_period": periods[0] if periods else None,
        "latest_period": periods[-1] if periods else None,
        "bank_count": len(banks),
        "categories": sorted(categories),
        "row_count": len(flat),
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2))
    FLAT.write_text(json.dumps(flat, separators=(",", ":")))
    print(f"Wrote manifest ({len(periods)} periods) and flat.json ({len(flat)} rows; {override_hits} category overrides applied)")


if __name__ == "__main__":
    main()
