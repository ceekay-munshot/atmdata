"""Parse every file in data/raw/ and write one JSON per month to data/processed/."""

import json
from pathlib import Path

from parser import parse_file

RAW_DIR = Path(__file__).parent.parent / "data" / "raw"
OUT_DIR = Path(__file__).parent.parent / "data" / "processed"


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    files = sorted(p for p in RAW_DIR.iterdir() if p.suffix.lower() in (".xls", ".xlsx"))
    if not files:
        print(f"No files in {RAW_DIR}")
        return

    # When RBI publishes a "(Revised)" file, the URL hash changes so we may end
    # up with two raw files for the same period. Keep the most recently
    # modified one — it represents the latest revision.
    from parser import detect_period
    by_period: dict[str, Path] = {}
    for path in files:
        period = detect_period(path.name)
        if not period:
            print(f"SKIP {path.name}: could not detect period")
            continue
        existing = by_period.get(period)
        if existing is None or path.stat().st_mtime > existing.stat().st_mtime:
            by_period[period] = path

    for period, path in sorted(by_period.items()):
        result = parse_file(path)
        out_path = OUT_DIR / f"{period}.json"
        out_path.write_text(json.dumps(result, indent=2, default=str))
        print(f"OK   {path.name} -> {out_path.relative_to(out_path.parent.parent.parent)}  ({len(result['banks'])} banks)")


if __name__ == "__main__":
    main()
