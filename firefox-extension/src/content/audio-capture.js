// audio-capture.js — Gladia (primary) + Whisper local (fallback)
// Firefox: uses getDisplayMedia for tab audio capture in both modes
// Gladia: real-time via WebSocket, best quality + diarization
// Whisper: local model via transformers.js, no API key needed, ~75MB download once

let mediaStream = null;
let audioContext = null;
let socket = null;
let captureActive = false;
let utteranceBuffer = '';
let gladiaKey = '';
let gladiaProxyUrl = ''; // set when Gladia should be started via the proxy (key server-side)
let proxyToken = '';     // shared secret sent to the proxy
let sourceLanguage = 'auto'; // 'auto' | ISO code (es, en, fr, ar, he, fa, ...)
let transcriptionMode = 'none'; // 'gladia' | 'whisper'

// Multilingual Whisper model (replaces English-only whisper-tiny.en).
const WHISPER_MODEL = 'onnx-community/whisper-base';

// For 'auto' detection, restrict Gladia to these languages (matches the popup list)
// so it can't mis-detect into something irrelevant (e.g. Welsh in an English speech).
const AUTO_LANGUAGES = ['es', 'en', 'fr', 'de', 'it', 'pt', 'ru', 'uk', 'tr', 'ar', 'he', 'fa', 'zh', 'ja'];

// Whisper state
let whisperPipeline = null;
let whisperChunks = [];
let whisperProcessor = null;
let whisperInterval = null;
let whisperLoading = false;
const WHISPER_CHUNK_SECONDS = 5;
const WHISPER_SAMPLE_RATE = 16000;

// Capture audio straight from the page's own media element (Firefox uses the
// prefixed mozCaptureStream). This gives the exact tab audio with no mic, no screen
// share and no OS loopback. Returns null if there's no usable element (e.g. the
// player lives in a cross-origin iframe, or the media is tainted).
function getPageMediaStream() {
  const els = [...document.querySelectorAll('video, audio')];
  const el = els.find(e => !e.paused && !e.muted && e.readyState >= 2)
          || els.find(e => e.readyState >= 2)
          || els[0];
  if (!el) return null;
  const capture = el.captureStream || el.mozCaptureStream;
  if (!capture) return null;
  try {
    const stream = capture.call(el);
    return (stream && stream.getAudioTracks().length) ? stream : null;
  } catch (err) {
    console.warn('[audio-capture] captureStream failed:', err);
    return null;
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

async function startAudioCapture() {
  if (captureActive) return;

  const data = await browser.storage.local.get(['gladiaKey', 'sourceLanguage', 'proxyUrl', 'connectionMode', 'proxyToken']);
  gladiaKey = data.gladiaKey || '';
  sourceLanguage = data.sourceLanguage || 'auto';
  proxyToken = data.proxyToken || '';

  // In proxy mode without a direct key, start Gladia through the proxy so the
  // Gladia key stays on the server (Railway), never in the browser.
  gladiaProxyUrl = '';
  if (!gladiaKey && data.connectionMode === 'proxy' && data.proxyUrl) {
    try { gladiaProxyUrl = new URL('/gladia/live', data.proxyUrl).href; }
    catch { gladiaProxyUrl = ''; }
  }

  // 1) Best path: capture the page's own <video>/<audio> directly — exact tab audio,
  //    no mic, no OS setup. Works when the player lives in this page (YouTube,
  //    Twitch, news sites). It can't reach players inside cross-origin iframes.
  // 2) Fallback: a system-audio INPUT device (loopback, e.g. "CABLE Output").
  mediaStream = getPageMediaStream();
  const usedPageMedia = !!mediaStream;

  if (!mediaStream) {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      });
    } catch (err) {
      console.error('[audio-capture] getUserMedia error:', err);
      browser.runtime.sendMessage({
        type: 'PIPELINE_ERROR',
        message: err.name === 'NotAllowedError'
          ? 'Permiso de audio denegado. Permite la entrada de audio para esta página.'
          : 'Fallo al capturar audio: ' + err.message,
      });
      return;
    }
  }

  const audioTracks = mediaStream.getAudioTracks();
  if (!audioTracks.length) {
    browser.runtime.sendMessage({
      type: 'PIPELINE_ERROR',
      message: 'No se detectó audio. Asegúrate de que el vídeo se está reproduciendo, o elige un dispositivo de audio del sistema.',
    });
    stopAudioCapture();
    return;
  }

  captureActive = true;

  const src = usedPageMedia ? 'audio del vídeo' : 'dispositivo de audio';
  const eng = gladiaProxyUrl ? 'Gladia (proxy)'
            : gladiaKey ? 'Gladia (clave directa)'
            : 'Whisper local';
  browser.runtime.sendMessage({
    type: 'PIPELINE_INFO',
    message: 'Capturando ' + src + ' · Transcripción: ' + eng,
  });

  if (gladiaKey || gladiaProxyUrl) {
    transcriptionMode = 'gladia';
    utteranceBuffer = '';
    connectGladia();
  } else {
    transcriptionMode = 'whisper';
    startWithWhisper();
  }
}

// ── Gladia (primary) ─────────────────────────────────────────────────────────

async function connectGladia() {
  try {
    // Direct (key in browser) or via proxy (key on server). Proxy forwards to Gladia.
    const initUrl = gladiaKey ? 'https://api.gladia.io/v2/live' : gladiaProxyUrl;
    const initHeaders = gladiaKey
      ? { 'Content-Type': 'application/json', 'x-gladia-key': gladiaKey }
      : { 'Content-Type': 'application/json' };
    if (!gladiaKey && proxyToken) initHeaders['x-proxy-token'] = proxyToken;

    const initRes = await fetch(initUrl, {
      method: 'POST',
      headers: initHeaders,
      body: JSON.stringify({
        encoding: 'wav/pcm',
        sample_rate: 16000,
        channels: 1,
        // 'auto' → empty list lets Gladia auto-detect (code_switching allows mid-stream changes).
        // Specific language → pin it for best accuracy.
        language_config: sourceLanguage === 'auto'
          ? { languages: AUTO_LANGUAGES, code_switching: true }
          : { languages: [sourceLanguage], code_switching: false },
        realtime_processing: {
          words_accurate_timestamps: true,
        },
      }),
    });

    if (!initRes.ok) {
      let detail = '';
      try { const e = await initRes.json(); detail = (e && e.error && e.error.message) || ''; } catch {}
      console.error('[gladia] init failed:', initRes.status, detail);
      const via = gladiaKey ? 'Gladia' : 'Gladia por proxy';
      browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: via + ' falló — estado ' + initRes.status + (detail ? ': ' + detail : '') + '.' });
      stopAudioCapture();
      return;
    }

    const initData = await initRes.json();
    const wsUrl = initData.url;

    if (!wsUrl) {
      browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: 'Gladia no devolvió URL de sesión. Revisa la clave de Gladia en Railway.' });
      stopAudioCapture();
      return;
    }

    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      console.log('[audio-capture] gladia connected');
      startGladiaPipeline();
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === 'transcript') {
          const text = msg.data?.utterance?.text?.trim();
          if (!text) return;

          const isFinal = msg.data?.is_final === true;
          const speaker = msg.data?.utterance?.words?.[0]?.speaker ?? null;

          browser.runtime.sendMessage({
            type: 'TRANSCRIPT_RESULT',
            text,
            isFinal,
            interim: !isFinal,
            speaker,
          });
        }
      } catch (err) {
        console.error('[gladia] message parse error:', err);
      }
    };

    socket.onerror = () => {
      browser.runtime.sendMessage({ type: 'PIPELINE_INFO', message: 'Gladia falló. Cambiando a Whisper local…' });
      fallbackToWhisper();
    };

    socket.onclose = (e) => {
      console.log('[gladia] closed:', e.code, e.reason);
      if (captureActive && transcriptionMode === 'gladia') {
        if (e.code === 1008 || e.code === 4001 || e.code === 4003) {
          browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: 'Gladia: autenticación fallida (código ' + e.code + '). Revisa la clave de Gladia en Railway.' });
          stopAudioCapture();
        } else {
          browser.runtime.sendMessage({ type: 'PIPELINE_INFO', message: 'Gladia desconectado (código ' + e.code + (e.reason ? ': ' + e.reason : '') + ') — reconectando…' });
          setTimeout(() => {
            if (captureActive && transcriptionMode === 'gladia') connectGladia();
          }, 2000);
        }
      }
    };

  } catch (err) {
    console.error('[gladia] connection error:', err);
    browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: 'No se pudo conectar con Gladia/proxy: ' + err.message + ' (¿URL del proxy correcta? ¿la web bloquea la conexión?).' });
    stopAudioCapture();
  }
}

function startGladiaPipeline() {
  if (!mediaStream) return;

  audioContext = new AudioContext({ sampleRate: WHISPER_SAMPLE_RATE });
  const source = audioContext.createMediaStreamSource(mediaStream);

  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (e) => {
    if (socket?.readyState !== WebSocket.OPEN) return;

    const float32 = e.inputBuffer.getChannelData(0);
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      int16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768));
    }

    const base64 = arrayBufferToBase64(int16.buffer);
    // Gladia v2 live expects this exact shape for streamed audio.
    socket.send(JSON.stringify({ type: 'audio_chunk', data: { chunk: base64 } }));
  };

  source.connect(processor);
  processor.connect(audioContext.destination);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ── Whisper local (fallback) ─────────────────────────────────────────────────

function fallbackToWhisper() {
  if (socket) { socket.close(); socket = null; }
  if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
  // Keep mediaStream — we reuse it for Whisper
  transcriptionMode = 'whisper';
  startWithWhisper();
}

async function startWithWhisper() {
  browser.runtime.sendMessage({
    type: 'PIPELINE_INFO',
    message: 'Cargando modelo Whisper local (~150MB, solo la 1ª vez)…',
  });

  try {
    await loadWhisperModel();
  } catch (err) {
    console.error('[whisper] model load error:', err);
    browser.runtime.sendMessage({
      type: 'PIPELINE_ERROR',
      message: 'No se pudo cargar el modelo Whisper: ' + err.message,
    });
    return;
  }

  browser.runtime.sendMessage({
    type: 'PIPELINE_INFO',
    message: 'Whisper cargado — transcribiendo en local (sin detección de orador).',
  });

  startWhisperPipeline();
}

async function loadWhisperModel() {
  if (whisperPipeline) return;
  if (whisperLoading) return;
  whisperLoading = true;

  try {
    // Content scripts can't use dynamic import() from CDN directly.
    // Inject transformers.js into the page context and bridge back via CustomEvent.
    const loaded = await new Promise((resolve, reject) => {
      const handler = (e) => {
        window.removeEventListener('__intruth_whisper_ready', handler);
        if (e.detail?.error) reject(new Error(e.detail.error));
        else resolve(true);
      };
      window.addEventListener('__intruth_whisper_ready', handler);

      const script = document.createElement('script');
      script.textContent = `
        (async () => {
          try {
            const { pipeline } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.1/dist/transformers.min.js');
            window.__intruth_pipeline = await pipeline(
              'automatic-speech-recognition',
              '${WHISPER_MODEL}',
              { dtype: 'q8', device: 'wasm' }
            );
            window.dispatchEvent(new CustomEvent('__intruth_whisper_ready', { detail: { ok: true } }));
          } catch (err) {
            window.dispatchEvent(new CustomEvent('__intruth_whisper_ready', { detail: { error: err.message } }));
          }
        })();
      `;
      document.documentElement.appendChild(script);
      script.remove();

      setTimeout(() => reject(new Error('Whisper model load timed out (60s)')), 60000);
    });

    // Bridge: content script calls page-context pipeline via CustomEvent
    whisperPipeline = {
      transcribe: (audioData, opts) => {
        return new Promise((resolve, reject) => {
          const handler = (e) => {
            window.removeEventListener('__intruth_whisper_result', handler);
            if (e.detail?.error) reject(new Error(e.detail.error));
            else resolve(e.detail.result);
          };
          window.addEventListener('__intruth_whisper_result', handler);

          // Pass audio as array (CustomEvent can carry structured clone data)
          window.dispatchEvent(new CustomEvent('__intruth_whisper_transcribe', {
            detail: { audio: Array.from(audioData), opts }
          }));

          setTimeout(() => reject(new Error('Whisper transcription timed out')), 30000);
        });
      }
    };

    // Inject the transcription listener into page context
    const listenerScript = document.createElement('script');
    listenerScript.textContent = `
      window.addEventListener('__intruth_whisper_transcribe', async (e) => {
        try {
          const audio = new Float32Array(e.detail.audio);
          const result = await window.__intruth_pipeline(audio, e.detail.opts || {});
          window.dispatchEvent(new CustomEvent('__intruth_whisper_result', { detail: { result } }));
        } catch (err) {
          window.dispatchEvent(new CustomEvent('__intruth_whisper_result', { detail: { error: err.message } }));
        }
      });
    `;
    document.documentElement.appendChild(listenerScript);
    listenerScript.remove();

    console.log('[whisper] model loaded via page context bridge');
  } finally {
    whisperLoading = false;
  }
}

function startWhisperPipeline() {
  if (!mediaStream) return;

  audioContext = new AudioContext({ sampleRate: WHISPER_SAMPLE_RATE });
  const source = audioContext.createMediaStreamSource(mediaStream);

  whisperChunks = [];
  whisperProcessor = audioContext.createScriptProcessor(4096, 1, 1);

  whisperProcessor.onaudioprocess = (e) => {
    if (!captureActive || transcriptionMode !== 'whisper') return;
    const samples = new Float32Array(e.inputBuffer.getChannelData(0));
    whisperChunks.push(samples);
  };

  source.connect(whisperProcessor);
  whisperProcessor.connect(audioContext.destination);

  // Process accumulated audio every WHISPER_CHUNK_SECONDS
  whisperInterval = setInterval(() => {
    if (!captureActive || transcriptionMode !== 'whisper') return;
    processWhisperChunks();
  }, WHISPER_CHUNK_SECONDS * 1000);

  console.log('[whisper] audio pipeline started, chunking every', WHISPER_CHUNK_SECONDS, 's');
}

let whisperProcessing = false;

async function processWhisperChunks() {
  if (!whisperPipeline || whisperProcessing) return;
  if (!whisperChunks.length) return;

  // Grab current chunks and reset buffer
  const chunks = whisperChunks;
  whisperChunks = [];

  // Merge into single Float32Array
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  if (totalLength < WHISPER_SAMPLE_RATE * 0.5) return; // skip if less than 0.5s

  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  // Check if audio has actual content (not silence)
  let maxAmp = 0;
  for (let i = 0; i < merged.length; i += 100) {
    const abs = Math.abs(merged[i]);
    if (abs > maxAmp) maxAmp = abs;
  }
  if (maxAmp < 0.01) return; // skip silence

  whisperProcessing = true;

  try {
    // Send interim to show we're processing
    browser.runtime.sendMessage({
      type: 'TRANSCRIPT_RESULT',
      text: '...',
      isFinal: false,
      interim: true,
      speaker: null,
    });

    // 'auto' → omit language so multilingual Whisper detects it per chunk.
    const whisperOpts = {
      task: 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 5,
    };
    if (sourceLanguage !== 'auto') whisperOpts.language = sourceLanguage;

    const result = await whisperPipeline.transcribe(merged, whisperOpts);

    const text = (result?.text || '').trim();
    if (text && text !== '...' && text.length > 1) {
      browser.runtime.sendMessage({
        type: 'TRANSCRIPT_RESULT',
        text,
        isFinal: true,
        interim: false,
        speaker: null,
      });
    }
  } catch (err) {
    console.error('[whisper] transcription error:', err);
  } finally {
    whisperProcessing = false;
  }
}

// ── Stop ──────────────────────────────────────────────────────────────────────

function stopAudioCapture() {
  captureActive = false;
  utteranceBuffer = '';
  transcriptionMode = 'none';

  if (whisperInterval) {
    clearInterval(whisperInterval);
    whisperInterval = null;
  }
  whisperChunks = [];

  if (socket) {
    socket.close();
    socket = null;
  }

  if (whisperProcessor) {
    whisperProcessor.disconnect();
    whisperProcessor = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
}
