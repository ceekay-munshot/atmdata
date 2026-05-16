"""Entry point: fetch new RBI files, parse them all into JSON.

Tolerant on purpose — never raises so the workflow's commit step always runs,
even on partial failures. data/_errors.log records anything that went wrong.
"""

import sys
import traceback

from build_all import main as build_main
from fetch import main as fetch_main


def main() -> int:
    print("=" * 60)
    print("STEP 1: Fetch from RBI")
    print("=" * 60)
    try:
        fetch_main()
    except Exception:
        traceback.print_exc()
        print("Fetch raised an exception — continuing to parse step.")

    print()
    print("=" * 60)
    print("STEP 2: Parse all files into JSON")
    print("=" * 60)
    try:
        build_main()
    except Exception:
        traceback.print_exc()
        print("Build raised an exception.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
