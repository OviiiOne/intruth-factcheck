// overlay.js

console.log('[overlay] content script loaded');

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let panel = null;
let transcriptFeedEl = null;
let interimEl = null;
let claimFeedEl = null;
let verdictListEl = null;
let summaryEl = null;
let transcriptCollapsed = false;
const pendingCards    = new Map();
const pendingCardTimes = new Map();

// expire pending cards after 90 seconds
setInterval(() => {
  const now = Date.now();
  for (const [key, time] of pendingCardTimes) {
    if (now - time > 90000) {
      const card = pendingCards.get(key);
      if (card) {
        card.classList.remove('rtfc-verdict--pending');
        const verifying = card.querySelector('.rtfc-verifying');
        if (verifying) verifying.textContent = '⚠ unverified';
      }
      pendingCards.delete(key);
      pendingCardTimes.delete(key);
    }
  }
}, 15000);

let lastTranscriptTimestamp = '';
const sentenceTimestamps   = [];
const MAX_TIMESTAMP_BUFFER = 10;

// ── Speaker state ────────────────────────────────────────────────────────────
let speakers = [];

// ── Speaker colors ────────────────────────────────────────────────────────────
const SPEAKER_COLORS = [
  '#3b82f6',
  '#ef4444',
  '#f59e0b',
  '#10b981',
  '#8b5cf6',
  '#f97316',
];
const speakerColorMap = new Map();

function getSpeakerColor(name) {
  if (!speakerColorMap.has(name)) {
    const idx = speakerColorMap.size % SPEAKER_COLORS.length;
    speakerColorMap.set(name, SPEAKER_COLORS[idx]);
  }
  return speakerColorMap.get(name);
}

// ── Speaker parsing ───────────────────────────────────────────────────────────
function parseSpeakersFromTitle(title) {
  if (!title) return [];
  const roleMatch = title.match(/(\d+)\s+([a-z]+(?:\s+[a-z]+)?)\s+(?:vs?\.?|versus)\s+(\d+)\s+([a-z]+(?:\s+[a-z]+)?)/i);
  if (roleMatch) {
    const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
    return [cap(roleMatch[2]), cap(roleMatch[4])];
  }
  // only match capitalized proper names (not lowercase words like "in", "the", etc.)
  const nameMatch = title.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:and|vs\.?|versus|&)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  if (nameMatch) {
    const clean = name => name.trim().split(' ').pop();
    return [clean(nameMatch[1]), clean(nameMatch[2])];
  }
  return [];
}

let lastActiveSpeaker = null; // track most recently labeled speaker

function normalizeSpeakerName(name) {
  if (!name) return name;
  // if name matches a known speaker's last name or full name, return the canonical last name
  for (const speaker of speakers) {
    const lastName = speaker.trim().split(' ').pop().toLowerCase();
    if (name.toLowerCase() === speaker.toLowerCase()) return speaker; // exact match
    if (name.toLowerCase().includes(lastName)) return speaker;        // last name match
  }
  return name; // unknown speaker — return as-is
}

function getClaimSpeaker(claimText) {
  if (!speakers.length) return 'Other';
  const lower = claimText.toLowerCase();

  // direct name match
  for (const speaker of speakers) {
    if (lower.includes(speaker.toLowerCase())) return speaker;
  }

  // partial name match (handles "Vice President Harris" → "Harris")
  for (const speaker of speakers) {
    const parts = speaker.toLowerCase().split(' ');
    if (parts.some(p => p.length > 3 && lower.includes(p))) return speaker;
  }

  // fallback: use last active speaker for vague references
  if (lastActiveSpeaker) return lastActiveSpeaker;

  return 'Other';
}

// ── Speaker ID confirmation ──────────────────────────────────────────────────

const confirmedSpeakerMap = {}; // { speakerId: 'Harris' }
const pendingSpeakerIds   = new Set(); // IDs waiting for confirmation

function showSpeakerBanner(speakerId, sample) {
  if (pendingSpeakerIds.has(speakerId)) return;
  if (speakerId in confirmedSpeakerMap) return;
  // if speakers not yet parsed from title, retry once after 1s
  if (!speakers.length) {
    setTimeout(() => showSpeakerBanner(speakerId, sample), 1000);
    return;
  }
  pendingSpeakerIds.add(speakerId);

  const banner = document.createElement('div');
  banner.className = 'rtfc-speaker-banner';
  banner.innerHTML =
    '<div class="rtfc-speaker-banner-text">New speaker detected — who is this?</div>' +
    '<div class="rtfc-speaker-banner-sample">"' + escapeHtml(sample) + '..."</div>' +
    '<div class="rtfc-speaker-banner-buttons">' +
      speakers.map(name =>
        '<button class="rtfc-speaker-banner-btn" data-name="' + escapeHtml(name) + '" data-id="' + speakerId + '">' + escapeHtml(name) + '</button>'
      ).join('') +
      '<button class="rtfc-speaker-banner-btn rtfc-speaker-banner-btn--skip" data-id="' + speakerId + '">Skip</button>' +
    '</div>';

  banner.querySelectorAll('.rtfc-speaker-banner-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.name;
      const id   = parseInt(btn.dataset.id);
      if (name) {
        confirmedSpeakerMap[id] = name;
        browser.runtime.sendMessage({
          type: 'SPEAKER_NAMES',
          speakerIdToName: { [id]: name },
        });
      }
      pendingSpeakerIds.delete(id);
      if (!name) confirmedSpeakerMap[id] = null;
      banner.remove();
      // retroactively tag all existing grounded cards now that we have more info
      retryTagAllCards();
    });
  });

  // insert above verdicts
  const verdictsSection = panel?.querySelector('#rtfc-verdicts-section');
  if (verdictsSection) verdictsSection.insertAdjacentElement('beforebegin', banner);
}

// ── Speaker confirmation state ───────────────────────────────────────────────

function allSpeakersConfirmed() {
  // true when every speaker seen so far has been confirmed or skipped
  // and at least one real name has been confirmed
  const confirmedNames = Object.values(confirmedSpeakerMap).filter(v => v !== null);
  return confirmedNames.length >= Math.min(speakers.length, Object.keys(confirmedSpeakerMap).length)
    && Object.keys(confirmedSpeakerMap).length > 0;
}

function retryTagAllCards() {
  // retroactively tag all grounded cards once speakers are confirmed
  if (!verdictListEl) return;
  verdictListEl.querySelectorAll('.rtfc-verdict:not(.rtfc-verdict--pending)').forEach(card => {
    const sid = card.dataset.speakerid;
    if (sid === undefined) return;
    const rawName = confirmedSpeakerMap[sid];
    if (!rawName) return; // skipped or not confirmed
    const name = normalizeSpeakerName(rawName);
    // add or update tag
    let tag = card.querySelector('.rtfc-speaker-tag');
    if (tag) {
      tag.textContent = name;
      tag.style.background = getSpeakerColor(name);
    } else {
      const color = getSpeakerColor(name);
      tag = document.createElement('div');
      tag.className = 'rtfc-speaker-tag';
      tag.style.background = color;
      tag.textContent = name;
      card.insertBefore(tag, card.firstChild);
    }
  });
}

// ── Speaker editor ───────────────────────────────────────────────────────────

function sendSpeakerMap() {
  // Deepgram speaker IDs are assigned in order of first appearance
  // We map ID 0 → speakers[0], ID 1 → speakers[1], etc.
  const speakerIdToName = {};
  speakers.forEach((name, i) => { speakerIdToName[i] = name; });
  browser.runtime.sendMessage({ type: 'SPEAKER_NAMES', speakerIdToName });
}

function renderSpeakerEditor() {
  const el = panel?.querySelector('#rtfc-speaker-editor');
  if (!el || !speakers.length) return;

  el.innerHTML = speakers.map((name, i) => {
    const color = getSpeakerColor(name);
    return '<span class="rtfc-speaker-chip" style="border-color:' + color + ';color:' + color + '" data-idx="' + i + '">' +
      '<input class="rtfc-speaker-chip-input" value="' + escapeHtml(name) + '" data-idx="' + i + '" style="color:' + color + '" />' +
    '</span>';
  }).join('');

  el.querySelectorAll('.rtfc-speaker-chip-input').forEach(input => {
    input.addEventListener('change', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      const oldName = speakers[idx];
      const newName = e.target.value.trim() || oldName;
      if (newName === oldName) return;

      // update color map
      if (speakerColorMap.has(oldName)) {
        speakerColorMap.set(newName, speakerColorMap.get(oldName));
        speakerColorMap.delete(oldName);
      }

      speakers[idx] = newName;
      e.target.style.color = getSpeakerColor(newName);
      e.target.closest('.rtfc-speaker-chip').style.borderColor = getSpeakerColor(newName);
      e.target.closest('.rtfc-speaker-chip').style.color = getSpeakerColor(newName);
      sendSpeakerMap(); // update service worker with new names

      // re-render all verdict cards to update speaker tags
      const cards = verdictListEl?.querySelectorAll('.rtfc-speaker-tag');
      if (cards) {
        cards.forEach(tag => {
          if (tag.textContent === oldName) {
            tag.textContent = newName;
            tag.style.background = getSpeakerColor(newName);
          }
        });
      }
    });
    // select all on focus for easy editing
    input.addEventListener('focus', e => e.target.select());
  });
}

// ── Error toast ──────────────────────────────────────────────────────────────

function showError(message, level) {
  if (!panel) return;
  const isInfo = level === 'info';
  const existing = panel.querySelector('.rtfc-error-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'rtfc-error-toast' + (isInfo ? ' rtfc-error-toast--info' : '');
  toast.innerHTML =
    '<span class="rtfc-error-icon">' + (isInfo ? 'ℹ' : '⚠') + '</span>' +
    '<span class="rtfc-error-msg">' + escapeHtml(message) + '</span>' +
    '<button class="rtfc-error-close">✕</button>';

  toast.querySelector('.rtfc-error-close').addEventListener('click', () => toast.remove());
  panel.querySelector('#rtfc-header').insertAdjacentElement('afterend', toast);

  // Info auto-dismisses; errors stay until replaced or closed, so failures get noticed.
  if (isInfo) setTimeout(() => toast.remove(), 5000);
}

// The header dot reflects real state so failures are noticeable even after a toast
// fades: amber = connecting, green = audio flowing, red = error.
function setDotState(state) {
  const dot = panel && panel.querySelector('.rtfc-dot');
  if (!dot) return;
  dot.classList.remove('rtfc-dot--live', 'rtfc-dot--error');
  if (state === 'live') dot.classList.add('rtfc-dot--live');
  else if (state === 'error') dot.classList.add('rtfc-dot--error');
}

// ── Panel ─────────────────────────────────────────────────────────────────────
function createPanel() {
  if (panel) return;

  panel = document.createElement('div');
  panel.id = 'rtfc-panel';
  panel.innerHTML = [
    '<div id="rtfc-header">',
      '<span><span class="rtfc-dot"></span>InTruth</span>',
      '<div class="rtfc-header-actions">',
        '<button id="rtfc-summary-btn" title="Generar resumen">🧾 Resumen</button>',
        '<button id="rtfc-export" title="Exportar sesión">↓ Exportar</button>',
        '<button id="rtfc-close">✕</button>',
      '</div>',
    '</div>',
    '<div id="rtfc-body">',
      '<div id="rtfc-summary" style="display:none"></div>',
      '<div id="rtfc-transcript-section">',
        '<div class="rtfc-section-header">',
          '<span class="rtfc-section-label">Transcript</span>',
          '<button class="rtfc-toggle-btn" id="rtfc-transcript-toggle">▾</button>',
        '</div>',
        '<div id="rtfc-transcript-feed"></div>',
        '<p id="rtfc-interim"></p>',
      '</div>',
      '<div id="rtfc-verdicts-section">',
        '<div class="rtfc-section-header">',
          '<span class="rtfc-section-label">Puntos clave</span>',
          '<div id="rtfc-speaker-editor"></div>',
        '</div>',
        '<div id="rtfc-verdicts">',
          '<p class="rtfc-empty">Los puntos clave aparecerán aquí…</p>',
        '</div>',
      '</div>',
    '</div>',
  ].join('');

  document.body.appendChild(panel);

  transcriptFeedEl = panel.querySelector('#rtfc-transcript-feed');
  interimEl        = panel.querySelector('#rtfc-interim');
  claimFeedEl      = panel.querySelector('#rtfc-claim-feed');
  verdictListEl    = panel.querySelector('#rtfc-verdicts');
  summaryEl        = panel.querySelector('#rtfc-summary');

  panel.querySelector('#rtfc-close').addEventListener('click', () => {
    browser.runtime.sendMessage({ type: 'STOP_FACTCHECK' });
    removePanel();
  });

  panel.querySelector('#rtfc-export').addEventListener('click', () => exportPDF());
  panel.querySelector('#rtfc-summary-btn').addEventListener('click', () => generateSummary());

  makeDraggable(panel);

  panel.querySelector('#rtfc-transcript-toggle').addEventListener('click', () => {
    transcriptCollapsed = !transcriptCollapsed;
    transcriptFeedEl.style.display = transcriptCollapsed ? 'none' : '';
    interimEl.style.display = transcriptCollapsed ? 'none' : '';
    panel.querySelector('#rtfc-transcript-toggle').textContent = transcriptCollapsed ? '▸' : '▾';
  });
}

function removePanel() {
  panel?.remove();
  panel = null;
  transcriptFeedEl = null;
  interimEl = null;
  claimFeedEl = null;
  verdictListEl = null;
  summaryEl = null;
  transcriptCollapsed = false;
  pendingCards.clear();
  pendingCardTimes.clear();
  kpCards.clear();
  kpCounter = 0;
  speakers = [];
  speakerColorMap.clear();
  sentenceTimestamps.length = 0;
  lastTranscriptTimestamp = '';
  lastActiveSpeaker = null;
  Object.keys(confirmedSpeakerMap).forEach(k => delete confirmedSpeakerMap[k]);
  pendingSpeakerIds.clear();
}

// ── Transcript ────────────────────────────────────────────────────────────────

// Computer-clock timecode HH:MM:SS:FF (FF = frame, 24 fps) at the moment the
// sentence was finalized — lets the user know the real-world time something was said.
function getClockTimecode() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ff = Math.floor(d.getMilliseconds() * 24 / 1000); // 0–23
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + ':' + p(ff);
}

function addTranscriptLine(timecode, text, translation) {
  if (!transcriptFeedEl) return;
  const line = document.createElement('div');
  line.className = 'rtfc-transcript-line';
  const tc = document.createElement('span');
  tc.className = 'rtfc-tc';
  tc.textContent = '[' + timecode + ']';
  line.appendChild(tc);
  line.appendChild(document.createTextNode(' ' + text));
  if (translation && translation.trim() && translation.trim() !== text.trim()) {
    const tr = document.createElement('div');
    tr.className = 'rtfc-tr';
    tr.textContent = '↳ ' + translation;
    line.appendChild(tr);
  }
  transcriptFeedEl.appendChild(line);
  transcriptFeedEl.scrollTop = transcriptFeedEl.scrollHeight;
}

function updateInterim(text) {
  if (!interimEl) return;
  interimEl.textContent = text;
}

function clearInterim() {
  if (!interimEl) return;
  interimEl.textContent = '';
}

// ── Claims ────────────────────────────────────────────────────────────────────
function addClaimBullet(claim) {
  if (!claimFeedEl) return;
  const li = document.createElement('li');
  li.className = 'rtfc-claim-bullet rtfc-claim-bullet--pending';
  li.dataset.claim = claim.toLowerCase().slice(0, 40);
  li.textContent = claim;
  claimFeedEl.appendChild(li);
  return li;
}

function applyVerdictToBullet(claim, verdict, confidence) {
  if (!claimFeedEl) return;
  const color = colorForVerdict(verdict, confidence);
  const claimWords = new Set(claim.toLowerCase().split(/\s+/).filter(w => w.length >= 4));
  const bullets = claimFeedEl.querySelectorAll('.rtfc-claim-bullet');
  let bestLi = null, bestScore = 0;
  for (const li of bullets) {
    const bulletWords = (li.textContent || '').toLowerCase().split(/\s+/).filter(w => w.length >= 4);
    const overlap = bulletWords.filter(w => claimWords.has(w)).length;
    const score = overlap / Math.max(claimWords.size, bulletWords.length);
    if (score > bestScore) { bestScore = score; bestLi = li; }
  }
  if (bestLi && bestScore >= 0.3) {
    bestLi.className = 'rtfc-claim-bullet rtfc-claim-bullet--' + color;
  }
}

// ── Verdicts ──────────────────────────────────────────────────────────────────
function colorForVerdict(verdict, confidence) {
  if (confidence === 'LOW')              return 'yellow';
  if (verdict === 'TRUE')                return 'green';
  if (verdict === 'SUBSTANTIALLY TRUE')  return 'teal';
  if (verdict === 'FALSE')               return 'red';
  if (verdict === 'MISLEADING')          return 'yellow';
  if (verdict === 'UNVERIFIABLE')        return 'grey';
  return 'grey';
}

function buildLexicalRows(lexical) {
  if (!lexical) return '';
  const rows = [];
  const r = lexical.rates || {};
  if (r.hedging > 0)
    rows.push('<div class="rtfc-conviction-row"><span class="rtfc-conviction-label">Hedging language:</span> ' + r.hedging + '% rate — e.g. "I think", "maybe", "probably"</div>');
  if (r.certainty > 0)
    rows.push('<div class="rtfc-conviction-row"><span class="rtfc-conviction-label">Certainty markers:</span> ' + r.certainty + '% rate — e.g. "definitely", "always"</div>');
  if (r.filler > 0)
    rows.push('<div class="rtfc-conviction-row"><span class="rtfc-conviction-label">Filler words:</span> ' + r.filler + '% rate — e.g. "um", "like", "you know"</div>');
  if (r.emotional > 0)
    rows.push('<div class="rtfc-conviction-row"><span class="rtfc-conviction-label">Emotional language:</span> ' + r.emotional + '% rate</div>');
  if (r.exclusive > 0)
    rows.push('<div class="rtfc-conviction-row"><span class="rtfc-conviction-label">Qualifying words:</span> ' + r.exclusive + '% rate — e.g. "but", "except"</div>');
  if (r.firstPersonSg > 0)
    rows.push('<div class="rtfc-conviction-row"><span class="rtfc-conviction-label">First-person singular:</span> ' + r.firstPersonSg + '% rate</div>');
  if (lexical.wordsPerSecond != null) {
    const rateDesc = lexical.wordsPerSecond > 3.5 ? 'fast' : lexical.wordsPerSecond < 2 ? 'slow' : 'moderate';
    rows.push('<div class="rtfc-conviction-row"><span class="rtfc-conviction-label">Speech rate:</span> ' + lexical.wordsPerSecond + ' w/s (' + rateDesc + ')</div>');
  }
  return rows.join('');
}

function buildCard(result) {
  const color = colorForVerdict(result.verdict, result.confidence);
  const convictionColor = result.speaker_confidence === 'HIGH' ? 'green'
                        : result.speaker_confidence === 'LOW'  ? 'red'
                        : 'yellow';

  const card = document.createElement('div');
  card.className = 'rtfc-verdict rtfc-verdict--' + color + (result.pending ? ' rtfc-verdict--pending' : '');
  card.dataset.claim = result.claim.toLowerCase().slice(0, 40);
  if (result.dominantSpeakerId !== null && result.dominantSpeakerId !== undefined) {
    card.dataset.speakerid = String(result.dominantSpeakerId);
  }
  card._resultData = result;

  const sourcesHTML = (result.sources ?? []).map((url, i) => {
    const isUrl = url.startsWith('http://') || url.startsWith('https://');
    return isUrl
      ? '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">Source ' + (i + 1) + '</a>'
      : '<span class="rtfc-source-text">' + escapeHtml(url) + '</span>';
  }).join('');

  const lexicalRows = buildLexicalRows(result.lexical);

  // speaker tag — only show on grounded cards AND only when all speakers confirmed
  // this prevents wrong tags from appearing before diarization stabilizes
  let speakerTag = '';
  if (!result.pending && allSpeakersConfirmed()) {
    const confirmedName = (result.dominantSpeakerId !== null && result.dominantSpeakerId !== undefined)
      ? confirmedSpeakerMap[result.dominantSpeakerId]
      : undefined;
    const rawSpeaker = (confirmedName !== undefined && confirmedName !== null)
      ? confirmedName
      : result.speaker || null;
    const normalizedName = rawSpeaker ? normalizeSpeakerName(rawSpeaker) : null;
    const speakerName  = (normalizedName && !normalizedName.match(/^Speaker\s*\d+$/i)) ? normalizedName : null;
    const speakerColor = speakerName ? getSpeakerColor(speakerName) : null;
    if (speakerColor) {
      speakerTag = '<div class="rtfc-speaker-tag" style="background:' + speakerColor + '">' + escapeHtml(speakerName) + '</div>';
    }
  }

  card.innerHTML = [
    speakerTag,
    '<div class="rtfc-verdict-header">',
      '<span class="rtfc-badge rtfc-badge--' + color + '">' + escapeHtml(result.verdict) + '</span>',
      result.pending ? '<span class="rtfc-verifying">⟳ verifying...</span>' : '',
      '<span class="rtfc-confidence-right">' + escapeHtml(result.confidence) + ' certainty</span>',
      '<span class="rtfc-timestamp">' + escapeHtml(result._timestamp || '') + '</span>',
    '</div>',
    '<p class="rtfc-claim">"' + escapeHtml(result.claim) + '"</p>',
    '<p class="rtfc-explanation">' + escapeHtml(result.explanation) + '</p>',
    '<div class="rtfc-speaker-confidence">',
      '<button class="rtfc-speaker-toggle">',
        '<span class="rtfc-speaker-dot rtfc-speaker-dot--' + convictionColor + '"></span>',
        'Speaker conviction: ' + escapeHtml(result.speaker_confidence || 'N/A'),
        '<span class="rtfc-speaker-arrow">▾</span>',
      '</button>',
      '<div class="rtfc-speaker-explanation" style="display:none">',
        lexicalRows,
      '</div>',
    '</div>',
    (sourcesHTML && sourcesHTML.trim()) ? '<div class="rtfc-sources">' + sourcesHTML + '</div>' : '',
  ].join('');

  const toggleBtn = card.querySelector('.rtfc-speaker-toggle');
  const reasons   = card.querySelector('.rtfc-speaker-explanation');
  const arrow     = card.querySelector('.rtfc-speaker-arrow');
  toggleBtn.addEventListener('click', () => {
    const open = reasons.style.display === 'none';
    reasons.style.display = open ? 'block' : 'none';
    arrow.textContent = open ? '▴' : '▾';
  });

  return card;
}

function findPendingCard(claim) {
  const key = claim.toLowerCase().slice(0, 40);
  if (pendingCards.has(key)) return pendingCards.get(key);

  const claimWords = new Set(claim.toLowerCase().split(/\s+/).filter(w => w.length >= 4));
  let bestCard = null, bestScore = 0;
  for (const [cardKey, card] of pendingCards) {
    const cardWords = cardKey.split(/\s+/).filter(w => w.length >= 4);
    const overlap = cardWords.filter(w => claimWords.has(w)).length;
    const score = overlap / Math.max(claimWords.size, cardWords.length);
    if (score > bestScore) { bestScore = score; bestCard = card; }
  }
  if (bestScore >= 0.4) return bestCard;
  return verdictListEl?.querySelector('.rtfc-verdict--pending');
}

function getVideoTimestamp() {
  const video = document.querySelector('video');
  if (!video) return '';
  const s = Math.floor(video.currentTime);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return h + ':' + String(m).padStart(2,'0') + ':' + String(sec).padStart(2,'0');
  return String(m).padStart(2,'0') + ':' + String(sec).padStart(2,'0');
}

function getClaimTimestamp(claim) {
  if (!sentenceTimestamps.length) return lastTranscriptTimestamp || getClockTimecode();
  const claimWords = new Set(claim.toLowerCase().split(/\s+/).filter(w => w.length >= 4));
  let bestMatch = null, bestScore = 0;
  for (const entry of sentenceTimestamps) {
    const sentWords = entry.text.toLowerCase().split(/\s+/).filter(w => w.length >= 4);
    const overlap = sentWords.filter(w => claimWords.has(w)).length;
    const score = overlap / Math.max(claimWords.size, sentWords.length);
    if (score > bestScore) { bestScore = score; bestMatch = entry; }
  }
  return bestScore >= 0.3 ? bestMatch.timestamp : (lastTranscriptTimestamp || getClockTimecode());
}

function addVerdict(result) {
  if (!verdictListEl) return;
  verdictListEl.querySelector('.rtfc-empty')?.remove();
  applyVerdictToBullet(result.claim, result.verdict, result.confidence);
  if (!result._timestamp) result._timestamp = getClaimTimestamp(result.claim);
  const card = buildCard(result);
  if (result.pending) {
    const key = result.claim.toLowerCase().slice(0, 40);
    pendingCards.set(key, card);
    pendingCardTimes.set(key, Date.now());
  } else {
    logVerdict(result);
  }
  verdictListEl.prepend(card);
}

function updateVerdict(result) {
  const existing = findPendingCard(result.claim);
  if (!result._timestamp) result._timestamp = getClaimTimestamp(result.claim);
  // inherit dominantSpeakerId from pending card if grounded result doesn't have one
  if (existing && existing.dataset.speakerid && !result.dominantSpeakerId) {
    result.dominantSpeakerId = existing.dataset.speakerid;
  }
  const newCard = buildCard(result);
  if (existing) {
    existing.replaceWith(newCard);
    for (const [k, v] of pendingCards) {
      if (v === existing) { pendingCards.delete(k); pendingCardTimes.delete(k); break; }
    }
  } else {
    verdictListEl?.querySelector('.rtfc-empty')?.remove();
    verdictListEl?.prepend(newCard);
  }
  applyVerdictToBullet(result.claim, result.verdict, result.confidence);
  logVerdict(result);
}

// ── Key points (neutral) ──────────────────────────────────────────────────────

const CATEGORY_META = {
  ANUNCIO:     { label: 'Anuncio',     color: '#3b82f6' },
  CIFRA:       { label: 'Cifra',       color: '#8b5cf6' },
  COMPROMISO:  { label: 'Compromiso',  color: '#10b981' },
  DECLARACION: { label: 'Declaración', color: '#f59e0b' },
  CITA:        { label: 'Cita',        color: '#06b6d4' },
  POLITICA:    { label: 'Política',    color: '#ef4444' },
  OTRO:        { label: 'Otro',        color: '#6b7280' },
};

const VERDICT_LABELS = {
  'TRUE': 'Verdadero',
  'SUBSTANTIALLY TRUE': 'Mayormente cierto',
  'FALSE': 'Falso',
  'MISLEADING': 'Engañoso',
  'UNVERIFIABLE': 'No verificable',
};
const CONF_LABELS = { HIGH: 'Alta', MEDIUM: 'Media', LOW: 'Baja' };

let kpCounter = 0;
const kpCards = new Map(); // id → card element

// Custom categories the AI may invent get a neutral colour + a Title-cased label.
function prettyCategory(cat) {
  if (!cat) return 'Otro';
  return cat.charAt(0).toUpperCase() + cat.slice(1).toLowerCase();
}

function buildKeyPointCard(kp) {
  const meta = CATEGORY_META[kp.category] || { label: prettyCategory(kp.category), color: '#64748b' };
  const card = document.createElement('div');
  card.className = 'rtfc-keypoint';
  card._kpData = kp;
  card.dataset.kpid = String(kp._id);
  kpCards.set(kp._id, card);

  const rawSpeaker = (kp.speaker && !String(kp.speaker).match(/^Speaker\s*\d+$/i)) ? kp.speaker : null;
  const speakerName = rawSpeaker ? normalizeSpeakerName(rawSpeaker) : null;
  const speakerTag = speakerName
    ? '<div class="rtfc-speaker-tag" style="background:' + getSpeakerColor(speakerName) + '">' + escapeHtml(speakerName) + '</div>'
    : '';

  const quoteHTML = kp.quote
    ? '<p class="rtfc-kp-quote">“' + escapeHtml(kp.quote) + '”</p>'
    : '';

  card.innerHTML = [
    speakerTag,
    '<div class="rtfc-kp-header">',
      '<span class="rtfc-kp-cat" style="background:' + meta.color + '">' + escapeHtml(meta.label) + '</span>',
      '<span class="rtfc-timestamp">' + escapeHtml(kp._timestamp || '') + '</span>',
    '</div>',
    '<p class="rtfc-kp-point">' + escapeHtml(kp.point) + '</p>',
    quoteHTML,
    '<div class="rtfc-kp-actions"><button class="rtfc-verify-btn">✓ Verificar</button></div>',
  ].join('');

  const btn = card.querySelector('.rtfc-verify-btn');
  if (btn) btn.addEventListener('click', () => {
    btn.disabled = true;
    btn.textContent = '⟳ Verificando…';
    browser.runtime.sendMessage({
      type: 'VERIFY_KEYPOINT',
      id: kp._id,
      claim: kp.point,
      quote: kp.quote || '',
    });
  });

  return card;
}

function addKeyPoint(kp) {
  if (!verdictListEl) return;
  verdictListEl.querySelector('.rtfc-empty')?.remove();
  if (!kp._timestamp) kp._timestamp = getClaimTimestamp(kp.quote || kp.point);
  kp._id = ++kpCounter;
  const card = buildKeyPointCard(kp);
  verdictListEl.prepend(card);
  if (typeof logKeyPoint === 'function') logKeyPoint(kp);
}

function applyKeyPointVerdict(id, result) {
  const card = kpCards.get(id);
  if (!card) return;
  const actions = card.querySelector('.rtfc-kp-actions');

  if (!result || !result.verdict) {
    if (actions) actions.innerHTML = '<span class="rtfc-kp-noverdict">No se pudo verificar.</span>';
    return;
  }

  const color = colorForVerdict(result.verdict, result.confidence);
  const label = VERDICT_LABELS[result.verdict] || result.verdict;
  const conf = CONF_LABELS[result.confidence] || '';
  const sourcesHTML = (result.sources ?? []).map((url, i) =>
    (url.startsWith('http://') || url.startsWith('https://'))
      ? '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">Fuente ' + (i + 1) + '</a>'
      : ''
  ).join('');

  const v = document.createElement('div');
  v.className = 'rtfc-kp-verdict rtfc-verdict--' + color;
  v.innerHTML = [
    '<div class="rtfc-kp-verdict-head">',
      '<span class="rtfc-badge rtfc-badge--' + color + '">' + escapeHtml(label) + '</span>',
      conf ? '<span class="rtfc-confidence-right">' + escapeHtml(conf) + ' confianza</span>' : '',
    '</div>',
    '<p class="rtfc-explanation">' + escapeHtml(result.explanation || '') + '</p>',
    (sourcesHTML.trim() ? '<div class="rtfc-sources">' + sourcesHTML + '</div>' : ''),
  ].join('');

  if (actions) actions.replaceWith(v); else card.appendChild(v);
  if (typeof updateKeyPointVerdict === 'function') updateKeyPointVerdict(id, result);
}

// ── Final summary ──────────────────────────────────────────────────────────────

function generateSummary() {
  if (typeof buildSummaryInput !== 'function') return;
  const input = buildSummaryInput();
  if (!input || !input.trim()) { showError('Aún no hay contenido para resumir.'); return; }
  if (summaryEl) {
    summaryEl.style.display = '';
    summaryEl.innerHTML =
      '<div class="rtfc-summary-title">Resumen</div>' +
      '<div class="rtfc-summary-body rtfc-summary-loading">Generando resumen…</div>';
  }
  browser.runtime.sendMessage({ type: 'SUMMARIZE', input });
}

function renderSummary(text) {
  if (!summaryEl) return;
  summaryEl.style.display = '';
  const title = '<div class="rtfc-summary-title">Resumen</div>';
  if (!text || !text.trim()) {
    summaryEl.innerHTML = title + '<div class="rtfc-summary-body">No se pudo generar el resumen.</div>';
    return;
  }
  summaryEl.innerHTML = title;
  const body = document.createElement('div');
  body.className = 'rtfc-summary-body';
  body.textContent = text;
  summaryEl.appendChild(body);
  if (typeof setSummary === 'function') setSummary(text);
}

function makeDraggable(panel) {
  const header = panel.querySelector('#rtfc-header');
  let isDragging = false, startX, startY, startLeft, startTop;
  header.addEventListener('mousedown', (e) => {
    if (e.target.id === 'rtfc-close' || e.target.id === 'rtfc-export') return;
    isDragging = true;
    startX = e.clientX; startY = e.clientY;
    const rect = panel.getBoundingClientRect();
    startLeft = rect.left; startTop = rect.top;
    header.style.cursor = 'grabbing';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    panel.style.right = 'unset';
    panel.style.left  = Math.max(0, startLeft + e.clientX - startX) + 'px';
    panel.style.top   = Math.max(0, startTop  + e.clientY - startY) + 'px';
  });
  document.addEventListener('mouseup', () => { isDragging = false; header.style.cursor = 'grab'; });
}

// ── Messages ──────────────────────────────────────────────────────────────────
browser.runtime.onMessage.addListener((msg) => {
  console.log('[overlay] message received:', msg.type);
  switch (msg.type) {

    case 'START_FACTCHECK':
      createPanel();
      setDotState('connecting');
      startSession();
      speakers = parseSpeakersFromTitle(document.title || '');
      speakerColorMap.clear();
      browser.runtime.sendMessage({
        type:  'PAGE_TITLE',
        title: document.title || '',
        date:  (() => {
          const el = document.querySelector('meta[itemprop="uploadDate"]') ||
                     document.querySelector('meta[property="og:updated_time"]');
          return el ? new Date(el.content).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
        })(),
      });
      renderSpeakerEditor();
      if (typeof startAudioCapture === 'function') startAudioCapture();
      break;

    case 'STOP_FACTCHECK':
      stopSession();
      if (typeof stopAudioCapture === 'function') stopAudioCapture();
      removePanel();
      break;

    case 'TRANSCRIPT_RESULT':
      if (msg.isFinal || (msg.text && msg.text.trim() && msg.text.trim() !== '...')) setDotState('live');
      if (msg.interim) {
        updateInterim(msg.text);
      } else if (msg.isFinal) {
        const ts = msg.timecode || getClockTimecode();
        lastTranscriptTimestamp = ts;
        sentenceTimestamps.push({ text: msg.text, timestamp: ts });
        if (sentenceTimestamps.length > MAX_TIMESTAMP_BUFFER) sentenceTimestamps.shift();
        clearInterim();
        // strip [Speaker N] prefix before displaying
        const displayText = msg.text.replace(/^\[.*?\]\s*/, '');
        const translation = msg.translation || '';
        addTranscriptLine(ts, displayText, translation);
        if (typeof logTranscript === 'function') logTranscript(ts, displayText, translation);
        // track which speaker is active from label
        const labelMatch = msg.text.match(/^\[(.+?)\]/);
        if (labelMatch && speakers.includes(labelMatch[1])) {
          lastActiveSpeaker = labelMatch[1];
        }
      }
      break;

    case 'NEW_SPEAKER':
      if (panel) showSpeakerBanner(msg.speakerId, msg.sample || '');
      break;

    case 'PIPELINE_ERROR':
      showError(msg.message || 'Se produjo un error en el procesamiento.');
      setDotState('error');
      break;

    case 'PIPELINE_INFO':
      showError(msg.message || '', 'info');
      break;

    case 'NEW_KEYPOINTS':
      if (msg.results) {
        for (const kp of msg.results) addKeyPoint(kp);
      }
      break;

    case 'KEYPOINT_VERDICT':
      applyKeyPointVerdict(msg.id, msg.result);
      break;

    case 'SUMMARY_RESULT':
      renderSummary(msg.text || '');
      break;

    case 'NEW_VERDICT':
      if (msg.results) {
        for (const result of msg.results) {
          addClaimBullet(result.claim);
          addVerdict(result);
        }
      }
      break;

    case 'UPDATE_VERDICTS':
      if (msg.results) {
        for (const result of msg.results) {
          updateVerdict(result);
        }
      }
      break;
  }
});