// Vercel Serverless Function — POST /api/groq
// Keeps the Groq API key server-side; the browser never sees it.

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';

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

// Returns every viable chat model, best-first — not just the top pick.
function rankChatModels(models) {
  const candidates = models.filter((m) => !isBannedModel(m.id));
  candidates.sort((a, b) => {
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
  if (!cachedModelList || !cachedModelList.length || forceRefresh) {
    cachedModelList = await discoverModelList(apiKey);
    console.warn(`Discovered Groq chat models (best-first): ${cachedModelList.join(', ')}`);
  }
  return cachedModelList;
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
  'When given the listener\'s recent listening history, treat it as a timeline (oldest to newest) and bridge from the most recent entry — immediate coherence with it outweighs everything except an explicit listener instruction. Never suggest a song or artist that already appears in that history.',
  'When given the listener\'s usual top genres, use them as a tiebreaker between otherwise-valid picks, but never let them override the golden rule of matching the current track\'s concrete style.',
  'MAINSTREAM HIT PRIORITY (mandatory): when dealing with regional, non-English, or specific genres like pagode or samba, strictly suggest the artist\'s most famous, undisputed Top 10 hits. Do not attempt to find deep cuts, rare tracks, or live versions. Absolute factual accuracy of the Artist + Song pairing is your highest priority.',
  'Suggest only real, existing, commercially released songs that actually exist on Spotify, by real artists who actually work in that confirmed genre. Never invent tracks, and never guess a plausible-sounding title you are not confident is a real released song — if you are unsure a specific song exists, pick a different, well-known song by an artist in the same confirmed genre that you are certain is real.',
  'NO REPEAT (critical): you must NEVER suggest the exact artist(s) that are currently playing, including featured artists. If the current track is by Matuê, absolutely do not suggest Matuê — not a different song by them, not a feature, not a collaboration. Never repeat the current song either.',
  'Rank your suggestions from most to least confident that they are real. Provide between 10 and 12 tracks — a downstream Spotify lookup will discard any that turn out not to exist, so lean toward 12 real candidates when you can.',
  'Respond with RAW JSON only (no markdown fences, no prose), exactly in this shape:',
  '{"tracks":[{"artist":"...","title":"...","why":"one short sentence naming the exact shared subgenre or production trait, per SUBGENRE LOCK"}]}',
].join(' ');

function buildUserPrompt({ track, artist, genres, history, topGenres, audioFeatures, feedback, mode, customPrompt }) {
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
    parts.push(`Current track measured tempo ~${Math.round(audioFeatures.tempo)} BPM, energy ${audioFeatures.energy.toFixed(2)}, danceability ${audioFeatures.danceability.toFixed(2)} (0-1 scale, Spotify's own analysis — this is ground truth, not a guess).`);
  }
  if (Array.isArray(history) && history.length) {
    parts.push(`Listener's recent history, oldest to newest (last one is most recent): ${history.join(' | ')}.`);
  }
  if (Array.isArray(topGenres) && topGenres.length) {
    parts.push(`Listener's usual top genres overall: ${topGenres.join(', ')}.`);
  }
  if (feedback && Array.isArray(feedback.liked) && feedback.liked.length) {
    parts.push(`Listener actually played these past AI suggestions (bias toward similar style/artists): ${feedback.liked.join(' | ')}.`);
  }
  if (feedback && Array.isArray(feedback.skipped) && feedback.skipped.length) {
    parts.push(`Listener never played these past AI suggestions (avoid repeating this exact style/artist guess): ${feedback.skipped.join(' | ')}.`);
  }
  if (mode) {
    parts.push(`Session mode / vibe to respect alongside the golden rule: ${mode}.`);
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

async function callGroqWithFallback(apiKey, messages) {
  const envModel = process.env.GROQ_MODEL;
  const ranked = await getModelCandidates(apiKey);
  const candidates = [...new Set([envModel, ...ranked].filter(Boolean))];
  const tried = new Set();
  let lastError = null;
  let refreshedOnce = false;

  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i];
    if (tried.has(model)) continue;
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
      cachedModelList = [model, ...ranked.filter((id) => id !== model)];
      return groqRes.json();
    }

    const errText = await groqRes.text();
    if (isInvalidModelResponse(groqRes.status, errText)) {
      console.warn(`Model ${model} failed (${groqRes.status}), falling back to next...`);
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

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GROQ_API_KEY is not configured on the server' });
  }

  const { track, artist, genres, history, topGenres, audioFeatures, feedback, mode, customPrompt } = req.body || {};

  try {
    const data = await callGroqWithFallback(apiKey, [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt({ track, artist, genres, history, topGenres, audioFeatures, feedback, mode, customPrompt }) },
    ]);

    const rawText = data?.choices?.[0]?.message?.content || '';
    const parsed = extractJson(rawText);

    if (!parsed || !Array.isArray(parsed.tracks) || parsed.tracks.length === 0) {
      return res.status(502).json({ error: 'Groq response could not be parsed as track JSON', raw: rawText });
    }

    const tracks = parsed.tracks
      .filter((t) => t && t.title && t.artist)
      .slice(0, 12)
      .map((t) => ({
        title: String(t.title).trim(),
        artist: String(t.artist).trim(),
        why: t.why ? String(t.why).trim() : '',
      }));

    return res.status(200).json({ tracks });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message || 'Unexpected error' });
  }
};
