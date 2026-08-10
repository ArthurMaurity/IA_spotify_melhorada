# Spotify Flow & Queue Manager (AI DJ)

Intelligent Spotify queue manager. It reads what you just listened to, asks Gemini
for tracks that bridge smoothly from it (no abrupt genre/tempo/energy jumps), and
injects them straight into your Spotify queue.

Lightweight by design — no background DataFrames, small prompts, single-threaded
polling — so it runs fine in Termux or a cheap cloud box.

## Modules

| File | Responsibility |
| --- | --- |
| `config.py` | Loads `.env`, validates keys, exposes execution parameters |
| `spotify_client.py` | OAuth, `currently_playing`, `recently_played`, `add_to_queue` |
| `ai_engine.py` | Gemini prompt enforcing the Golden Rule of Sequencing |
| `data_logger.py` | CSV + `.txt` session log + optional Google Sheets sync |
| `main.py` | Terminal UI and the two operation modes |

## Install

```bash
pip install -r requirements.txt
cp .env.example .env      # then fill it in
python main.py
```

Python 3.10+.

## Configuration

1. **Spotify** — create an app at <https://developer.spotify.com/dashboard>, add
   `http://127.0.0.1:8888/callback` as a Redirect URI, and copy the Client ID/Secret
   into `.env`. On first run the app prints an authorization URL; open it, approve,
   and paste the URL you land on back into the terminal. The token is cached in
   `.cache-spotify` and refreshed automatically afterwards.
2. **Gemini** — get a free key at <https://aistudio.google.com/apikey>.
3. **Google Sheets (optional)** — set `SHEETS_ENABLED=true`, drop a service-account
   JSON at `GOOGLE_CREDENTIALS_FILE`, and share the target spreadsheet with the
   service account's email. If it fails, logging silently falls back to CSV only.

Tunables in `.env`: `POLL_INTERVAL`, `INJECT_THRESHOLD` (0.66 = final third),
`CONTEXT_SIZE`, `TRACKS_PER_INJECTION`.

## Modes

**1 — Radio Mode.** Polls playback every `POLL_INTERVAL` seconds. Once the current
track passes `INJECT_THRESHOLD`, it sends the last `CONTEXT_SIZE` tracks to Gemini
and queues `TRACKS_PER_INJECTION` suggestions. Fires at most once per track.

**2 — My Turn Mode.** You type an intention (e.g. *"smooth transition from rap to
something calmer"*) and it builds a gradual sequence from your current context.

Spotify requires an **active playback device** — start playing something in the
Spotify app first, otherwise queue writes have nowhere to go.

## Output

- `history.csv` — one row per recommendation (context, suggestion, justification,
  whether it was queued, AI latency).
- `session_log.txt` — human-readable session summary.
- Google Sheets — same rows, when enabled.

Empty or missing fields are written as `0` rather than blank, so no row is ever
lost during analysis. `DataLogger.load_history()` returns the CSV as a
null-filled pandas DataFrame.

## Notes

- Uses the current `google-genai` SDK; the older `google-generativeai` package is
  end-of-life.
- Track suggestions come from Gemini by name and are resolved via Spotify search,
  so the app does not depend on Spotify's deprecated `recommendations` /
  `audio-features` endpoints (unavailable to apps created after Nov 2024).
- Network drops and token expiry are retried once and then skipped — the loop
  never crashes.
