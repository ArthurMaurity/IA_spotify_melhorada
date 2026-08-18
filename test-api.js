// Offline test harness for the serverless functions.
// Run with: node test-api.js      (no network, no real credentials needed)
//
// The repo has no test framework and no dependencies, so this is a plain
// script with hand-rolled assertions — same approach as previous verification
// passes in this project (see CLAUDE.md, "There's no automated test suite").

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log('  PASS  ' + name);
  } else {
    failed++;
    console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : ''));
  }
}

function section(title) {
  console.log('\n' + title);
}

// ---------------------------------------------------------------- mock res --
function mockRes() {
  const r = {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return r;
}

function mockReq(overrides = {}) {
  return {
    method: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.7' },
    socket: { remoteAddress: '203.0.113.7' },
    body: {},
    ...overrides,
  };
}

// ------------------------------------------------------------- rate limiter --
section('_ratelimit');
{
  const rl = require('./api/_ratelimit');

  rl._resetForTests();
  let lastVerdict;
  for (let i = 0; i < 5; i++) lastVerdict = rl.rateLimit(mockReq(), 'test', 5);
  check('allows exactly up to the limit', lastVerdict.ok === true, JSON.stringify(lastVerdict));
  check('reports remaining 0 at the limit', lastVerdict.remaining === 0, JSON.stringify(lastVerdict));

  const over = rl.rateLimit(mockReq(), 'test', 5);
  check('blocks the request past the limit', over.ok === false);
  check('returns a positive retryAfter', over.retryAfter > 0 && over.retryAfter <= 60, String(over.retryAfter));

  // Distinct IPs must not share a budget.
  rl._resetForTests();
  for (let i = 0; i < 5; i++) rl.rateLimit(mockReq({ headers: { 'x-forwarded-for': '198.51.100.1' } }), 'test', 5);
  const otherIp = rl.rateLimit(mockReq({ headers: { 'x-forwarded-for': '198.51.100.2' } }), 'test', 5);
  check('budgets are per-IP, not global', otherIp.ok === true);

  // Distinct routes must not share a budget either.
  rl._resetForTests();
  for (let i = 0; i < 5; i++) rl.rateLimit(mockReq(), 'routeA', 5);
  const otherRoute = rl.rateLimit(mockReq(), 'routeB', 5);
  check('budgets are per-route', otherRoute.ok === true);

  // x-forwarded-for is a chain; the leftmost entry is the real client.
  rl._resetForTests();
  const chained = rl.clientKey(mockReq({ headers: { 'x-forwarded-for': '203.0.113.9, 70.41.3.18, 150.172.238.178' } }));
  check('parses leftmost IP from x-forwarded-for chain', chained === '203.0.113.9', chained);

  // Falls back to the socket address when the header is absent.
  const noHeader = rl.clientKey(mockReq({ headers: {}, socket: { remoteAddress: '10.0.0.5' } }));
  check('falls back to socket address', noHeader === '10.0.0.5', noHeader);

  // The eviction path must never let a flooder reset their own budget by
  // pushing the map over MAX_ENTRIES with spoofed IPs.
  rl._resetForTests();
  const attacker = mockReq({ headers: { 'x-forwarded-for': '192.0.2.99' } });
  for (let i = 0; i < 5; i++) rl.rateLimit(attacker, 'flood', 5);
  for (let i = 0; i < rl.MAX_ENTRIES + 50; i++) {
    rl.rateLimit(mockReq({ headers: { 'x-forwarded-for': '198.18.' + ((i >> 8) & 255) + '.' + (i & 255) } }), 'flood', 5);
  }
  const stillBlocked = rl.rateLimit(attacker, 'flood', 5);
  check('flooding with spoofed IPs does not reset the flooder\'s own budget', stillBlocked.ok === false);

  // enforceRateLimit should let requests through under budget and write a
  // real 429 response once over it.
  rl._resetForTests();
  let anyHaltedEarly = false;
  for (let i = 0; i < 3; i++) {
    if (rl.enforceRateLimit(mockReq(), mockRes(), 'enf', 3)) anyHaltedEarly = true;
  }
  check('enforceRateLimit lets through requests under budget', anyHaltedEarly === false);

  const resEnf = mockRes();
  const halted = rl.enforceRateLimit(mockReq(), resEnf, 'enf', 3);
  check('enforceRateLimit signals the caller to stop when over budget', halted === true);
  check('enforceRateLimit writes a 429', resEnf.statusCode === 429, String(resEnf.statusCode));
  check('enforceRateLimit sets Retry-After', !!resEnf.headers['Retry-After']);
}

// -------------------------------------------------------------------- groq --
section('groq: model ranking & JSON extraction');
{
  const groq = require('./api/groq');

  check('excludes guard models', groq.isBannedModel('llama-prompt-guard-2-86m') === true);
  check('excludes whisper models', groq.isBannedModel('whisper-large-v3') === true);
  check('excludes compound models', groq.isBannedModel('groq/compound') === true);
  check('keeps normal chat models', groq.isBannedModel('openai/gpt-oss-120b') === false);

  const ranked = groq.rankChatModels([
    { id: 'whisper-large-v3', context_window: 999999 },
    { id: 'small-chat', context_window: 8192 },
    { id: 'openai/gpt-oss-120b', context_window: 131072 },
    { id: 'llama-prompt-guard-2-86m', context_window: 512 },
  ]);
  check('ranking drops banned models', ranked.length === 2, JSON.stringify(ranked));
  check('ranking is widest-context-first', ranked[0] === 'openai/gpt-oss-120b', JSON.stringify(ranked));

  check('extractJson parses bare JSON', groq.extractJson('{"tracks":[]}')?.tracks?.length === 0);
  check('extractJson strips markdown fences',
    groq.extractJson('```json\n{"tracks":[{"title":"a","artist":"b"}]}\n```')?.tracks?.[0]?.title === 'a');
  check('extractJson salvages JSON embedded in prose',
    groq.extractJson('Sure! {"tracks":[{"title":"x","artist":"y"}]} hope that helps')?.tracks?.[0]?.artist === 'y');
  check('extractJson returns null on garbage', groq.extractJson('not json at all') === null);

  check('peekModelCache does not throw on a cold cache', (() => {
    const c = groq.peekModelCache();
    return Array.isArray(c.models) && c.ttlMs > 0;
  })());
}

// --------------------------------------------------- groq handler behaviour --
section('groq: handler');
{
  const groq = require('./api/groq');
  const rl = require('./api/_ratelimit');

  (async () => {
    rl._resetForTests();

    // Rejects non-POST.
    const res405 = mockRes();
    await groq(mockReq({ method: 'GET' }), res405);
    check('rejects GET with 405', res405.statusCode === 405);

    // Missing API key surfaces a clear 500 rather than a crash.
    rl._resetForTests();
    const savedKey = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    const res500 = mockRes();
    await groq(mockReq(), res500);
    check('missing GROQ_API_KEY yields 500 with a clear message',
      res500.statusCode === 500 && /GROQ_API_KEY/.test(res500.body.error));
    if (savedKey !== undefined) process.env.GROQ_API_KEY = savedKey;

    // Rate limit actually engages on the real handler.
    rl._resetForTests();
    process.env.GROQ_API_KEY = 'test-key';
    const savedFetch = global.fetch;
    let fetchCalls = 0;
    global.fetch = async (url) => {
      fetchCalls++;
      if (String(url).includes('/models')) {
        return { ok: true, json: async () => ({ data: [{ id: 'openai/gpt-oss-120b', context_window: 131072 }] }) };
      }
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"tracks":[{"title":"T","artist":"A","why":"same subgenre"}]}' } }],
        }),
      };
    };

    const resOk = mockRes();
    await groq(mockReq(), resOk);
    check('happy path returns 200 with tracks', resOk.statusCode === 200 && resOk.body.tracks.length === 1);
    check('response reports which model answered', resOk.body.meta?.model === 'openai/gpt-oss-120b', JSON.stringify(resOk.body.meta));
    check('response is not flagged degraded when the first model works', resOk.body.meta?.degraded === false);
    check('response preserves the why field', resOk.body.tracks[0].why === 'same subgenre');

    // Exhaust the per-minute budget.
    for (let i = 0; i < 15; i++) await groq(mockReq(), mockRes());
    const res429 = mockRes();
    await groq(mockReq(), res429);
    check('handler returns 429 once over budget', res429.statusCode === 429, String(res429.statusCode));
    check('429 includes Retry-After', !!res429.headers['Retry-After']);

    // Degraded path: the top-ranked model 404s, the next one succeeds.
    // Keyed on the model NAME in the request body, not on call order — the
    // module-scope cache means call order depends on what earlier cases
    // promoted, which made an order-based mock test the wrong model.
    rl._resetForTests();
    groq._resetModelCacheForTests();
    global.fetch = async (url, opts) => {
      if (String(url).includes('/models')) {
        return {
          ok: true,
          json: async () => ({ data: [
            { id: 'broken-model', context_window: 200000 },
            { id: 'working-model', context_window: 100000 },
          ] }),
        };
      }
      const model = JSON.parse(opts.body).model;
      if (model === 'broken-model') {
        return { ok: false, status: 404, text: async () => 'model has been decommissioned' };
      }
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"tracks":[{"title":"T2","artist":"A2"}]}' } }] }),
      };
    };
    const resDeg = mockRes();
    await groq(mockReq(), resDeg);
    check('falls back past a decommissioned model', resDeg.statusCode === 200, JSON.stringify(resDeg.body).slice(0, 200));
    check('fallback is reported as degraded', resDeg.body.meta?.degraded === true);
    check('degraded response names the working model', resDeg.body.meta?.model === 'working-model', JSON.stringify(resDeg.body.meta));

    // Systemic failure must stop after MAX_MODEL_ATTEMPTS, not walk everything.
    rl._resetForTests();
    groq._resetModelCacheForTests();
    let attempts = 0;
    global.fetch = async (url) => {
      if (String(url).includes('/models')) {
        return {
          ok: true,
          json: async () => ({ data: Array.from({ length: 20 }, (_, i) => ({ id: 'model-' + i, context_window: 100000 - i })) }),
        };
      }
      attempts++;
      return { ok: false, status: 404, text: async () => 'not found' };
    };
    const resFail = mockRes();
    await groq(mockReq(), resFail);
    check('total failure still returns an error status', resFail.statusCode >= 400);
    check('does not walk the entire catalog on systemic failure', attempts <= 4, 'attempts=' + attempts);

    // Unparseable model output must be a clean 502, not a crash.
    rl._resetForTests();
    global.fetch = async (url) => {
      if (String(url).includes('/models')) {
        return { ok: true, json: async () => ({ data: [{ id: 'm', context_window: 100 }] }) };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'I am not JSON' } }] }) };
    };
    const res502 = mockRes();
    await groq(mockReq(), res502);
    check('unparseable model output yields 502', res502.statusCode === 502, String(res502.statusCode));

    global.fetch = savedFetch;

    // ------------------------------------------------------------- health --
    section('health');
    rl._resetForTests();
    const health = require('./api/health');
    process.env.GROQ_API_KEY = 'test-key';
    const resH = mockRes();
    await health(mockReq({ method: 'GET' }), resH);
    check('health returns 200 when Groq is configured', resH.statusCode === 200, String(resH.statusCode));
    check('health reports configured flags', resH.body.configured?.groq === true);
    check('health never leaks secret values', !JSON.stringify(resH.body).includes('test-key'));
    check('health is marked no-store', resH.headers['Cache-Control'] === 'no-store');

    rl._resetForTests();
    delete process.env.GROQ_API_KEY;
    const resH503 = mockRes();
    await health(mockReq({ method: 'GET' }), resH503);
    check('health reports 503 when Groq is unconfigured', resH503.statusCode === 503);
    process.env.GROQ_API_KEY = 'test-key';

    // -------------------------------------------------------- apple stub --
    section('apple-token (dormant stub)');
    rl._resetForTests();
    const apple = require('./api/apple-token');
    check('apple-token exports a callable handler', typeof apple === 'function');
    const resA = mockRes();
    await apple(mockReq({ method: 'GET' }), resA);
    check('dormant apple endpoint answers 503, not a crash', resA.statusCode === 503, String(resA.statusCode));
    check('dormant apple endpoint explains itself', /Apple Developer/.test(resA.body.error || ''));

    // ------------------------------------------------------ youtube proxy --
    section('youtube-token');
    rl._resetForTests();
    const yt = require('./api/youtube-token');
    process.env.YOUTUBE_CLIENT_ID = 'cid';
    process.env.YOUTUBE_CLIENT_SECRET = 'csecret';
    const resY = mockRes();
    await yt(mockReq({ body: { grant_type: 'nonsense' } }), resY);
    check('rejects an unknown grant_type with 400', resY.statusCode === 400);

    rl._resetForTests();
    let sentBody = null;
    global.fetch = async (url, opts) => {
      sentBody = opts.body.toString();
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }) };
    };
    const resY2 = mockRes();
    await yt(mockReq({ body: { grant_type: 'authorization_code', code: 'c', redirect_uri: 'https://x/', code_verifier: 'v', client_id: 'SPOOFED' } }), resY2);
    check('authorization_code grant proxies successfully', resY2.statusCode === 200);
    check('never trusts a client-supplied client_id', sentBody.includes('client_id=cid') && !sentBody.includes('SPOOFED'), sentBody);
    check('attaches the server-side client_secret', sentBody.includes('client_secret=csecret'));
    global.fetch = savedFetch;

    console.log('\n' + '='.repeat(50));
    console.log(passed + ' passed, ' + failed + ' failed');
    console.log('='.repeat(50));
    process.exit(failed > 0 ? 1 : 0);
  })().catch((e) => {
    console.error('\nHarness crashed:', e);
    process.exit(1);
  });
}
