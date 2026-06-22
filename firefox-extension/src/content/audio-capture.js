// audio-capture.js — Firefox audio capture via getDisplayMedia
// Firefox doesn't have tabCapture, so we use getDisplayMedia with audio
// The user will see a prompt to share a tab with audio enabled

const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen?' + [
  'encoding=linear16',
  'sample_rate=16000',
  'channels=1',
  'model=nova-2',
  'language=en-US',
  'punctuate=true',
  'interim_results=true',
  'utterance_end_ms=2500',
  'smart_format=true',
  'vad_events=true',
  'diarize=true',
].join('&');

let mediaStream = null;
let audioContext = null;
let workletNode = null;
let socket = null;
let captureActive = false;
let utteranceBuffer = '';
let deepgramKey = '';

async function startAudioCapture() {
  if (captureActive) return;

  const data = await browser.storage.local.get(['deepgramKey']);
  deepgramKey = data.deepgramKey || '';

  if (!deepgramKey) {
    browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: 'Deepgram API key not set. Enter it in the extension popup.' });
    return;
  }

  try {
    mediaStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });

    const audioTracks = mediaStream.getAudioTracks();
    if (!audioTracks.length) {
      browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: 'No audio track — make sure to enable "Share audio" when sharing the tab.' });
      stopAudioCapture();
      return;
    }

    // Stop video track — we only need audio
    mediaStream.getVideoTracks().forEach(t => t.stop());

    captureActive = true;
    utteranceBuffer = '';
    connectDeepgram();

  } catch (err) {
    console.error('[audio-capture] getDisplayMedia error:', err);
    if (err.name === 'NotAllowedError') {
      browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: 'Audio sharing was denied. Please try again and share a tab with audio enabled.' });
    } else {
      browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: 'Failed to capture audio: ' + err.message });
    }
  }
}

function connectDeepgram() {
  socket = new WebSocket(DEEPGRAM_WS_URL, ['token', deepgramKey]);

  socket.onopen = () => {
    console.log('[audio-capture] deepgram connected');
    startAudioPipeline();
  };

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'UtteranceEnd') return;

      const result = data.channel?.alternatives?.[0];
      if (!result || !result.transcript) return;

      const text = result.transcript.trim();
      const isFinal = data.is_final;
      const speech = data.speech_final;
      const speaker = result.words?.[0]?.speaker ?? null;

      if (!text) return;

      if (isFinal && speech) {
        const fullText = utteranceBuffer ? utteranceBuffer + ' ' + text : text;
        utteranceBuffer = '';
        browser.runtime.sendMessage({
          type: 'TRANSCRIPT_RESULT',
          text: fullText.trim(),
          isFinal: true,
          interim: false,
          speaker,
        });
      } else if (isFinal && !speech) {
        utteranceBuffer += (utteranceBuffer ? ' ' : '') + text;
        browser.runtime.sendMessage({
          type: 'TRANSCRIPT_RESULT',
          text: utteranceBuffer,
          isFinal: false,
          interim: true,
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
    } catch (err) {
      console.error('[audio-capture] message parse error:', err);
    }
  };

  socket.onerror = (err) => {
    console.error('[audio-capture] deepgram error:', err);
    browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: 'Transcription error — check your Deepgram key.' });
  };

  socket.onclose = (e) => {
    console.log('[audio-capture] deepgram closed:', e.code, e.reason);
    if (e.code === 1008 || e.code === 1011) {
      browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: 'Deepgram connection failed (code ' + e.code + '). Check your API key.' });
      return;
    }
    if (captureActive) {
      browser.runtime.sendMessage({ type: 'PIPELINE_ERROR', message: 'Transcription disconnected — reconnecting...' });
      setTimeout(() => {
        if (captureActive) connectDeepgram();
      }, 2000);
    }
  };
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
    socket.send(int16.buffer);
  };

  source.connect(processor);
  processor.connect(audioContext.destination);
}

function stopAudioCapture() {
  captureActive = false;
  utteranceBuffer = '';

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
