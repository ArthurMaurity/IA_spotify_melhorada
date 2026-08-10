"""Gemini-backed sequencing brain.

Given the last few tracks (and optionally a user intention), it returns the next
tracks to play plus a one-line justification for the transition. The prompt
enforces the Golden Rule: no abrupt genre/energy jumps.
"""

import json
import re
from datetime import datetime

from google import genai
from google.genai import types

import config

SYSTEM_RULES = """You are an expert DJ specialized in seamless transitions.

GOLDEN RULE OF SEQUENCING (mandatory):
Analyze the genre, tempo (approximate BPM), and energy of the last tracks the
listener heard. Choose songs that create a smooth bridge from those tracks.
Abrupt jumps in style, tempo, or energy are FORBIDDEN. Immediate coherence with
the MOST RECENT track outweighs everything else.

TEMPORAL AWARENESS:
The prompt tells you the current day of week and time of day. Subtly adjust the
ENERGY level of your picks to match the real-world moment (e.g. calmer/lower
energy late at night or early morning, higher energy on Friday/Saturday
evenings) -- without ever breaking the Golden Rule above.

COOLDOWN / BLOCKLIST:
The prompt may include a "Blocklist" of tracks played or recommended in the
last two hours. NEVER suggest anything on that list, even if it would
otherwise be a perfect fit -- pick a different song that still respects the
Golden Rule.

GENRE BRIDGE RULE (applies to My Turn mode, when the listener states an
explicit intention):
If honouring the listener's intention implies a drastic genre/energy shift
from the most recent track, do NOT cut directly into the new genre. Instead,
make the first 1-2 suggested tracks "bridge tracks" that audibly share
elements (tempo, instrumentation, mood, vocal style) with BOTH the old and the
new genre, and only move fully into the requested genre afterwards. A hard cut
is FORBIDDEN when a shift is drastic.

Additional constraints:
- Suggest only real, existing, commercially released songs findable on Spotify.
- Never repeat a track or artist that appears in the recent history.
- Respect the listener's language/regional taste implied by the history.

Answer with RAW JSON only (no markdown fences, no prose), exactly:
{"tracks":[{"artist":"...","title":"...","why":"one short sentence"}],
 "justification":"one sentence on how the sequence bridges the flow"}"""


class AIEngine:
    def __init__(self):
        self.client = genai.Client(api_key=config.GEMINI_API_KEY)
        self.gen_config = types.GenerateContentConfig(
            system_instruction=SYSTEM_RULES,
            temperature=0.8,
            # Small cap: the reply is a handful of song names, nothing more.
            max_output_tokens=600,
            response_mime_type="application/json",
        )

    # ---------- internals ----------

    @staticmethod
    def _format_history(history: list) -> str:
        if not history:
            return "(no history available)"
        lines = []
        # Oldest first so "most recent" is literally last in the prompt.
        for i, t in enumerate(reversed(history), start=1):
            lines.append(f"{i}. {t.get('artist')} - {t.get('name')}")
        lines[-1] += "   <-- MOST RECENT, bridge from this one"
        return "\n".join(lines)

    @staticmethod
    def _temporal_context() -> str:
        """Real-world day/time, in plain English, for the prompt."""
        now = datetime.now()
        hour = now.hour
        if 5 <= hour < 12:
            part_of_day = "morning"
        elif 12 <= hour < 18:
            part_of_day = "afternoon"
        elif 18 <= hour < 23:
            part_of_day = "evening"
        else:
            part_of_day = "late night"
        return f"{now.strftime('%A')}, {now.strftime('%H:%M')} ({part_of_day})"

    @staticmethod
    def _parse(raw: str) -> dict:
        """Parse the model reply, tolerating stray fences, prose, or a bare array."""
        if not raw:
            return {}
        text = raw.strip()
        text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.MULTILINE).strip()

        parsed = None
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            # Aggressively grab the first JSON object or array in the reply,
            # ignoring any prose/apologies/explanations before or after it.
            match = re.search(r"(\[.*\]|\{.*\})", text, flags=re.DOTALL)
            if match:
                try:
                    parsed = json.loads(match.group(0))
                except json.JSONDecodeError:
                    parsed = None

        if isinstance(parsed, list):
            return {"tracks": parsed}
        if isinstance(parsed, dict):
            return parsed
        return {}

    # ---------- public API ----------

    def suggest(self, history: list, count: int, intention: str = "",
                blocklist: list = None, preset: str = ""):
        """Return (suggestions, justification, error).

        suggestions = [{'artist','title','why'}, ...]
        blocklist   = ["Artist - Title", ...] played/recommended in the last 2h.
        preset      = free-text session vibe selected at startup (e.g. "Gaming Mode").
        """
        prompt = (
            f"Current moment: {self._temporal_context()}\n\n"
            f"Recently played (oldest to newest):\n{self._format_history(history)}\n\n"
            f"Suggest exactly {count} track(s) to play next."
        )
        if preset:
            prompt += f"\n\nSession preset / vibe for tonight: {preset}"
        if blocklist:
            prompt += (
                "\n\nBlocklist -- do NOT suggest any of these "
                "(played or recommended in the last 2h):\n"
                + "\n".join(f"- {b}" for b in blocklist)
            )
        if intention:
            prompt += (
                f"\n\nListener's explicit intention: \"{intention}\"\n"
                "Honour it, but still move there gradually -- build the bridge."
            )

        try:
            response = self.client.models.generate_content(
                model=config.GEMINI_MODEL, contents=prompt, config=self.gen_config
            )
            raw_text = getattr(response, "text", "") or ""
            print("RAW GEMINI:", raw_text)
            data = self._parse(raw_text)
        except Exception as exc:  # quota, network, safety block...
            return [], "", f"Gemini error: {exc}"

        tracks = data.get("tracks") or []
        clean = []
        for item in tracks[:count]:
            if not isinstance(item, dict):
                continue
            artist = (item.get("artist") or "").strip()
            title = (item.get("title") or "").strip()
            if not artist or not title:
                continue
            clean.append(
                {"artist": artist, "title": title, "why": (item.get("why") or "").strip()}
            )

        if not clean:
            return [], "", "Gemini returned no usable suggestion"
        return clean, (data.get("justification") or "").strip(), None
