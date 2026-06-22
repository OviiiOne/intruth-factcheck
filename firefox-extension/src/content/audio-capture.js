// audio-capture.js — Gladia (primary) + Web Speech API (fallback)
// Firefox: uses getDisplayMedia for audio capture (user shares tab with audio)
// If no Gladia key → falls back to Web Speech API (free, no key needed)

let mediaStream = null;
let audioContext = null;
let socket = null;
let captureActive = false;
let utteranceBuffer = '';
let gladiaKey = '';
let transcriptionMode = 'none'; // 'gladia' | 'webspeech'
let speechRecognition = null;

// ── Start ─────────────────────────────────────────────────────────────────────

async function startAudioCapture() {
  if (captureActive) return;

  const data = await browser.storage.local.get(['gladiaKey']);
  gladiaKey = data.gladiaKey || '';

  if (gladiaKey) {
    await startWithGladia();
  } else {
    startWithWebSpeech();
  }
}

// ── Gladia (primary) ─────────────────────────────────────────────────────────

async function startWithGladia() {
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
    transcriptionMode = 'gladia';
    utteranceBuffer = '';
    connectGladia();

  } catch (err) {
    console.error('[audio-capture] getDisplayMedia error:', err);
    if (err.name === 'NotAllowedError') {
      browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: 'Audio sharing denied. Falling back to Web Speech API (microphone)...' });
    } else {
      browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: 'Audio capture failed. Falling back to Web Speech API...' });
    }
    startWithWebSpeech();
  }
}

async function connectGladia() {
  try {
    // Step 1: Create a live session via POST
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
      const errText = await initRes.text();
      console.error('[gladia] init failed:', initRes.status, errText);
      browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: 'Gladia init failed (' + initRes.status + '). Falling back to Web Speech API...' });
      fallbackToWebSpeech();
      return;
    }

    const initData = await initRes.json();
    const wsUrl = initData.url;

    if (!wsUrl) {
      browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: 'Gladia did not return WebSocket URL. Falling back...' });
      fallbackToWebSpeech();
      return;
    }

    // Step 2: Connect WebSocket
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      console.log('[audio-capture] gladia connected');
      startAudioPipeline();
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === 'transcript') {
          const text = msg.data?.utterance?.text?.trim();
          if (!text) return;

          const isFinal = msg.data?.is_final === true;
          const speaker = msg.data?.utterance?.words?.[0]?.speaker ?? null;

          if (isFinal) {
            browser.runtime.sendMessage({
              type: 'TRANSCRIPT_RESULT',
              text,
              isFinal: true,
              interim: false,
              speaker,
            });
          } else {
            browser.runtime.sendMessage({
              type: 'TRANSCRIPT_RESULT',
              text,
              isFinal: false,
              interim: true,
              speaker,
            });
          }
        }
      } catch (err) {
        console.error('[gladia] message parse error:', err);
      }
    };

    socket.onerror = (err) => {
      console.error('[gladia] WebSocket error:', err);
      browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: 'Gladia connection error. Falling back to Web Speech API...' });
      fallbackToWebSpeech();
    };

    socket.onclose = (e) => {
      console.log('[gladia] closed:', e.code, e.reason);
      if (captureActive && transcriptionMode === 'gladia') {
        if (e.code === 1008 || e.code === 4001 || e.code === 4003) {
          browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: 'Gladia auth failed. Check your API key. Falling back...' });
          fallbackToWebSpeech();
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
    browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: 'Gladia connection failed: ' + err.message + '. Falling back...' });
    fallbackToWebSpeech();
  }
}

function startAudioPipeline() {
  if (!mediaStream) return;

  audioContext = new AudioContext({ sampleRate: 16000 });
  const source = audioContext.createMediaStreamSource(mediaStream);

  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (e) => {
    if (socket?.readyState !== WebSocket.OPEN) return;

    const float32 = e.inputBuffer.getChannelData(0);
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      int16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768));
    }

    // Gladia expects base64-encoded audio in JSON frames
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

// ── Web Speech API (fallback) ────────────────────────────────────────────────

function fallbackToWebSpeech() {
  // Clean up Gladia resources
  if (socket) { socket.close(); socket = null; }
  if (audioContext) { audioContext.close().catch(() => {}); audioContext = null; }
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }

  startWithWebSpeech();
}

function startWithWebSpeech() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: 'Web Speech API not supported in this browser.' });
    return;
  }

  captureActive = true;
  transcriptionMode = 'webspeech';

  speechRecognition = new SpeechRecognition();
  speechRecognition.continuous = true;
  speechRecognition.interimResults = true;
  speechRecognition.lang = 'en-US';

  speechRecognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const text = result[0].transcript.trim();
      if (!text) continue;

      if (result.isFinal) {
        browser.runtime.sendMessage({
          type: 'TRANSCRIPT_RESULT',
          text,
          isFinal: true,
          interim: false,
          speaker: null, // Web Speech API has no diarization
        });
      } else {
        browser.runtime.sendMessage({
          type: 'TRANSCRIPT_RESULT',
          text,
          isFinal: false,
          interim: true,
          speaker: null,
        });
      }
    }
  };

  speechRecognition.onerror = (event) => {
    console.error('[webspeech] error:', event.error);
    if (event.error === 'not-allowed') {
      browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: 'Microphone access denied.' });
    } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
      browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: 'Speech recognition error: ' + event.error });
    }
  };

  speechRecognition.onend = () => {
    // Auto-restart if still active (Web Speech API stops after pauses)
    if (captureActive && transcriptionMode === 'webspeech') {
      try { speechRecognition.start(); } catch (e) {}
    }
  };

  try {
    speechRecognition.start();
    console.log('[audio-capture] Web Speech API started (fallback mode)');
    browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: 'Using microphone (Web Speech API) — no speaker detection available.' });
  } catch (err) {
    browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: 'Failed to start speech recognition: ' + err.message });
  }
}

// ── Stop ──────────────────────────────────────────────────────────────────────

function stopAudioCapture() {
  captureActive = false;
  utteranceBuffer = '';
  transcriptionMode = 'none';

  if (speechRecognition) {
    try { speechRecognition.stop(); } catch (e) {}
    speechRecognition = null;
  }

  if (socket) {
    socket.close();
    socket = null;
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
