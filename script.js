/* J.A.R.V.I.S. frontend logic
 * - Chat with streaming from YOUR backend (POST /api/chat). No API keys live here.
 * - Voice input: browser SpeechRecognition (tap-to-talk, not continuous).
 * - Voice output: browser speechSynthesis, spoken sentence by sentence while streaming.
 *
 * Backend contract (Stage 3 implements this):
 *   GET  /api/health -> 200 { ok: true, provider: "...", model: "..." }
 *   POST /api/chat   body: { messages: [{role:"user"|"assistant", content:"..."}], lang: "en-IN"|"te-IN" }
 *        success: 200, Content-Type text/plain, body streamed as plain text chunks
 *        failure: 4xx/5xx with JSON { error: { code: "...", message: "..." } }
 */
(() => {
  'use strict';

  // If you host the backend on a different address, put it here or paste it in Settings (⚙).
  const DEFAULT_API_BASE = '';
  const MAX_HISTORY = 20;              // messages kept as conversation context
  const FIRST_BYTE_TIMEOUT_MS = 45000; // wait this long for the backend to start answering

  const $ = (id) => document.getElementById(id);
  const el = {
    chat: $('chat'), form: $('form'), input: $('textInput'), heard: $('heard'),
    mic: $('micBtn'), send: $('sendBtn'), stop: $('stopBtn'), clear: $('clearBtn'),
    lang: $('langSelect'), settingsBtn: $('settingsBtn'), settings: $('settings'),
    api: $('apiInput'), voice: $('voiceSelect'), speak: $('speakToggle'), auto: $('autoToggle'),
    save: $('saveSettings'), close: $('closeSettings'),
    status: $('statusText'), connDot: $('connDot'), connText: $('connText'), notice: $('notice'),
  };

  /* ---------- Settings (no secrets: only language, voice and backend URL) ---------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem('jarvis_' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('jarvis_' + k, JSON.stringify(v)); } catch { /* storage blocked */ } },
  };
  const settings = {
    lang: store.get('lang', 'en-IN'),
    speak: store.get('speak', true),
    auto: store.get('auto', false),
    voice: store.get('voice', ''),
    api: store.get('api', DEFAULT_API_BASE),
  };
  const apiBase = () => (settings.api || '').trim().replace(/\/+$/, '');

  /* ---------- State ---------- */
  let state = 'idle';
  let busy = false;          // an AI request is in flight
  let streaming = false;
  let controller = null;
  let history = [];
  let autoNext = false;

  function setState(s) {
    state = s;
    document.body.dataset.state = s;
    el.status.textContent = s.toUpperCase();
  }

  /* ---------- Notices ---------- */
  function showNotice(msg, kind) {
    el.notice.textContent = msg;
    el.notice.className = 'notice' + (kind === 'info' ? ' info' : '');
    el.notice.hidden = false;
  }
  function hideNotice() { el.notice.hidden = true; }
  el.notice.addEventListener('click', hideNotice);

  /* ---------- Chat DOM ---------- */
  function addMsg(role, text) {
    const d = document.createElement('div');
    d.className = 'msg ' + role;
    d.textContent = text || '';
    el.chat.appendChild(d);
    scrollChat();
    return d;
  }
  let scrollQueued = false;
  function scrollChat() {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => { el.chat.scrollTop = el.chat.scrollHeight; scrollQueued = false; });
  }
  function greeting() {
    addMsg('sys', 'Online. Tap the mic and speak, or type a message.');
  }

  /* ---------- Text-to-speech ---------- */
  const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
  let voices = [];
  let speakGen = 0;     // bumped on cancel so stale callbacks are ignored
  let pending = 0;      // utterances queued or playing
  let warnedNoTelugu = false;

  const langPrefix = () => settings.lang.slice(0, 2).toLowerCase();
  const normLang = (l) => (l || '').replace('_', '-').toLowerCase();

  function loadVoices() {
    if (!synth) return;
    voices = synth.getVoices();
    const p = langPrefix();
    const list = voices.filter((v) => normLang(v.lang).startsWith(p));
    el.voice.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = ''; auto.textContent = 'Auto';
    el.voice.appendChild(auto);
    list.forEach((v) => {
      const o = document.createElement('option');
      o.value = v.voiceURI; o.textContent = v.name + ' (' + v.lang + ')';
      el.voice.appendChild(o);
    });
    el.voice.value = list.some((v) => v.voiceURI === settings.voice) ? settings.voice : '';
  }
  if (synth) {
    loadVoices();
    synth.addEventListener('voiceschanged', loadVoices);
  }

  function pickVoice() {
    const p = langPrefix();
    const matches = voices.filter((v) => normLang(v.lang).startsWith(p));
    return matches.find((v) => v.voiceURI === settings.voice)
      || matches.find((v) => normLang(v.lang) === normLang(settings.lang))
      || matches[0] || null;
  }

  function checkTeluguVoice() {
    if (settings.lang !== 'te-IN' || warnedNoTelugu || !synth) return;
    if (voices.length && !voices.some((v) => normLang(v.lang).startsWith('te'))) {
      warnedNoTelugu = true;
      showNotice('No Telugu voice found on this phone. Replies will still appear as text. To hear Telugu, install Telugu voice data in Android Settings → Text-to-speech output (Google).', 'info');
    }
  }

  function cleanForSpeech(t) {
    return t
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/https?:\/\/\S+/g, 'link')
      .replace(/[*_#`>~|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function speakChunk(text) {
    if (!synth || !settings.speak) return;
    const clean = cleanForSpeech(text);
    if (!clean) return;
    const gen = speakGen;
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = settings.lang;
    const v = pickVoice();
    if (v) u.voice = v;
    u.rate = 1.05;
    u.onstart = () => { if (gen === speakGen && !listening) setState('speaking'); };
    const done = () => { if (gen !== speakGen) return; pending = Math.max(0, pending - 1); finishIfDone(); };
    u.onend = done;
    u.onerror = done;
    pending++;
    synth.speak(u);
  }

  function cancelSpeech() {
    speakGen++;
    pending = 0;
    if (synth) synth.cancel();
  }

  // Pull complete sentences out of a streaming buffer.
  function takeSentences(buf) {
    const re = /[.!?।]+["')\]]*\s|\n/g;
    let idx = -1, m;
    while ((m = re.exec(buf)) !== null) idx = m.index + m[0].length;
    if (idx < 0 && buf.length > 220) {          // very long run without punctuation
      const sp = buf.lastIndexOf(' ');
      if (sp > 0) idx = sp + 1;
    }
    return idx > 0 ? [buf.slice(0, idx), buf.slice(idx)] : ['', buf];
  }

  function finishIfDone() {
    if (streaming || busy || pending > 0 || listening) return;
    setState('idle');
    if (autoNext) { autoNext = false; startListening(); }
  }

  /* ---------- Speech recognition ---------- */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  let listening = false;
  let finalText = '';

  if (!SR) {
    el.mic.disabled = true;
    el.mic.title = 'Speech recognition is not supported in this browser';
    showNotice('Voice input is not supported in this browser. Use Chrome on Android, or type your messages.', 'info');
  }

  function startListening() {
    if (!SR || busy) return;
    if (listening) { stopListening(true); return; }
    cancelSpeech();
    hideNotice();
    finalText = '';
    el.heard.textContent = '';
    const r = new SR();
    rec = r;
    r.lang = settings.lang;
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;
    r.onstart = () => { listening = true; setState('listening'); };
    r.onresult = (e) => {
      let interim = '', fin = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) fin += t; else interim += t;
      }
      if (fin) finalText = (finalText + ' ' + fin).trim();
      el.heard.textContent = 'Heard: ' + (finalText || interim);
    };
    r.onerror = (e) => handleRecError(e.error);
    r.onend = () => {
      listening = false;
      rec = null;
      const text = finalText.trim();
      finalText = '';
      if (text) { el.heard.textContent = ''; sendMessage(text, true); }
      else { setState('idle'); }
    };
    try { r.start(); } catch (err) { listening = false; rec = null; setState('idle'); showNotice('Could not start the microphone. Try again.'); }
  }

  function stopListening(sendWhatWasHeard) {
    const r = rec;
    if (!r) return;
    if (!sendWhatWasHeard) { r.onend = null; r.onresult = null; r.onerror = null; rec = null; listening = false; finalText = ''; el.heard.textContent = ''; try { r.abort(); } catch { /* ignore */ } }
    else { try { r.stop(); } catch { /* ignore */ } }
  }

  function handleRecError(code) {
    const msgs = {
      'not-allowed': 'Microphone access is blocked. Allow the microphone for this site in your browser settings. Note: the mic often does not work inside an online editor\'s preview frame, so open the preview in its own tab or use the deployed https site.',
      'service-not-allowed': 'The browser blocked speech recognition for this page. Use https and Chrome, and check the mic permission.',
      'no-speech': 'I did not hear anything. Tap the mic and try again.',
      'audio-capture': 'No microphone was found or it is in use by another app.',
      'network': 'Speech recognition needs an internet connection. Check your network and try again.',
      'language-not-supported': 'This language is not supported for voice input on this device. Switch language or type instead.',
      'aborted': '',
    };
    const m = msgs[code];
    if (m === '') return;
    autoNext = false;
    showNotice(m || ('Voice input error: ' + code));
  }

  /* ---------- Chat request (streaming) ---------- */
  async function readApiError(res) {
    let msg = '';
    try { const j = await res.json(); msg = j && j.error && j.error.message ? j.error.message : ''; } catch { /* not JSON */ }
    const fallback = {
      400: 'The request was rejected by the backend.',
      401: 'The AI provider rejected the API key. Check the key in your backend environment variables.',
      403: 'Access denied. The API key may not have permission for this model.',
      404: 'Backend not found at that URL. Check the Backend URL in Settings.',
      413: 'That message is too long.',
      429: 'Rate limit reached. Wait a moment and try again.',
    };
    return new Error(msg || fallback[res.status] || (res.status >= 500 ? 'The server or AI provider had a problem. Try again shortly.' : 'Unexpected error (' + res.status + ').'));
  }

  async function sendMessage(text, fromVoice) {
    text = (text || '').trim();
    if (!text || busy) return;
    if (!apiBase()) {
      showNotice('Backend URL is not set. Open Settings (⚙) and paste your backend address.');
      el.input.value = text;
      return;
    }
    hideNotice();
    cancelSpeech();
    if (listening) stopListening(false);

    addMsg('user', text);
    history.push({ role: 'user', content: text });
    el.input.value = '';
    busy = true;
    streaming = true;
    setState('thinking');

    const bubble = addMsg('assistant', '');
    bubble.classList.add('typing');
    controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, FIRST_BYTE_TIMEOUT_MS);

    let full = '', buf = '', ok = false;
    try {
      const res = await fetch(apiBase() + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history.slice(-MAX_HISTORY), lang: settings.lang }),
        signal: controller.signal,
      });
      if (!res.ok) throw await readApiError(res);

      const reader = res.body && res.body.getReader ? res.body.getReader() : null;
      const dec = new TextDecoder();
      if (reader) {
        for (;;) {
          const { value, done } = await reader.read();
          clearTimeout(timer);
          if (done) break;
          const chunk = dec.decode(value, { stream: true });
          full += chunk; buf += chunk;
          bubble.classList.remove('typing');
          bubble.textContent = full;
          scrollChat();
          const [out, rest] = takeSentences(buf);
          if (out) { speakChunk(out); buf = rest; }
        }
      } else {                      // very old browser: no streaming, read whole body
        full = await res.text(); buf = full;
        bubble.classList.remove('typing'); bubble.textContent = full;
      }
      if (buf.trim()) speakChunk(buf);
      if (!full.trim()) throw new Error('The AI returned an empty reply. Try again.');
      ok = true;
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        if (timedOut) showErr(bubble, full, 'The backend took too long to respond. It may be waking up (free hosts sleep when idle). Try again in a moment.');
      } else if (err instanceof TypeError) {
        showErr(bubble, full, 'Cannot reach the backend. Check your internet connection and the Backend URL in Settings.');
        setConn('bad', 'BACKEND OFFLINE');
      } else {
        showErr(bubble, full, err.message);
      }
      if (!full.trim()) {            // nothing answered: undo the user turn and give the text back
        history.pop();
        if (!bubble.classList.contains('error')) bubble.remove();
        el.input.value = text;
      }
    } finally {
      clearTimeout(timer);
      bubble.classList.remove('typing');
      if (full.trim()) {
        history.push({ role: 'assistant', content: full });
        if (bubble.classList.contains('error')) bubble.classList.remove('error');
      } else if (bubble.parentNode && !bubble.textContent) {
        bubble.remove();
      }
      busy = false;
      streaming = false;
      controller = null;
      autoNext = ok && settings.auto && !!SR;
      if (pending === 0) finishIfDone();
    }
  }

  function showErr(bubble, partial, message) {
    autoNext = false;
    if (partial.trim()) { showNotice(message); return; }   // partial answer stays, message in banner
    bubble.className = 'msg error';
    bubble.textContent = message;
  }

  /* ---------- Controls ---------- */
  function stopAll() {
    autoNext = false;
    if (controller) controller.abort();
    cancelSpeech();
    if (listening) stopListening(false);
    if (!busy) setState('idle');
    el.heard.textContent = '';
  }

  function clearChat() {
    stopAll();
    history = [];
    el.chat.innerHTML = '';
    hideNotice();
    greeting();
  }

  el.form.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(el.input.value, false); });
  el.mic.addEventListener('click', () => { listening ? stopListening(true) : startListening(); });
  el.stop.addEventListener('click', stopAll);
  el.clear.addEventListener('click', clearChat);

  el.lang.value = settings.lang;
  el.lang.addEventListener('change', () => {
    settings.lang = el.lang.value;
    store.set('lang', settings.lang);
    warnedNoTelugu = false;
    loadVoices();
    checkTeluguVoice();
    if (listening) stopListening(false);
  });

  /* ---------- Settings panel ---------- */
  el.api.value = settings.api;
  el.speak.checked = settings.speak;
  el.auto.checked = settings.auto;
  el.settingsBtn.addEventListener('click', () => { el.settings.hidden = !el.settings.hidden; });
  el.close.addEventListener('click', () => { el.settings.hidden = true; });
  el.save.addEventListener('click', () => {
    settings.api = el.api.value.trim();
    settings.speak = el.speak.checked;
    settings.auto = el.auto.checked;
    settings.voice = el.voice.value;
    store.set('api', settings.api);
    store.set('speak', settings.speak);
    store.set('auto', settings.auto);
    store.set('voice', settings.voice);
    if (!settings.speak) cancelSpeech();
    el.settings.hidden = true;
    hideNotice();
    checkBackend();
  });

  /* ---------- Backend health (one request on load / after saving settings) ---------- */
  function setConn(cls, text, title) {
    el.connDot.className = 'dot ' + cls;
    el.connText.textContent = text;
    el.connText.title = title || '';
  }
  async function checkBackend() {
    const base = apiBase();
    if (!base) {
      setConn('bad', 'NO BACKEND');
      showNotice('Backend URL is not set yet. The interface works, but AI replies need your backend. Open Settings (⚙) to add it.', 'info');
      return;
    }
    setConn('wait', 'CHECKING');
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 15000);
    try {
      const r = await fetch(base + '/api/health', { cache: 'no-store', signal: c.signal });
      const j = await r.json();
      if (!r.ok || !j.ok) {
        setConn('bad', 'BACKEND NOT READY');
        showNotice((j && j.error && j.error.message) || 'The backend answered but is not ready.');
        return;
      }
      setConn('ok', 'BACKEND ONLINE', (j.provider || '') + ' · ' + (j.model || ''));
    } catch {
      setConn('bad', 'BACKEND OFFLINE');
      showNotice('Cannot reach the backend at ' + base + '. Check the URL in Settings. Free hosts can take up to a minute to wake up.');
    } finally { clearTimeout(t); }
  }

  /* ---------- Particles (28 dots, ~30fps, paused when hidden) ---------- */
  const cv = $('particles');
  const cx = cv.getContext('2d');
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let W = 0, H = 0, parts = [], raf = 0, last = 0;
  function resize() { W = cv.width = window.innerWidth; H = cv.height = window.innerHeight; }
  function initParts() {
    parts = [];
    for (let i = 0; i < 28; i++) {
      parts.push({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - 0.5) * 0.25, vy: -0.1 - Math.random() * 0.3, r: 0.6 + Math.random() * 1.4, a: 0.2 + Math.random() * 0.5 });
    }
  }
  function frame(ts) {
    raf = requestAnimationFrame(frame);
    if (ts - last < 33) return;
    last = ts;
    cx.clearRect(0, 0, W, H);
    cx.fillStyle = '#19e3ff';
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy;
      if (p.y < -5) { p.y = H + 5; p.x = Math.random() * W; }
      if (p.x < -5) p.x = W + 5; else if (p.x > W + 5) p.x = -5;
      cx.globalAlpha = p.a;
      cx.beginPath(); cx.arc(p.x, p.y, p.r, 0, 6.2832); cx.fill();
    }
    cx.globalAlpha = 1;
  }
  function startParticles() { if (!raf && !reduce) raf = requestAnimationFrame(frame); }
  function stopParticles() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }
  window.addEventListener('resize', () => { resize(); initParts(); });
  document.addEventListener('visibilitychange', () => { document.hidden ? stopParticles() : startParticles(); });

  /* ---------- Boot ---------- */
  resize(); initParts(); startParticles();
  greeting();
  if (!synth) showNotice('Spoken replies are not supported in this browser. Replies will appear as text.', 'info');
  setTimeout(checkTeluguVoice, 800);   // voices load asynchronously
  checkBackend();
})();
