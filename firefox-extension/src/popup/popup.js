const toggleBtn = document.getElementById('toggleBtn');
const statusEl = document.getElementById('status');
const anthropicEl = document.getElementById('anthropicKey');
const proxyUrlEl = document.getElementById('proxyUrl');
const proxyTokenEl = document.getElementById('proxyToken');
const gladiaEl = document.getElementById('gladiaKey');
const sourceLanguageEl = document.getElementById('sourceLanguage');
const understoodEl = document.getElementById('understoodLanguages');
const participantsEl = document.getElementById('participants');
const feedbackRulesEl = document.getElementById('feedbackRules');
const keyHint = document.getElementById('keyHint');
const keysSection = document.getElementById('keysSection');
const modeApiKeyBtn = document.getElementById('modeApiKey');
const modeProxyBtn = document.getElementById('modeProxy');
const apiKeyFields = document.getElementById('apiKeyFields');
const proxyFields = document.getElementById('proxyFields');
const provGroqBtn = document.getElementById('provGroq');
const provGeminiBtn = document.getElementById('provGemini');
const provClaudeBtn = document.getElementById('provClaude');
const uiLangEsBtn = document.getElementById('uiLangEs');
const uiLangEnBtn = document.getElementById('uiLangEn');

let isActive = false;
let mode = 'apikey';
let aiProvider = 'groq';
let understoodExplicit = false; // whether the user ever chose understood languages

// ── UI language (bilingual edition) ──────────────────────────────────────────
// One setting drives the popup/overlay texts AND the language the AI writes in.

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  uiLangEsBtn.classList.toggle('active', getUiLang() === 'es');
  uiLangEnBtn.classList.toggle('active', getUiLang() === 'en');
  setActive(isActive); // refresh status + toggle-button texts
}

// Rebuild both language selects with labels in the current UI language,
// preserving the current selections.
function buildLanguageSelects(selectedSource, selectedUnderstood) {
  const source = selectedSource !== undefined ? selectedSource : sourceLanguageEl.value || 'auto';
  const understood = selectedUnderstood !== undefined
    ? selectedUnderstood
    : [...understoodEl.selectedOptions].map(o => o.value);

  sourceLanguageEl.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = 'auto';
  auto.textContent = t('p_opt_auto');
  sourceLanguageEl.appendChild(auto);
  for (const l of EXT_LANGUAGES) {
    const o = document.createElement('option');
    o.value = l.code;
    o.textContent = l[getUiLang()] || l.en;
    sourceLanguageEl.appendChild(o);
  }
  sourceLanguageEl.value = source;

  understoodEl.innerHTML = '';
  for (const l of EXT_LANGUAGES) {
    const o = document.createElement('option');
    o.value = l.code;
    o.textContent = l[getUiLang()] || l.en;
    o.selected = understood.includes(l.code);
    understoodEl.appendChild(o);
  }
}

function switchUiLang(lang) {
  setUiLang(lang);
  browser.storage.local.set({ uiLanguage: getUiLang() });
  // If the user never chose understood languages, follow the new language's default.
  buildLanguageSelects(undefined, understoodExplicit
    ? undefined
    : defaultUnderstoodLanguages(getUiLang()));
  applyI18n();
  updateHint();
}

uiLangEsBtn.addEventListener('click', () => switchUiLang('es'));
uiLangEnBtn.addEventListener('click', () => switchUiLang('en'));

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

browser.storage.local.get(['anthropicKey', 'proxyUrl', 'proxyToken', 'gladiaKey', 'sourceLanguage', 'participants', 'connectionMode', 'aiProvider', 'feedbackRules', 'uiLanguage', 'understoodLanguages']).then(data => {
  setUiLang(data.uiLanguage || defaultUiLanguage());
  understoodExplicit = Array.isArray(data.understoodLanguages) && data.understoodLanguages.length > 0;
  const understood = understoodExplicit ? data.understoodLanguages : defaultUnderstoodLanguages(getUiLang());
  buildLanguageSelects(data.sourceLanguage || 'auto', understood);

  if (data.anthropicKey) { anthropicEl.value = data.anthropicKey; anthropicEl.classList.add('saved'); }
  if (data.proxyUrl) { proxyUrlEl.value = data.proxyUrl; proxyUrlEl.classList.add('saved'); }
  if (data.proxyToken) { proxyTokenEl.value = data.proxyToken; proxyTokenEl.classList.add('saved'); }
  if (data.gladiaKey) { gladiaEl.value = data.gladiaKey; gladiaEl.classList.add('saved'); }
  if (data.participants) participantsEl.value = data.participants;
  if (Array.isArray(data.feedbackRules)) feedbackRulesEl.value = data.feedbackRules.join('\n');
  if (data.connectionMode === 'proxy') switchMode('proxy');
  switchProvider(data.aiProvider || 'groq');
  applyI18n();
  updateHint();
});

sourceLanguageEl.addEventListener('change', () => {
  browser.storage.local.set({ sourceLanguage: sourceLanguageEl.value });
});

understoodEl.addEventListener('change', () => {
  const langs = [...understoodEl.selectedOptions].map(o => o.value);
  understoodExplicit = langs.length > 0;
  browser.storage.local.set({ understoodLanguages: langs });
});

participantsEl.addEventListener('change', () => {
  browser.storage.local.set({ participants: participantsEl.value.trim() });
});

// Learned rules: one per line; the background picks up edits via storage.onChanged.
feedbackRulesEl.addEventListener('change', () => {
  const rules = feedbackRulesEl.value.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 12);
  browser.storage.local.set({ feedbackRules: rules });
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
    keyHint.textContent = mode === 'proxy' ? t('p_hint_enter_proxy') : t('p_hint_enter_key');
    keyHint.className = 'key-hint error';
    toggleBtn.disabled = !isActive;
  } else if (hasGladia) {
    keyHint.textContent = t('p_hint_ready_gladia_direct');
    keyHint.className = 'key-hint ok';
    toggleBtn.disabled = false;
  } else if (mode === 'proxy') {
    keyHint.textContent = t('p_hint_ready_gladia_proxy');
    keyHint.className = 'key-hint ok';
    toggleBtn.disabled = false;
  } else {
    keyHint.textContent = t('p_hint_ready_whisper');
    keyHint.className = 'key-hint ok';
    toggleBtn.disabled = false;
  }
}

// ── Backup export / import ────────────────────────────────────────────────────

// What a backup may contain. Credentials only go in when the checkbox is ticked,
// and on import a file is never trusted: only these keys, type-checked, are applied.
const BACKUP_SETTINGS_KEYS = ['sourceLanguage', 'participants', 'aiProvider', 'connectionMode', 'feedbackNegative', 'feedbackPositive', 'feedbackRules', 'feedbackSinceDistill', 'uiLanguage', 'understoodLanguages'];
const BACKUP_CRED_KEYS = ['proxyUrl', 'proxyToken', 'gladiaKey', 'anthropicKey'];
const BACKUP_ARRAY_KEYS = ['feedbackNegative', 'feedbackPositive', 'feedbackRules', 'understoodLanguages'];

const exportBackupBtn = document.getElementById('exportBackupBtn');
const importBackupBtn = document.getElementById('importBackupBtn');
const importBackupFile = document.getElementById('importBackupFile');
const backupIncludeCreds = document.getElementById('backupIncludeCreds');

function backupHint(text, ok) {
  keyHint.textContent = text;
  keyHint.className = 'key-hint ' + (ok ? 'ok' : 'error');
}

exportBackupBtn.addEventListener('click', async () => {
  const keys = backupIncludeCreds.checked
    ? [...BACKUP_SETTINGS_KEYS, ...BACKUP_CRED_KEYS]
    : BACKUP_SETTINGS_KEYS;
  const data = await browser.storage.local.get(keys);
  const payload = {
    app: 'intruth-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    includesCredentials: backupIncludeCreds.checked,
    data,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'intruth-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  backupHint(backupIncludeCreds.checked ? t('p_backup_done_creds') : t('p_backup_done'), true);
});

importBackupBtn.addEventListener('click', () => importBackupFile.click());

importBackupFile.addEventListener('change', async () => {
  const file = importBackupFile.files && importBackupFile.files[0];
  importBackupFile.value = '';
  if (!file) return;
  let payload;
  try { payload = JSON.parse(await file.text()); }
  catch { backupHint(t('p_backup_bad_json'), false); return; }
  if (!payload || payload.app !== 'intruth-backup' || typeof payload.data !== 'object' || payload.data === null) {
    backupHint(t('p_backup_not_ours'), false);
    return;
  }
  const clean = {};
  for (const key of [...BACKUP_SETTINGS_KEYS, ...BACKUP_CRED_KEYS]) {
    if (!(key in payload.data)) continue;
    const v = payload.data[key];
    if (BACKUP_ARRAY_KEYS.includes(key)) {
      if (Array.isArray(v)) clean[key] = v.map(s => String(s).trim()).filter(Boolean);
    } else if (key === 'feedbackSinceDistill') {
      if (Number.isInteger(v) && v >= 0) clean[key] = v;
    } else if (typeof v === 'string') {
      const s = v.trim();
      // An empty value in the file must never wipe an existing credential here.
      if (s || !BACKUP_CRED_KEYS.includes(key)) clean[key] = s;
    }
  }
  if (!Object.keys(clean).length) {
    backupHint(t('p_backup_empty'), false);
    return;
  }
  await browser.storage.local.set(clean);
  // Reload so every field shows the restored values (background picks up the changes
  // via storage.onChanged; the rest is read on the next Start).
  window.location.reload();
});

// ── Status ────────────────────────────────────────────────────────────────────

browser.runtime.sendMessage({ type: 'GET_STATUS' }).then(res => {
  if (res?.isCapturing) setActive(true);
}).catch(() => {});

function setActive(active) {
  isActive = active;
  toggleBtn.textContent = active ? t('p_btn_stop') : t('p_btn_start');
  toggleBtn.className = 'toggle-btn' + (active ? ' active' : '');
  statusEl.textContent = active ? t('p_status_active') : t('p_status_inactive');
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
    keyHint.textContent = t('p_hint_enter_key');
    keyHint.className = 'key-hint error';
    return;
  }

  if (mode === 'proxy' && !proxyUrl) {
    keyHint.textContent = t('p_hint_enter_proxy');
    keyHint.className = 'key-hint error';
    return;
  }

  await browser.storage.local.set({ anthropicKey, proxyUrl, proxyToken, gladiaKey, sourceLanguage: sourceLanguageEl.value, participants: participantsEl.value.trim(), connectionMode: mode, aiProvider, uiLanguage: getUiLang() });

  try {
    const res = await browser.runtime.sendMessage({ type: 'START_FACTCHECK' });
    if (res?.ok) {
      setActive(true);
    } else {
      keyHint.textContent = t('p_start_failed') + (res?.error || 'unknown error');
      keyHint.className = 'key-hint error';
    }
  } catch (err) {
    keyHint.textContent = t('p_error') + err.message;
    keyHint.className = 'key-hint error';
  }
});
