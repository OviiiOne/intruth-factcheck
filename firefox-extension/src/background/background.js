// background.js — Firefox adaptation
// Uses browser.* APIs (Firefox MV2 with promises)
// No tabCapture, no offscreen — audio capture handled in content script

let ANTHROPIC_KEY = '';
let PROXY_URL = '';
let PROXY_TOKEN = '';
let AI_PROVIDER = 'claude';
let SOURCE_LANGUAGE = 'auto';
const SERPER_KEY = '';

async function loadKeys() {
  const data = await browser.storage.local.get(['anthropicKey', 'proxyUrl', 'proxyToken', 'aiProvider', 'sourceLanguage']);
  ANTHROPIC_KEY = data.anthropicKey || '';
  PROXY_URL = data.proxyUrl || '';
  PROXY_TOKEN = data.proxyToken || '';
  AI_PROVIDER = data.aiProvider || 'claude';
  SOURCE_LANGUAGE = data.sourceLanguage || 'auto';
}

const EVALUATE_PROMPT = `You are a real-time fact-checker. Given a transcript excerpt, identify check-worthy factual claims and evaluate each one.

For each claim, return a JSON array of objects with these fields:
- "claim": the exact factual claim
- "verdict": one of TRUE, SUBSTANTIALLY TRUE, FALSE, MISLEADING, UNVERIFIABLE
- "confidence": one of HIGH, MEDIUM, LOW
- "explanation": 1-2 sentence explanation
- "speaker": who made the claim (use real names, never "Speaker N")
- "speaker_confidence": one of HIGH, MEDIUM, LOW (how committed the speaker sounds)

Only include check-worthy factual claims (statistics, historical events, policy claims, public records). Skip opinions, predictions, rhetorical questions, and value judgments.

Return ONLY a JSON array. No markdown, no explanation outside the array.`;

const KEYPOINTS_PROMPT = `You are following a live press conference or political statement. From the transcript excerpt, extract the noteworthy KEY POINTS: announcements, figures/statistics, commitments or promises, factual claims, geopolitical and foreign-policy positions, statements about conflicts or security, accusations, threats, denials, named decisions, and important verbatim quotes.

Capture the SUBSTANCE of any significant statement EVEN IF it sounds like a repeated talking point or campaign rhetoric. For example "Iran will not have a nuclear weapon" is a key point. Only skip pure greetings, filler, and contentless pleasantries.

Do NOT judge whether anything is true — just capture what was said, neutrally.

For each key point, return a JSON object with:
- "point": a concise, neutral one-sentence summary, written in SPANISH
- "category": a short UPPERCASE label. Prefer one of: ANUNCIO, CIFRA, COMPROMISO, DECLARACION, CITA, POLITICA. If none fits well, invent a concise label in Spanish (one or two words, e.g. GEOPOLITICA, SEGURIDAD, ECONOMIA, JUSTICIA). Use OTRO only as a last resort.
- "quote": the most relevant short verbatim fragment from the transcript, in its ORIGINAL language (or "" if none)
- "speaker": who said it, using a real name when known; never "Speaker N"; null if unknown

Return ONLY a JSON array of these objects. No markdown, no text outside the array. If nothing is noteworthy, return [].`;

const TRANSLATE_PROMPT = `Translate the user's text into Spanish. If the text is already in Spanish or in English, return it EXACTLY as-is, unchanged. Output ONLY the resulting text — no quotes, no notes, no explanation.`;

const VERIFY_PROMPT = `You are a fact-checker. Evaluate the SINGLE claim the user provides, using the web results if given and your own knowledge. Take the event date/context into account.

Return ONLY a JSON object (no array, no markdown) with:
- "verdict": one of TRUE, SUBSTANTIALLY TRUE, FALSE, MISLEADING, UNVERIFIABLE
- "confidence": one of HIGH, MEDIUM, LOW
- "explanation": 1-2 sentences IN SPANISH explaining the verdict and what the evidence says

No text outside the JSON object.`;

const SUMMARY_PROMPT = `You are summarizing a live press conference for a Spanish-speaking professional. Using the key points (and any transcript) the user provides, write a clear, structured summary IN SPANISH, in PLAIN TEXT (no Markdown symbols like # or *).

Format:
- Start with a short overview paragraph (2-3 sentences).
- Then a blank line, then the main points, each on its own line starting with "• ", attributed to the speaker when known.
- If some points were fact-checked, add a final short section with the verdicts.

Be concise and neutral. Return only the summary text.`;

// ── Speaker parsing ──────────────────────────────────────────────────────────

function parseSpeakersFromTitle(title) {
  if (!title) return [];
  const roleMatch = title.match(/(\d+)\s+([a-z]+(?:\s+[a-z]+)?)\s+(?:vs?\.?|versus)\s+(\d+)\s+([a-z]+(?:\s+[a-z]+)?)/i);
  if (roleMatch) {
    const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
    return [cap(roleMatch[2]), cap(roleMatch[4])];
  }
  const nameMatch = title.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:and|vs\.?|versus|&)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  if (nameMatch) {
    const clean = name => name.trim().split(' ').pop();
    return [clean(nameMatch[1]), clean(nameMatch[2])];
  }
  return [];
}

// ── Serper ────────────────────────────────────────────────────────────────────

const BLOCKED_DOMAINS = [
  'reddit.com', 'facebook.com', 'twitter.com', 'x.com',
  'tiktok.com', 'instagram.com', 'pinterest.com', 'quora.com',
  'yelp.com', 'tripadvisor.com', 'youtube.com',
  'democrats.org', 'republicans.org', 'gop.com', 'dnc.org',
  'breitbart.com', 'dailykos.com', 'mediamatters.org', 'newsmax.com',
  'thefederalist.com', 'motherjones.com', 'nationalreview.com',
];

async function searchWeb(query, retries = 2) {
  if (!SERPER_KEY) return [];
  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': SERPER_KEY },
      body: JSON.stringify({ q: query, num: 6 }),
    });
    const data = await res.json();
    return (data.organic ?? [])
      .map(r => r.link)
      .filter(url => url && !BLOCKED_DOMAINS.some(d => url.includes(d)))
      .slice(0, 3);
  } catch (err) {
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 500 * (3 - retries)));
      return searchWeb(query, retries - 1);
    }
    console.error('[serper] error:', err);
    return [];
  }
}

// ── Claude (direct or proxy) ─────────────────────────────────────────────────

async function callClaude(userMessage, systemPrompt, grounded = false, maxTokens = 768) {
  let res;

  if (PROXY_URL) {
    const proxyHeaders = { 'Content-Type': 'application/json' };
    if (PROXY_TOKEN) proxyHeaders['x-proxy-token'] = PROXY_TOKEN;
    res = await fetch(PROXY_URL, {
      method: 'POST',
      headers: proxyHeaders,
      body: JSON.stringify({
        provider: AI_PROVIDER,
        model: AI_PROVIDER === 'gemini' ? 'gemini-2.0-flash' : 'claude-haiku-4-5-20251001',
        max_tokens: maxTokens,
        temperature: 0,
        grounded,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
  } else if (ANTHROPIC_KEY) {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: maxTokens,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
  } else {
    if (activeTabId) sendToTab(activeTabId, { type: 'PIPELINE_ERROR', message: 'No API key or proxy configured.' });
    return { text: '', sources: [] };
  }

  const data = await res.json();
  if (data.error) {
    const msg = data.error.message || 'Unknown API error';
    console.error('[claude] API error:', msg);
    if (activeTabId) sendToTab(activeTabId, { type: 'PIPELINE_ERROR', message: msg });
    return { text: '', sources: [] };
  }
  const raw = data.content?.[0]?.text?.trim() || '';
  const text = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  return { text, sources: Array.isArray(data.sources) ? data.sources : [] };
}

function parseArray(str) {
  const start = str.indexOf('[');
  const end = str.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  try { return JSON.parse(str.slice(start, end + 1)); }
  catch { return []; }
}

function parseObject(str) {
  const start = str.indexOf('{');
  const end = str.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(str.slice(start, end + 1)); }
  catch { return null; }
}

// ── Lexical features ──────────────────────────────────────────────────────────

const HEDGING_WORDS = ['think','believe','maybe','perhaps','probably','might','could','seem','appears','guess','suppose','somewhat'];
const CERTAINTY_WORDS = ['definitely','certainly','absolutely','always','never','clearly','obviously','undoubtedly','exactly','proven'];
const FILLER_WORDS = ['um','uh','like','basically','actually','literally','right','okay'];
const EMOTIONAL_WORDS = ['disaster','terrible','horrible','amazing','incredible','great','awful','fantastic','disgusting','wonderful','worst','best'];
const EXCLUSIVE_WORDS = ['but','except','however','although','unless','without','exclude'];
const FP_SINGULAR = ['i','me','my','mine','myself'];

function extractLexical(text) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const total = words.length || 1;
  const rate = (list) => Math.round(words.filter(w => list.some(h => w.includes(h))).length / total * 100);
  return {
    rates: {
      hedging: rate(HEDGING_WORDS),
      certainty: rate(CERTAINTY_WORDS),
      filler: rate(FILLER_WORDS),
      emotional: rate(EMOTIONAL_WORDS),
      exclusive: rate(EXCLUSIVE_WORDS),
      firstPersonSg: Math.round(words.filter(w => FP_SINGULAR.includes(w)).length / total * 100),
    },
    wordsPerSecond: null,
    wordCount: total,
  };
}

function buildLexicalSummary(f) {
  const r = f.rates || f;
  const notes = [];
  if (r.hedging > 8) notes.push(`hedging language (${r.hedging}%)`);
  if (r.certainty > 8) notes.push(`certainty markers (${r.certainty}%)`);
  if (r.filler > 8) notes.push(`filler words (${r.filler}%)`);
  if (r.emotional > 8) notes.push(`emotional language (${r.emotional}%)`);
  if (r.exclusive > 8) notes.push(`qualifying words (${r.exclusive}%)`);
  if (r.firstPersonSg > 8) notes.push(`first-person singular (${r.firstPersonSg}%)`);
  if (f.wordsPerSecond) {
    const pace = f.wordsPerSecond > 3.5 ? 'fast' : f.wordsPerSecond < 2 ? 'slow' : 'moderate';
    notes.push(`speech rate ${f.wordsPerSecond} w/s (${pace})`);
  }
  return notes.length ? `Features detected: ${notes.join(', ')}.` : 'Neutral delivery.';
}

// ── Claim deduplication ───────────────────────────────────────────────────────

const recentClaims = new Map();
const CLAIM_DEDUP_MS = 200000;

function normalizeClaimKey(claim) {
  return claim.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length >= 4)
    .sort()
    .join(' ');
}

function isDuplicate(claim) {
  const key = normalizeClaimKey(claim);
  const now = Date.now();

  for (const [k, v] of recentClaims) {
    const t = Array.isArray(v) ? v[0] : v;
    if (now - t > CLAIM_DEDUP_MS) recentClaims.delete(k);
  }

  if (recentClaims.has(key)) return true;

  const keyWords = new Set(key.split(' ').filter(Boolean));
  const figures = (claim.match(/\$[\d,.]+(?:\s*(?:trillion|billion|million|thousand))?/gi) || [])
    .map(d => d.replace(/[,\s]/g, '').toLowerCase());

  for (const [k, v] of recentClaims) {
    const kWords = k.split(' ').filter(Boolean);
    if (kWords.filter(w => keyWords.has(w)).length / Math.max(keyWords.size, kWords.length) >= 0.35) return true;
    if (figures.length) {
      const origClaim = Array.isArray(v) ? v[1] : '';
      if (origClaim) {
        const origFigures = (origClaim.match(/\$[\d,.]+(?:\s*(?:trillion|billion|million|thousand))?/gi) || [])
          .map(d => d.replace(/[,\s]/g, '').toLowerCase());
        if (figures.some(f => origFigures.includes(f))) return true;
      }
    }
  }

  recentClaims.set(key, [now, claim]);
  return false;
}

// ── Rolling window ────────────────────────────────────────────────────────────

const WINDOW_SIZE = 4;
const WINDOW_KEEP = 15;

let sentenceWindow = [];
let sentenceCount = 0;
let windowLexical = { rates: { hedging: 0, certainty: 0, filler: 0, emotional: 0, exclusive: 0, firstPersonSg: 0 }, wordsPerSecond: null, wordCount: 0 };
let windowStartTime = null;
let pageTitle = '';
let pageDate = '';
let currentSpeakerId = null;
let lastSpeakerId = null;
let speakerIdToName = {};
let confirmedSpeakers = new Set();

function resetWindow() {
  sentenceWindow = [];
  sentenceCount = 0;
  windowLexical = { rates: { hedging: 0, certainty: 0, filler: 0, emotional: 0, exclusive: 0, firstPersonSg: 0 }, wordsPerSecond: null, wordCount: 0 };
  windowStartTime = null;
  currentSpeakerId = null;
  lastSpeakerId = null;
  speakerIdToName = {};
  confirmedSpeakers = new Set();
}

function resetLexical() {
  return { rates: { hedging: 0, certainty: 0, filler: 0, emotional: 0, exclusive: 0, firstPersonSg: 0 }, wordsPerSecond: null, wordCount: 0 };
}

async function onNewSentence(text, speakerId) {
  if (lastSpeakerId !== null &&
      speakerId !== null && speakerId !== undefined &&
      speakerId !== lastSpeakerId &&
      sentenceCount % WINDOW_SIZE !== 0 &&
      sentenceWindow.length >= 2) {
    const flushText = sentenceWindow.map(s => s.text).join(' ');
    const flushCounts = {};
    sentenceWindow.slice(-WINDOW_SIZE).forEach(s => {
      if (s.speakerId !== null && s.speakerId !== undefined)
        flushCounts[s.speakerId] = (flushCounts[s.speakerId] || 0) + 1;
    });
    const flushDominantId = Object.keys(flushCounts).length
      ? Object.entries(flushCounts).sort((a, b) => b[1] - a[1])[0][0]
      : null;
    const flushDominantSpeaker = flushDominantId !== null ? (speakerIdToName[flushDominantId] || null) : null;
    const flushLexSnapshot = JSON.parse(JSON.stringify(windowLexical));
    const flushLexSummary = buildLexicalSummary(flushLexSnapshot);
    windowLexical = resetLexical();
    windowStartTime = null;
    await extractKeyPoints(flushText, pageTitle, flushLexSummary, flushLexSnapshot, flushDominantSpeaker, flushDominantId);
  }
  lastSpeakerId = speakerId;

  const confirmedName = (speakerId !== null && speakerId !== undefined) ? speakerIdToName[speakerId] : null;
  const label = confirmedName ? `[${confirmedName}]` : (speakerId !== null && speakerId !== undefined ? `[Speaker ${speakerId}]` : null);
  const labeledText = label ? `${label} ${text}` : text;

  sentenceWindow.push({ text: labeledText, speakerId, speakerName: confirmedName });
  if (sentenceWindow.length > WINDOW_KEEP) sentenceWindow.shift();
  sentenceCount++;

  if (!windowStartTime) windowStartTime = Date.now();

  const f = extractLexical(text);
  const r = f.rates, wr = windowLexical.rates;
  wr.hedging = Math.round((wr.hedging + r.hedging) / 2);
  wr.certainty = Math.round((wr.certainty + r.certainty) / 2);
  wr.filler = Math.round((wr.filler + r.filler) / 2);
  wr.emotional = Math.round((wr.emotional + r.emotional) / 2);
  wr.exclusive = Math.round((wr.exclusive + r.exclusive) / 2);
  wr.firstPersonSg = Math.round((wr.firstPersonSg + r.firstPersonSg) / 2);
  windowLexical.wordCount += f.wordCount;

  if (sentenceCount % WINDOW_SIZE === 0) {
    const contextText = sentenceWindow.map(s => s.text).join(' ');
    const currentWindowSentences = sentenceWindow.slice(-WINDOW_SIZE);
    const counts = {};
    currentWindowSentences.forEach(s => {
      if (s.speakerId !== null && s.speakerId !== undefined)
        counts[s.speakerId] = (counts[s.speakerId] || 0) + 1;
    });
    const dominantSpeakerId = Object.keys(counts).length
      ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
      : null;
    const dominantSpeaker = dominantSpeakerId !== null
      ? (speakerIdToName[dominantSpeakerId] || null)
      : null;

    const elapsed = windowStartTime ? (Date.now() - windowStartTime) / 1000 : null;
    if (elapsed && elapsed > 0) windowLexical.wordsPerSecond = Math.round(windowLexical.wordCount / elapsed * 10) / 10;
    windowStartTime = null;

    const lexicalSnapshot = JSON.parse(JSON.stringify(windowLexical));
    const lexicalSummary = buildLexicalSummary(lexicalSnapshot);
    windowLexical = resetLexical();
    windowStartTime = null;

    try {
      await extractKeyPoints(contextText, pageTitle, lexicalSummary, lexicalSnapshot, dominantSpeaker, dominantSpeakerId);
    } catch (e) {
      console.error('[window] evaluation error:', e);
    }
  }
}

// ── Evaluation pipeline ───────────────────────────────────────────────────────

async function evaluateClaims(contextText, title, lexicalSummary, lexicalSnapshot, dominantSpeaker, dominantSpeakerId) {
  try {
    const dateContext = pageDate ? `\nDate: ${pageDate}` : '';
    const titleNames = parseSpeakersFromTitle(title || '');
    const nameList = titleNames.join(' and ');
    const speakerLegend = titleNames.length
      ? `\nDebate participants: ${nameList}.` +
        `\nSpeaker attribution rules:` +
        `\n- Identify speakers using: (1) first-person language; (2) policy content; (3) cross-references.` +
        `\n- Use your knowledge of each participant's background and policies.` +
        `\n- NEVER output "Speaker N" in any field.`
      : `\nIdentify speakers using first-person language, policy content, and speech patterns. Never output "Speaker N".`;

    const titleContext = title
      ? `Video: "${title}"${dateContext}${speakerLegend}\n\nEvaluate claims as they were made at the time of this recording.\n\n`
      : '';
    const lexicalContext = lexicalSummary ? `\n\nLexical analysis: ${lexicalSummary}` : '';

    const checkedList = [...recentClaims.values()]
      .filter(v => Array.isArray(v) && v[1])
      .map(v => v[1])
      .slice(-15)
      .join('\n- ');
    const alreadyChecked = checkedList
      ? `\n\nClaims already fact-checked — do NOT re-evaluate:\n- ${checkedList}\n`
      : '';

    const raw = (await callClaude(
      `${titleContext}Transcript: "${contextText}"${alreadyChecked}${lexicalContext}`,
      EVALUATE_PROMPT
    )).text;
    const results = parseArray(raw);
    const valid = results.filter(r => r.claim && r.verdict && !isDuplicate(r.claim));

    if (!valid.length) return;

    if (activeTabId) {
      sendToTab(activeTabId, {
        type: 'NEW_VERDICT',
        results: valid.map(r => ({
          ...r,
          sources: [],
          pending: true,
          lexical: lexicalSnapshot,
          dominantSpeakerId,
          speaker: dominantSpeaker || (r.speaker && !r.speaker.match(/^Speaker\s*\d+$/i) ? r.speaker : null),
        })),
      });
    }

    groundAndUpdate(contextText, valid, title, lexicalSummary, lexicalSnapshot, dominantSpeaker, dominantSpeakerId);
  } catch (err) {
    console.error('[pipeline] error:', err);
  }
}

async function groundAndUpdate(contextText, fastResults, title, lexicalSummary, lexicalSnapshot, dominantSpeaker, dominantSpeakerId) {
  try {
    const dateCtx = pageDate ? `\nDate: ${pageDate}` : '';
    const titleContext = title
      ? `Video: "${title}"${dateCtx}\nEvaluate claims as they were made at the time of this recording.\n\n`
      : '';
    const lexicalContext = lexicalSummary ? `\n\nLexical analysis: ${lexicalSummary}` : '';

    const groundedAll = await Promise.all(fastResults.map(async (fastResult) => {
      try {
        const urls = await searchWeb(fastResult.claim);
        if (!urls.length) return null;
        const raw = (await callClaude(
          `${titleContext}Transcript: "${contextText}"\n\nEvaluate ONLY this claim:\n1. ${fastResult.claim}\n\nWeb results:\n${urls.join('\n')}${lexicalContext}`,
          EVALUATE_PROMPT
        )).text;
        const results = parseArray(raw);
        const match = results.find(r => r.claim && r.verdict);
        if (!match) return null;

        const lateResolved = dominantSpeakerId !== null && dominantSpeakerId !== undefined
          ? speakerIdToName[dominantSpeakerId] || null : null;
        const resolvedSpeaker = lateResolved || dominantSpeaker
          || (match.speaker && !match.speaker.match(/^Speaker\s*\d+$/i) ? match.speaker : null)
          || (fastResult.speaker && !fastResult.speaker.match(/^Speaker\s*\d+$/i) ? fastResult.speaker : null);

        const fastWasTrue = fastResult.verdict === 'TRUE' || fastResult.verdict === 'SUBSTANTIALLY TRUE';
        const groundedIsMisleading = match.verdict === 'MISLEADING';
        const finalVerdict = (fastWasTrue && groundedIsMisleading) ? fastResult.verdict : match.verdict;

        return { ...match, verdict: finalVerdict, sources: urls, pending: false, lexical: lexicalSnapshot, speaker: resolvedSpeaker, dominantSpeakerId };
      } catch (err) {
        console.error('[grounded] error:', err);
        return null;
      }
    }));

    const valid = groundedAll.filter(Boolean);
    if (valid.length && activeTabId) {
      sendToTab(activeTabId, { type: 'UPDATE_VERDICTS', results: valid });
    }
  } catch (err) {
    console.error('[grounded] error:', err);
  }
}

// ── Key points (neutral, no verdict) ──────────────────────────────────────────

async function extractKeyPoints(contextText, title, lexicalSummary, lexicalSnapshot, dominantSpeaker, dominantSpeakerId) {
  try {
    const dateContext = pageDate ? `\nDate: ${pageDate}` : '';
    const titleNames = parseSpeakersFromTitle(title || '');
    const speakerLegend = titleNames.length
      ? `\nParticipants: ${titleNames.join(' and ')}. Attribute each point to the right person; never output "Speaker N".`
      : `\nIdentify the speaker from context; never output "Speaker N".`;
    const titleContext = title
      ? `Event: "${title}"${dateContext}${speakerLegend}\n\n`
      : '';

    const notedList = [...recentClaims.values()]
      .filter(v => Array.isArray(v) && v[1])
      .map(v => v[1])
      .slice(-15)
      .join('\n- ');
    const alreadyNoted = notedList ? `\n\nAlready noted — do NOT repeat:\n- ${notedList}\n` : '';

    const raw = (await callClaude(
      `${titleContext}Transcript: "${contextText}"${alreadyNoted}`,
      KEYPOINTS_PROMPT
    )).text;
    const results = parseArray(raw);
    const valid = results.filter(r => r.point && !isDuplicate(r.point));
    if (!valid.length) return;

    if (activeTabId) {
      sendToTab(activeTabId, {
        type: 'NEW_KEYPOINTS',
        results: valid.map(r => ({
          point: r.point,
          category: (r.category || 'OTRO').toUpperCase(),
          quote: r.quote || '',
          speaker: dominantSpeaker
            || (r.speaker && !String(r.speaker).match(/^Speaker\s*\d+$/i) ? r.speaker : null),
          dominantSpeakerId,
        })),
      });
    }
  } catch (err) {
    console.error('[keypoints] error:', err);
  }
}

// ── On-demand verification of a single key point ───────────────────────────────

async function verifyKeyPoint(id, claim, quote) {
  try {
    const dateCtx = pageDate ? `\nDate: ${pageDate}` : '';
    const titleCtx = pageTitle ? `Event: "${pageTitle}"${dateCtx}\n\n` : '';
    const quoteCtx = (quote && quote.trim()) ? `\nOriginal quote: "${quote}"` : '';

    // grounded=true → the proxy enables Gemini's native Google Search; the answer
    // comes back with real sources (no Serper needed).
    const { text, sources } = await callClaude(
      `${titleCtx}Evaluate ONLY this claim:\n${claim}${quoteCtx}`,
      VERIFY_PROMPT,
      true
    );
    const result = parseObject(text);
    if (activeTabId) {
      sendToTab(activeTabId, {
        type: 'KEYPOINT_VERDICT',
        id,
        result: result ? { ...result, sources: sources || [] } : null,
      });
    }
  } catch (err) {
    console.error('[verify] error:', err);
    if (activeTabId) sendToTab(activeTabId, { type: 'KEYPOINT_VERDICT', id, result: null });
  }
}

// ── Final summary (on demand) ──────────────────────────────────────────────────

async function summarizeSession(input) {
  try {
    const { text } = await callClaude(input, SUMMARY_PROMPT, false, 1536);
    if (activeTabId) sendToTab(activeTabId, { type: 'SUMMARY_RESULT', text: text || '' });
  } catch (err) {
    console.error('[summary] error:', err);
    if (activeTabId) sendToTab(activeTabId, { type: 'SUMMARY_RESULT', text: '' });
  }
}

// ── State ─────────────────────────────────────────────────────────────────────

let activeTabId = null;
let isCapturing = false;

function sendToTab(tabId, msg) {
  browser.tabs.sendMessage(tabId, msg).catch(() => {});
}

// ── Translation ────────────────────────────────────────────────────────────────

// Spanish and English are left untranslated (user understands both). Any other
// selected language — or 'auto' — gets translated to Spanish (the prompt passes
// Spanish/English through unchanged, so 'auto' stays correct without detection).
function needsTranslation() {
  return SOURCE_LANGUAGE !== 'es' && SOURCE_LANGUAGE !== 'en';
}

async function translateToSpanish(text) {
  if (!text || !text.trim()) return '';
  try {
    const out = (await callClaude(text, TRANSLATE_PROMPT)).text;
    return (out || '').trim();
  } catch {
    return '';
  }
}

// Computer-clock timecode HH:MM:SS:FF (FF = frame, 24 fps), captured when the
// sentence is finalized — before any translation latency.
function getClockTimecode() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ff = Math.floor(d.getMilliseconds() * 24 / 1000);
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + ':' + p(ff);
}

async function relayTranscript(msg) {
  if (!activeTabId) return;
  const timecode = msg.isFinal ? getClockTimecode() : '';
  let translation = '';
  if (msg.isFinal && needsTranslation()) {
    translation = await translateToSpanish(msg.text);
  }
  sendToTab(activeTabId, {
    type: 'TRANSCRIPT_RESULT',
    text: msg.text,
    isFinal: msg.isFinal,
    interim: msg.interim,
    timecode,
    translation,
  });
}

// ── Messages ──────────────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((msg, sender) => {
  switch (msg.type) {

    case 'START_FACTCHECK':
      return startFactCheck();

    case 'STOP_FACTCHECK':
      stopFactCheck();
      return Promise.resolve({ ok: true });

    case 'TRANSCRIPT_RESULT':
      if (msg.isFinal) {
        if (msg.speaker !== null && msg.speaker !== undefined) {
          currentSpeakerId = msg.speaker;
          if (activeTabId && !confirmedSpeakers.has(currentSpeakerId) && !speakerIdToName[currentSpeakerId]) {
            sendToTab(activeTabId, {
              type: 'NEW_SPEAKER',
              speakerId: currentSpeakerId,
              sample: msg.text.slice(0, 80),
            });
          }
        }
        onNewSentence(msg.text, currentSpeakerId);
      }
      relayTranscript(msg);
      return Promise.resolve();

    case 'SPEAKER_NAMES':
      if (msg.speakerIdToName) {
        Object.entries(msg.speakerIdToName).forEach(([id, name]) => {
          const numId = parseInt(id);
          if (!confirmedSpeakers.has(numId)) {
            speakerIdToName[numId] = name;
            confirmedSpeakers.add(numId);
          }
        });
      }
      return Promise.resolve();

    case 'PAGE_TITLE':
      pageTitle = msg.title || '';
      pageDate = msg.date || '';
      return Promise.resolve();

    case 'PIPELINE_ERROR':
      if (activeTabId) sendToTab(activeTabId, { type: 'PIPELINE_ERROR', message: msg.message });
      return Promise.resolve();

    case 'VERIFY_KEYPOINT':
      verifyKeyPoint(msg.id, msg.claim, msg.quote);
      return Promise.resolve();

    case 'SUMMARIZE':
      summarizeSession(msg.input || '');
      return Promise.resolve();

    case 'GET_STATUS':
      return Promise.resolve({ isCapturing });
  }
});

// ── Start / stop ──────────────────────────────────────────────────────────────

async function startFactCheck() {
  if (isCapturing) return { ok: true };

  await loadKeys();
  if (!ANTHROPIC_KEY && !PROXY_URL) {
    throw new Error('Configura una API key de Anthropic o una URL de proxy en el popup.');
  }

  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) throw new Error('No active tab found.');
  activeTabId = tabs[0].id;

  isCapturing = true;
  resetWindow();
  recentClaims.clear();

  await sendToTab(activeTabId, { type: 'START_FACTCHECK' });
  return { ok: true };
}

function stopFactCheck() {
  resetWindow();
  recentClaims.clear();
  pageTitle = '';
  pageDate = '';

  if (!isCapturing) return;

  if (activeTabId) sendToTab(activeTabId, { type: 'STOP_FACTCHECK' });

  activeTabId = null;
  isCapturing = false;
}
