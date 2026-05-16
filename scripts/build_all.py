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

    for path in files:
        result = parse_file(path)
        period = result.get("period")
        if not period:
            print(f"SKIP {path.name}: could not detect period")
            continue
        out_path = OUT_DIR / f"{period}.json"
        out_path.write_text(json.dumps(result, indent=2, default=str))
        print(f"OK   {path.name} -> {out_path.relative_to(out_path.parent.parent.parent)}  ({len(result['banks'])} banks)")


if __name__ == "__main__":
    main()
