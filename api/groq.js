// Vercel Serverless Function — POST /api/groq
// Keeps the Groq API key server-side; the browser never sees it.

const { enforceRateLimit } = require('./_ratelimit');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';

// GROQ_API_KEY sits behind this endpoint with no auth, so anyone who finds the
// deployed URL could otherwise drain the free-tier quota in a loop. 12/min is
// far above real use (DJ Mode fires at most ~4/min per listener, and only one
// Groq call per trigger) while still capping a runaway script. See
// _ratelimit.js on why this is best-effort rather than a true global limit.
const RATE_LIMIT_PER_MIN = 12;

// A model that passes the filters can still fail per-request, so we walk the
// ranked list — but walking ALL of it on a systemic outage (bad key, Groq
// down) means one request fans out into dozens of upstream calls, burning
// serverless execution time to arrive at the same failure. Cap the walk.
const MAX_MODEL_ATTEMPTS = 4;

// Groq reshuffles its catalog without notice, so a warm instance holding a
// months-old ranked list is a real failure mode: every model in it can be
// decommissioned at once, and the only thing that rediscovers the catalog is
// the exhausted-all-candidates path — i.e. after every model has already
// failed. Expiring the cache turns that into a cheap periodic refresh.
const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Groq has repeatedly retired entire model families with no notice (llama-3.3
// and llama-3.1 70b, then the whole llama3-70b/8b + mixtral fallback list all
// got decommissioned within the same second). Hardcoded model IDs will always
// eventually rot, so instead we ask Groq's own catalog which chat models are
// currently live and rank them at request time. The ranking is cached at
// module scope so a warm serverless instance reuses it instead of listing
// models on every request. We cache the whole ranked list, not just the top
// pick — a model can exist and pass our filters but still fail per-request
// (e.g. json_validate_failed on a specific prompt), and re-running the same
// deterministic ranking would just hand back that same failed model again.
// Keeping the full list lets the fallback loop walk to the next-best model
// instead of looping on one bad pick.
let cachedModelList = null;
let cachedModelListAt = 0;

const PREFERRED_TAGS = ['versatile', 'instruct', 'chat'];

// Deny-list, not allow-list. An allow-list keyed to vendor names (llama,
// mixtral, ...) breaks completely every time Groq reshuffles which vendors
// they host — which has already happened twice (llama-3.3/3.1 decommissioned,
// then the entire llama3/mixtral fallback chain vanished in favor of
// openai/gpt-oss, qwen, groq/compound, allam-2-7b). Excluding known
// non-chat/unsafe categories survives vendor churn; only the categories
// below need to ever be revisited.
const EXCLUDED_PATTERNS = [
  'vision',    // image-input models — can't handle our text-only prompt shape
  'tool',      // tool-use-tuned variants — quirky with plain json_object mode
  'guard',     // safety/moderation classifiers (e.g. llama-prompt-guard-2-*)
  'safeguard', // same category as 'guard', different naming (gpt-oss-safeguard-*)
  'whisper',   // speech-to-text, not a chat model
  'tts',       // text-to-speech
  'orpheus',   // Canopy Labs TTS models
  'compound',  // Groq's agentic tool-router systems — unpredictable with strict JSON output
];

function isBannedModel(id) {
  const lower = String(id || '').toLowerCase();
  return EXCLUDED_PATTERNS.some((pattern) => lower.includes(pattern));
}

// Substring patterns (not full IDs — Groq's exact naming shifts, e.g.
// "llama-3.3-70b-versatile" vs a future "llama-4-70b-...") for model
// families with a strong reputation for broad factual knowledge, i.e. the
// thing this app actually needs (real artists, real songs, real subgenre
// facts) rather than raw context-window size. This app's prompt sends a
// short, single-turn request — it never needs a huge context window, so
// ranking purely by context_window (the previous sole criterion) was
// optimizing for the wrong property and could hand the request to a small,
// fast, latency-optimized model with more gaps in long-tail music knowledge
// just because it happened to report a larger window. This list is a
// preference, not a requirement: if none of these are present in the live
// catalog (Groq's lineup changes), ranking falls through unchanged to the
// context_window/tag criteria below, so the vendor-churn resilience the
// deny-list above already provides is untouched.
const KNOWLEDGE_PREFERRED_PATTERNS = [
  'llama-3.3-70b', // strongest broad-knowledge Llama chat model on Groq as of writing
  'llama-3.1-70b',
  '70b',           // generic fallback: any 70B+-class model outranks smaller ones on knowledge depth
  'qwen',          // Qwen's larger chat variants also test well on broad factual recall
];

function knowledgePreferenceRank(id) {
  const lower = String(id || '').toLowerCase();
  const idx = KNOWLEDGE_PREFERRED_PATTERNS.findIndex((pattern) => lower.includes(pattern));
  return idx === -1 ? KNOWLEDGE_PREFERRED_PATTERNS.length : idx;
}

// Returns every viable chat model, best-first — not just the top pick.
function rankChatModels(models) {
  const candidates = models.filter((m) => !isBannedModel(m.id));
  candidates.sort((a, b) => {
    const knowledgeDiff = knowledgePreferenceRank(a.id) - knowledgePreferenceRank(b.id);
    if (knowledgeDiff !== 0) return knowledgeDiff;
    const windowDiff = (b.context_window || 0) - (a.context_window || 0);
    if (windowDiff !== 0) return windowDiff;
    const aPreferred = PREFERRED_TAGS.some((tag) => String(a.id || '').toLowerCase().includes(tag));
    const bPreferred = PREFERRED_TAGS.some((tag) => String(b.id || '').toLowerCase().includes(tag));
    return (bPreferred ? 1 : 0) - (aPreferred ? 1 : 0);
  });
  return candidates.map((m) => m.id);
}

async function discoverModelList(apiKey) {
  const res = await fetch(GROQ_MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to list Groq models: ${await res.text()}`);
  }
  const data = await res.json();
  const ranked = rankChatModels(Array.isArray(data.data) ? data.data : []);
  if (!ranked.length) {
    throw new Error('No active Groq chat model found in the models list');
  }
  return ranked;
}

async function getModelCandidates(apiKey, forceRefresh) {
  // Defensive: a warm process may still be holding a cached list picked by an
  // older, buggier filter (e.g. containing a guard model). Strip any banned
  // entries so a stale cache can never resurrect a model we've since excluded.
  if (cachedModelList) {
    cachedModelList = cachedModelList.filter((id) => !isBannedModel(id));
  }
  const expired = Date.now() - cachedModelListAt > MODEL_CACHE_TTL_MS;
  if (!cachedModelList || !cachedModelList.length || forceRefresh || expired) {
    cachedModelList = await discoverModelList(apiKey);
    cachedModelListAt = Date.now();
    console.warn(`Discovered Groq chat models (best-first): ${cachedModelList.join(', ')}`);
  }
  return cachedModelList;
}

// Read-only view for /api/health — never triggers a catalog fetch, so hitting
// the health endpoint can't itself burn quota or mutate the cache.
function peekModelCache() {
  return {
    models: cachedModelList ? [...cachedModelList] : [],
    cachedAt: cachedModelListAt || null,
    ageMs: cachedModelListAt ? Date.now() - cachedModelListAt : null,
    ttlMs: MODEL_CACHE_TTL_MS,
  };
}

const SYSTEM_PROMPT = [
  'You are an expert DJ specialized in seamless transitions, with deep knowledge of genres, subgenres, tempo (BPM) and production style across music history.',
  'GROUNDING RULE (mandatory): when the prompt gives you "Confirmed Spotify genres" for the artist, treat that as ground truth about the real artist\'s style — it always overrides your own guess if they conflict. When no confirmed genres are given, fall back to your own knowledge of that specific real artist and song.',
  'GOLDEN RULE (mandatory, unless overridden below): your suggestions must share the same concrete genre/subgenre, approximate BPM and energy level as the current track — not just a vague "similar vibe". When a measured tempo/energy/danceability is given for the current track, treat it as ground truth and match numerically (target BPM within about 15 of it) instead of guessing from genre alone.',
  'TOP PRIORITY OVERRIDE: if the listener gives an explicit instruction naming a concrete genre, subgenre or style (e.g. "trap", "reggae rock brasileiro", "bossa nova"), that request wins over the GOLDEN RULE and over matching the current track — pick real songs that genuinely belong to that named genre/scene, even if it is a hard cut from the current track\'s style. Treat regional or non-English genre names as literal, specific tags, not as something to approximate with a mainstream substitute — draw on your deep knowledge of that country/scene\'s real artists and catalog (e.g. for Brazilian genres, think of the actual Brazilian artists who work in that style). Only apply the "bridge gradually" softening below when the listener\'s instruction is vague about genre (e.g. "slow it down", "more chill") rather than naming one explicitly.',
  'Abrupt jumps in genre, tempo or production style are FORBIDDEN only when there is no explicit genre/style request from the listener. If the listener\'s vague instruction demands a real style change, make the first suggested track a bridge that shares elements (tempo, instrumentation, mood) with both the old and new style; if the listener named a concrete genre, skip the bridge and go straight to that genre.',
  'ANTI-ABRUPT JUMP RULE (mandatory): if the current track belongs to a highly characteristic niche or regional genre (e.g. samba, pagode, bossa nova, heavy metal, techno), your suggestions must belong to that exact same subgenre family or direct cultural scene. Jumping to a distant adjacent style (e.g. samba to axé, rock to mainstream pop) is strictly forbidden unless the listener explicitly requests it via their customPrompt instruction.',
  'GEOGRAPHY IS NOT A GENRE (mandatory): never group artists simply because they share a country or language. "Brazilian music" or "MPB" are not valid transition justifications. You must respect the exact micro-genre — e.g. pagode may only transition to other pagode or samba artists (Sorriso Maroto, Ferrugem, Thiaguinho, etc.); NEVER transition from pagode to Brazilian rock, pop or bossa nova.',
  'HIP-HOP IS NOT ONE GENRE (mandatory): "rap" and "hip-hop" are umbrella tags, not micro-genres. Modern trap (808s, hi-hat rolls, autotune, contemporary production) must ONLY transition to other modern trap artists. NEVER transition from trap to boom bap, conscious rap or pop rap just because they share a country or the "rap" tag — e.g. Matuê does not lead to Emicida or Projota. Valid Brazilian trap names include Matuê, Teto (the Brazilian trapper — NOT Kasane Teto, the Japanese Vocaloid character), WIU, Brandão85, Yunk Vino and Cabelinho; when an artist name is ambiguous across scenes, always resolve it to the artist who actually works in the current track\'s genre and country.',
  'ERA / DECADE STRICTNESS (mandatory): respect the timeline of the current track. Do not jump from a 2020s contemporary hit to 2010s or 90s tracks unless the listener explicitly asks for it. A modern trap song must lead to other modern trap songs; a 90s track should lead to tracks of that same era and production style. Specifically: do not suggest 90s boom bap (like Racionais MCs) or funk when the current track is 2020s trap.',
  'STRICT ANTI-HALLUCINATION (mandatory): do not invent live versions or acoustic versions unless you are 100% certain they exist. Do not attribute famous songs to the wrong artist. If you cannot guarantee a deep cut is real, suggest a verified, well-known track from a highly similar artist instead of inventing one.',
  'SUBGENRE LOCK (mandatory): the "why" field in your JSON response must explicitly name the exact shared subgenre or production trait that justifies the pick alongside the current track (e.g. "keeps the 90s/2000s romantic pagode lineage", "shares cavaquinho/violão instrumentation", "similar samba-exaltação tempo") — a vague "similar vibe" is not acceptable.',
  'When given the listener\'s recent listening history, treat it as a timeline (oldest to newest) and bridge from the most recent entry — immediate coherence with it outweighs everything except an explicit listener instruction. Never suggest the exact same song that already appears in that history — a different song by an artist who already appears there is fine and often desirable, do not avoid an artist just because they were played recently.',
  'When given the listener\'s usual top genres, use them as a tiebreaker between otherwise-valid picks, but never let them override the golden rule of matching the current track\'s concrete style.',
  'MAINSTREAM HIT PRIORITY (mandatory): when dealing with regional, non-English, or specific genres like pagode or samba, strictly suggest the artist\'s most famous, undisputed Top 10 hits — UNLESS that specific artist appears in the listener\'s own most-played artists/tracks list below, in which case the listener has already proven real familiarity with that act and a well-regarded deeper cut is fine instead of only the single most obvious hit. Absolute factual accuracy of the Artist + Song pairing is always your highest priority, no matter how well-known the pick is.',
  'AVOID DEFAULT-TO-THE-SAME-HIT (mandatory outside the regional/non-English case above): do not let every suggestion collapse into each artist\'s single most radio-ubiquitous song. Prefer real variety across an artist\'s catalog, and across different real artists within the same genre — coherence should come from matching genre/subgenre/era/tempo, not from always picking the most famous song.',
  'Suggest only real, existing, commercially released songs that actually exist on Spotify, by real artists who actually work in that confirmed genre. Never invent tracks, and never guess a plausible-sounding title you are not confident is a real released song — if you are unsure a specific song exists, pick a different, well-known song by an artist in the same confirmed genre that you are certain is real.',
  'NO REPEAT (critical): never suggest the exact same song that is currently playing (same title and same artist) or a song that was already suggested earlier in this listening session. Suggesting a *different* song by the artist who is currently playing is fine and often desirable — do not avoid an artist just because they are currently playing.',
  'Rank your suggestions from most to least confident that they are real. Provide between 10 and 12 tracks — a downstream Spotify lookup will discard any that turn out not to exist, so lean toward 12 real candidates when you can.',
  'Respond with RAW JSON only (no markdown fences, no prose), exactly in this shape:',
  '{"tracks":[{"artist":"...","title":"...","why":"one short sentence naming the exact shared subgenre or production trait, per SUBGENRE LOCK"}]}',
].join(' ');

function buildUserPrompt({ track, artist, genres, history, topGenres, topArtists, topTracks, audioFeatures, feedback, avoidList, vetoedArtists, sessionMinutes, queuedThisSession, mode, customPrompt }) {
  const parts = [];
  if (track || artist) {
    parts.push(`Current track: "${track || 'unknown'}" by ${artist || 'unknown artist'}.`);
  }
  if (Array.isArray(genres) && genres.length) {
    parts.push(`Confirmed Spotify genres for this artist: ${genres.join(', ')}. Use these as ground truth, not your own guess.`);
  } else if (track || artist) {
    parts.push('No confirmed genre data available — use your own knowledge of this specific real artist and song.');
  }
  if (audioFeatures && typeof audioFeatures.tempo === 'number') {
    // Not every provider can supply energy/danceability alongside tempo (e.g.
    // a future non-Spotify provider) -- only mention the fields that are
    // actually present instead of assuming the full Spotify audio-features shape.
    const bits = [`tempo ~${Math.round(audioFeatures.tempo)} BPM`];
    if (typeof audioFeatures.energy === 'number') bits.push(`energy ${audioFeatures.energy.toFixed(2)}`);
    if (typeof audioFeatures.danceability === 'number') bits.push(`danceability ${audioFeatures.danceability.toFixed(2)}`);
    parts.push(`Current track measured ${bits.join(', ')} (0-1 scale where applicable — this is ground truth, not a guess).`);
  } else if (track || artist) {
    // Spotify's Web API has locked the audio-features endpoint for apps
    // created after Nov 2024 (see README "Known limitations"), and the
    // Spotify provider's getAudioFeatures() returns null unconditionally —
    // this branch is not a rare fallback, it is the normal path on every
    // single request today. Rather than silently omit tempo/energy grounding
    // (leaving the GOLDEN RULE's "match numerically... instead of guessing
    // from genre alone" with nothing to match against), ask the model to
    // estimate from its own knowledge and be explicit that it's an estimate,
    // not a measurement — weaker than real audio-features data, but strictly
    // better than not mentioning tempo/energy at all.
    parts.push('No measured tempo/energy data is available for the current track (the provider does not expose it). Estimate the current track\'s approximate BPM and energy level from your own knowledge of the real song, and match new suggestions to that estimate — clearly a best-effort estimate, not a measurement, so weight it below any confirmed genre data above if they conflict.');
  }
  if (Array.isArray(history) && history.length) {
    parts.push(`Listener's recent history, oldest to newest (last one is most recent): ${history.join(' | ')}.`);
  }
  if (Array.isArray(topGenres) && topGenres.length) {
    parts.push(`Listener's usual top genres overall: ${topGenres.join(', ')}.`);
  }
  if (Array.isArray(topArtists) && topArtists.length) {
    parts.push(`Listener's most-played artists (last ~6 months, real and verified by their own listening — per MAINSTREAM HIT PRIORITY, a deeper cut is allowed for these specific artists): ${topArtists.join(', ')}.`);
  }
  if (Array.isArray(topTracks) && topTracks.length) {
    parts.push(`Listener's most-played tracks (last ~6 months) — use these as a concrete signal of real taste, not as songs to necessarily re-suggest: ${topTracks.join(' | ')}.`);
  }
  if (feedback && Array.isArray(feedback.liked) && feedback.liked.length) {
    parts.push(`Listener actually played these past AI suggestions (bias toward similar style/artists): ${feedback.liked.join(' | ')}.`);
  }
  if (feedback && Array.isArray(feedback.skipped) && feedback.skipped.length) {
    parts.push(`Listener never played these past AI suggestions (avoid repeating this exact style/artist guess): ${feedback.skipped.join(' | ')}.`);
  }
  if (Array.isArray(avoidList) && avoidList.length) {
    // Ground truth from the provider itself (already queued, or actually
    // played in roughly the last 4h) -- distinct from `history` above
    // (a short recency-ordered timeline for narrative bridging) and from
    // `feedback` (soft liked/skipped signal). This is a harder "don't waste
    // a candidate slot on these" list. A different song by an artist in this
    // list is completely fine per NO REPEAT -- only the exact songs listed are off-limits.
    parts.push(`Songs already queued or played very recently — do NOT suggest any of these exact songs again (a different song by the same artist is fine): ${avoidList.join(' | ')}.`);
  }
  if (Array.isArray(vetoedArtists) && vetoedArtists.length) {
    // Distinct from avoidList (exact songs, session-scoped, provider-verified)
    // and from feedback.skipped (soft signal, inferred, decays with time):
    // this is a small, explicit, listener-curated, cross-session "never this
    // artist" list (see IMPROVEMENT_PLAN.md item 4.3) — persisted in the
    // browser's localStorage, not sent because of any automatic inference.
    // Hard exclude, not a soft deprioritization.
    parts.push(`NEVER-SUGGEST ARTISTS (mandatory, listener-curated): the listener has explicitly asked to never receive suggestions from these artists, across all sessions — do not suggest any song by: ${vetoedArtists.join(', ')}.`);
  }
  if (mode) {
    parts.push(`Session mode / vibe to respect alongside the golden rule: ${mode}.`);
  }
  if (typeof sessionMinutes === 'number' && sessionMinutes > 0) {
    // Only modes whose vibe text actually references session progression
    // (Default Flow's wind-down clause — see MODES in index.html, folded in
    // from the old dedicated Night Wind-Down mode per IMPROVEMENT_PLAN.md
    // item 4.7) act on this; other modes' prompt text never mentions "the
    // session", so this line is effectively inert for them. Sent
    // unconditionally rather than gated client-side so adding a future
    // energy-arc mode doesn't require a second wiring point.
    const queuedNote = typeof queuedThisSession === 'number' && queuedThisSession > 0
      ? `, ${queuedThisSession} track${queuedThisSession === 1 ? '' : 's'} queued so far`
      : '';
    parts.push(`This listening session has been running for about ${sessionMinutes} minute${sessionMinutes === 1 ? '' : 's'}${queuedNote} — if the session mode's vibe describes a progression over the session (e.g. gradually decreasing energy), let this duration inform how far along that arc the current suggestion should sit, rather than treating every trigger as an isolated starting point.`);
  }
  if (customPrompt) {
    parts.push(`LISTENER'S EXPLICIT INSTRUCTION (top priority — see TOP PRIORITY OVERRIDE rule): "${customPrompt}". If this names a concrete genre/style, honour it exactly and directly rather than blending it with the current track's style.`);
  }
  parts.push('Suggest 10 to 12 songs that fit.');
  return parts.join(' ');
}

function extractJson(text) {
  const cleaned = String(text || '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function isInvalidModelResponse(status, errText) {
  return status === 404
    || status === 400
    || /not found|does not exist|decommissioned|json_validate_failed/i.test(errText);
}

// Reasoning models (gpt-oss, qwen3) spend part of their token budget on an
// internal "reasoning" trace before the actual answer. With our long DJ
// system prompt that trace can eat the whole completion, leaving nothing for
// the final JSON and triggering json_validate_failed. Dialing reasoning down
// fixes it — but the valid values differ per model family, and sending an
// unsupported value (or the param at all, for a non-reasoning model) is
// itself a 400, so this only applies per-family, never as a blanket default.
function getReasoningEffort(model) {
  const id = String(model || '').toLowerCase();
  if (id.includes('gpt-oss')) return 'low';
  if (id.includes('qwen')) return 'none';
  return null;
}

async function requestCompletion(apiKey, model, messages) {
  const reasoningEffort = getReasoningEffort(model);
  return fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      response_format: { type: 'json_object' },
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      messages,
    }),
  });
}

// Resolves to { data, model, attempts, fallbacks } rather than the bare Groq
// payload, so the handler can report which model actually answered. Without
// that, a silently degrading catalog (top pick always failing, every request
// quietly served by the 3rd fallback) is invisible from the outside.
async function callGroqWithFallback(apiKey, messages) {
  const envModel = process.env.GROQ_MODEL;
  const ranked = await getModelCandidates(apiKey);
  const candidates = [...new Set([envModel, ...ranked].filter(Boolean))];
  const tried = new Set();
  const fallbacks = [];
  let lastError = null;
  let refreshedOnce = false;

  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i];
    if (tried.has(model)) continue;

    // Stop walking once we've genuinely tried MAX_MODEL_ATTEMPTS distinct
    // models. On a systemic failure (revoked key, Groq outage) every candidate
    // fails identically, and walking a 15-model catalog turns one client
    // request into 15 upstream calls — slow, and pure waste of the execution
    // budget to reach the same error. Four attempts still clears the real
    // case this loop exists for (one or two decommissioned models).
    if (tried.size >= MAX_MODEL_ATTEMPTS) {
      console.warn(`Giving up after ${tried.size} model attempts.`);
      break;
    }
    tried.add(model);

    let groqRes;
    try {
      groqRes = await requestCompletion(apiKey, model, messages);
    } catch (err) {
      // Network-level failure (timeout, DNS, etc.) — not a model problem, surface it immediately.
      throw err;
    }

    if (groqRes.ok) {
      // This model actually works for real requests — promote it to the front
      // of the cache so future calls try it first instead of a flakier one
      // that merely ranked higher on paper (context window, name tags).
      // Rebuild from `candidates` rather than the `ranked` snapshot taken
      // before the loop: if the catalog was re-listed mid-loop below, `ranked`
      // is the stale pre-refresh list, and rebuilding from it would discard
      // every newly discovered model except the one that just succeeded.
      cachedModelList = [model, ...candidates.filter((id) => id !== model && !isBannedModel(id))];
      return { data: await groqRes.json(), model, attempts: tried.size, fallbacks };
    }

    const errText = await groqRes.text();
    if (isInvalidModelResponse(groqRes.status, errText)) {
      console.warn(`Model ${model} failed (${groqRes.status}), falling back to next...`);
      fallbacks.push({ model, status: groqRes.status });
      lastError = new Error(`Groq request failed for model ${model}: ${errText}`);

      // Every known candidate has failed — re-list Groq's catalog once in case
      // it has changed since our cache was populated, and queue up anything new.
      if (i === candidates.length - 1 && !refreshedOnce) {
        refreshedOnce = true;
        const fresh = await getModelCandidates(apiKey, true);
        for (const id of fresh) if (!tried.has(id)) candidates.push(id);
      }
      continue;
    }

    // Any other error (auth, rate limit, bad request, etc.) is a real problem — don't mask it.
    const err = new Error(`Groq request failed: ${errText}`);
    err.status = groqRes.status;
    throw err;
  }

  throw lastError || new Error('Groq request failed: no models available');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Before touching the API key or Groq itself, so a flooder costs us nothing
  // beyond the function invocation that already happened.
  if (enforceRateLimit(req, res, 'groq', RATE_LIMIT_PER_MIN)) return;

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GROQ_API_KEY is not configured on the server' });
  }

  const { track, artist, genres, history, topGenres, topArtists, topTracks, audioFeatures, feedback, avoidList, vetoedArtists, sessionMinutes, queuedThisSession, mode, customPrompt } = req.body || {};

  const startedAt = Date.now();
  try {
    const { data, model, attempts, fallbacks } = await callGroqWithFallback(apiKey, [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt({ track, artist, genres, history, topGenres, topArtists, topTracks, audioFeatures, feedback, avoidList, vetoedArtists, sessionMinutes, queuedThisSession, mode, customPrompt }) },
    ]);

    const rawText = data?.choices?.[0]?.message?.content || '';
    const parsed = extractJson(rawText);

    if (!parsed || !Array.isArray(parsed.tracks) || parsed.tracks.length === 0) {
      return res.status(502).json({ error: 'Groq response could not be parsed as track JSON', raw: rawText, model });
    }

    const tracks = parsed.tracks
      .filter((t) => t && t.title && t.artist)
      .slice(0, 12)
      .map((t) => ({
        title: String(t.title).trim(),
        artist: String(t.artist).trim(),
        why: t.why ? String(t.why).trim() : '',
      }));

    // `meta` is purely diagnostic — the client renders nothing from it beyond
    // an optional log line, so older clients that ignore it keep working.
    // It's what makes silent degradation visible: if `fallbacks` is non-empty
    // on every request, the top-ranked model is broken and nobody would
    // otherwise notice, because the response still looks perfectly fine.
    return res.status(200).json({
      tracks,
      meta: {
        model,
        attempts,
        fallbacks,
        ms: Date.now() - startedAt,
        degraded: fallbacks.length > 0,
      },
    });
  } catch (err) {
    return res.status(err.status || 500).json({
      error: err.message || 'Unexpected error',
      ms: Date.now() - startedAt,
    });
  }
};

// Exported for /api/health and for the offline test harness. Vercel only ever
// invokes module.exports itself as the handler, so extra properties hung off
// the exported function are inert in production.
module.exports.peekModelCache = peekModelCache;
module.exports.rankChatModels = rankChatModels;
module.exports.isBannedModel = isBannedModel;
module.exports.extractJson = extractJson;
// Test-only: the model cache is module scope, so without this every test case
// inherits whichever model the previous case promoted, and mocks that assume a
// fresh catalog silently test the wrong thing.
module.exports._resetModelCacheForTests = () => { cachedModelList = null; cachedModelListAt = 0; };
