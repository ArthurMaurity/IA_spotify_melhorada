"""Central configuration: reads .env once and exposes plain module-level values.

Kept dependency-free (beyond python-dotenv) so importing it is cheap on mobile.
"""

import os

from dotenv import load_dotenv

load_dotenv()


def _get(name: str, default: str = "") -> str:
    return (os.getenv(name) or default).strip()


def _get_int(name: str, default: int) -> int:
    try:
        return int(float(_get(name, str(default))))
    except ValueError:
        return default


def _get_float(name: str, default: float) -> float:
    try:
        return float(_get(name, str(default)))
    except ValueError:
        return default


def _get_bool(name: str, default: bool = False) -> bool:
    return _get(name, str(default)).lower() in ("1", "true", "yes", "on")


# --- Spotify ---
SPOTIFY_CLIENT_ID = _get("SPOTIFY_CLIENT_ID")
SPOTIFY_CLIENT_SECRET = _get("SPOTIFY_CLIENT_SECRET")
SPOTIFY_REDIRECT_URI = _get("SPOTIFY_REDIRECT_URI", "http://127.0.0.1:8888/callback")
SPOTIFY_CACHE_PATH = _get("SPOTIFY_CACHE_PATH", ".cache-spotify")

# Scopes needed to read playback/history and write to the queue.
SPOTIFY_SCOPE = " ".join(
    [
        "user-read-currently-playing",
        "user-read-playback-state",
        "user-modify-playback-state",
        "user-read-recently-played",
    ]
)

# --- Gemini ---
GEMINI_API_KEY = _get("GEMINI_API_KEY")
GEMINI_MODEL = _get("GEMINI_MODEL", "gemini-2.0-flash")

# --- Google Sheets (optional) ---
SHEETS_ENABLED = _get_bool("SHEETS_ENABLED", False)
GOOGLE_CREDENTIALS_FILE = _get("GOOGLE_CREDENTIALS_FILE", "credentials.json")
GOOGLE_SHEET_NAME = _get("GOOGLE_SHEET_NAME", "SpotifyFlowLog")
GOOGLE_WORKSHEET_NAME = _get("GOOGLE_WORKSHEET_NAME", "history")

# --- Execution parameters ---
POLL_INTERVAL = _get_int("POLL_INTERVAL", 15)
INJECT_THRESHOLD = _get_float("INJECT_THRESHOLD", 0.66)
CONTEXT_SIZE = max(3, min(_get_int("CONTEXT_SIZE", 5), 10))
TRACKS_PER_INJECTION = max(1, min(_get_int("TRACKS_PER_INJECTION", 2), 5))
CSV_PATH = _get("CSV_PATH", "history.csv")
SESSION_LOG_PATH = _get("SESSION_LOG_PATH", "session_log.txt")

# Minutes of lookback used to build the "don't repeat this" cooldown blocklist.
COOLDOWN_MINUTES = _get_int("COOLDOWN_MINUTES", 120)

# Value used to replace null/empty fields so no data row is ever dropped.
NULL_FILL = 0


def validate() -> list:
    """Return a list of human-readable problems with the current config."""
    problems = []
    if not SPOTIFY_CLIENT_ID or not SPOTIFY_CLIENT_SECRET:
        problems.append("SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET missing in .env")
    if not GEMINI_API_KEY:
        problems.append("GEMINI_API_KEY missing in .env")
    if SHEETS_ENABLED and not os.path.exists(GOOGLE_CREDENTIALS_FILE):
        problems.append(f"SHEETS_ENABLED=true but {GOOGLE_CREDENTIALS_FILE} not found")
    return problems
