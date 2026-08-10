"""Spotify Flow & Queue Manager (AI DJ) -- terminal entry point.

Radio Mode   : polls playback and injects AI-chosen tracks near the end of a song.
My Turn Mode : you describe an intention and it builds the bridge on demand.
"""

import sys
import time

import config
from ai_engine import AIEngine
from data_logger import DataLogger
from spotify_client import SpotifyClient

# ANSI colours; harmless on Termux and modern Windows terminals.
DIM, BOLD, GREEN, YELLOW, RED, CYAN, RESET = (
    "\033[2m", "\033[1m", "\033[32m", "\033[33m", "\033[31m", "\033[36m", "\033[0m",
)

# Session presets offered at startup; the text is appended to every AI prompt.
PRESETS = {
    "1": ("Default Flow", ""),
    "2": (
        "Gaming Mode",
        "High energy and focus for competitive matches, or immersive "
        "atmospheric background for RPGs and story-driven games. Match "
        "intensity to what the gaming session needs.",
    ),
    "3": (
        "Work/Study Mode",
        "Instrumentals and Lo-fi only, minimal or no vocals, steady low-key "
        "energy suited for deep focus work or study.",
    ),
}


def hr(char="-"):
    print(DIM + char * 58 + RESET)


def banner():
    hr("=")
    print(BOLD + "  SPOTIFY FLOW & QUEUE MANAGER  " + CYAN + "(AI DJ)" + RESET)
    hr("=")


def fmt(track):
    return f"{track.get('artist')} - {track.get('name')}"


def choose_preset():
    """Ask once at startup which session preset to append to the AI context."""
    hr()
    print(f"  {BOLD}Session Preset{RESET}")
    print(f"  {BOLD}1{RESET}  Default Flow")
    print(f"  {BOLD}2{RESET}  Gaming Mode      {DIM}competitive energy / immersive RPG background{RESET}")
    print(f"  {BOLD}3{RESET}  Work/Study Mode  {DIM}instrumentals & lo-fi for deep focus{RESET}")
    hr()
    choice = input("preset > ").strip()
    name, text = PRESETS.get(choice, PRESETS["1"])
    print(f"{GREEN}preset: {name}{RESET}\n")
    return name, text


def build_blocklist(spotify, logger):
    """URIs + display strings for tracks played or recommended in the last cooldown window."""
    played, err = spotify.recent_played(config.COOLDOWN_MINUTES)
    if err:
        played = []
    recommended = logger.recent_recommendations(config.COOLDOWN_MINUTES)

    uris = {t["uri"] for t in played if t.get("uri") and t["uri"] != config.NULL_FILL}
    uris |= {r["uri"] for r in recommended if r.get("uri")}

    seen, display = set(), []
    for t in played:
        line = fmt(t)
        if t.get("name") and line not in seen:
            seen.add(line)
            display.append(line)
    for r in recommended:
        line = f"{r.get('artist')} - {r.get('title')}"
        if r.get("title") and line not in seen:
            seen.add(line)
            display.append(line)

    return uris, display


def resolve_and_queue(spotify, logger, suggestions, justification, context, mode, latency,
                       blocked_uris=None):
    """Search each suggestion on Spotify, queue it, and log the outcome."""
    queued, _ = spotify.queued_uris()
    blocked_uris = blocked_uris or set()
    injected_any = False

    for s in suggestions:
        query = f"{s['artist']} {s['title']}"
        track, err = spotify.search_track(query)
        if err or not track:
            print(f"  {YELLOW}x not found on Spotify: {query}{RESET}")
            logger.log(mode, context, {"title": s["title"], "artist": s["artist"]},
                       justification, injected=False, latency_ms=latency)
            continue

        if track["uri"] in queued:
            print(f"  {DIM}~ already queued: {fmt(track)}{RESET}")
            continue

        if track["uri"] in blocked_uris:
            print(f"  {DIM}~ cooldown, skipping: {fmt(track)}{RESET}")
            logger.log(mode, context, track, justification, injected=False, latency_ms=latency)
            continue

        ok, err = spotify.add_to_queue(track["uri"])
        if ok:
            queued.add(track["uri"])
            injected_any = True
            print(f"  {GREEN}+ queued:{RESET} {fmt(track)}")
            if s.get("why"):
                print(f"    {DIM}{s['why']}{RESET}")
        else:
            print(f"  {RED}! could not queue {fmt(track)}: {err}{RESET}")

        status = logger.log(mode, context, track, justification,
                            injected=ok, latency_ms=latency)
        print(f"    {DIM}log: {status}{RESET}")

    if justification:
        print(f"  {CYAN}why this flow:{RESET} {justification}")
    return injected_any


def build_context(spotify, current):
    """Recent history, newest first, with the current track at the front."""
    history, err = spotify.recently_played(limit=config.CONTEXT_SIZE)
    if err:
        print(f"{YELLOW}! history unavailable: {err}{RESET}")
        history = []
    context = ([current] if current else []) + history
    # De-duplicate while preserving order.
    seen, unique = set(), []
    for t in context:
        key = (t.get("name"), t.get("artist"))
        if key not in seen:
            seen.add(key)
            unique.append(t)
    return unique[: config.CONTEXT_SIZE]


def radio_mode(spotify, ai, logger, preset_text=""):
    print(f"\n{BOLD}RADIO MODE{RESET} -- polling every {config.POLL_INTERVAL}s. "
          f"Ctrl+C to stop.\n")
    last_injected_for = None  # track id we already handled

    while True:
        current, err = spotify.currently_playing()
        if err:
            print(f"{YELLOW}! {err} -- retrying{RESET}")
            time.sleep(config.POLL_INTERVAL)
            continue

        if not current or not current["is_playing"]:
            print(f"{DIM}nothing playing...{RESET}")
            time.sleep(config.POLL_INTERVAL)
            continue

        ratio = current["progress_ratio"]
        print(f"\r{DIM}now playing:{RESET} {fmt(current)} "
              f"{DIM}[{ratio * 100:.0f}%]{RESET}      ")

        if ratio >= config.INJECT_THRESHOLD and current["id"] != last_injected_for:
            last_injected_for = current["id"]
            hr()
            print(f"{BOLD}final third reached -- asking the AI DJ...{RESET}")
            context = build_context(spotify, current)
            blocked_uris, blocked_display = build_blocklist(spotify, logger)
            started = time.time()
            suggestions, justification, ai_err = ai.suggest(
                context, config.TRACKS_PER_INJECTION,
                blocklist=blocked_display, preset=preset_text,
            )
            latency = int((time.time() - started) * 1000)
            if ai_err:
                print(f"{RED}! {ai_err}{RESET}")
            else:
                resolve_and_queue(spotify, logger, suggestions, justification,
                                  context[0] if context else {}, "radio", latency,
                                  blocked_uris=blocked_uris)
            hr()

        time.sleep(config.POLL_INTERVAL)


def my_turn_mode(spotify, ai, logger, preset_text=""):
    print(f"\n{BOLD}MY TURN MODE{RESET} -- describe the flow you want. "
          f"Blank line or 'q' to go back.\n")

    while True:
        try:
            intention = input(f"{CYAN}intention >{RESET} ").strip()
        except EOFError:
            return
        if not intention or intention.lower() in ("q", "quit", "exit"):
            return

        current, _ = spotify.currently_playing()
        context = build_context(spotify, current)
        if context:
            print(f"{DIM}context: " + " | ".join(fmt(t) for t in context) + RESET)

        blocked_uris, blocked_display = build_blocklist(spotify, logger)
        started = time.time()
        count = max(config.TRACKS_PER_INJECTION, 3)
        suggestions, justification, err = ai.suggest(
            context, count, intention, blocklist=blocked_display, preset=preset_text,
        )
        latency = int((time.time() - started) * 1000)
        if err:
            print(f"{RED}! {err}{RESET}\n")
            continue

        resolve_and_queue(spotify, logger, suggestions, justification,
                          context[0] if context else {}, "my_turn", latency,
                          blocked_uris=blocked_uris)
        print()


def main():
    banner()

    problems = config.validate()
    if problems:
        print(f"{RED}Configuration problems:{RESET}")
        for p in problems:
            print(f"  - {p}")
        print(f"\n{DIM}Copy .env.example to .env and fill it in.{RESET}")
        return 1

    print(f"{DIM}connecting to Spotify...{RESET}")
    try:
        spotify = SpotifyClient()
    except Exception as exc:
        print(f"{RED}Spotify auth failed: {exc}{RESET}")
        return 1

    name, err = spotify.me()
    if err:
        print(f"{RED}Spotify auth failed: {err}{RESET}")
        return 1
    print(f"{GREEN}connected as {name}{RESET}")

    ai = AIEngine()
    logger = DataLogger()

    preset_name, preset_text = choose_preset()

    try:
        while True:
            hr()
            print(f"  {DIM}preset: {preset_name}{RESET}")
            print(f"  {BOLD}1{RESET}  Radio Mode    {DIM}continuous automatic flow{RESET}")
            print(f"  {BOLD}2{RESET}  My Turn Mode  {DIM}curated queue from your intention{RESET}")
            print(f"  {BOLD}3{RESET}  Change Preset")
            print(f"  {BOLD}0{RESET}  Exit")
            hr()
            choice = input("choose > ").strip()

            if choice == "1":
                radio_mode(spotify, ai, logger, preset_text)
            elif choice == "2":
                my_turn_mode(spotify, ai, logger, preset_text)
            elif choice == "3":
                preset_name, preset_text = choose_preset()
            elif choice in ("0", "q", "exit"):
                break
            else:
                print(f"{YELLOW}invalid option{RESET}")
    except KeyboardInterrupt:
        print(f"\n{DIM}interrupted{RESET}")
    finally:
        logger.close()
        print(f"{DIM}session summary saved to {config.SESSION_LOG_PATH}{RESET}")
        print(f"{GREEN}bye.{RESET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
