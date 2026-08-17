# Nocturne DJ

An AI co-pilot for your music queue. Connect your account and it listens for
the right moment to line up what plays next — matching the concrete genre,
tempo and energy of what you're already hearing instead of generic picks.

Spotify, YouTube Music and Apple Music are all supported, but not to the same
depth — see "Provider capabilities" below before picking one.

Single-page app (`index.html` + `support.js`) backed by three Vercel
serverless functions that keep API keys/secrets off the client.

## Architecture

| Path | Responsibility |
| --- | --- |
| `index.html` | The whole app: provider auth, playback polling, DJ Mode, My Turn, queueing |
| `support.js` | Generated runtime that renders `index.html`'s template — **do not edit**, rebuilt from tooling |
| `api/groq.js` | Holds `GROQ_API_KEY` server-side, discovers a live Groq chat model, calls the chat completions API, returns clean track JSON |
| `api/apple-token.js` | Signs Apple MusicKit "developer tokens" (ES256 JWT) server-side so the MusicKit private key never reaches the browser |
| `api/youtube-token.js` | Proxies the Google OAuth token exchange so `YOUTUBE_CLIENT_SECRET` never reaches the browser (Google requires a client secret at exchange time even for PKCE — Spotify doesn't) |
| `vercel.json` | Static hosting config (`framework: null` — no Vite/other preset, no rewrites needed beyond serving the files as-is) |

Nothing runs server-side except those three functions — there's no database,
no build step, no bundler for the app itself.

## Provider capabilities

Spotify's Web API is the only one of the three with a real cross-device
"what's playing right now" endpoint, so it's the only provider where DJ Mode
(auto-suggest near the end of a track) works exactly as advertised.

- **Spotify** — full parity: now-playing detection, real device queueing,
  audio history, top genres.
- **YouTube Music** — the YouTube Data API has **no** now-playing or queue
  API of any kind for a user's own device. DJ Mode's auto-trigger can't work
  here; use **My Turn** instead. Suggestions get added to a "Nocturne DJ
  Queue" playlist (auto-created on first use) rather than an in-app queue —
  play that playlist to actually hear them.
- **Apple Music** — MusicKit JS only ever knows what *it itself* is playing,
  not what's playing in the native Apple Music app elsewhere. So Apple Music
  here means playing through this page via MusicKit's embedded player — in
  exchange you get real playback + real queue control (`playLater`), which
  YouTube can't offer at all.

The UI shows a capability note for YouTube/Apple once connected.

## How a suggestion gets made

1. The browser polls the active provider's now-playing state every 15s
   (Spotify: `GET /v1/me/player/currently-playing`; Apple: MusicKit's own
   player state; YouTube: not available, see above).
2. Once the track passes 66% (DJ Mode) or you hit **Suggest now** (My Turn),
   it gathers whatever grounding data the provider can offer: confirmed
   genres for the artist, last-5 recently-played tracks, overall top genres.
3. All of that plus the track name/artist and selected mode/instruction goes
   to `POST /api/groq`, which discovers a currently-live Groq chat model at
   request time (never hardcoded — see `api/groq.js`) and asks it for 10-12
   ranked candidate songs, grounded in the real genre data rather than the
   model's own guess.
4. The browser resolves each candidate against the provider's search and
   queues the first 3 that actually exist — candidates that don't resolve
   are logged and skipped instead of wasting a slot.

## Local development

```bash
npm install -g vercel   # if you don't have it
vercel dev
```

Needs a `.env` (gitignored). At minimum:

```
GROQ_API_KEY=gsk_...
```

Add the YouTube/Apple variables below only if you're testing those providers.

The Spotify Client ID and YouTube Client ID are **not** read from env vars —
there's no build step that could substitute one into a static HTML file.
They're hardcoded as the `CLIENT_ID` / `YOUTUBE_CLIENT_ID` constants near the
top of `index.html`'s script block; edit them there. (Client IDs are public
identifiers by design in OAuth — safe to ship in client code. Client
*secrets* are not, which is why those live in env vars behind the two proxy
functions instead.)

## Deploying

1. Import the repo at <https://vercel.com/new>. Framework Preset: **Other**.
2. Add env vars in Project Settings → Environment Variables (below) —
   `.env` is local-only and never gets deployed.
3. In the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard),
   under your app's Settings → Redirect URIs, add the deployed URL exactly as
   the browser will send it: `https://<your-domain>/` (HTTPS, trailing slash).
   Spotify no longer accepts `http://localhost` reliably for every app, so
   testing against the real deployed domain is the path of least resistance.

## Adding YouTube Music

1. In [Google Cloud Console](https://console.cloud.google.com/), create a
   project (or reuse one), enable **YouTube Data API v3**, then create an
   OAuth 2.0 Client ID of type **Web application** under
   APIs & Services → Credentials.
2. Add your deployed URL (and `http://localhost:3000/` for local dev) as an
   **Authorized redirect URI**.
3. Set `YOUTUBE_CLIENT_ID` in `index.html` (the constant, not an env var —
   see above) to the Client ID.
4. Set `YOUTUBE_CLIENT_SECRET` as a server env var (`.env` locally, Vercel
   Project Settings for deploys). This one **is** a real secret — never put
   it in `index.html`.

Google only grants a scope like `youtube.force-ssl` after an OAuth consent
screen review for public apps; for personal use, add your own Google account
as a test user under the consent screen's "Test users" list and you can skip
verification entirely.

## Adding Apple Music

1. Requires an active [Apple Developer Program](https://developer.apple.com/programs/)
   membership (paid, $99/year) — Apple Music integration isn't available on
   a free Apple ID.
2. In the Apple Developer portal: create a MusicKit identifier, then a
   MusicKit private key (downloads once as a `.p8` file — save it, it can't
   be re-downloaded). Note your **Team ID** and the key's **Key ID**.
3. Set three server env vars (`.env` locally, Vercel Project Settings for
   deploys):
   ```
   APPLE_TEAM_ID=...
   APPLE_KEY_ID=...
   APPLE_PRIVATE_KEY=<contents of the .p8 file>
   ```
   `APPLE_PRIVATE_KEY` can be pasted either as the raw multi-line PEM or as a
   single line with `\n` in place of real newlines — `api/apple-token.js`
   normalizes either form.
4. The listener connecting to Apple Music needs an active Apple Music
   subscription — MusicKit's `authorize()` will fail without one.

## Auth notes

- Spotify and YouTube use Authorization Code + PKCE (`response_type=code`).
  Apple Music instead uses MusicKit JS's own `authorize()` popup — there's no
  redirect-based OAuth flow for it at all.
- Google's token endpoint requires a client secret even for a PKCE request
  from a Web application client — `api/youtube-token.js` proxies the
  exchange so that secret stays server-side (see Architecture table above).
- Tokens live in `sessionStorage`, not `localStorage` — closing the tab ends
  the session. Apple Music additionally keeps its own session state inside
  MusicKit's SDK.
- Spotify/YouTube access tokens are refreshed silently in the background
  using the stored refresh token, proactively before they expire and
  reactively on a stray 401 — an open tab survives an overnight DJ session
  without needing to reconnect. Apple Music has no equivalent silent-refresh
  path (MusicKit manages its own session lifetime); a lost session just
  needs reconnecting.
- Spotify requires an **active playback device**: start playing something in
  the Spotify app first, otherwise queue writes have nowhere to go.

## Known limitations

- Groq is a text model with no live internet access — it can still invent a
  plausible-sounding song that doesn't exist. The app buffers for this (asks
  for 10-12 candidates, verifies each against the provider's search, keeps
  the first 3 real ones) but can't eliminate it entirely.
- Spotify: `GET /v1/artists/{id}` (genres) is unrestricted, but Spotify
  locked down `recommendations` and `audio-features` for apps created after
  Nov 2024 — this app never relies on either, by design.
- YouTube: no now-playing/queue API exists at all (see "Provider
  capabilities"), and no genre-tagging or listening-history API either — the
  AI falls back entirely on its own knowledge of the artist for YouTube
  sessions, with no grounding data.
- Apple Music: DJ Mode and now-playing detection only see playback through
  this page's embedded MusicKit player, not the native Apple Music app
  elsewhere. Catalog search has no popularity/play-count signal to rank
  fallback picks by, unlike Spotify's `popularity` or YouTube's view counts.
- Artists with no genre tagged (small/niche/very new, or any YouTube session)
  fall back to the model's own knowledge, which is where quality drops the most.
