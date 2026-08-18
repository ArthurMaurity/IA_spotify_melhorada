// Offline test harness for index.html's Component class.
// Run with: node test-client.js
//
// index.html has no build step and its script block is a <script type="text/x-dc">
// evaluated by support.js's runtime, so it cannot simply be require()d. This
// harness extracts that block, stubs the browser globals and the DCLogic base
// class the runtime would normally supply, and drives the real Component
// methods directly — the approach CLAUDE.md describes for verifying this file.
//
// setState is stubbed to merge SYNCHRONOUSLY, matching the documented
// behaviour of the real runtime (see CLAUDE.md: "this.setState(...) mutates
// this.state synchronously before scheduling the actual re-render"). Getting
// that wrong here would make these tests pass against semantics the app does
// not actually have.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

// ---------------------------------------------------------------- extract --
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const match = html.match(/<script type="text\/x-dc" data-dc-script>([\s\S]*?)<\/script>/);
if (!match) { console.error('Could not find the x-dc script block in index.html'); process.exit(1); }
const scriptSource = match[1];

// ------------------------------------------------------------ browser stubs --
function makeLocalStorage() {
  const store = new Map();
  return {
    get length() { return store.size; },
    key(i) { return Array.from(store.keys())[i] ?? null; },
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    clear() { store.clear(); },
    _store: store,
  };
}

function buildSandbox() {
  const localStorage = makeLocalStorage();
  const sessionStorage = makeLocalStorage();
  const listeners = {};
  const sandbox = {
    console,
    localStorage,
    sessionStorage,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON, Set, Map, Promise, Array, Object, String, Number, Error,
    URLSearchParams,
    TextEncoder,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    fetch: async () => { throw new Error('unstubbed fetch'); },
    crypto: { getRandomValues: (a) => a, subtle: { digest: async () => new Uint8Array(32) } },
    document: {
      hidden: false,
      title: 'test',
      addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
      removeEventListener: (ev, fn) => { listeners[ev] = (listeners[ev] || []).filter(f => f !== fn); },
      createElement: () => ({ style: {} }),
      head: { appendChild() {} },
      _listeners: listeners,
    },
    window: {
      location: { search: '', pathname: '/', origin: 'https://example.test' },
      history: { replaceState() {} },
    },
    // The runtime's base class. setState merges synchronously, per CLAUDE.md.
    DCLogic: class DCLogic {
      setState(patch) {
        const next = typeof patch === 'function' ? patch(this.state) : patch;
        this.state = { ...this.state, ...next };
      }
    },
  };
  sandbox.globalThis = sandbox;
  return sandbox;
}

function loadComponent() {
  const sandbox = buildSandbox();
  vm.createContext(sandbox);
  vm.runInContext(scriptSource + '\n;globalThis.__Component = Component; globalThis.__trackKey = trackKey;', sandbox);
  return sandbox;
}

// Builds a Component instance with polling/logging inert, so tests exercise
// one method at a time instead of the whole app booting.
function makeInstance(sandbox, overrides = {}) {
  const C = sandbox.__Component;
  const inst = new C();
  inst.state = { ...inst.state, provider: 'spotify', accessToken: 'tok' };
  inst.addLog = (t) => { inst._logs = inst._logs || []; inst._logs.push(t); };
  inst.logs = () => (inst._logs || []).join('\n');
  Object.assign(inst, overrides);
  return inst;
}

// Stubs every provider data fetch triggerDJ awaits, so tests control failure.
function stubFetches(inst, { throwOn = null } = {}) {
  const ok = (v) => async () => {
    if (throwOn === 'any') throw new Error('provider exploded');
    return v;
  };
  inst.fetchArtistGenres = throwOn === 'genres'
    ? async () => { throw new Error('genres endpoint 500'); }
    : ok(['pagode']);
  inst.fetchRecentHistory = ok({ history: [], recentNames: [], recentPlayed: [] });
  inst.fetchTopGenres = ok([]);
  inst.fetchAudioFeatures = ok(null);
  inst.fetchQueue = ok([]);
  inst.fetchTopTracks = ok({ topTracks: [], topArtists: [] });
}

// ============================================================= storage layer =
section('storage: suggestion log');
{
  const sb = loadComponent();
  const inst = makeInstance(sb);

  inst.recordSuggestion('Song A', 'Artist A', 'same subgenre');
  const log = inst.loadSuggestionLog();
  check('recordSuggestion persists an entry', log.length === 1 && log[0].title === 'Song A');
  check('recordSuggestion stores the why field', log[0].why === 'same subgenre');
  check('new entries start unplayed', log[0].played === false);

  inst.markSuggestionsPlayed(['Artist A - Song A']);
  check('markSuggestionsPlayed flips the flag', inst.loadSuggestionLog()[0].played === true);
  check('markSuggestionsPlayed stamps playedAt', !!inst.loadSuggestionLog()[0].playedAt);

  // Corrupt JSON must degrade to an empty log, not throw on every trigger.
  sb.localStorage.setItem('nocturne_suggestions', '{not json');
  check('corrupt suggestion log returns [] instead of throwing', inst.loadSuggestionLog().length === 0);

  // A non-array payload would break .forEach in triggerDJ.
  sb.localStorage.setItem('nocturne_suggestions', '{"a":1}');
  check('non-array suggestion log returns []', Array.isArray(inst.loadSuggestionLog()) && inst.loadSuggestionLog().length === 0);
}

section('storage: Groq response cache');
{
  const sb = loadComponent();
  const inst = makeInstance(sb);
  const track = { name: 'Deixa Alagar', artists: 'Sorriso Maroto' };

  const k1 = inst.cacheKeyFor(track, '', 'Default Flow');
  const k2 = inst.cacheKeyFor(track, '', 'Default Flow');
  check('cache key is deterministic', k1 === k2, k1 + ' vs ' + k2);

  const k3 = inst.cacheKeyFor(track, 'more chill', 'Default Flow');
  check('cache key varies with the custom prompt', k1 !== k3);

  const k4 = inst.cacheKeyFor(track, '', 'Gaming Mode');
  check('cache key varies with the mode', k1 !== k4);

  const k5 = inst.cacheKeyFor({ name: 'Other', artists: 'Someone' }, '', 'Default Flow');
  check('cache key varies with the track', k1 !== k5);

  inst.state.provider = 'youtube';
  const k6 = inst.cacheKeyFor(track, '', 'Default Flow');
  check('cache key varies with the provider', k1 !== k6);
  inst.state.provider = 'spotify';

  check('reading a missing key returns null', inst.readGroqCache(k1) === null);

  inst.writeGroqCache(k1, [{ title: 'T', artist: 'A' }]);
  check('cache round-trips', inst.readGroqCache(k1)?.[0]?.title === 'T');

  // Expiry: rewrite the entry with an old timestamp.
  sb.localStorage.setItem(k1, JSON.stringify({ at: Date.now() - (31 * 60 * 1000), tracks: [{ title: 'stale' }] }));
  check('expired cache entry reads as null', inst.readGroqCache(k1) === null);
  check('expired cache entry is deleted on read', sb.localStorage.getItem(k1) === null);

  // Corrupt entry must not throw.
  sb.localStorage.setItem(k1, 'garbage{');
  check('corrupt cache entry returns null', inst.readGroqCache(k1) === null);
}

section('storage: pruning');
{
  const sb = loadComponent();
  const inst = makeInstance(sb);

  sb.localStorage.setItem('nocturne_groq_fresh', JSON.stringify({ at: Date.now(), tracks: [] }));
  sb.localStorage.setItem('nocturne_groq_stale', JSON.stringify({ at: Date.now() - (60 * 60 * 1000), tracks: [] }));
  sb.localStorage.setItem('nocturne_groq_broken', 'not json');
  sb.localStorage.setItem('unrelated_key', 'keep me');

  const old = Date.now() - (40 * 24 * 60 * 60 * 1000);
  sb.localStorage.setItem('nocturne_suggestions', JSON.stringify([
    { title: 'Ancient', artist: 'A', queuedAt: old },
    { title: 'Recent', artist: 'B', queuedAt: Date.now() },
  ]));

  inst.pruneStorage();

  check('pruning keeps fresh cache entries', sb.localStorage.getItem('nocturne_groq_fresh') !== null);
  check('pruning drops expired cache entries', sb.localStorage.getItem('nocturne_groq_stale') === null);
  check('pruning drops unparseable cache entries', sb.localStorage.getItem('nocturne_groq_broken') === null);
  check('pruning leaves unrelated keys alone', sb.localStorage.getItem('unrelated_key') === 'keep me');

  const remaining = inst.loadSuggestionLog();
  check('pruning drops suggestion entries older than 30d', remaining.length === 1 && remaining[0].title === 'Recent',
    JSON.stringify(remaining.map(r => r.title)));
}

// ====================================================== isThinking bug fix ==
section('triggerDJ: isThinking must never latch (the regression this fixes)');
{
  const sb = loadComponent();

  // The original bug: the provider fetches ran OUTSIDE the try, so a throw
  // there left isThinking true forever and pollTick then refused to ever
  // trigger again for the rest of the session.

  (async () => {
    {
      const inst = makeInstance(sb);
      stubFetches(inst, { throwOn: 'genres' });
      await inst.triggerDJ({ name: 'X', artists: 'Y', id: '1', artistId: 'a1' });
      check('isThinking resets when a provider fetch throws', inst.state.isThinking === false);
      check('the failure is reported to the user', /DJ engine error/.test(inst.logs()));
    }

    {
      const inst = makeInstance(sb);
      stubFetches(inst, { throwOn: 'any' });
      await inst.triggerDJ({ name: 'X', artists: 'Y', id: '1', artistId: 'a1' });
      check('isThinking resets when every provider fetch throws', inst.state.isThinking === false);
    }

    {
      const inst = makeInstance(sb);
      stubFetches(inst);
      sb.fetch = async () => { throw new Error('network down'); };
      await inst.triggerDJ({ name: 'X', artists: 'Y', id: '1', artistId: 'a1' });
      check('isThinking resets when the Groq call itself throws', inst.state.isThinking === false);
    }

    {
      const inst = makeInstance(sb);
      stubFetches(inst);
      sb.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
      await inst.triggerDJ({ name: 'X', artists: 'Y', id: '1', artistId: 'a1' });
      check('isThinking resets on a Groq HTTP error', inst.state.isThinking === false);
      check('Groq HTTP error is surfaced', /AI request failed/.test(inst.logs()));
    }

    {
      const inst = makeInstance(sb);
      stubFetches(inst);
      sb.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: 'slow down', retryAfter: 42 }) });
      await inst.triggerDJ({ name: 'X', artists: 'Y', id: '1', artistId: 'a1' });
      check('429 is reported as rate limiting, not a generic failure', /Rate limited/.test(inst.logs()));
      check('429 message includes the retry delay', /42s/.test(inst.logs()));
    }

    // ------------------------------------------------- happy path + cache --
    section('triggerDJ: caching');
    {
      const inst = makeInstance(sb);
      stubFetches(inst);
      let groqCalls = 0;
      sb.fetch = async () => {
        groqCalls++;
        return {
          ok: true,
          json: async () => ({
            tracks: [{ title: 'S1', artist: 'A1', why: 'same scene' }],
            meta: { model: 'm', degraded: false },
          }),
        };
      };
      inst.resolveTrack = async (title, artist) => ({
        track: { id: 't', name: title, artists: [{ name: artist }] },
        fellBack: false,
      });
      inst.queueTrack = async (found, why) => { inst.recordSuggestion(found.name, found.artists[0].name, why); return true; };

      const track = { name: 'Cur', artists: 'CurA', id: '1', artistId: 'a1' };
      await inst.triggerDJ(track);
      check('first trigger calls Groq', groqCalls === 1, 'calls=' + groqCalls);
      check('a successful trigger enables Try again', inst.state.canRetry === true);

      // Second trigger, same track/mode: served from cache, no Groq call.
      // Clear the played guard first, otherwise the only reason nothing is
      // queued would be the dedup rather than the cache.
      sb.localStorage.setItem('nocturne_suggestions', '[]');
      await inst.triggerDJ(track);
      check('repeat trigger is served from cache without calling Groq', groqCalls === 1, 'calls=' + groqCalls);
      check('cache reuse is disclosed in the log', /Reusing cached suggestions/.test(inst.logs()));

      // noCache must bypass it.
      sb.localStorage.setItem('nocturne_suggestions', '[]');
      await inst.triggerDJ(track, '', { noCache: true });
      check('noCache bypasses the cache', groqCalls === 2, 'calls=' + groqCalls);
    }

    section('triggerDJ: stale cache falls back to a live call');
    {
      const inst = makeInstance(sb);
      stubFetches(inst);
      let groqCalls = 0;
      sb.fetch = async () => {
        groqCalls++;
        return { ok: true, json: async () => ({ tracks: [{ title: 'S1', artist: 'A1' }] }) };
      };
      inst.resolveTrack = async (title, artist) => ({
        track: { id: 't', name: title, artists: [{ name: artist }] }, fellBack: false,
      });
      inst.queueTrack = async () => true;

      const track = { name: 'Cur2', artists: 'CurA2', id: '2', artistId: 'a2' };
      await inst.triggerDJ(track);
      const afterFirst = groqCalls;

      // Now poison the played set so every cached candidate is filtered out.
      inst.fetchRecentHistory = async () => ({
        history: [], recentNames: [], recentPlayed: [{ title: 'S1', artist: 'A1' }],
      });
      await inst.triggerDJ(track);
      check('an all-filtered cached batch triggers a fresh Groq call', groqCalls > afterFirst,
        'before=' + afterFirst + ' after=' + groqCalls);
      check('the fallback is explained in the log', /already played — asking the AI for fresh ones/.test(inst.logs()));
    }

    section('triggerDJ: degraded model is surfaced');
    {
      const inst = makeInstance(sb);
      stubFetches(inst);
      sb.fetch = async () => ({
        ok: true,
        json: async () => ({
          tracks: [{ title: 'S', artist: 'A' }],
          meta: { model: 'backup-model', degraded: true },
        }),
      });
      inst.resolveTrack = async () => null;
      await inst.triggerDJ({ name: 'D', artists: 'DA', id: '9', artistId: 'a9' });
      check('a degraded Groq response is reported', /primary AI model unavailable, answered by backup-model/.test(inst.logs()));
    }

    section('retry reinforces the avoid list');
    {
      const inst = makeInstance(sb);
      stubFetches(inst);
      let lastBody = null;
      sb.fetch = async (url, opts) => {
        lastBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ tracks: [{ title: 'RS', artist: 'RA' }] }) };
      };
      inst.resolveTrack = async (title, artist) => ({
        track: { id: 't', name: title, artists: [{ name: artist }] }, fellBack: false,
      });
      inst.queueTrack = async () => true;

      const track = { name: 'R', artists: 'RArt', id: '3', artistId: 'a3' };
      await inst.triggerDJ(track);
      check('a queued track is remembered for retry', (inst.lastQueuedLabels || []).length > 0,
        JSON.stringify(inst.lastQueuedLabels));

      await inst.retryLastSuggestion();
      // retryLastSuggestion is fire-and-forget; give the microtask queue a turn.
      await new Promise(r => setTimeout(r, 20));
      check('retry sends the just-queued track in avoidList',
        (lastBody.avoidList || []).includes('RA - RS'), JSON.stringify(lastBody.avoidList));
      check('retry is announced', /Trying again/.test(inst.logs()));
    }

    section('retry guards');
    {
      const inst = makeInstance(sb);
      inst.lastRequest = null;
      let called = false;
      inst.triggerDJ = async () => { called = true; };
      inst.retryLastSuggestion();
      check('retry does nothing before any request has been made', called === false);

      inst.lastRequest = { track: null, customPrompt: 'x' };
      inst.state.isThinking = true;
      inst.retryLastSuggestion();
      check('retry does nothing while already thinking', called === false);
    }

    // ================================================================ poll ==
    section('pollTick: backoff and rescheduling');
    {
      const inst = makeInstance(sb);
      check('base delay with no failures', inst.currentPollDelay() === inst.POLL_BASE_MS);
      inst.pollFailures = 1;
      check('delay doubles after one failure', inst.currentPollDelay() === 30000, String(inst.currentPollDelay()));
      inst.pollFailures = 2;
      check('delay doubles again', inst.currentPollDelay() === 60000, String(inst.currentPollDelay()));
      inst.pollFailures = 10;
      check('delay is capped', inst.currentPollDelay() === inst.POLL_MAX_MS, String(inst.currentPollDelay()));
    }

    {
      // Every exit path must reschedule, or polling silently dies.
      const paths = [
        ['empty', { status: 'empty' }],
        ['unsupported', { status: 'unsupported' }],
        ['error', { status: 'error', code: 500 }],
        ['playing', { status: 'playing', track: { id: 'x', name: 'n', artists: 'a', progressMs: 1, durationMs: 100 } }],
      ];
      for (const [label, result] of paths) {
        const inst = makeInstance(sb);
        let scheduled = 0;
        inst.scheduleNextPoll = () => { scheduled++; };
        inst.ensureFreshToken = async () => {};
        inst.activeProviderOverride = null;
        Object.defineProperty(inst, 'activeProvider', {
          get: () => ({ label: 'Spotify', getCurrentlyPlaying: async () => result }),
          configurable: true,
        });
        await inst.pollTick();
        check('pollTick reschedules on the "' + label + '" path', scheduled === 1, 'scheduled=' + scheduled);
      }
    }

    {
      // A throwing provider must also reschedule, and must count as a failure.
      const inst = makeInstance(sb);
      let scheduled = 0;
      inst.scheduleNextPoll = () => { scheduled++; };
      inst.ensureFreshToken = async () => {};
      Object.defineProperty(inst, 'activeProvider', {
        get: () => ({ label: 'Spotify', getCurrentlyPlaying: async () => { throw new Error('offline'); } }),
        configurable: true,
      });
      await inst.pollTick();
      check('pollTick reschedules after a thrown provider error', scheduled === 1);
      check('a thrown provider error counts as a poll failure', inst.pollFailures === 1);
    }

    {
      // Expired auth is the one path that must NOT reschedule.
      const inst = makeInstance(sb);
      let scheduled = 0;
      inst.scheduleNextPoll = () => { scheduled++; };
      inst.ensureFreshToken = async () => {};
      inst.refreshAccessToken = async () => false;
      inst.handleAuthExpired = () => { inst.state.accessToken = null; };
      Object.defineProperty(inst, 'activeProvider', {
        get: () => ({ label: 'Spotify', getCurrentlyPlaying: async () => ({ status: 'expired' }) }),
        configurable: true,
      });
      await inst.pollTick();
      check('pollTick stops rescheduling once auth is dead', scheduled === 0, 'scheduled=' + scheduled);
    }

    {
      // Hidden tab: no poll, no reschedule.
      const inst = makeInstance(sb);
      let scheduled = 0;
      inst.scheduleNextPoll = () => { scheduled++; };
      sb.document.hidden = true;
      await inst.pollTick();
      check('a hidden tab does not poll or reschedule', scheduled === 0);
      sb.document.hidden = false;
    }

    section('pollTick: failure reporting is not spammy');
    {
      const inst = makeInstance(sb);
      inst.scheduleNextPoll = () => {};
      inst.ensureFreshToken = async () => {};
      Object.defineProperty(inst, 'activeProvider', {
        get: () => ({ label: 'Spotify', getCurrentlyPlaying: async () => ({ status: 'error', code: 503 }) }),
        configurable: true,
      });
      for (let i = 0; i < 10; i++) await inst.pollTick();
      const lines = (inst._logs || []).length;
      check('ten consecutive failures do not produce ten log lines', lines <= 4, 'lines=' + lines);
      check('the backoff notice is shown once', (inst.logs().match(/backing off/g) || []).length === 1);
      check('degraded state is flagged for the UI', inst.state.pollDegraded === true);

      // Recovery.
      Object.defineProperty(inst, 'activeProvider', {
        get: () => ({ label: 'Spotify', getCurrentlyPlaying: async () => ({ status: 'empty' }) }),
        configurable: true,
      });
      await inst.pollTick();
      check('recovery resets the failure counter', inst.pollFailures === 0);
      check('recovery clears the degraded flag', inst.state.pollDegraded === false);
      check('recovery is announced', /responding again/.test(inst.logs()));
    }

    // ============================================================= history ==
    section('history view');
    {
      const inst = makeInstance(sb);
      sb.localStorage.setItem('nocturne_suggestions', '[]');
      for (let i = 0; i < 50; i++) inst.recordSuggestion('Song ' + i, 'Artist ' + i, 'why ' + i);
      const rows = inst.buildHistoryView();
      check('history view is capped at 40 rows', rows.length === 40, 'rows=' + rows.length);
      check('history view is newest-first', rows[0].title === 'Song 49', rows[0].title);
      check('history rows carry the why text', rows[0].why === 'why 49');
      check('unplayed rows are labelled queued', rows[0].statusLabel === 'queued');

      inst.markSuggestionsPlayed(['Artist 49 - Song 49']);
      const rows2 = inst.buildHistoryView();
      check('played rows are labelled played', rows2[0].statusLabel === 'played');
      check('played rows get the played badge class', /hist-played/.test(rows2[0].statusClass));

      check('formatAgo handles sub-minute', inst.formatAgo(5000) === 'just now');
      check('formatAgo handles minutes', inst.formatAgo(5 * 60000) === '5m ago');
      check('formatAgo handles hours', inst.formatAgo(3 * 3600000) === '3h ago');
      check('formatAgo handles days', inst.formatAgo(50 * 3600000) === '2d ago');

      inst.state.showHistory = false;
      check('history is hidden by default', inst.renderVals().showHistory === false);
      inst.toggleHistory();
      check('toggleHistory flips the flag', inst.state.showHistory === true);
    }

    section('renderVals: contract with the template');
    {
      const inst = makeInstance(sb);
      const v = inst.renderVals();
      const required = [
        'canRetry', 'retryLastSuggestion', 'toggleHistory', 'showHistory',
        'historyToggleLabel', 'historyRows', 'hasHistoryRows', 'noHistoryRows',
        'isThinking', 'engineStatusText', 'connected', 'logs',
      ];
      const missing = required.filter(k => !(k in v));
      check('renderVals exposes every key the new template reads', missing.length === 0, 'missing: ' + missing.join(', '));
      check('retry is not offered before the first suggestion', v.canRetry === false);

      inst.state.canRetry = true;
      inst.state.isThinking = true;
      check('retry is hidden while thinking', inst.renderVals().canRetry === false);

      inst.state.isThinking = false;
      check('retry is offered once available and idle', inst.renderVals().canRetry === true);

      // Slow-thinking notice.
      inst.state.activeMode = 'default';
      inst.state.isThinking = true;
      inst.state.thinkingSince = Date.now() - 25000;
      check('a slow trigger is called out in the status text',
        /taking longer than usual/.test(inst.renderVals().engineStatusText), inst.renderVals().engineStatusText);
    }

    console.log('\n' + '='.repeat(52));
    console.log(passed + ' passed, ' + failed + ' failed');
    console.log('='.repeat(52));
    process.exit(failed > 0 ? 1 : 0);
  })().catch((e) => {
    console.error('\nHarness crashed:', e);
    process.exit(1);
  });
}
