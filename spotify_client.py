"""Thin wrapper over spotipy: auth, playback reads, and queue injection.

Every network call is wrapped so a dropped connection or an expired token never
takes down the main loop -- failures return None/[] and the caller keeps polling.
"""

import time

import spotipy
from spotipy.oauth2 import SpotifyOAuth

import config


class SpotifyClient:
    def __init__(self):
        auth = SpotifyOAuth(
            client_id=config.SPOTIFY_CLIENT_ID,
            client_secret=config.SPOTIFY_CLIENT_SECRET,
            redirect_uri=config.SPOTIFY_REDIRECT_URI,
            scope=config.SPOTIFY_SCOPE,
            cache_path=config.SPOTIFY_CACHE_PATH,
            open_browser=False,  # Termux/headless: the URL is printed instead.
        )
        # requests_timeout keeps a stalled mobile connection from hanging the loop;
        # retries covers transient 5xx/429 without extra code on our side.
        self.sp = spotipy.Spotify(auth_manager=auth, requests_timeout=10, retries=3)

    # ---------- internals ----------

    @staticmethod
    def _safe(fn, *args, **kwargs):
        """Run a spotipy call, swallowing network/API errors.

        Returns (result, error_message). One retry covers the common case of a
        token that expired mid-call (spotipy refreshes it on the next attempt).
        """
        for attempt in (1, 2):
            try:
                return fn(*args, **kwargs), None
            except spotipy.SpotifyException as exc:
                if attempt == 1 and exc.http_status in (401, 429, 500, 502, 503):
                    time.sleep(1)
                    continue
                return None, f"Spotify API error: {exc}"
            except Exception as exc:  # network drop, DNS, timeout...
                if attempt == 1:
                    time.sleep(1)
                    continue
                return None, f"Connection error: {exc}"
        return None, "unknown error"

    @staticmethod
    def _simplify(track: dict) -> dict:
        """Flatten a Spotify track object into the small dict the rest of the app uses."""
        if not track:
            return {}
        artists = [a.get("name") for a in track.get("artists") or [] if a.get("name")]
        return {
            "id": track.get("id") or config.NULL_FILL,
            "uri": track.get("uri") or config.NULL_FILL,
            "name": track.get("name") or config.NULL_FILL,
            "artist": ", ".join(artists) if artists else config.NULL_FILL,
            "album": (track.get("album") or {}).get("name") or config.NULL_FILL,
            "duration_ms": track.get("duration_ms") or config.NULL_FILL,
            "popularity": track.get("popularity") or config.NULL_FILL,
        }

    # ---------- public API ----------

    def me(self):
        data, err = self._safe(self.sp.current_user)
        if err:
            return None, err
        return (data or {}).get("display_name") or "user", None

    def currently_playing(self):
        """Return (state, error).

        state = {track fields..., 'progress_ms', 'is_playing', 'progress_ratio'}
        or None when nothing is playing.
        """
        data, err = self._safe(self.sp.current_playback)
        if err:
            return None, err
        if not data or not data.get("item"):
            return None, None

        state = self._simplify(data["item"])
        progress = data.get("progress_ms") or 0
        duration = data["item"].get("duration_ms") or 0
        state["progress_ms"] = progress
        state["is_playing"] = bool(data.get("is_playing"))
        state["progress_ratio"] = (progress / duration) if duration else 0.0
        return state, None

    def recently_played(self, limit: int = 5):
        """Most recent finished tracks, newest first."""
        limit = max(1, min(limit, 50))
        data, err = self._safe(self.sp.current_user_recently_played, limit=limit)
        if err:
            return [], err
        items = (data or {}).get("items") or []
        return [self._simplify(i.get("track")) for i in items if i.get("track")], None

    def recent_played(self, minutes: int = None):
        """Tracks actually played in the last `minutes` -- feeds the cooldown blocklist.

        Unlike recently_played (which is limit-bound), this is time-bound via the
        Spotify API's `after` cursor, so it lines up with the logger's own window.
        """
        minutes = config.COOLDOWN_MINUTES if minutes is None else minutes
        after_ms = int((time.time() - minutes * 60) * 1000)
        data, err = self._safe(self.sp.current_user_recently_played, limit=50, after=after_ms)
        if err:
            return [], err
        items = (data or {}).get("items") or []
        return [self._simplify(i.get("track")) for i in items if i.get("track")], None

    def search_track(self, query: str):
        """Resolve a free-text 'Artist - Title' suggestion to a real Spotify track."""
        if not query:
            return None, "empty query"
        data, err = self._safe(self.sp.search, q=query, type="track", limit=1)
        if err:
            return None, err
        items = ((data or {}).get("tracks") or {}).get("items") or []
        if not items:
            return None, None
        return self._simplify(items[0]), None

    def add_to_queue(self, uri: str):
        """Push a track URI onto the active device's queue."""
        if not uri or uri == config.NULL_FILL:
            return False, "invalid uri"
        _, err = self._safe(self.sp.add_to_queue, uri)
        if err:
            return False, err
        return True, None

    def queued_uris(self):
        """URIs already in the queue -- used to avoid injecting duplicates."""
        data, err = self._safe(self.sp.queue)
        if err:
            return set(), err
        items = (data or {}).get("queue") or []
        return {t.get("uri") for t in items if t.get("uri")}, None
