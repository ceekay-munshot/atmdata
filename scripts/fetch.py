"""Download RBI Bankwise ATM/POS/Card Statistics Excel files.

Strategy:
  1. Fetch the listing page https://rbi.org.in/scripts/atmview.aspx — this
     usually only renders the current year's months.
  2. Also fetch the year-filtered variants (atmview.aspx?yr=YYYY) for every
     historical year. Both URL conventions in the wild are tried.
  3. Extract every .XLS/.XLSX link pointing at rbidocs.rbi.org.in.
  4. Download files we don't already have under data/raw/.

This script must run from an environment that can reach rbi.org.in — the
managed sandbox has a host allowlist that blocks it, so this is intended for
GitHub Actions.
"""

from __future__ import annotations

import re
import sys
import time
from datetime import date
from pathlib import Path
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

LISTING_URL = "https://rbi.org.in/scripts/atmview.aspx"
RAW_DIR = Path(__file__).parent.parent / "data" / "raw"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

FILE_PATTERN = re.compile(r"\.xlsx?$", re.IGNORECASE)
ATM_FILE_HINT = re.compile(r"/(ATM|atm)[A-Za-z0-9]*\.xlsx?$", re.IGNORECASE)


def _get(url: str, session: requests.Session) -> str | None:
    try:
        r = session.get(url, headers=HEADERS, timeout=60)
    except requests.RequestException as e:
        print(f"  ERR fetching {url}: {e}", file=sys.stderr)
        return None
    if r.status_code != 200:
        print(f"  WARN {url} returned HTTP {r.status_code}", file=sys.stderr)
        return None
    return r.text


def _extract_file_urls(html: str, base_url: str) -> list[str]:
    """Return absolute URLs to .xls/.xlsx files that look like ATM stats files."""
    soup = BeautifulSoup(html, "html.parser")
    urls: list[str] = []
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if not FILE_PATTERN.search(href):
            continue
        abs_url = urljoin(base_url, href)
        if "ATM" not in abs_url.upper():
            continue
        urls.append(abs_url)
    # de-duplicate while preserving order
    seen: set[str] = set()
    out: list[str] = []
    for u in urls:
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


def collect_file_urls() -> list[str]:
    """Crawl the listing page + per-year variants and return all ATM file URLs."""
    session = requests.Session()
    all_urls: list[str] = []
    seen: set[str] = set()

    candidate_pages: list[str] = [LISTING_URL]
    current_year = date.today().year
    for yr in range(2010, current_year + 1):
        candidate_pages.append(f"{LISTING_URL}?yr={yr}")
        candidate_pages.append(f"{LISTING_URL}?Year={yr}")

    for page_url in candidate_pages:
        print(f"-> {page_url}")
        html = _get(page_url, session)
        if not html:
            continue
        urls = _extract_file_urls(html, page_url)
        new = [u for u in urls if u not in seen]
        for u in new:
            seen.add(u)
            all_urls.append(u)
        if new:
            print(f"   found {len(new)} new file URL(s)")
        time.sleep(0.5)  # be polite

    return all_urls


def download(url: str, dest: Path, session: requests.Session) -> bool:
    """Download url to dest. Returns True if a new file was written."""
    if dest.exists():
        return False
    print(f"   downloading {url}")
    try:
        r = session.get(url, headers=HEADERS, timeout=120)
    except requests.RequestException as e:
        print(f"   ERR: {e}", file=sys.stderr)
        return False
    if r.status_code != 200:
        print(f"   ERR HTTP {r.status_code}", file=sys.stderr)
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(r.content)
    return True


def main() -> int:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    urls = collect_file_urls()
    print(f"\nTotal unique ATM file URLs discovered: {len(urls)}")

    session = requests.Session()
    new_count = 0
    for url in urls:
        filename = url.rsplit("/", 1)[-1]
        # RBI sometimes returns upper/lowercase extensions inconsistently
        dest = RAW_DIR / filename
        if download(url, dest, session):
            new_count += 1
        time.sleep(0.3)

    print(f"\nNew files downloaded: {new_count}")
    print(f"Total files in raw/: {len(list(RAW_DIR.iterdir()))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
