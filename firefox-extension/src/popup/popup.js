const toggleBtn = document.getElementById('toggleBtn');
const statusEl = document.getElementById('status');
const anthropicEl = document.getElementById('anthropicKey');
const proxyUrlEl = document.getElementById('proxyUrl');
const gladiaEl = document.getElementById('gladiaKey');
const keyHint = document.getElementById('keyHint');
const keysSection = document.getElementById('keysSection');
const modeApiKeyBtn = document.getElementById('modeApiKey');
const modeProxyBtn = document.getElementById('modeProxy');
const apiKeyFields = document.getElementById('apiKeyFields');
const proxyFields = document.getElementById('proxyFields');

let isActive = false;
let mode = 'apikey';

// ── Load saved config ─────────────────────────────────────────────────────────

browser.storage.local.get(['anthropicKey', 'proxyUrl', 'gladiaKey', 'connectionMode']).then(data => {
  if (data.anthropicKey) { anthropicEl.value = data.anthropicKey; anthropicEl.classList.add('saved'); }
  if (data.proxyUrl) { proxyUrlEl.value = data.proxyUrl; proxyUrlEl.classList.add('saved'); }
  if (data.gladiaKey) { gladiaEl.value = data.gladiaKey; gladiaEl.classList.add('saved'); }
  if (data.connectionMode === 'proxy') switchMode('proxy');
  updateHint();
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

[anthropicEl, proxyUrlEl, gladiaEl].forEach(el => {
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
    keyHint.textContent = mode === 'proxy' ? 'Enter your proxy URL.' : 'Enter your Anthropic API key.';
    keyHint.className = 'key-hint error';
    toggleBtn.disabled = !isActive;
  } else if (!hasGladia) {
    keyHint.textContent = 'Ready — will use microphone (Web Speech API).';
    keyHint.className = 'key-hint ok';
    toggleBtn.disabled = false;
  } else {
    keyHint.textContent = 'Ready — will use Gladia for transcription.';
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

  await browser.storage.local.set({ anthropicKey, proxyUrl, gladiaKey, connectionMode: mode });

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
