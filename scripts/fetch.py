"""Download RBI Bankwise ATM/POS/Card Statistics Excel files for every year.

The listing page (atmview.aspx) is an ASP.NET WebForm. The year sidebar links
are JS handlers that call GetYearMonth(year, month), which sets the hidden
inputs hdnYear/hdnMonth and submits the form. To enumerate all years we
mimic that POST with the appropriate hdnYear, plus the ASP.NET state fields
parsed from the initial GET.

Sandbox note: rbi.org.in is blocked by the managed sandbox's network policy.
This script only works from GitHub Actions runners (or any environment with
unrestricted egress).
"""

from __future__ import annotations

import sys
import time
from datetime import date
from pathlib import Path
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

LISTING_URL = "https://rbi.org.in/scripts/atmview.aspx"
RAW_DIR = Path(__file__).parent.parent / "data" / "raw"

START_YEAR = 2009  # RBI ATM stats predate this in the sidebar but appear empty
END_YEAR = date.today().year

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": LISTING_URL,
}


def _parse_aspnet_state(html: str) -> dict[str, str]:
    soup = BeautifulSoup(html, "html.parser")
    state: dict[str, str] = {}
    for inp in soup.find_all("input", type="hidden"):
        name = inp.get("name")
        if name in ("__VIEWSTATE", "__VIEWSTATEGENERATOR", "__EVENTVALIDATION"):
            state[name] = inp.get("value", "")
    return state


def _extract_xls_urls(html: str, base_url: str) -> list[str]:
    soup = BeautifulSoup(html, "html.parser")
    urls: list[str] = []
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if not href.lower().endswith((".xls", ".xlsx")):
            continue
        abs_url = urljoin(base_url, href)
        if "ATM" not in abs_url.upper():
            continue
        urls.append(abs_url)
    seen: set[str] = set()
    out: list[str] = []
    for u in urls:
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


def collect_all_file_urls(session: requests.Session) -> list[str]:
    print(f"GET {LISTING_URL}")
    r = session.get(LISTING_URL, headers=HEADERS, timeout=60)
    r.raise_for_status()
    state = _parse_aspnet_state(r.text)
    if not state.get("__VIEWSTATE"):
        print("WARN: __VIEWSTATE missing — site structure may have changed")

    all_urls: list[str] = []
    seen: set[str] = set()

    # Include URLs from the initial page (current year listing)
    for u in _extract_xls_urls(r.text, LISTING_URL):
        if u not in seen:
            seen.add(u)
            all_urls.append(u)

    # POST once per year
    for year in range(END_YEAR, START_YEAR - 1, -1):
        form_data = {
            "__EVENTTARGET": "",
            "__EVENTARGUMENT": "",
            "__VIEWSTATE": state.get("__VIEWSTATE", ""),
            "__VIEWSTATEGENERATOR": state.get("__VIEWSTATEGENERATOR", ""),
            "__EVENTVALIDATION": state.get("__EVENTVALIDATION", ""),
            "hdnYear": str(year),
            "hdnMonth": "0",
            "UsrFontCntr$btn": "",
        }
        print(f"POST hdnYear={year}", end=" ")
        try:
            rr = session.post(LISTING_URL, data=form_data, headers=HEADERS, timeout=60)
        except requests.RequestException as e:
            print(f"ERR {e}")
            continue
        if rr.status_code != 200:
            print(f"HTTP {rr.status_code}")
            continue

        # Refresh state from the response so subsequent POSTs use a fresh viewstate
        new_state = _parse_aspnet_state(rr.text)
        if new_state.get("__VIEWSTATE"):
            state = new_state

        urls = _extract_xls_urls(rr.text, LISTING_URL)
        new = [u for u in urls if u not in seen]
        for u in new:
            seen.add(u)
            all_urls.append(u)
        print(f"-> {len(urls)} links ({len(new)} new)")

        time.sleep(0.5)

    return all_urls


def download(url: str, dest: Path, session: requests.Session) -> bool:
    if dest.exists():
        return False
    print(f"   download {url.rsplit('/', 1)[-1]}")
    try:
        r = session.get(url, headers=HEADERS, timeout=120)
    except requests.RequestException as e:
        print(f"   ERR {e}", file=sys.stderr)
        return False
    if r.status_code != 200:
        print(f"   ERR HTTP {r.status_code}", file=sys.stderr)
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(r.content)
    return True


def main() -> int:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    urls = collect_all_file_urls(session)
    print(f"\nTotal unique ATM file URLs discovered: {len(urls)}")

    new_count = 0
    for url in urls:
        filename = url.rsplit("/", 1)[-1]
        dest = RAW_DIR / filename
        if download(url, dest, session):
            new_count += 1
            time.sleep(0.3)

    print(f"\nNew files downloaded: {new_count}")
    print(f"Total files in raw/: {len(list(RAW_DIR.iterdir()))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
