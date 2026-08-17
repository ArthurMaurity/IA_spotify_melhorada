// Vercel Serverless Function — POST /api/groq
// Keeps the Groq API key server-side; the browser never sees it.

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';

// Groq has repeatedly retired entire model families with no notice (llama-3.3
// and llama-3.1 70b, then the whole llama3-70b/8b + mixtral fallback list all
// got decommissioned within the same second). Hardcoded model IDs will always
// eventually rot, so instead we ask Groq's own catalog which chat models are
// currently live and pick one at request time. The answer is cached at module
// scope so a warm serverless instance reuses it instead of listing models on
// every request — only a cold start (or a decommissioned cache hit) re-fetches.
let cachedModelId = null;

const PREFERRED_TAGS = ['versatile', 'instruct', 'chat'];

function pickChatModel(models) {
  // 'guard' models (e.g. llama-prompt-guard-2-86m) are tiny safety classifiers,
  // not conversational LLMs — they choke on our full DJ prompt with a context
  // length error, so they must never be picked as the chat model.
  const candidates = models.filter((m) => {
    const id = String(m.id || '').toLowerCase();
    return (id.includes('llama') || id.includes('mixtral'))
      && !id.includes('vision')
      && !id.includes('tool')
      && !id.includes('guard');
  });
  candidates.sort((a, b) => {
    const windowDiff = (b.context_window || 0) - (a.context_window || 0);
    if (windowDiff !== 0) return windowDiff;
    const aPreferred = PREFERRED_TAGS.some((tag) => String(a.id || '').toLowerCase().includes(tag));
    const bPreferred = PREFERRED_TAGS.some((tag) => String(b.id || '').toLowerCase().includes(tag));
    return (bPreferred ? 1 : 0) - (aPreferred ? 1 : 0);
  });
  return candidates[0]?.id || null;
}

async function discoverModel(apiKey) {
  const res = await fetch(GROQ_MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to list Groq models: ${await res.text()}`);
  }
  const data = await res.json();
  const modelId = pickChatModel(Array.isArray(data.data) ? data.data : []);
  if (!modelId) {
    throw new Error('No active Groq chat model found in the models list');
  }
  return modelId;
}

async function getActiveModel(apiKey, forceRefresh) {
  if (!cachedModelId || forceRefresh) {
    cachedModelId = await discoverModel(apiKey);
    console.warn(`Discovered active Groq model: ${cachedModelId}`);
  }
  return cachedModelId;
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
    || /not found|does not exist|decommissioned/i.test(errText);
}

async function requestCompletion(apiKey, model, messages) {
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
      messages,
    }),
  });
}

async function callGroqWithFallback(apiKey, messages) {
  const envModel = process.env.GROQ_MODEL;
  const candidates = [...new Set([envModel, await getActiveModel(apiKey)].filter(Boolean))];
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
      return groqRes.json();
    }

    const errText = await groqRes.text();
    if (isInvalidModelResponse(groqRes.status, errText)) {
      console.warn(`Model ${model} not found, falling back to next...`);
      lastError = new Error(`Groq request failed for model ${model}: ${errText}`);
      if (model === cachedModelId) cachedModelId = null;

      // Every known candidate is dead — re-list Groq's catalog once in case a
      // new model appeared since our cache was populated, and keep going.
      if (i === candidates.length - 1 && !refreshedOnce) {
        refreshedOnce = true;
        const fresh = await getActiveModel(apiKey, true);
        if (!tried.has(fresh)) candidates.push(fresh);
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
