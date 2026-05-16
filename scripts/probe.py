"""One-shot debug script: dump the RBI listing page structure so we can
reverse-engineer the year-filter mechanism. Output goes to data/_debug/.

Delete this script once the real fetcher works for all years.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import requests
from bs4 import BeautifulSoup

LISTING_URL = "https://rbi.org.in/scripts/atmview.aspx"
DEBUG_DIR = Path(__file__).parent.parent / "data" / "_debug"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


def summarize(label: str, html: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")

    # ASP.NET form fields
    form = soup.find("form")
    form_action = form.get("action") if form else None
    form_method = form.get("method") if form else None
    hidden_inputs = {
        i.get("name"): (i.get("value") or "")[:80]
        for i in soup.find_all("input", type="hidden")
        if i.get("name")
    }

    # All anchors — collect href + text + onclick, focus on year-looking ones
    anchors: list[dict] = []
    for a in soup.find_all("a"):
        text = (a.get_text() or "").strip()
        href = a.get("href") or ""
        onclick = a.get("onclick") or ""
        if (
            re.search(r"\b20\d{2}\b", text)
            or re.search(r"\b20\d{2}\b", href)
            or "Archive" in text
            or "__doPostBack" in onclick
            or href.lower().endswith((".xls", ".xlsx"))
        ):
            anchors.append({
                "text": text[:80],
                "href": href[:200],
                "onclick": onclick[:200],
            })

    # XLS/XLSX file links
    files = [
        a.get("href")
        for a in soup.find_all("a", href=True)
        if a["href"].lower().endswith((".xls", ".xlsx"))
    ]

    return {
        "label": label,
        "form_action": form_action,
        "form_method": form_method,
        "hidden_input_names": list(hidden_inputs.keys()),
        "viewstate_len": len(hidden_inputs.get("__VIEWSTATE", "")),
        "eventvalidation_len": len(hidden_inputs.get("__EVENTVALIDATION", "")),
        "interesting_anchors_count": len(anchors),
        "interesting_anchors_sample": anchors[:60],
        "xls_file_links_count": len(files),
        "xls_file_links_sample": files[:30],
    }


def fetch_and_save(label: str, url: str, session: requests.Session, **post_kwargs):
    DEBUG_DIR.mkdir(parents=True, exist_ok=True)
    safe_label = re.sub(r"[^A-Za-z0-9_-]", "_", label)
    try:
        if post_kwargs:
            r = session.post(url, headers=HEADERS, timeout=60, **post_kwargs)
        else:
            r = session.get(url, headers=HEADERS, timeout=60)
    except requests.RequestException as e:
        (DEBUG_DIR / f"{safe_label}.error.txt").write_text(f"{type(e).__name__}: {e}")
        print(f"  {label}: ERROR {e}")
        return None
    (DEBUG_DIR / f"{safe_label}.status.txt").write_text(
        f"HTTP {r.status_code}\nfinal URL: {r.url}\ncontent-length: {len(r.text)}\n"
    )
    if r.status_code == 200:
        (DEBUG_DIR / f"{safe_label}.html").write_text(r.text)
        summary = summarize(label, r.text)
        print(f"  {label}: HTTP {r.status_code}, {summary['xls_file_links_count']} xls links, "
              f"{summary['interesting_anchors_count']} interesting anchors")
        return summary
    print(f"  {label}: HTTP {r.status_code}")
    return None


def main() -> int:
    DEBUG_DIR.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    summaries: list[dict] = []

    # Step 1: plain GET of the listing page
    s = fetch_and_save("root", LISTING_URL, session)
    if s:
        summaries.append(s)

    # Step 2: try common query-string year filters for 2020 and 2017
    for label, url in [
        ("qs_yr_2020", f"{LISTING_URL}?yr=2020"),
        ("qs_Year_2020", f"{LISTING_URL}?Year=2020"),
        ("qs_year_2020", f"{LISTING_URL}?year=2020"),
        ("qs_yr_2017", f"{LISTING_URL}?yr=2017"),
    ]:
        s = fetch_and_save(label, url, session)
        if s:
            summaries.append(s)

    # Step 3: if root page is an ASP.NET form with __doPostBack on year links,
    # attempt a postback for year 2020 using the first relevant event target.
    root_html_path = DEBUG_DIR / "root.html"
    if root_html_path.exists() and summaries and summaries[0].get("form_action"):
        soup = BeautifulSoup(root_html_path.read_text(), "html.parser")
        # Find all __doPostBack targets that reference a year (heuristic)
        targets: list[str] = []
        for a in soup.find_all("a"):
            onclick = a.get("onclick") or ""
            text = (a.get_text() or "").strip()
            m = re.search(r"__doPostBack\(['\"]([^'\"]+)['\"],\s*['\"]([^'\"]*)['\"]\)", onclick)
            if m and re.search(r"\b20\d{2}\b", text):
                targets.append((text, m.group(1), m.group(2)))
        (DEBUG_DIR / "postback_targets.json").write_text(json.dumps(targets, indent=2))
        print(f"  Found {len(targets)} year postback targets")

        if targets:
            # Try a postback for the first year target
            text, et, ea = targets[0]
            form_data = {}
            for inp in soup.find_all("input", type="hidden"):
                if inp.get("name"):
                    form_data[inp["name"]] = inp.get("value", "")
            form_data["__EVENTTARGET"] = et
            form_data["__EVENTARGUMENT"] = ea
            label = f"postback_{re.sub(r'[^A-Za-z0-9]', '_', text)}"
            print(f"  Attempting POST with __EVENTTARGET={et!r}, target year={text}")
            s = fetch_and_save(label, LISTING_URL, session, data=form_data)
            if s:
                summaries.append(s)

    # Final: write the master summary
    (DEBUG_DIR / "_summary.json").write_text(json.dumps(summaries, indent=2))
    print(f"\nWrote {len(summaries)} summaries to {DEBUG_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
