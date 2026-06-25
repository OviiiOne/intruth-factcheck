const toggleBtn = document.getElementById('toggleBtn');
const statusEl = document.getElementById('status');
const anthropicEl = document.getElementById('anthropicKey');
const proxyUrlEl = document.getElementById('proxyUrl');
const proxyTokenEl = document.getElementById('proxyToken');
const gladiaEl = document.getElementById('gladiaKey');
const sourceLanguageEl = document.getElementById('sourceLanguage');
const participantsEl = document.getElementById('participants');
const keyHint = document.getElementById('keyHint');
const keysSection = document.getElementById('keysSection');
const modeApiKeyBtn = document.getElementById('modeApiKey');
const modeProxyBtn = document.getElementById('modeProxy');
const apiKeyFields = document.getElementById('apiKeyFields');
const proxyFields = document.getElementById('proxyFields');
const provGroqBtn = document.getElementById('provGroq');
const provGeminiBtn = document.getElementById('provGemini');
const provClaudeBtn = document.getElementById('provClaude');

let isActive = false;
let mode = 'apikey';
let aiProvider = 'groq';

// ── Provider toggle ──────────────────────────────────────────────────────────

function switchProvider(prov) {
  aiProvider = prov;
  provGroqBtn.classList.toggle('active', prov === 'groq');
  provGeminiBtn.classList.toggle('active', prov === 'gemini');
  provClaudeBtn.classList.toggle('active', prov === 'claude');
  browser.storage.local.set({ aiProvider: prov });
  updateHint();
}

provGroqBtn.addEventListener('click', () => switchProvider('groq'));
provGeminiBtn.addEventListener('click', () => switchProvider('gemini'));
provClaudeBtn.addEventListener('click', () => switchProvider('claude'));

// ── Load saved config ─────────────────────────────────────────────────────────

browser.storage.local.get(['anthropicKey', 'proxyUrl', 'proxyToken', 'gladiaKey', 'sourceLanguage', 'participants', 'connectionMode', 'aiProvider']).then(data => {
  if (data.anthropicKey) { anthropicEl.value = data.anthropicKey; anthropicEl.classList.add('saved'); }
  if (data.proxyUrl) { proxyUrlEl.value = data.proxyUrl; proxyUrlEl.classList.add('saved'); }
  if (data.proxyToken) { proxyTokenEl.value = data.proxyToken; proxyTokenEl.classList.add('saved'); }
  if (data.gladiaKey) { gladiaEl.value = data.gladiaKey; gladiaEl.classList.add('saved'); }
  if (data.sourceLanguage) sourceLanguageEl.value = data.sourceLanguage;
  if (data.participants) participantsEl.value = data.participants;
  if (data.connectionMode === 'proxy') switchMode('proxy');
  switchProvider(data.aiProvider || 'groq');
  updateHint();
});

sourceLanguageEl.addEventListener('change', () => {
  browser.storage.local.set({ sourceLanguage: sourceLanguageEl.value });
});

participantsEl.addEventListener('change', () => {
  browser.storage.local.set({ participants: participantsEl.value.trim() });
});

// ── Mode toggle ───────────────────────────────────────────────────────────────

function switchMode(newMode) {
  mode = newMode;
  if (mode === 'proxy') {
    modeProxyBtn.classList.add('active');
    modeApiKeyBtn.classList.remove('active');
    apiKeyFields.style.display = 'none';
    proxyFields.style.display = 'block';
  } else {
    modeApiKeyBtn.classList.add('active');
    modeProxyBtn.classList.remove('active');
    apiKeyFields.style.display = 'block';
    proxyFields.style.display = 'none';
  }
  browser.storage.local.set({ connectionMode: mode });
  updateHint();
}

modeApiKeyBtn.addEventListener('click', () => switchMode('apikey'));
modeProxyBtn.addEventListener('click', () => switchMode('proxy'));

// ── Save keys on change ───────────────────────────────────────────────────────

[anthropicEl, proxyUrlEl, proxyTokenEl, gladiaEl].forEach(el => {
  el.addEventListener('input', () => { el.classList.remove('saved'); updateHint(); });
  el.addEventListener('change', () => {
    const key = el.id;
    browser.storage.local.set({ [key]: el.value.trim() });
    el.classList.add('saved');
    updateHint();
  });
});

function updateHint() {
  const hasClaude = mode === 'proxy' ? proxyUrlEl.value.trim() : anthropicEl.value.trim();
  const hasGladia = gladiaEl.value.trim();

  if (!hasClaude) {
    keyHint.textContent = mode === 'proxy' ? 'Introduce la URL del proxy.' : 'Introduce tu API key de Anthropic.';
    keyHint.className = 'key-hint error';
    toggleBtn.disabled = !isActive;
  } else if (hasGladia) {
    keyHint.textContent = 'Listo — transcripción con Gladia (clave directa).';
    keyHint.className = 'key-hint ok';
    toggleBtn.disabled = false;
  } else if (mode === 'proxy') {
    keyHint.textContent = 'Listo — Gladia a través del proxy (clave en el servidor).';
    keyHint.className = 'key-hint ok';
    toggleBtn.disabled = false;
  } else {
    keyHint.textContent = 'Listo — Whisper local (audio de pestaña, ~5s de retardo).';
    keyHint.className = 'key-hint ok';
    toggleBtn.disabled = false;
  }
}

// ── Status ────────────────────────────────────────────────────────────────────

browser.runtime.sendMessage({ type: 'GET_STATUS' }).then(res => {
  if (res?.isCapturing) setActive(true);
}).catch(() => {});

function setActive(active) {
  isActive = active;
  toggleBtn.textContent = active ? 'Stop Fact-Checking' : 'Start Fact-Checking';
  toggleBtn.className = 'toggle-btn' + (active ? ' active' : '');
  statusEl.textContent = active ? 'Live • Fact-checking active' : 'Inactive';
  statusEl.className = 'status' + (active ? ' active' : '');
  keysSection.style.display = active ? 'none' : 'flex';
  if (!active) updateHint();
}

// ── Toggle ────────────────────────────────────────────────────────────────────

toggleBtn.addEventListener('click', async () => {
  if (isActive) {
    browser.runtime.sendMessage({ type: 'STOP_FACTCHECK' });
    setActive(false);
    return;
  }

  const anthropicKey = anthropicEl.value.trim();
  const proxyUrl = proxyUrlEl.value.trim();
  const proxyToken = proxyTokenEl.value.trim();
  const gladiaKey = gladiaEl.value.trim();

  if (mode === 'apikey' && !anthropicKey) {
    keyHint.textContent = 'Enter your Anthropic API key.';
    keyHint.className = 'key-hint error';
    return;
  }

  if (mode === 'proxy' && !proxyUrl) {
    keyHint.textContent = 'Enter your proxy URL.';
    keyHint.className = 'key-hint error';
    return;
  }

  await browser.storage.local.set({ anthropicKey, proxyUrl, proxyToken, gladiaKey, sourceLanguage: sourceLanguageEl.value, participants: participantsEl.value.trim(), connectionMode: mode, aiProvider });

  try {
    const res = await browser.runtime.sendMessage({ type: 'START_FACTCHECK' });
    if (res?.ok) {
      setActive(true);
    } else {
      keyHint.textContent = 'Failed: ' + (res?.error || 'unknown error');
      keyHint.className = 'key-hint error';
    }
  } catch (err) {
    keyHint.textContent = 'Error: ' + err.message;
    keyHint.className = 'key-hint error';
  }
});
