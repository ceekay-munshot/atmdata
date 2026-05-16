"""Parse RBI Bankwise ATM/POS/Card Statistics Excel files into a normalized schema.

Handles both the legacy format (2017, .XLS, no Micro ATMs, values in Rs Millions)
and the modern format (2019+, .XLSX, Micro ATMs present, values in Rs '000).

All output values are normalized to Rs '000.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pandas as pd

CATEGORY_KEYWORDS = {
    "public sector": "Public Sector",
    "private sector": "Private Sector",
    "foreign bank": "Foreign Bank",
    "payment bank": "Payment Bank",
    "small finance": "Small Finance Bank",
}

MONTHS = {
    "JANUARY": 1, "FEBRUARY": 2, "MARCH": 3, "APRIL": 4,
    "MAY": 5, "JUNE": 6, "JULY": 7, "AUGUST": 8,
    "SEPTEMBER": 9, "OCTOBER": 10, "NOVEMBER": 11, "DECEMBER": 12,
}


def detect_period(filename: str) -> str | None:
    """Extract YYYY-MM from a filename. RBI uses three naming schemes:
      - ATM<MONTHNAME><YYYY>  e.g. ATMMARCH2026<hash>.XLSX (modern)
      - ATMCS<MM><YYYY>       e.g. ATMCS012017<hash>.XLS  (legacy 2017-ish)
      - ATM<MM><YYYY>         e.g. ATM122025<hash>.XLSX   (short numeric)
    """
    name = Path(filename).stem.upper()
    for mname, mnum in MONTHS.items():
        m = re.search(rf"ATM{mname}(\d{{4}})", name)
        if m:
            return f"{m.group(1)}-{mnum:02d}"
    m = re.search(r"ATMCS(\d{2})(\d{4})", name)
    if m:
        mm = int(m.group(1))
        if 1 <= mm <= 12:
            return f"{m.group(2)}-{mm:02d}"
    m = re.search(r"ATM(\d{2})(\d{4})", name)
    if m:
        mm = int(m.group(1))
        if 1 <= mm <= 12:
            return f"{m.group(2)}-{mm:02d}"
    return None


def _is_numeric(val) -> bool:
    if pd.isna(val):
        return False
    if isinstance(val, (int, float)):
        return True
    try:
        float(str(val).replace(",", ""))
        return True
    except (ValueError, TypeError):
        return False


def _to_float(val):
    if pd.isna(val):
        return None
    try:
        return float(str(val).replace(",", ""))
    except (ValueError, TypeError):
        return None


def _to_int(val):
    f = _to_float(val)
    return int(f) if f is not None else None


def _find_category(text: str) -> str | None:
    if not isinstance(text, str):
        return None
    lower = text.lower()
    for key, label in CATEGORY_KEYWORDS.items():
        if key in lower:
            return label
    return None


def _detect_format(df: pd.DataFrame) -> str:
    """Return 'modern' (Micro ATMs present) or 'legacy' (no Micro ATMs)."""
    head_text = " ".join(
        str(v) for v in df.head(12).values.flatten() if isinstance(v, str)
    ).lower()
    if "micro atm" in head_text:
        return "modern"
    return "legacy"


def _find_data_start(df: pd.DataFrame, bank_col: int) -> int:
    """Find the first row where bank name column has a real bank entry.

    A real bank row has a string in the bank column AND a number in the next column.
    """
    for i in range(len(df)):
        bank = df.iat[i, bank_col]
        if not isinstance(bank, str) or not bank.strip():
            continue
        if bank.strip().lower() in ("bank name", "sr. no.", "particulars"):
            continue
        # Check the next column has numeric content
        if bank_col + 1 < df.shape[1] and _is_numeric(df.iat[i, bank_col + 1]):
            return i
    raise ValueError("Could not locate data start row")


def parse_modern(df: pd.DataFrame) -> list[dict]:
    """Parse modern format (2019+): includes Micro ATMs, values in Rs '000."""
    # Modern layout (confirmed from March 2026):
    # col 2 = Bank Name, 3 = On-site, 4 = Off-site, 6 = Micro ATMs
    # col 17 = CC ATM Vol, 18 = CC ATM Val (Rs'000)
    # col 25 = DC ATM Vol, 26 = DC ATM Val (Rs'000)
    BANK, ONSITE, OFFSITE, MICRO = 2, 3, 4, 6
    CC_VOL, CC_VAL = 17, 18
    DC_VOL, DC_VAL = 25, 26

    rows: list[dict] = []
    current_category: str | None = None

    # Scan from row 0 so we catch "Public Sector Banks" header before the first bank.
    # Non-bank rows are filtered by the numeric check below.
    for i in range(len(df)):
        # Section headers (Public/Private/Foreign/Payment/Small Finance) live in col 1
        sno_cell = df.iat[i, 1] if df.shape[1] > 1 else None
        if isinstance(sno_cell, str):
            cat = _find_category(sno_cell)
            if cat:
                current_category = cat
                continue

        bank = df.iat[i, BANK]
        if not isinstance(bank, str) or not bank.strip():
            continue
        bank = bank.strip()

        # Skip totals / notes / footnote definitions
        lower = bank.lower()
        if lower.startswith("total") or lower.startswith("grand total") or lower.startswith("note"):
            continue

        # Row must have at least one numeric data column to be a real bank row
        if not _is_numeric(df.iat[i, ONSITE]) and not _is_numeric(df.iat[i, OFFSITE]):
            continue

        rows.append({
            "bank": bank,
            "category": current_category,
            "on_site_atms": _to_int(df.iat[i, ONSITE]),
            "off_site_atms": _to_int(df.iat[i, OFFSITE]),
            "micro_atms": _to_int(df.iat[i, MICRO]),
            "credit_card_atm_withdrawal_volume": _to_int(df.iat[i, CC_VOL]),
            "credit_card_atm_withdrawal_value_thousands": _to_float(df.iat[i, CC_VAL]),
            "debit_card_atm_withdrawal_volume": _to_int(df.iat[i, DC_VOL]),
            "debit_card_atm_withdrawal_value_thousands": _to_float(df.iat[i, DC_VAL]),
        })
    return rows


def parse_legacy(df: pd.DataFrame) -> list[dict]:
    """Parse 2017 format: no Micro ATMs, values in Rs Millions -> convert to Rs '000."""
    # Legacy layout (confirmed from Jan 2017):
    # col 2 = Bank Name, 3 = On-site, 4 = Off-site (no Micro ATMs)
    # col 8 = CC ATM Vol, 10 = CC ATM Val (Rs Millions)
    # col 13 = DC ATM Vol, 15 = DC ATM Val (Rs Millions)
    BANK, ONSITE, OFFSITE = 2, 3, 4
    CC_VOL, CC_VAL_MILLIONS = 8, 10
    DC_VOL, DC_VAL_MILLIONS = 13, 15

    start = _find_data_start(df, BANK)
    rows: list[dict] = []

    for i in range(start, len(df)):
        bank = df.iat[i, BANK]
        if not isinstance(bank, str) or not bank.strip():
            continue
        bank = bank.strip()

        lower = bank.lower()
        if lower.startswith("total") or lower.startswith("grand total") or lower.startswith("note"):
            continue
        if not _is_numeric(df.iat[i, ONSITE]) and not _is_numeric(df.iat[i, OFFSITE]):
            continue

        cc_val_m = _to_float(df.iat[i, CC_VAL_MILLIONS])
        dc_val_m = _to_float(df.iat[i, DC_VAL_MILLIONS])

        rows.append({
            "bank": bank,
            "category": None,
            "on_site_atms": _to_int(df.iat[i, ONSITE]),
            "off_site_atms": _to_int(df.iat[i, OFFSITE]),
            "micro_atms": None,
            "credit_card_atm_withdrawal_volume": _to_int(df.iat[i, CC_VOL]),
            "credit_card_atm_withdrawal_value_thousands": cc_val_m * 1000 if cc_val_m is not None else None,
            "debit_card_atm_withdrawal_volume": _to_int(df.iat[i, DC_VOL]),
            "debit_card_atm_withdrawal_value_thousands": dc_val_m * 1000 if dc_val_m is not None else None,
        })
    return rows


def parse_file(path: str | Path) -> dict:
    """Parse an RBI ATM stats file and return {period, format, banks: [...]}"""
    path = Path(path)
    engine = "xlrd" if path.suffix.lower() == ".xls" else "openpyxl"
    df = pd.read_excel(path, sheet_name=0, header=None, engine=engine)

    period = detect_period(path.name)
    fmt = _detect_format(df)
    banks = parse_modern(df) if fmt == "modern" else parse_legacy(df)

    return {
        "period": period,
        "format": fmt,
        "source_file": path.name,
        "banks": banks,
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: parser.py <file.xlsx|file.xls>", file=sys.stderr)
        sys.exit(1)
    result = parse_file(sys.argv[1])
    print(json.dumps(result, indent=2, default=str))
