"""Parse every file in data/raw/ and write one JSON per month to data/processed/.

Errors during parsing are caught and appended to data/_errors.log so a single
bad file (e.g. an unfamiliar pre-2017 layout) cannot fail the whole run.
"""

import json
import traceback
from pathlib import Path

from parser import detect_period, parse_file

RAW_DIR = Path(__file__).parent.parent / "data" / "raw"
OUT_DIR = Path(__file__).parent.parent / "data" / "processed"
ERR_LOG = Path(__file__).parent.parent / "data" / "_errors.log"


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    files = sorted(p for p in RAW_DIR.iterdir() if p.suffix.lower() in (".xls", ".xlsx"))
    if not files:
        print(f"No files in {RAW_DIR}")
        return

    by_period: dict[str, Path] = {}
    unknown_period: list[Path] = []
    for path in files:
        period = detect_period(path.name)
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
            out_path = OUT_DIR / f"{period}.json"
            out_path.write_text(json.dumps(result, indent=2, default=str))
            print(f"OK   {path.name} -> data/processed/{period}.json  ({len(result['banks'])} banks)")
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


if __name__ == "__main__":
    main()
