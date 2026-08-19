# Nocturne DJ — "iPod Device" Redesign (planning, before any code)

Visual reference: [areebali.com](https://areebali.com/) — an entire portfolio
navigated inside a simulated physical "device," with a mono screen, a click
wheel/D-pad, live-documented keyboard shortcuts, and a power LED.

Decisions already locked in with the user:
- **Scope:** full redesign. Every app component (Now Playing, DJ Mode, My
  Turn, History, Activity Log, provider connection) lives inside a single
  simulated device, navigated as menu screens.
- **Control:** one click wheel = universal control. Visually it's a click
  wheel (circular ring); mechanically it's a 4-zone D-pad (up, down, left,
  right) + a center button (select/enter) + a separate MENU button (back).
  No drag/circular gesture — zero angle math.
- **Art:** real album art (Spotify/YouTube) inside the little screen, not
  pixel art.
- **Background:** for now keeps the current album-art-based ambient blur;
  the final background style decision is deferred.

## 1. Device anatomy (chassis)

A single component fixed at the center of the viewport (as on
areebali.com — the "rest of the page" is just the ambient background behind
it). Structure, top to bottom:

1. **Top of the chassis (status bar):** "Nocturne" logo + version (e.g.
   `nocturne v1.0`) on the left. On the right, a row of permanent status
   indicators — the metaphor is literally a real device's "battery and
   clock," always visible, with no need to navigate to them:
   - **Connection/provider icon** (the "signal" equivalent): shows the
     active provider (Spotify/YouTube/Apple) and its state — connected,
     auth error, rate-limited. Tapping/clicking it opens the CONNECT screen
     as a short overlay/modal (not as a screen in the main navigation
     stack), only when there's something to resolve (expired token,
     provider not connected). When everything's fine, it's just a static
     informational icon.
   - **Activity/log icon** (the "notification" equivalent): pulses or
     changes color when there's a new Activity Log event (new suggestion,
     error, skip). Tapping it opens the log as a sliding panel/overlay on
     top of the current screen — it layers over whatever is already being
     shown, it doesn't replace the current screen. `aria-live="polite"`
     keeps announcing new entries regardless of whether the panel is open
     or closed, exactly as it does today.
   - **Real clock** (current time) + power LED (green=connected,
     amber=thinking, red=error), reusing the color semantics that already
     exist in `statusDotColor`.
2. **Screen:** rectangular area, near-black background, monospace font —
   this is where ALL the screens in section 2 below get rendered. Subtle
   rounded corners, optional light vignette/scanline (evaluate later — not
   essential and could hurt legibility; Impeccable's craft-floor.md requires
   ≥4.5:1 contrast on body text, so any scanline overlay needs to stay very
   subtle or be dropped).
3. **Click wheel (round D-pad):** circular ring below the screen, a visual
   replica of the classic iPod click wheel. 4 click zones (top, bottom,
   left, right) mapped to the 4 directions, center button to select/confirm.
   Discreet icon labels on each zone when contextually meaningful (e.g. the
   top zone could show a "menu" icon when applicable, the way areebali.com
   uses a briefcase/person/envelope/chat icon on its 4 zones).
4. **MENU/BACK button:** separate physical button, to the right of the
   wheel (like areebali.com's "BACK" pill), always goes back one level in
   navigation.
5. **Microphone button (reserved, disabled):** a dedicated physical button
   on the chassis — next to the MENU/BACK button is the natural spot, the
   two form the "auxiliary buttons" pair outside the wheel. It's visually
   present from this first version onward, but in a real `disabled` state
   (not a fake decoration pretending to work): `not-allowed` cursor, reduced
   opacity, a tooltip/label like "Voice — coming soon." It triggers no
   action. It exists only to reserve the physical spot on the chassis for
   if/when `planoparaconversas.md` gets approved and implemented — no voice
   logic goes in now. This respects the already-locked decision to keep the
   two plans separate.
6. **Chassis footer:** small "copyright"/version text, purely decorative,
   reinforces the physical metaphor.
7. **Keyboard shortcuts:** a fixed text panel outside the device (right
   corner of the viewport, as on areebali.com), live-documenting what each
   key does on the current screen — accessibility and "vibe" at the same
   time. Arrow keys mirror the wheel's 4 zones; Enter = center; Esc = MENU.

## 2. Screen tree (what runs inside the little screen)

Replaces the current layout (side-by-side cards always visible) with a
navigation stack showing ONE screen at a time. A breadcrumb at the top of
the screen shows the path, e.g. `MODES / GAMING`.

ACTIVITY LOG and CONNECT **are not part of this tree** — they're
status/overlay panels triggered by the status bar icons (section 1), not
screens you navigate to via the wheel. This keeps the 4-direction cross
100% dedicated to the most frequent actions.

```
ROOT (Now Playing)
├── [up]     MODES      (list of the 7 modes — MODES from the current code)
│            └── <selected mode> → back to ROOT with the mode applied
├── [right]  DJ MODE    (current DJ Mode panel: auto-suggest toggle, interval)
├── [down]   HISTORY    (list of played tracks, like/skip/veto — already exists)
│            └── <selected track> → detail (like/skip/veto actions)
└── [left]   MY TURN    (free-text input + "Suggest now" button + retry)

Overlays (via status bar icons, not via the wheel):
├── LOG overlay       (sliding panel over the current screen, aria-live preserved)
└── CONNECT overlay    (appears automatically with no token, or when tapping the
                         connection icon when there's an error/expiry to resolve)
```

**ROOT / Now Playing** is the device's "home" screen — the equivalent of
areebali.com's "PRESS POWER" screen, but already showing real content:
- Real album art, taking up most of the screen (with the already-implemented
  `.np-art-wrap`/skeleton-loading).
- Title + artist overlaid or below, monospace font.
- Active-mode indicator (e.g. `▸ PARTY`) — a direct link to reopen MODES.
- `{{ engineStatusText }}` as a status line at the bottom of the screen (the
  chassis's top status bar already covers connection/log/time, so this line
  focuses on something more moment-specific, like "thinking..." or the
  suggestion engine's status text).
- Final, locked wheel mapping from ROOT: **up → MODES, right → DJ MODE,
  down → HISTORY, left → MY TURN.** Mode (the most frequent action) gets the
  most natural gesture; history at the bottom; DJ Mode and My Turn on the
  sides.

**MODES** is a navigable list (like the `01 Resonance / 02 Echo...` list on
the reference site): up/down cycles through the 7 modes, the center button
selects and applies it (equivalent to the current `setMode`), MENU goes back
without applying.

## 3. State mapping (React/DCLogic)

Doesn't change the business logic (`triggerDJ`, `queueTrack`, `resolveTrack`,
`addLog`, etc.) — only the presentation layer. Needs:

- New `activeScreen` state (string: `'root' | 'modes' | 'djmode' |
  'myturn' | 'history' | 'log' | 'connect' | 'trackDetail'`) and
  `screenStack` (array, so the MENU/BACK button knows where to go back to —
  a simple navigation stack, no external router needed).
- New `wheelFocusIndex` state per screen (which list item is highlighted
  before confirming) — each list-screen (MODES, HISTORY) needs to track its
  own cursor position.
- `wheelUp/wheelDown/wheelLeft/wheelRight/wheelSelect/wheelBack` handlers
  that dispatch to the right handler depending on `activeScreen` (a simple
  routing table, like a mini reducer).
- A global keyboard listener (arrow keys, Enter, Escape) calling the same
  handlers as the wheel — a single source of truth for both the wheel and
  the keyboard, not two parallel implementations.
- The content for each screen (MODES, HISTORY, LOG, etc.) already almost
  exists in `renderVals()` — most of the work is *packaging* that content
  inside the new single-screen template, not recreating it from scratch.

## 3.5. Responsiveness (mobile)

Explicit user requirement — the device needs to work well on narrow
screens, not just as a desktop curiosity like the original areebali.com
(which is clearly desktop-first, with the keyboard-shortcut panel floating
outside the device).

- **The chassis scales, it doesn't stack into two columns.** Instead of a
  fixed-size device centered with empty space on the sides, the whole device
  (chassis + screen + wheel) resizes fluidly to fit the viewport, with a max
  width cap on desktop (something like `max-width: 420px`) and using the
  available width on mobile with breathing-room margins.
- **The keyboard-shortcut panel (side, outside the device) is
  desktop-only.** On mobile it makes no sense (no visible physical
  keyboard) — hide it via media query, don't try to fit it below the
  device. The wheel/D-pad is already the primary touch interface on touch
  devices.
- **The D-pad's 4 zones need real touch targets.** Minimum 44×44px tappable
  area per zone (mobile accessibility standard), even if the ring's visual
  representation is thinner — the tap area can extend beyond the visible
  drawing.
- **The screen inside the chassis keeps its proportions, no overflow.**
  Monospace text with long lists (HISTORY, MODES) needs to scroll inside
  the little screen instead of stretching the whole chassis — the device's
  "physical frame" can't grow with the content, or it loses the illusion of
  a real device's fixed screen.
- **Orientation:** assume predominantly portrait use on mobile; no need to
  optimize for landscape in this redesign unless it comes up as a real
  problem later.
- This is explicitly addressed in execution step 4 (Polish), but the
  chassis is built with relative units/`clamp()` from step 1 onward — it's
  not something to "add later," it's structural from the very first static
  HTML.

## 4. What does NOT change

- All the business logic — `triggerDJ`, track resolution, rate limiting,
  caching, artist veto, explicit feedback — the data layer stays intact.
- The design system (`_ds/nocturne-.../styles.css`, OKLCH tokens) remains
  the source of colors/spacing — the device chassis uses these tokens, no
  new hardcoded colors.
- Accessibility: the log's `aria-live`, `:focus-visible`, labels — these
  need to survive the refactor, they're not optional. The keyboard
  navigation model actually *improves* accessibility if done well
  (everything reachable without a mouse), but that requires extra attention
  to focus/tab-order inside the little screen.
- No voice/conversation logic (Web Speech API, recognition, synthesis) goes
  into this work — the microphone button from item 5 in section 1 is purely
  reserved/disabled. The decision to keep `planoparaconversas.md` separate
  until explicit approval still stands.

## 5. Suggested execution order

1. Static chassis (top bar, empty screen, wheel, MENU button, shortcuts
   panel) with no logic — just the "object" visually in place, using a mock
   ROOT screen.
2. Navigation system (`activeScreen`/`screenStack`/wheel+keyboard handlers)
   plugged into the chassis, still with minimal placeholder content screens.
3. Migrate each real content screen, one at a time: ROOT → MODES → DJ MODE →
   MY TURN → HISTORY → LOG → CONNECT.
4. Polish (Impeccable craft-floor: contrast, shadows,
   hover/focus/loading/error/empty states, customized scrollbar/text
   selection, purposeful motion — one authored "moment" for screen
   transitions, not a scatter of effects).
5. Full testing: `node --check`, `test-client.js`, `test-api.js`, then real
   browser validation (Claude in Chrome) covering full navigation via both
   the wheel and the keyboard.

## 6. Biggest identified risk

The most fragile point isn't visual — it's the navigation tree becoming
confusing or slow to use day-to-day (e.g. if switching to the next mode
takes 4 clicks instead of 1). This is real UX, not aesthetics, and it will
only become clear once end-to-end navigation is tested after step 3. It's
worth using Impeccable's `critique` command (two independent assessments —
design review + mechanical scan) at that point before considering it done.
