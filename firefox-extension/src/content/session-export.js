// session-export.js
// Handles session logging and PDF export.
// Loaded after overlay.js — exposes logVerdict(), startSession(), stopSession(), exportPDF() as globals.
// Reuses escapeHtml() defined in overlay.js (loaded first in manifest.json).

const sessionLog = [];
const transcriptLog = [];
const keyPointsLog = [];
let sessionStartTime = null;

function logVerdict(result) {
  sessionLog.push({
    timestamp: new Date().toISOString(),
    secondsElapsed: sessionStartTime ? Math.round((Date.now() - sessionStartTime) / 1000) : 0,
    clockTimestamp: result._timestamp || '',
    claim: result.claim,
    verdict: result.verdict,
    confidence: result.confidence,
    explanation: result.explanation,
    speakerConfidence: result.speaker_confidence,
    speakerExplanation: result.speaker_confidence_explanation,
    speakerName: result.speaker || null,
    sources: result.sources ?? [],
  });
}

// Full session transcript, each line tagged with its clock timecode HH:MM:SS:FF.
function logTranscript(timecode, text, translation) {
  transcriptLog.push({ timecode, text, translation: translation || '' });
}

// Neutral key points extracted live (no verdict).
function logKeyPoint(kp) {
  keyPointsLog.push({
    timecode: kp._timestamp || '',
    category: kp.category || 'OTRO',
    point: kp.point,
    quote: kp.quote || '',
    speaker: kp.speaker || null,
  });
}

function startSession() {
  sessionLog.length = 0;
  transcriptLog.length = 0;
  keyPointsLog.length = 0;
  sessionStartTime = Date.now();
}

function stopSession() {
  sessionStartTime = null;
}

function exportPDF() {
  if (!sessionLog.length && !transcriptLog.length && !keyPointsLog.length) {
    alert('No hay nada que exportar todavía.');
    return;
  }

  const pageTitle = document.title || 'Fact Check Session';
  const exportDate = new Date().toLocaleString();

  const verdictColor = (v, c) => {
    if (c === 'LOW') return '#b45309';
    if (v === 'TRUE') return '#15803d';
    if (v === 'SUBSTANTIALLY TRUE') return '#0d9488';
    if (v === 'FALSE') return '#b91c1c';
    if (v === 'MISLEADING') return '#b45309';
    return '#6b7280';
  };

  // group by speaker
  const speakerGroups = {};
  const speakerOrder  = [];
  sessionLog.forEach((entry, i) => {
    // filter out unresolved Speaker N labels — group under Unknown
    const rawSpk = entry.speakerName;
    const spk = (rawSpk && !rawSpk.match(/^Speaker\s*\d+$/i) && rawSpk !== 'Other')
      ? rawSpk
      : 'Unknown';
    if (!speakerGroups[spk]) { speakerGroups[spk] = []; speakerOrder.push(spk); }
    speakerGroups[spk].push({ entry, i });
  });

  const speakerColors = ['#3b82f6', '#ef4444', '#f59e0b', '#10b981', '#8b5cf6', '#f97316'];

  const claimsHTML = speakerOrder.map((spk, spkIdx) => {
    const color = spk !== 'Other' ? speakerColors[spkIdx % speakerColors.length] : '#888';
    const headerHTML = '<div class="speaker-section-header" style="border-left:3px solid ' + color + '">' +
      '<span class="speaker-section-name" style="color:' + color + '">' + escapeHtml(spk) + '</span>' +
      '<span class="speaker-section-count">' + speakerGroups[spk].length + ' claim' + (speakerGroups[spk].length !== 1 ? 's' : '') + '</span>' +
    '</div>';

    const cardsHTML = speakerGroups[spk].map(({ entry, i }) => {
      const minutes = Math.floor(entry.secondsElapsed / 60);
      const seconds = entry.secondsElapsed % 60;
      const timestamp = entry.clockTimestamp ||
        (String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0'));
      const vcolor = verdictColor(entry.verdict, entry.confidence);

      const sourcesHTML = entry.sources.length
        ? '<div class="sources"><span class="sources-label">Sources:</span>' +
          entry.sources.map((url, j) =>
            '<a href="' + escapeHtml(url) + '" class="source-link">Source ' + (j + 1) + '</a>'
          ).join('') + '</div>'
        : '';

      return '<div class="claim-card">' +
        '<div class="claim-header">' +
          '<span class="claim-number">#' + (i + 1) + '</span>' +
          '<span class="verdict" style="color:' + vcolor + '">' + escapeHtml(entry.verdict) + '</span>' +
          '<span class="confidence">' + escapeHtml(entry.confidence) + ' certainty</span>' +
          '<span class="timestamp">' + escapeHtml(timestamp) + '</span>' +
        '</div>' +
        '<div class="claim-text">"' + escapeHtml(entry.claim) + '"</div>' +
        '<div class="explanation">' + escapeHtml(entry.explanation) + '</div>' +
        '<div class="speaker-row"><span class="speaker-label">Speaker conviction:</span> ' +
          escapeHtml(entry.speakerConfidence || 'N/A') +
        '</div>' +
        sourcesHTML +
      '</div>';
    }).join('');

    return headerHTML + cardsHTML;
  }).join('');

  const CAT_LABELS = {
    ANUNCIO: 'Anuncio', CIFRA: 'Cifra', COMPROMISO: 'Compromiso',
    DECLARACION: 'Declaración', CITA: 'Cita', POLITICA: 'Política', OTRO: 'Otro',
  };
  const keyPointsHTML = keyPointsLog.length
    ? '<div class="claims-title">Puntos clave (' + keyPointsLog.length + ')</div>' +
      keyPointsLog.map(kp => {
        const cat = (kp.category || 'OTRO').toUpperCase();
        const label = CAT_LABELS[cat] || (cat.charAt(0) + cat.slice(1).toLowerCase());
        const spk = kp.speaker ? '<span class="kp-speaker">' + escapeHtml(kp.speaker) + '</span>' : '';
        const quote = kp.quote ? '<div class="kp-quote">“' + escapeHtml(kp.quote) + '”</div>' : '';
        return '<div class="kp-card">' +
          '<div class="kp-header">' +
            '<span class="kp-cat">' + escapeHtml(label) + '</span>' +
            spk +
            '<span class="timestamp">' + escapeHtml(kp.timecode || '') + '</span>' +
          '</div>' +
          '<div class="kp-point">' + escapeHtml(kp.point) + '</div>' +
          quote +
        '</div>';
      }).join('')
    : '';

  const transcriptHTML = transcriptLog.length
    ? '<div class="claims-title">Transcripción (' + transcriptLog.length + ')</div>' +
      '<div class="transcript">' +
        transcriptLog.map(t => {
          const tr = (t.translation && t.translation.trim() && t.translation.trim() !== (t.text || '').trim())
            ? '<div class="transcript-tr">↳ ' + escapeHtml(t.translation) + '</div>'
            : '';
          return '<div class="transcript-line">' +
            '<span class="transcript-tc">[' + escapeHtml(t.timecode) + ']</span> ' +
            escapeHtml(t.text) + tr +
          '</div>';
        }).join('') +
      '</div>'
    : '';

  const trueCount = sessionLog.filter(e => e.verdict === 'TRUE').length;
  const subTrueCount = sessionLog.filter(e => e.verdict === 'SUBSTANTIALLY TRUE').length;
  const falseCount = sessionLog.filter(e => e.verdict === 'FALSE').length;
  const misleadingCount = sessionLog.filter(e => e.verdict === 'MISLEADING').length;
  const unverifiableCount = sessionLog.filter(e => e.verdict === 'UNVERIFIABLE').length;

  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"/>' +
    '<title>Fact Check Report</title><style>' +
    '* { box-sizing: border-box; margin: 0; padding: 0; }' +
    'body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; color: #111; padding: 40px; max-width: 800px; margin: 0 auto; line-height: 1.5; }' +
    '.report-header { border-bottom: 2px solid #111; padding-bottom: 16px; margin-bottom: 24px; }' +
    '.report-title { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 4px; }' +
    '.report-meta { font-size: 11px; color: #666; }' +
    '.report-meta span { margin-right: 16px; }' +
    '.summary { display: flex; gap: 16px; margin-bottom: 28px; padding: 16px; background: #f8f8f8; border-radius: 8px; }' +
    '.summary-item { display: flex; flex-direction: column; align-items: center; flex: 1; }' +
    '.summary-count { font-size: 24px; font-weight: 700; }' +
    '.summary-count.true { color: #15803d; } .summary-count.subtrue { color: #0d9488; } .summary-count.false { color: #b91c1c; } .summary-count.misleading { color: #b45309; } .summary-count.unverifiable { color: #6b7280; }' +
    '.summary-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #888; margin-top: 2px; }' +
    '.claims-title { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #888; margin-bottom: 12px; }' +
    '.claim-card { border: 1px solid #e5e5e5; border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; page-break-inside: avoid; }' +
    '.claim-header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }' +
    '.claim-number { font-size: 10px; color: #aaa; font-weight: 600; }' +
    '.verdict { font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; }' +
    '.confidence { font-size: 10px; color: #888; }' +
    '.timestamp { font-size: 10px; color: #aaa; margin-left: auto; }' +
    '.claim-text { font-size: 13px; font-style: italic; color: #333; margin-bottom: 6px; }' +
    '.explanation { font-size: 12px; color: #555; margin-bottom: 6px; }' +
    '.speaker-row { font-size: 11px; color: #888; margin-bottom: 4px; }' +
    '.speaker-label { font-weight: 600; }' +
    '.sources { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 6px; }' +
    '.sources-label { font-size: 10px; color: #aaa; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }' +
    '.source-link { font-size: 10px; color: #1d4ed8; text-decoration: none; }' +
    '.speaker-section-header { display: flex; align-items: center; gap: 10px; padding: 8px 12px; margin: 20px 0 8px; background: #f8f8f8; border-radius: 6px; }' +
    '.speaker-section-name { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }' +
    '.speaker-section-count { font-size: 11px; color: #888; margin-left: auto; }' +
    '.kp-card { border: 1px solid #e5e5e5; border-radius: 8px; padding: 12px 16px; margin-bottom: 10px; page-break-inside: avoid; }' +
    '.kp-header { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }' +
    '.kp-cat { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #1d4ed8; }' +
    '.kp-speaker { font-size: 11px; font-weight: 600; color: #444; }' +
    '.kp-point { font-size: 13px; color: #222; margin-bottom: 4px; }' +
    '.kp-quote { font-size: 12px; font-style: italic; color: #666; }' +
    '.transcript { border: 1px solid #e5e5e5; border-radius: 8px; padding: 12px 16px; margin-top: 8px; }' +
    '.transcript-line { font-size: 12px; color: #333; line-height: 1.6; margin-bottom: 2px; }' +
    '.transcript-tc { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; font-weight: 600; color: #b45309; }' +
    '.transcript-tr { margin-left: 16px; color: #1d4ed8; font-size: 12px; line-height: 1.5; }' +
    '@media print { body { padding: 20px; } .claim-card { page-break-inside: avoid; } }' +
    '</style></head><body>' +
    '<div class="report-header">' +
      '<div class="report-title">Fact Check Report</div>' +
      '<div class="report-meta">' +
        '<span>📺 ' + escapeHtml(pageTitle) + '</span>' +
        '<span>🕐 ' + escapeHtml(exportDate) + '</span>' +
        '<span>📋 ' + sessionLog.length + ' claim' + (sessionLog.length !== 1 ? 's' : '') + ' detected</span>' +
      '</div>' +
    '</div>' +
    keyPointsHTML +
    (sessionLog.length
      ? '<div class="summary">' +
          '<div class="summary-item"><span class="summary-count true">' + trueCount + '</span><span class="summary-label">True</span></div>' +
          '<div class="summary-item"><span class="summary-count subtrue">' + subTrueCount + '</span><span class="summary-label">Substantially True</span></div>' +
          '<div class="summary-item"><span class="summary-count false">' + falseCount + '</span><span class="summary-label">False</span></div>' +
          '<div class="summary-item"><span class="summary-count misleading">' + misleadingCount + '</span><span class="summary-label">Misleading</span></div>' +
          '<div class="summary-item"><span class="summary-count unverifiable">' + unverifiableCount + '</span><span class="summary-label">Unverifiable</span></div>' +
        '</div>' +
        '<div class="claims-title">Verificados (' + sessionLog.length + ')</div>' +
        claimsHTML
      : '') +
    transcriptHTML +
    '</body></html>';

  // window.open is blocked in extensions — use blob URL instead
  const blob = new Blob([html], { type: 'text/html' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'factcheck-report.html';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}