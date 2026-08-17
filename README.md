# Nocturne DJ

An AI co-pilot for your Spotify queue. Connect your account and it listens for
the right moment to line up what plays next — matching the concrete genre,
tempo and energy of what you're already hearing instead of generic picks.

Single-page app (`index.html` + `support.js`) backed by one Vercel serverless
function (`api/groq.js`) that keeps the Groq API key off the client.

## Architecture

| Path | Responsibility |
| --- | --- |
| `index.html` | The whole app: Spotify auth (PKCE), playback polling, DJ Mode, My Turn, queueing |
| `support.js` | Generated runtime that renders `index.html`'s template — **do not edit**, rebuilt from tooling |
| `api/groq.js` | Vercel serverless function. Holds `GROQ_API_KEY` server-side, calls the Groq chat completions API, returns clean track JSON |
| `vercel.json` | Static hosting config (`framework: null` — no Vite/other preset, no rewrites needed beyond serving the files as-is) |

Nothing runs server-side except that one function — there's no database, no
build step, no bundler for the app itself.

## How a suggestion gets made

1. The browser polls `GET /v1/me/player/currently-playing` every 15s.
2. Once the track passes 66% (DJ Mode) or you hit **Suggest now** (My Turn),
   it gathers grounding data directly from Spotify:
   - `GET /v1/artists/{id}` → the current artist's confirmed genres
   - `GET /v1/me/player/recently-played` → last 5 tracks, as a timeline
   - `GET /v1/me/top/artists` → your overall top genres (tiebreaker only)
3. All of that plus the track name/artist and selected mode/instruction goes
   to `POST /api/groq`, which discovers a currently-live Groq chat model at
   request time (never hardcoded — see `api/groq.js`) and asks it for 10-12
   ranked candidate songs, grounded in the real genre data rather than the
   model's own guess.
4. The browser resolves each candidate against `GET /v1/search` and queues
   the first 3 that actually exist on Spotify — candidates that don't
   resolve are logged and skipped instead of wasting a slot.

## Local development

```bash
npm install -g vercel   # if you don't have it
vercel dev
```

Needs a `.env` (gitignored) with:

```
GROQ_API_KEY=gsk_...
```

The Spotify Client ID is **not** read from an env var — there's no build step
that could substitute one into a static HTML file. It's hardcoded as the
`CLIENT_ID` constant near the top of `index.html`'s script block; edit it
there if you swap in your own Spotify app.

## Deploying

1. Import the repo at <https://vercel.com/new>. Framework Preset: **Other**.
2. Add `GROQ_API_KEY` in Project Settings → Environment Variables — `.env` is
   local-only and never gets deployed.
3. In the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard),
   under your app's Settings → Redirect URIs, add the deployed URL exactly as
   the browser will send it: `https://<your-domain>/` (HTTPS, trailing slash).
   Spotify no longer accepts `http://localhost` reliably for every app, so
   testing against the real deployed domain is the path of least resistance.

## Auth notes

- Uses Authorization Code + PKCE (`response_type=code`), not the deprecated
  Implicit Grant (`response_type=token`) — Spotify stopped accepting the
  latter for all apps.
- Scopes requested: `user-read-currently-playing`, `user-read-playback-state`,
  `user-modify-playback-state`, `user-read-recently-played`, `user-top-read`.
  If you add a scope later, existing sessions won't have it — click
  Disconnect then Connect to Spotify again to re-consent.
- Tokens live in `sessionStorage`, not `localStorage` — closing the tab ends
  the session.
- The access token (~1h lifetime) is refreshed silently in the background
  using the stored refresh token, proactively before it expires and
  reactively on a stray 401 — an open tab survives an overnight DJ session
  without needing to reconnect.
- Requires an **active playback device**: start playing something in the
  Spotify app first, otherwise queue writes have nowhere to go.

## Known limitations

- Groq is a text model with no live internet access — it can still invent a
  plausible-sounding song that doesn't exist. The app buffers for this (asks
  for 6 candidates, verifies each on Spotify, keeps the first 3 real ones)
  but can't eliminate it entirely.
- `GET /v1/artists/{id}` (genres) is unrestricted, but Spotify locked down
  `recommendations` and `audio-features` for apps created after Nov 2024 —
  this app never relies on either, by design.
- Artists with no genre tagged on Spotify (small/niche/very new) fall back to
  the model's own knowledge, which is where quality drops the most.
