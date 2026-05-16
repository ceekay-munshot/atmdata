"""Parse RBI Bankwise ATM/POS/Card Statistics Excel files into a normalized schema.

Handles both the legacy format (2017, .XLS, no Micro ATMs, values in Rs Millions)
and the modern format (2019+, .XLSX, Micro ATMs present, values in Rs '000).

All output values are normalized to Rs '000.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import date
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


MIN_YEAR = 2008
MAX_YEAR = date.today().year + 1

TITLE_PERIOD_RE = re.compile(
    r"\b(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)"
    r"[\s,\-]+(\d{4})\b",
    re.IGNORECASE,
)


def _validate_period(year: int, month: int) -> bool:
    return MIN_YEAR <= year <= MAX_YEAR and 1 <= month <= 12


def detect_period_from_filename(filename: str) -> str | None:
    """Best-effort period extraction from filename. Returns None if not a
    confident match. Used as a fast path only — content-based detection is
    the source of truth.
    """
    name = Path(filename).stem.upper()
    # ATM<MONTHNAME><YYYY> (preferred, unambiguous)
    for mname, mnum in MONTHS.items():
        m = re.search(rf"(?:^|[^A-Z]){mname}(\d{{4}})", name)
        if m and _validate_period(int(m.group(1)), mnum):
            return f"{m.group(1)}-{mnum:02d}"
    # ATMCS<MM><YYYY>
    m = re.search(r"ATMCS(\d{2})(\d{4})", name)
    if m and _validate_period(int(m.group(2)), int(m.group(1))):
        return f"{m.group(2)}-{int(m.group(1)):02d}"
    return None


def extract_period_from_content(path: Path) -> str | None:
    """Open the file and look for a title row like
    'ATM & Card Statistics for September 2017'. Most reliable signal.
    """
    engine = "xlrd" if path.suffix.lower() == ".xls" else "openpyxl"
    try:
        df = pd.read_excel(path, sheet_name=0, header=None, engine=engine, nrows=6)
    except Exception:
        return None
    for r in range(min(6, len(df))):
        for c in range(min(15, df.shape[1])):
            v = df.iat[r, c]
            if not isinstance(v, str):
                continue
            m = TITLE_PERIOD_RE.search(v)
            if m:
                mnum = MONTHS.get(m.group(1).upper())
                year = int(m.group(2))
                if mnum and _validate_period(year, mnum):
                    return f"{year}-{mnum:02d}"
    return None


def detect_period(filename_or_path: str | Path) -> str | None:
    """Resolve period (YYYY-MM) for a file. Tries filename first, falls back
    to opening the file and reading its title row.
    """
    path = Path(filename_or_path)
    fn_period = detect_period_from_filename(path.name)
    if fn_period:
        return fn_period
    if path.is_file():
        return extract_period_from_content(path)
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
    """Return one of:
      'modern'        - 2023+, Bank Name col 2, Micro ATMs present, values in Rs '000
      'transition'    - 2020 (Jun+)-2022, Bank Name col 1, Micro ATMs, Rs Lakh
      'legacy'        - 2017-2019, Bank Name col 2, no Micro ATMs, Rs Millions
      'legacy_narrow' - 2020 Mar-Apr (and similar), Bank Name col 1, no Micro ATMs, Rs Lakh
    """
    head_text = " ".join(
        str(v) for v in df.head(12).values.flatten() if isinstance(v, str)
    ).lower()
    has_micro = "micro atm" in head_text
    # Locate the column that holds the literal "Bank Name" header
    bank_col: int | None = None
    for r in range(min(12, len(df))):
        for c in range(min(5, df.shape[1])):
            v = df.iat[r, c]
            if isinstance(v, str) and v.strip().lower() == "bank name":
                bank_col = c
                break
        if bank_col is not None:
            break

    if has_micro:
        return "modern" if bank_col == 2 else "transition"
    return "legacy" if bank_col == 2 else "legacy_narrow"


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


def parse_transition(df: pd.DataFrame) -> list[dict]:
    """2020-2022 layout: has Micro ATMs but tighter column placement than
    modern. Values are in Rupees Lakh (1 Lakh = 100 thousand).
    """
    # Confirmed from June 2020 / Jan 2021 / Jan 2022 files:
    # col 1 = Bank Name, 2 = On-site, 3 = Off-site, 6 = Micro ATMs
    # col 9 = CC Transactions @ ATM (volume) = cash withdrawal volume
    # col 11 = CC Value of transactions @ ATM (Rs Lakh)
    # col 14 = DC Transactions @ ATM (volume)
    # col 16 = DC Value of transactions @ ATM (Rs Lakh)
    BANK, ONSITE, OFFSITE, MICRO = 1, 2, 3, 6
    CC_VOL, CC_VAL_LAKH = 9, 11
    DC_VOL, DC_VAL_LAKH = 14, 16

    rows: list[dict] = []
    current_category: str | None = None

    for i in range(len(df)):
        bank_cell = df.iat[i, BANK] if df.shape[1] > BANK else None
        if not isinstance(bank_cell, str):
            continue
        bank = bank_cell.strip()
        if not bank:
            continue

        # Section header (Public/Private/Foreign/Payment/Small Finance) shares
        # the bank-name column in this layout.
        cat = _find_category(bank)
        if cat:
            current_category = cat
            continue

        lower = bank.lower()
        if (lower.startswith("total")
                or lower.startswith("grand total")
                or lower.startswith("note")
                or lower in ("bank name", "sr. no.", "particulars")
                or lower.startswith("scheduled commercial")):
            continue

        if not _is_numeric(df.iat[i, ONSITE]) and not _is_numeric(df.iat[i, OFFSITE]):
            continue

        cc_val = _to_float(df.iat[i, CC_VAL_LAKH])
        dc_val = _to_float(df.iat[i, DC_VAL_LAKH])

        rows.append({
            "bank": bank,
            "category": current_category,
            "on_site_atms": _to_int(df.iat[i, ONSITE]),
            "off_site_atms": _to_int(df.iat[i, OFFSITE]),
            "micro_atms": _to_int(df.iat[i, MICRO]),
            "credit_card_atm_withdrawal_volume": _to_int(df.iat[i, CC_VOL]),
            "credit_card_atm_withdrawal_value_thousands": cc_val * 100 if cc_val is not None else None,
            "debit_card_atm_withdrawal_volume": _to_int(df.iat[i, DC_VOL]),
            "debit_card_atm_withdrawal_value_thousands": dc_val * 100 if dc_val is not None else None,
        })
    return rows


def parse_legacy_narrow(df: pd.DataFrame) -> list[dict]:
    """March-April 2020 layout: no Micro ATMs, Bank Name col 1, values in Lakh."""
    BANK, ONSITE, OFFSITE = 1, 2, 3
    CC_VOL, CC_VAL_LAKH = 7, 9
    DC_VOL, DC_VAL_LAKH = 12, 14

    rows: list[dict] = []
    current_category: str | None = None

    for i in range(len(df)):
        bank_cell = df.iat[i, BANK] if df.shape[1] > BANK else None
        if not isinstance(bank_cell, str):
            continue
        bank = bank_cell.strip()
        if not bank:
            continue

        cat = _find_category(bank)
        if cat:
            current_category = cat
            continue

        lower = bank.lower()
        if (lower.startswith("total")
                or lower.startswith("grand total")
                or lower.startswith("note")
                or lower in ("bank name", "sr. no.", "particulars")
                or lower.startswith("scheduled commercial")):
            continue

        if not _is_numeric(df.iat[i, ONSITE]) and not _is_numeric(df.iat[i, OFFSITE]):
            continue

        cc_val = _to_float(df.iat[i, CC_VAL_LAKH])
        dc_val = _to_float(df.iat[i, DC_VAL_LAKH])

        rows.append({
            "bank": bank,
            "category": current_category,
            "on_site_atms": _to_int(df.iat[i, ONSITE]),
            "off_site_atms": _to_int(df.iat[i, OFFSITE]),
            "micro_atms": None,
            "credit_card_atm_withdrawal_volume": _to_int(df.iat[i, CC_VOL]),
            "credit_card_atm_withdrawal_value_thousands": cc_val * 100 if cc_val is not None else None,
            "debit_card_atm_withdrawal_volume": _to_int(df.iat[i, DC_VOL]),
            "debit_card_atm_withdrawal_value_thousands": dc_val * 100 if dc_val is not None else None,
        })
    return rows


def parse_file(path: str | Path) -> dict:
    """Parse an RBI ATM stats file and return {period, format, banks: [...]}"""
    path = Path(path)
    engine = "xlrd" if path.suffix.lower() == ".xls" else "openpyxl"
    df = pd.read_excel(path, sheet_name=0, header=None, engine=engine)

    period = detect_period(path)
    fmt = _detect_format(df)
    if fmt == "modern":
        banks = parse_modern(df)
    elif fmt == "transition":
        banks = parse_transition(df)
    elif fmt == "legacy_narrow":
        banks = parse_legacy_narrow(df)
    else:
        banks = parse_legacy(df)

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
