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
let transcriptionMode = 'none'; // 'gladia' | 'whisper'

// Whisper state
let whisperPipeline = null;
let whisperChunks = [];
let whisperProcessor = null;
let whisperInterval = null;
let whisperLoading = false;
const WHISPER_CHUNK_SECONDS = 5;
const WHISPER_SAMPLE_RATE = 16000;

// ── Start ─────────────────────────────────────────────────────────────────────

async function startAudioCapture() {
  if (captureActive) return;

  const data = await browser.storage.local.get(['gladiaKey']);
  gladiaKey = data.gladiaKey || '';

  // Always need tab audio — request getDisplayMedia first
  try {
    mediaStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });

    const audioTracks = mediaStream.getAudioTracks();
    if (!audioTracks.length) {
      browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: 'No audio — enable "Share audio" when sharing the tab.' });
      stopAudioCapture();
      return;
    }

    mediaStream.getVideoTracks().forEach(t => t.stop());
    captureActive = true;

    if (gladiaKey) {
      transcriptionMode = 'gladia';
      utteranceBuffer = '';
      connectGladia();
    } else {
      transcriptionMode = 'whisper';
      startWithWhisper();
    }

  } catch (err) {
    console.error('[audio-capture] getDisplayMedia error:', err);
    if (err.name === 'NotAllowedError') {
      browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: 'Tab sharing denied. Cannot capture audio without sharing a tab.' });
    } else {
      browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: 'Audio capture failed: ' + err.message });
    }
  }
}

// ── Gladia (primary) ─────────────────────────────────────────────────────────

async function connectGladia() {
  try {
    const initRes = await fetch('https://api.gladia.io/v2/live', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-gladia-key': gladiaKey,
      },
      body: JSON.stringify({
        encoding: 'wav/pcm',
        sample_rate: 16000,
        channels: 1,
        language_config: {
          languages: ['en'],
          code_switching: false,
        },
        realtime_processing: {
          words_accurate_timestamps: true,
        },
      }),
    });

    if (!initRes.ok) {
      console.error('[gladia] init failed:', initRes.status);
      browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: 'Gladia init failed (' + initRes.status + '). Switching to local Whisper...' });
      fallbackToWhisper();
      return;
    }

    const initData = await initRes.json();
    const wsUrl = initData.url;

    if (!wsUrl) {
      browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: 'Gladia error. Switching to local Whisper...' });
      fallbackToWhisper();
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
      browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: 'Gladia error. Switching to local Whisper...' });
      fallbackToWhisper();
    };

    socket.onclose = (e) => {
      console.log('[gladia] closed:', e.code, e.reason);
      if (captureActive && transcriptionMode === 'gladia') {
        if (e.code === 1008 || e.code === 4001 || e.code === 4003) {
          browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: 'Gladia auth failed. Switching to local Whisper...' });
          fallbackToWhisper();
        } else {
          browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: 'Gladia disconnected — reconnecting...' });
          setTimeout(() => {
            if (captureActive && transcriptionMode === 'gladia') connectGladia();
          }, 2000);
        }
      }
    };

  } catch (err) {
    console.error('[gladia] connection error:', err);
    browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: 'Gladia failed: ' + err.message + '. Switching to local Whisper...' });
    fallbackToWhisper();
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
    socket.send(JSON.stringify({ frames: base64 }));
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
    type: 'PIPELINE_ERROR',
    message: 'Loading local Whisper model (~75MB, first time only)...',
  });

  try {
    await loadWhisperModel();
  } catch (err) {
    console.error('[whisper] model load error:', err);
    browser.runtime.sendMessage({
      type: 'PIPELINE_ERROR',
      message: 'Failed to load Whisper model: ' + err.message,
    });
    return;
  }

  browser.runtime.sendMessage({
    type: 'PIPELINE_ERROR',
    message: 'Whisper loaded — transcribing tab audio locally (no speaker detection).',
  });

  startWhisperPipeline();
}

async function loadWhisperModel() {
  if (whisperPipeline) return;
  if (whisperLoading) return;
  whisperLoading = true;

  try {
    // Dynamic import from CDN
    const { pipeline } = await import(
      /* webpackIgnore: true */
      'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.1/dist/transformers.min.js'
    );

    whisperPipeline = await pipeline(
      'automatic-speech-recognition',
      'onnx-community/whisper-tiny.en',
      {
        dtype: 'q8',
        device: 'wasm',
      }
    );

    console.log('[whisper] model loaded');
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

    const result = await whisperPipeline(merged, {
      language: 'en',
      task: 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 5,
    });

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
