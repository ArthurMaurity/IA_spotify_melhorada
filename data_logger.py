"""Persistence: CSV history, plain-text session summary, optional Google Sheets.

Rows are appended one at a time (never a growing in-memory DataFrame) so RAM
stays flat during long radio sessions. Any null/empty field is replaced by
config.NULL_FILL (0) so a missing genre never costs us the whole row.
"""

import csv
import os
from datetime import datetime, timedelta

import config

COLUMNS = [
    "timestamp",
    "mode",
    "context_track",
    "context_artist",
    "recommended_track",
    "recommended_artist",
    "recommended_uri",
    "justification",
    "injected",
    "latency_ms",
]


def _fill(value):
    """Replace null/empty values with NULL_FILL to preserve row integrity."""
    if value is None:
        return config.NULL_FILL
    if isinstance(value, str) and not value.strip():
        return config.NULL_FILL
    if isinstance(value, float) and value != value:  # NaN
        return config.NULL_FILL
    return value


class DataLogger:
    def __init__(self):
        self.csv_path = config.CSV_PATH
        self.txt_path = config.SESSION_LOG_PATH
        self.rows_written = 0
        self._sheet = None
        self._sheet_error = None
        self._ensure_csv()
        if config.SHEETS_ENABLED:
            self._connect_sheets()
        self._append_txt(f"=== Session started {datetime.now():%Y-%m-%d %H:%M:%S} ===")

    # ---------- setup ----------

    def _ensure_csv(self):
        if not os.path.exists(self.csv_path):
            with open(self.csv_path, "w", newline="", encoding="utf-8") as fh:
                csv.writer(fh).writerow(COLUMNS)

    def _connect_sheets(self):
        """Lazy Sheets setup; failure degrades to CSV-only, never fatal."""
        try:
            import gspread
            from google.oauth2.service_account import Credentials

            creds = Credentials.from_service_account_file(
                config.GOOGLE_CREDENTIALS_FILE,
                scopes=["https://www.googleapis.com/auth/spreadsheets"],
            )
            client = gspread.authorize(creds)
            book = client.open(config.GOOGLE_SHEET_NAME)
            try:
                self._sheet = book.worksheet(config.GOOGLE_WORKSHEET_NAME)
            except Exception:
                self._sheet = book.add_worksheet(
                    config.GOOGLE_WORKSHEET_NAME, rows=1000, cols=len(COLUMNS)
                )
                self._sheet.append_row(COLUMNS)
        except Exception as exc:
            self._sheet = None
            self._sheet_error = str(exc)

    # ---------- writing ----------

    def log(
        self,
        mode,
        context_track=None,
        recommendation=None,
        justification=None,
        injected=False,
        latency_ms=None,
    ):
        """Persist one recommendation. Returns a short status string for the UI."""
        context_track = context_track or {}
        recommendation = recommendation or {}

        row = [
            _fill(datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
            _fill(mode),
            _fill(context_track.get("name")),
            _fill(context_track.get("artist")),
            _fill(recommendation.get("name") or recommendation.get("title")),
            _fill(recommendation.get("artist")),
            _fill(recommendation.get("uri")),
            _fill(justification),
            1 if injected else 0,
            _fill(latency_ms),
        ]

        status = []
        try:
            with open(self.csv_path, "a", newline="", encoding="utf-8") as fh:
                csv.writer(fh).writerow(row)
            self.rows_written += 1
            status.append("CSV ok")
        except Exception as exc:
            status.append(f"CSV failed ({exc})")

        if self._sheet is not None:
            try:
                self._sheet.append_row(row, value_input_option="USER_ENTERED")
                status.append("Sheets ok")
            except Exception as exc:
                status.append(f"Sheets failed ({exc})")
        elif config.SHEETS_ENABLED:
            status.append(f"Sheets off ({self._sheet_error})")

        self._append_txt(
            f"[{row[0]}] {mode} | after '{row[2]} - {row[3]}' -> "
            f"'{row[4]} - {row[5]}' | {'queued' if injected else 'NOT queued'} | {row[7]}"
        )
        return " | ".join(status)

    def _append_txt(self, line: str):
        try:
            with open(self.txt_path, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        except Exception:
            pass  # the txt summary is a convenience, never a failure point

    def close(self, extra: str = ""):
        self._append_txt(
            f"=== Session ended {datetime.now():%Y-%m-%d %H:%M:%S} | "
            f"{self.rows_written} recommendation(s) logged {extra} ===\n"
        )

    # ---------- cooldown helper ----------

    def recent_recommendations(self, minutes: int = None):
        """Rows logged in the last `minutes` -- feeds the AI cooldown blocklist.

        Returns a list of {'uri','title','artist'} dicts, newest first.
        """
        minutes = config.COOLDOWN_MINUTES if minutes is None else minutes
        if not os.path.exists(self.csv_path):
            return []
        cutoff = datetime.now() - timedelta(minutes=minutes)
        out = []
        try:
            with open(self.csv_path, newline="", encoding="utf-8") as fh:
                for row in csv.DictReader(fh):
                    try:
                        ts = datetime.strptime(row["timestamp"], "%Y-%m-%d %H:%M:%S")
                    except (ValueError, KeyError):
                        continue
                    if ts < cutoff:
                        continue
                    uri = row.get("recommended_uri")
                    if not uri or uri == str(config.NULL_FILL):
                        continue
                    out.append({
                        "uri": uri,
                        "title": row.get("recommended_track"),
                        "artist": row.get("recommended_artist"),
                    })
        except Exception:
            pass
        out.reverse()
        return out

    # ---------- analysis helper ----------

    def load_history(self):
        """Read the CSV back as a DataFrame with nulls filled (analysis only)."""
        import pandas as pd

        if not os.path.exists(self.csv_path):
            return pd.DataFrame(columns=COLUMNS)
        return pd.read_csv(self.csv_path).fillna(config.NULL_FILL)
