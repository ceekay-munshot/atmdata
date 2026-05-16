"""Entry point: fetch new RBI files, parse them all into JSON."""

import sys

from build_all import main as build_main
from fetch import main as fetch_main


def main() -> int:
    print("=" * 60)
    print("STEP 1: Fetch from RBI")
    print("=" * 60)
    rc = fetch_main()
    if rc != 0:
        return rc

    print()
    print("=" * 60)
    print("STEP 2: Parse all files into JSON")
    print("=" * 60)
    build_main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
