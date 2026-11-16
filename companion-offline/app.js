(function () {
  'use strict';
  const CFG = window.__LIAO__ || {};
  const $ = (id) => document.getElementById(id);

  const STORE_KEY = 'liao.offline.v1';
  const KEY_KEY = 'liao.key.v1';
  const LOCK_PW = '111';
  const LOCK_KEY = 'liao.unlocked.v1';

  const EMPTY_NOTES = { about_you: [], how_to_talk: [], between_us: [], about_me: [] };
  const list = $('list');
  const input = $('input');

  function read(k, d) {
    try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; }
  }
  function write(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; }
  }
  function normalizeNotes(n) {
    const out = {};
    for (const k of Object.keys(EMPTY_NOTES)) {
      out[k] = Array.isArray(n && n[k]) ? n[k].filter((x) => typeof x === 'string') : [];
    }
    return out;
  }

  // ---------- 状态 ----------
  const S = {
    threadId: '',
    title: '',
    createdAt: '',
    history: [],
    notes: normalizeNotes(EMPTY_NOTES),
    episodes: [],
    epCursor: 0,
    summary: '',
    limit: CFG.limit || 26,
    model: read('liao.model.v1', CFG.chatModel || 'deepseek-v4-pro'),
    gen: 0,
    queue: [],
    idx: 0,
    done: true,
    wake: null,
    typing: null,
    notesBusy: false,
    epBusy: false,
    notesTick: 0,
    dirty: false,
  };
  let ctrl = null;
  let queueTimer = null;

  const newId = () => 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const titleOf = (h) => {
    const first = (h || []).find((m) => m.role === 'user');
    return first ? first.content.slice(0, 20) : '未命名';
  };

  // ---------- 本地存储 ----------
  function snapshot() {
    return {
      v: 1,
      threadId: S.threadId,
      title: S.title,
      createdAt: S.createdAt,
      updatedAt: new Date().toISOString(),
      messages: S.history,
      notes: S.notes,
      episodes: S.episodes,
      epCursor: S.epCursor,
      summary: S.summary,
      model: S.model,
    };
  }
  function persist() {
    const ok = write(STORE_KEY, snapshot());
    S.dirty = !ok;
    if (!ok) console.warn('[liao] localStorage 写满了，导出备份后清理旧对话');
  }
  function load() {
    const d = read(STORE_KEY, null);
    if (!d || typeof d !== 'object') return false;
    S.threadId = String(d.threadId || newId());
    S.title = String(d.title || '');
    S.createdAt = String(d.createdAt || new Date().toISOString());
    S.history = Array.isArray(d.messages) ? d.messages.filter((m) => m && typeof m.content === 'string') : [];
    S.notes = normalizeNotes(d.notes);
    S.episodes = Array.isArray(d.episodes) ? d.episodes : [];
    S.epCursor = Number(d.epCursor) || 0;
    S.summary = String(d.summary || '');
    if (d.model) S.model = d.model;
    return true;
  }

  // ---------- 小工具（照搬服务端逻辑） ----------
  const pad = (n) => String(n).padStart(2, '0');
  function formatNow() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function formatTs(ts) {
    if (!ts) return null;
    const d = new Date(Number(ts));
    if (isNaN(d.getTime())) return null;
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const FIELDS = ['about_you', 'how_to_talk', 'between_us', 'about_me'];
  const MAX_NOTES = 8;

  function cleanNotes(obj) {
    const out = {};
    for (const f of FIELDS) {
      const arr = Array.isArray(obj && obj[f]) ? obj[f] : [];
      const seen = [];
      for (const item of arr) {
        if (typeof item !== 'string') continue;
        const s = item.trim().replace(/^[。·\-「」\s]+|[。\s]+$/g, '');
        if (!s || seen.includes(s)) continue;
        seen.push(s.slice(0, 36));
      }
      out[f] = seen.slice(-MAX_NOTES);
    }
    return out;
  }

  function memoryBlock(notes) {
    const labels = {
      about_you: '关于对方',
      how_to_talk: 'TA 明确说过的习惯',
      between_us: '你们之间',
      about_me: '你自己',
    };
    const lines = [];
    for (const f of FIELDS) {
      const items = notes[f] || [];
      if (items.length) lines.push(`· ${labels[f]}：${items.join('；')}`);
    }
    return lines.length ? lines.join('\n') : '（还什么都没记住，正常聊就行）';
  }

  function factsBlock() {
    const kws = new Set();
    for (const e of S.episodes) {
      for (const kw of e.keywords || []) {
        const k = String(kw).trim();
        if (k.length >= 2 && k.length <= 24) kws.add(k);
      }
    }
    if (!kws.size) return '';
    return '【对方提过这些名字/作品/关键词，可能被问起】\n' + [...kws].slice(0, 40).join('、');
  }

  function bigrams(s) {
    const clean = String(s || '').toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
    const set = new Set();
    for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
    return set;
  }

  function recallEpisodes(query) {
    const eps = S.episodes;
    if (!eps.length || !query || !String(query).trim()) return [];
    const q = bigrams(query);
    const ql = String(query).toLowerCase();
    const scored = [];
    for (const e of eps) {
      const ageDays = e.ts ? Math.max(0, (Date.now() - new Date(e.ts).getTime()) / 86400000) : 365;
      const decay = Math.max(0, 1 - ageDays / 30);
      let kwHit = 0;
      for (const kw of e.keywords || []) {
        const k = String(kw).toLowerCase();
        if (k && (ql.includes(k) || k.includes(ql))) kwHit++;
      }
      let score = 0;
      if (kwHit > 0) {
        score = 0.8 + 0.06 * Math.min(kwHit, 3) + decay * 0.1;
      } else if (q.size) {
        const t = bigrams((e.theme || '') + ' ' + (e.content || ''));
        let hit = 0;
        if (t.size) for (const b of q) if (t.has(b)) hit++;
        if (hit > 0) score = (hit / q.size) * 0.75 + decay * 0.25;
      }
      if (score >= 0.28) scored.push({ e, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 4).map((s) => s.e);
  }

  function recallBlock(eps) {
    if (eps.length) {
      return eps.map((e) => {
        const ts = formatTs(e.ts ? new Date(e.ts).getTime() : 0);
        const when = ts ? `（${ts}）` : '';
        return `· ${e.theme}${when}：${e.content}${e.mood ? `（${e.mood}）` : ''}`;
      }).join('\n');
    }
    return S.summary ? '更早以前：' + S.summary : '';
  }

  function queryGrams(query) {
    const c = String(query || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
    const grams = [];
    for (let n = 3; n >= 2; n--) {
      for (let i = 0; i + n <= c.length; i++) grams.push(c.slice(i, i + n));
    }
    return grams;
  }

  function backtrackBlock(full, query) {
    if (!query || !String(query).trim()) return '';
    const grams = queryGrams(query);
    if (!grams.length) return '';
    const target = full.slice(0, -1);
    if (!target.length) return '';
    const minHits = grams.length <= 4 ? 1 : 2;
    const WINDOW = 5;
    const scored = [];
    for (let i = 0; i < target.length; i++) {
      const c = target[i].content || '';
      if (!c) continue;
      let hits = 0;
      for (const g of grams) if (c.includes(g)) hits++;
      if (hits >= minHits) scored.push({ i, hits });
    }
    if (!scored.length) return '';
    scored.sort((a, b) => b.hits - a.hits);
    const top = scored.slice(0, 3).map((s) => s.i).sort((a, b) => a - b);
    const idx = new Set();
    for (const i of top) {
      for (let j = Math.max(0, i - WINDOW); j <= Math.min(target.length - 1, i + WINDOW); j++) idx.add(j);
    }
    const lines = [...idx].sort((a, b) => a - b).map((i) => {
      const m = target[i];
      const role = m.role === 'user' ? '对方' : '你';
      const ts = formatTs(m.ts);
      return ts ? `[${ts}] ${role}：${m.content}` : `${role}：${m.content}`;
    });
    return '【从之前的聊天记录里翻到，可能和你的问题有关】\n' + lines.join('\n');
  }

  function buildSystem() {
    const base = String(CFG.prompt || '').replace('{memory}', memoryBlock(S.notes));
    let out = base + `\n\n现在是 ${formatNow()}（北京时间）。这是系统提供的准确时间，可信。`;
    const facts = factsBlock();
    if (facts) out += `\n\n${facts}`;
    return out;
  }

  function buildTranscript(history) {
    const lines = [];
    lines.push(`现在是 ${formatNow()}（北京时间）。`);
    lines.push('');
    lines.push('以下是你们之前的聊天记录（"你"是你自己，"对方"是TA）：');
    for (const m of history) {
      const role = m.role === 'user' ? '对方' : '你';
      const ts = formatTs(m.ts);
      if (ts) lines.push(`[${ts}] ${role}：${m.content}`);
      else lines.push(`${role}：${m.content}`);
    }
    lines.push('');
    lines.push('请用你自己的身份，接着回对方最后那条。');
    return lines.join('\n');
  }

  // ---------- 切气泡 ----------
  const HARD = new Set(Array.from('。！？!?\n'));
  const SOFT = new Set(Array.from('，,；;、：:'));
  function cleanBubble(raw) {
    let s = String(raw || '');
    s = s.replace(/^\s*(?:[-*•·—]|\d+[.、)])\s+/, '');
    s = s.replace(/\*\*|`|#/g, '');
    s = s.replace(/[ \t]+/g, ' ').trim();
    s = s.replace(/[。，,；;、：:]+$/, '').trim();
    if (s === '嗯') s = '嗯嗯';
    return s;
  }
  function splitLong(s, limit) {
    limit = limit || 52;
    const parts = [];
    let rest = s;
    while (rest.length > limit) {
      const w = rest.slice(0, limit);
      let cut = Math.max(w.lastIndexOf('，'), w.lastIndexOf(','), w.lastIndexOf('；'), w.lastIndexOf(';'), w.lastIndexOf('、'));
      if (cut < limit / 2) cut = limit;
      const head = rest.slice(0, cut).replace(/[，,；;、 ]+$/, '');
      if (head) parts.push(head);
      rest = rest.slice(cut + 1).replace(/^[，,；;、 ]+/, '');
    }
    if (rest.trim()) parts.push(rest.trim());
    return parts.length ? parts : [s];
  }
  class Splitter {
    constructor(soft, hard) {
      this.buf = '';
      this.soft = soft || 24;
      this.hard = hard || 38;
      this.pendingEllipsis = false;
    }
    push(text) {
      const out = [];
      for (const ch of text) {
        if (this.pendingEllipsis && ch !== '…') {
          this.pendingEllipsis = false;
          const b = cleanBubble(this.buf);
          this.buf = '';
          if (b) out.push(...splitLong(b));
        }
        this.buf += ch;
        if (ch === '…') { this.pendingEllipsis = true; continue; }
        let emit = false;
        let cutAt = this.buf.length;
        if (HARD.has(ch)) {
          emit = true;
        } else if (this.buf.length >= this.soft && SOFT.has(ch)) {
          emit = true;
        } else if (this.buf.length >= this.hard) {
          const i = Math.max(this.buf.lastIndexOf('，'), this.buf.lastIndexOf(','), this.buf.lastIndexOf('；'), this.buf.lastIndexOf(';'), this.buf.lastIndexOf('、'), this.buf.lastIndexOf('：'));
          emit = true;
          if (i >= this.soft * 0.6) cutAt = i + 1;
        }
        if (emit) {
          const piece = this.buf.slice(0, cutAt);
          this.buf = this.buf.slice(cutAt);
          const b = cleanBubble(piece);
          if (b) out.push(...splitLong(b));
        }
      }
      return out;
    }
    flush() {
      this.pendingEllipsis = false;
      const b = cleanBubble(this.buf);
      this.buf = '';
      return b ? splitLong(b) : [];
    }
  }

  // ---------- 连中转站 ----------
  // 两种玩法：
  //   1) 直连：自己在设置里填 key
  //   2) 走代理（Cloudflare Pages 那种）：key 在服务器端，页面里没有，也不用填
  function apiKey() { return read(KEY_KEY, '') || CFG.apiKey || ''; }
  function viaProxy() { return !CFG.apiKey; }

  async function callModel(opts) {
    const key = apiKey();
    if (!key && !viaProxy()) throw new Error('没填 API Key');
    const body = {
      model: opts.model,
      messages: (opts.system ? [{ role: 'system', content: opts.system }] : []).concat(opts.messages),
      stream: !!opts.stream,
      max_tokens: opts.maxTokens || 800,
      temperature: typeof opts.temperature === 'number' ? opts.temperature : 1,
    };
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = 'Bearer ' + key;
    const resp = await fetch(CFG.baseUrl + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!resp.ok) {
      let msg = 'HTTP ' + resp.status;
      try { const t = await resp.text(); if (t) msg += ' ' + t.slice(0, 160); } catch {}
      throw new Error(msg);
    }
    if (!opts.stream) {
      const d = await resp.json();
      return ((d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '');
    }
    return resp.body.getReader();
  }

  async function streamText(opts, onDelta) {
    const reader = await callModel({ ...opts, stream: true });
    const dec = new TextDecoder();
    let buf = '';
    let all = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, cut).trim();
        buf = buf.slice(cut + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let evt;
        try { evt = JSON.parse(payload); } catch { continue; }
        const ch = evt.choices && evt.choices[0];
        if (!ch) continue;
        const d = ch.delta || {};
        if (typeof d.content === 'string' && d.content) {
          all += d.content;
          if (onDelta) onDelta(d.content);
        }
      }
    }
    return all;
  }

  function parseJsonBlock(text) {
    let t = String(text || '').trim();
    if (t.startsWith('```')) t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '');
    const i = t.indexOf('{');
    const j = t.lastIndexOf('}');
    if (i < 0 || j <= i) throw new Error('no json');
    return JSON.parse(t.slice(i, j + 1));
  }
  function parseArray(text) {
    let t = String(text || '').trim();
    if (t.startsWith('```')) t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '');
    const i = t.indexOf('[');
    const j = t.lastIndexOf(']');
    if (i < 0 || j <= i) return [];
    try {
      const a = JSON.parse(t.slice(i, j + 1));
      return Array.isArray(a) ? a : [];
    } catch { return []; }
  }

  // ---------- 视图 ----------
  let followBottom = true;
  let lastScrollTop = 0;
  list.addEventListener('scroll', () => {
    const t = list.scrollTop;
    if (t < lastScrollTop - 4) followBottom = false;
    else if (t > lastScrollTop + 4) followBottom = true;
    lastScrollTop = t;
  });
  function scrollBottom() {
    requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }
  function keepBottom() { if (followBottom) scrollBottom(); }
  function setStatus(text, typing) {
    const el = $('status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('typing', !!typing);
  }

  // ---------- 朗读 ----------
  let ttsAudio = null;
  let playingEl = null;
  let playEndCb = null;
  let ttsQueue = [];
  let ttsQueueActive = false;
  let autoPlay = read('liao.autoplay.v1', false);
  function getAudio() {
    if (!ttsAudio) {
      ttsAudio = document.createElement('audio');
      ttsAudio.preload = 'auto';
      ttsAudio.addEventListener('ended', () => finishPlay());
      ttsAudio.addEventListener('error', () => finishPlay());
    }
    return ttsAudio;
  }
  function finishPlay() {
    if (playingEl) playingEl.classList.remove('playing');
    playingEl = null;
    const cb = playEndCb;
    playEndCb = null;
    if (cb) cb();
  }
  function unlockAudio() {
    try {
      const a = getAudio();
      if (!a.paused) return;
      a.muted = true;
      a.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
      const p = a.play();
      const done = () => { try { a.pause(); } catch {} a.muted = false; };
      if (p && p.then) p.then(done).catch(() => { a.muted = false; });
      else done();
    } catch {}
  }
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  document.addEventListener('keydown', unlockAudio, { once: true });
  document.addEventListener('touchstart', unlockAudio, { once: true });

  function stopAllTts() {
    try { getAudio().pause(); } catch {}
    ttsQueue = [];
    if (playingEl) playingEl.classList.remove('playing');
    playingEl = null;
    playEndCb = null;
    ttsQueueActive = false;
  }
  function playOne(text, bubbleEl, onEnd) {
    const a = getAudio();
    try { a.pause(); } catch {}
    if (playingEl) playingEl.classList.remove('playing');
    playingEl = bubbleEl || null;
    if (playingEl) playingEl.classList.add('playing');
    playEndCb = onEnd || null;
    a.muted = false;
    const u = new SpeechSynthesisUtterance(text);
    a.play().catch(() => {});
    window.speechSynthesis.cancel();
    u.lang = 'zh-CN';
    u.rate = 1.08;
    u.onend = () => finishPlay();
    u.onerror = () => finishPlay();
    window.speechSynthesis.speak(u);
  }
  function toggleBubble(text, bubbleEl) {
    if (playingEl === bubbleEl && window.speechSynthesis && window.speechSynthesis.speaking) {
      stopAllTts();
    } else {
      stopAllTts();
      playOne(text, bubbleEl);
    }
  }
  function enqueueTts(text, bubbleEl) {
    if (!autoPlay) return;
    ttsQueue.push({ text, bubbleEl });
    if (!ttsQueueActive) pumpTtsQueue();
  }
  function pumpTtsQueue() {
    ttsQueueActive = true;
    const step = () => {
      if (!ttsQueue.length) { ttsQueueActive = false; return; }
      const item = ttsQueue.shift();
      playOne(item.text, item.bubbleEl, step);
    };
    step();
  }

  // ---------- 气泡 ----------
  function makeBubble(role, text, imgs) {
    const row = document.createElement('div');
    row.className = 'row' + (role === 'user' ? ' mine' : '') + (role === 'err' ? ' err' : '');
    const b = document.createElement('div');
    b.className = 'bubble';
    const arr = Array.isArray(imgs) ? imgs : (imgs ? [imgs] : []);
    if (arr.length) {
      b.classList.add('img-bubble');
      for (const im of arr) {
        const el = document.createElement('img');
        el.className = 'chat-img';
        el.src = String(im);
        el.addEventListener('load', keepBottom);
        el.addEventListener('error', keepBottom);
        b.appendChild(el);
      }
      if (text) {
        const t = document.createElement('div');
        t.textContent = text;
        b.appendChild(t);
      }
    } else {
      b.textContent = text;
    }
    if (role === 'assistant') {
      b.classList.add('tts');
      b.title = '点击朗读 / 再点停止';
      b.addEventListener('click', () => toggleBubble(text, b));
    }
    row.appendChild(b);
    return row;
  }
  function addBubble(role, text, imgs) {
    hideTyping();
    const row = makeBubble(role, text, imgs);
    list.appendChild(row);
    scrollBottom();
    return row.querySelector('.bubble');
  }
  function addDivider(text) {
    const d = document.createElement('div');
    d.className = 'divider';
    d.textContent = text;
    list.appendChild(d);
  }
  function showTyping() {
    if (S.typing) return;
    const row = document.createElement('div');
    row.className = 'row typing';
    row.innerHTML = '<div class="bubble"><i></i><i></i><i></i></div>';
    list.appendChild(row);
    S.typing = row;
    setStatus('正在输入…', true);
    scrollBottom();
  }
  function hideTyping() {
    if (S.typing) { S.typing.remove(); S.typing = null; }
    setStatus('', false);
  }
  function showError(msg) {
    hideTyping();
    list.appendChild(makeBubble('err', msg));
    scrollBottom();
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function wake() { if (S.wake) { const r = S.wake; S.wake = null; r(); } }
  function waitWake() { return new Promise((r) => { S.wake = r; }); }

  function stamp(ts) {
    const d = ts ? new Date(ts) : new Date();
    const hh = pad(d.getHours());
    const mm = pad(d.getMinutes());
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
  }

  const PAGE = 60;
  let shown = PAGE;
  function renderAll(keepScroll) {
    const prevHeight = list.scrollHeight;
    const prevTop = list.scrollTop;
    list.innerHTML = '';
    const hidden = Math.max(0, S.history.length - shown);
    if (hidden > 0) {
      const more = document.createElement('div');
      more.className = 'load-more';
      more.textContent = `加载更早的聊天（还有 ${hidden} 条）`;
      more.addEventListener('click', () => { shown += 100; renderAll(true); });
      list.appendChild(more);
    }
    const view = S.history.slice(-shown);
    if (view.length) {
      addDivider(stamp(view[0] && view[0].ts));
      for (const m of view) list.appendChild(makeBubble(m.role, m.content, m.imgs || m.img));
      if (keepScroll) { list.scrollTop = list.scrollHeight - prevHeight + prevTop; followBottom = false; }
      else scrollBottom();
    }
    updateUsage();
  }

  function updateUsage() {
    const el = $('usage');
    if (!el) return;
    const n = S.history.length;
    const seen = Math.min(n, S.limit || 26);
    el.textContent = n
      ? `这段共 ${n} 条 · 每轮模型看最近 ${seen} 条`
      : '还没开始聊';
  }

  // ---------- 逐条吐气泡 ----------
  async function typeOut(text, gen) {
    const total = Math.min(1800, 380 + text.length * 45);
    showTyping();
    if (total > 1000) {
      await sleep(total * 0.55);
      if (gen !== S.gen) return;
      hideTyping();
      await sleep(190);
      if (gen !== S.gen) return;
      showTyping();
      await sleep(total * 0.45);
    } else {
      await sleep(total);
    }
    if (gen !== S.gen) return;
    hideTyping();
  }

  async function pump(gen) {
    while (true) {
      if (gen !== S.gen) return;
      if (S.idx >= S.queue.length) {
        if (S.done) { hideTyping(); return; }
        await waitWake();
        continue;
      }
      const text = S.queue[S.idx++];
      await typeOut(text, gen);
      if (gen !== S.gen) return;
      const bubbleEl = addBubble('assistant', text);
      enqueueTts(text, bubbleEl);
      S.history.push({ id: newId(), role: 'assistant', content: text, ts: Date.now() });
      persist();
      updateUsage();
      await sleep(150 + Math.random() * 220);
    }
  }

  // ---------- 图片 ----------
  let pendingImages = [];
  function compressImage(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const max = 1024;
          let w = img.width, h = img.height;
          if (w > max || h > max) {
            if (w > h) { h = Math.round(h * max / w); w = max; }
            else { w = Math.round(w * max / h); h = max; }
          }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.8));
        };
        img.onerror = () => resolve(String(reader.result || ''));
        img.src = String(reader.result || '');
      };
      reader.onerror = () => resolve('');
      reader.readAsDataURL(file);
    });
  }
  function renderPreviews() {
    const box = $('preview');
    if (!box) return;
    box.innerHTML = '';
    if (!pendingImages.length) { box.hidden = true; return; }
    box.hidden = false;
    pendingImages.forEach((url, i) => {
      const item = document.createElement('div');
      item.className = 'preview-item';
      const im = document.createElement('img');
      im.src = url;
      const x = document.createElement('button');
      x.className = 'preview-x';
      x.textContent = '✕';
      x.addEventListener('click', () => { pendingImages.splice(i, 1); renderPreviews(); });
      item.appendChild(im);
      item.appendChild(x);
      box.appendChild(item);
    });
  }
  async function addFiles(files) {
    const arr = Array.from(files || []).filter((f) => f && f.type && f.type.startsWith('image/')).slice(0, 9);
    for (const f of arr) {
      const d = await compressImage(f);
      if (d) pendingImages.push(d);
    }
    renderPreviews();
  }
  $('pic').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', async () => {
    await addFiles($('file').files);
    $('file').value = '';
  });
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [];
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  ['dragenter', 'dragover'].forEach((t) => {
    document.body.addEventListener(t, (e) => e.preventDefault());
  });
  document.body.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files) await addFiles(e.dataTransfer.files);
  });

  // ---------- 发送 ----------
  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  }
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  $('send').addEventListener('click', send);

  async function send() {
    const text = input.value.trim();
    const images = pendingImages.slice();
    if (!text && !images.length) return;
    unlockAudio();
    input.value = '';
    autosize();
    if (images.length) {
      addBubble('user', text, images);
      const label = text || (images.length > 1 ? `（发了 ${images.length} 张图）` : '（发了张图）');
      S.history.push({ id: newId(), role: 'user', content: label, imgs: images.slice(), ts: Date.now() });
    } else {
      addBubble('user', text);
      S.history.push({ id: newId(), role: 'user', content: text, ts: Date.now() });
    }
    pendingImages = [];
    renderPreviews();
    if (!S.title) S.title = titleOf(S.history);
    persist();
    updateUsage();
    runTurn(text, false, images);
  }

  async function runTurn(text, isRetry, images) {
    const gen = ++S.gen;
    if (ctrl) { try { ctrl.abort(); } catch {} }
    ctrl = new AbortController();
    hideTyping();
    wake();
    S.queue = [];
    S.idx = 0;
    S.done = false;

    const kick = setTimeout(() => { if (gen === S.gen) showTyping(); }, 280);
    pump(gen);

    let got = 0;
    let timedOut = false;
    let idleTimer = null;
    const timeoutMs = isRetry ? 60000 : 30000;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (gen !== S.gen) return;
        timedOut = true;
        try { ctrl.abort(); } catch {}
      }, timeoutMs);
    };
    armIdle();

    const splitter = new Splitter(CFG.bubbleSoft, CFG.bubbleHard);
    let count = 0;
    let tail = '';
    const emit = (b) => {
      count += 1;
      if (count > (CFG.maxBubbles || 4)) { tail += b; return; }
      S.queue.push(b);
      wake();
    };

    try {
      const history = S.history.slice(-(S.limit || 26));
      const userContent = [{ type: 'text', text: buildTranscript(history) }];
      for (const u of (images || [])) userContent.push({ type: 'image_url', image_url: { url: u } });
      await streamText({
        model: S.model,
        system: buildSystem(),
        messages: [{ role: 'user', content: userContent }],
        maxTokens: CFG.maxTokens,
        temperature: CFG.temperature,
        signal: ctrl.signal,
      }, (delta) => {
        if (gen !== S.gen) return;
        armIdle();
        got += 1;
        for (const b of splitter.push(delta)) emit(b);
      });
      for (const b of splitter.flush()) emit(b);
      if (tail) { S.queue.push(tail); wake(); }
    } catch (e) {
      if (e && e.name !== 'AbortError' && gen === S.gen) showError('连不上：' + ((e && e.message) || e));
    } finally {
      clearTimeout(kick);
      clearTimeout(idleTimer);
      if (gen === S.gen) {
        S.done = true;
        wake();
        if (timedOut && got === 0) {
          if (!isRetry) {
            addBubble('assistant', '诶，刚才卡了一下，我重接一下…');
            setTimeout(() => { if (gen === S.gen) runTurn(text, true, images); }, 300);
          } else {
            addBubble('assistant', '还是没接上，你再说一遍？');
          }
        }
        if (got > 0) {
          S.notesTick += 1;
          if (S.notesTick % 5 === 0) updateNotes();
          maybeEpisodes();
        }
      }
    }
  }

  // ---------- 记忆提取（后台，用 flash） ----------
  async function updateNotes() {
    if (S.notesBusy || S.history.length < 4) return;
    S.notesBusy = true;
    try {
      const hist = S.history.slice(-40);
      const tLines = hist.map((m) => {
        const role = m.role === 'user' ? '对方' : '你';
        const ts = formatTs(m.ts);
        return ts ? `[${ts}] ${role}：${m.content}` : `${role}：${m.content}`;
      });
      const transcript = `现在是 ${formatNow()}。\n${tLines.join('\n')}`;
      const epLines = S.episodes.slice(-12).map((e) => `${e.theme}（${(e.keywords || []).join('、')}）`).join('\n');
      const text = await streamText({
        model: CFG.extractModel,
        system: CFG.notesPrompt,
        messages: [{
          role: 'user',
          content: `旧记忆：\n${JSON.stringify(S.notes)}\n\n最近的事件卡（从中提取具体名字、游戏名、人名）：\n${epLines}\n\n最近的对话：\n${transcript}`,
        }],
        maxTokens: 800,
        temperature: 0.3,
      });
      const parsed = cleanNotes(parseJsonBlock(text));
      if (FIELDS.some((f) => parsed[f].length)) {
        S.notes = parsed;
        renderMem();
        persist();
      }
    } catch (e) {
      console.warn('[liao] notes 提取失败', e);
    } finally {
      S.notesBusy = false;
    }
  }

  async function maybeEpisodes() {
    if (S.epBusy) return;
    if (S.history.length - S.epCursor < 20) return;
    S.epBusy = true;
    try {
      let chunks = 0;
      while (S.history.length - S.epCursor >= 20 && chunks < 3) {
        const chunk = S.history.slice(S.epCursor, S.epCursor + 40);
        if (!chunk.length) break;
        const lines = chunk.map((m) => {
          const role = m.role === 'user' ? '对方' : '你';
          const ts = formatTs(m.ts);
          return ts ? `[${ts}] ${role}：${m.content}` : `${role}：${m.content}`;
        });
        const text = await streamText({
          model: CFG.extractModel,
          system: CFG.episodesPrompt,
          messages: [{ role: 'user', content: lines.join('\n') }],
          maxTokens: 2000,
          temperature: 0.3,
        });
        const now = Date.now();
        const eps = parseArray(text)
          .filter((e) => e && typeof e === 'object')
          .map((e, k) => ({
            id: 'e-' + now + '-' + k,
            ts: new Date().toISOString(),
            theme: String(e.theme || '').trim().slice(0, 24),
            content: String(e.content || '').trim().slice(0, 60),
            mood: String(e.mood || '').trim().slice(0, 12),
            keywords: (Array.isArray(e.keywords) ? e.keywords : [])
              .map((s) => String(s || '').trim())
              .filter((s) => s && s.length <= 20)
              .slice(0, 6),
          }))
          .filter((e) => e.theme || e.content);
        S.epCursor += chunk.length;
        if (eps.length) S.episodes = S.episodes.concat(eps);
        if (S.episodes.length > 200) {
          const over = S.episodes.length - 200;
          const old = S.episodes.slice(0, over);
          S.episodes = S.episodes.slice(over);
          const themes = old.map((e) => e.theme).filter(Boolean);
          if (themes.length) {
            S.summary = (((S.summary || '') + '；前期：' + themes.join('、')).replace(/^；/, '')).slice(-160);
          }
        }
        persist();
        chunks += 1;
      }
    } catch (e) {
      console.warn('[liao] 事件卡提取失败', e);
    } finally {
      S.epBusy = false;
    }
  }

  // ---------- 面板 ----------
  const panel = $('panel');
  const MEM_LABELS = [
    ['about_you', '关于对方'],
    ['how_to_talk', 'TA 说过的习惯'],
    ['between_us', '你们之间'],
    ['about_me', '你自己'],
  ];
  function renderMem() {
    const box = $('mem');
    if (!box) return;
    box.innerHTML = '';
    let any = false;
    for (const [key, label] of MEM_LABELS) {
      const items = S.notes[key] || [];
      if (!items.length) continue;
      any = true;
      const wrap = document.createElement('div');
      wrap.className = 'mem-group';
      const h = document.createElement('div');
      h.className = 'mem-label';
      h.textContent = label;
      wrap.appendChild(h);
      const ul = document.createElement('ul');
      for (const it of items) {
        const li = document.createElement('li');
        li.textContent = it;
        ul.appendChild(li);
      }
      wrap.appendChild(ul);
      box.appendChild(wrap);
    }
    if (!any) box.innerHTML = '<p class="mem-empty">还没记住什么，多聊几句就有了。</p>';
  }
  function renderEpisodes() {
    const box = $('episodes');
    if (!box) return;
    box.innerHTML = '';
    const items = S.episodes.slice(-40).reverse();
    if (!items.length) {
      box.innerHTML = '<p class="mem-empty">还没有事件卡，多聊几句就有了。</p>';
      return;
    }
    for (const e of items) {
      const div = document.createElement('div');
      div.className = 'episode';
      const t = document.createElement('div');
      t.className = 'episode-theme';
      t.textContent = e.theme;
      const c = document.createElement('div');
      c.className = 'episode-content';
      c.textContent = e.content;
      div.appendChild(t);
      div.appendChild(c);
      if (e.mood) {
        const m = document.createElement('div');
        m.className = 'episode-mood';
        m.textContent = e.mood;
        div.appendChild(m);
      }
      box.appendChild(div);
    }
  }
  function storageHint() {
    const el = $('storage-hint');
    if (!el) return;
    let bytes = 0;
    try { bytes = (localStorage.getItem(STORE_KEY) || '').length; } catch {}
    const mb = (bytes / 1024 / 1024).toFixed(2);
    el.textContent = `本地占用约 ${mb} MB（图片会占地方）。换设备请用「导出备份」。`;
  }

  $('gear').addEventListener('click', () => {
    renderMem();
    updateUsage();
    renderEpisodes();
    storageHint();
    const k = $('key');
    if (k) {
      // 走代理时不暴露 key 这一栏，免得以为还要自己填
      const field = k.closest('.field');
      if (field) field.style.display = viaProxy() ? 'none' : '';
      k.value = apiKey();
    }
    panel.classList.add('open');
  });
  panel.addEventListener('click', (e) => { if (e.target === panel) panel.classList.remove('open'); });
  $('save').addEventListener('click', () => panel.classList.remove('open'));
  $('close-panel').addEventListener('click', () => panel.classList.remove('open'));

  const apEl = $('autoplay');
  apEl.checked = autoPlay;
  apEl.addEventListener('change', () => {
    autoPlay = apEl.checked;
    write('liao.autoplay.v1', autoPlay);
    if (autoPlay) unlockAudio();
    else stopAllTts();
  });

  function syncModelUI() {
    document.querySelectorAll('input[name="model"]').forEach((el) => {
      el.checked = (el.value === S.model);
    });
  }
  document.querySelectorAll('input[name="model"]').forEach((el) => {
    el.addEventListener('change', () => {
      if (!el.checked) return;
      S.model = el.value;
      write('liao.model.v1', S.model);
      persist();
    });
  });

  $('new').addEventListener('click', () => {
    if (S.history.length && !confirm('开一段新的对话？现在这段的记录会被清掉（想留就先导出备份）。')) return;
    S.gen += 1;
    if (ctrl) { try { ctrl.abort(); } catch {} }
    S.queue = []; S.idx = 0; S.done = true;
    S.history = [];
    S.threadId = newId();
    S.title = '';
    S.createdAt = new Date().toISOString();
    shown = PAGE;
    persist();
    renderAll();
  });

  $('copy').addEventListener('click', async () => {
    if (!S.history.length) return;
    const text = S.history.map((m) => (m.role === 'user' ? '我：' : 'ta：') + m.content).join('\n');
    const btn = $('copy');
    const done = () => {
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = '复制对话'; }, 1200);
    };
    try {
      await navigator.clipboard.writeText(text);
      done();
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch {}
      ta.remove();
    }
  });

  $('clear-mem').addEventListener('click', () => {
    if (!confirm('清空它记住的东西？对话不会删。')) return;
    S.notes = normalizeNotes(EMPTY_NOTES);
    S.episodes = [];
    S.epCursor = S.history.length;
    S.summary = '';
    renderMem();
    renderEpisodes();
    persist();
  });

  $('reset').addEventListener('click', () => {
    if (!confirm('清空全部？这段对话和它记住的东西都会删掉。')) return;
    S.gen += 1;
    if (ctrl) { try { ctrl.abort(); } catch {} }
    S.history = [];
    S.notes = normalizeNotes(EMPTY_NOTES);
    S.episodes = [];
    S.epCursor = 0;
    S.summary = '';
    S.threadId = newId();
    S.title = '';
    S.createdAt = new Date().toISOString();
    S.queue = []; S.idx = 0; S.done = true;
    shown = PAGE;
    persist();
    renderAll();
    renderMem();
    renderEpisodes();
    panel.classList.remove('open');
  });

  $('key').addEventListener('change', () => {
    const v = $('key').value.trim();
    write(KEY_KEY, v);
    persist();
  });

  $('export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(snapshot(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    const d = new Date();
    a.href = URL.createObjectURL(blob);
    a.download = `liao-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  });
  $('import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async () => {
    const f = $('import-file').files && $('import-file').files[0];
    $('import-file').value = '';
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!d || !Array.isArray(d.messages)) throw new Error('格式不对');
      if (!confirm(`导入 ${d.messages.length} 条记录？会覆盖这台设备上现有的对话。`)) return;
      S.threadId = String(d.threadId || newId());
      S.title = String(d.title || '');
      S.createdAt = String(d.createdAt || new Date().toISOString());
      S.history = d.messages.filter((m) => m && typeof m.content === 'string');
      S.notes = normalizeNotes(d.notes);
      S.episodes = Array.isArray(d.episodes) ? d.episodes : [];
      S.epCursor = Number(d.epCursor) || S.history.length;
      S.summary = String(d.summary || '');
      shown = PAGE;
      persist();
      renderAll();
      renderMem();
      renderEpisodes();
      storageHint();
    } catch (e) {
      alert('导入失败：' + ((e && e.message) || e));
    }
  });

  window.addEventListener('pagehide', persist);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persist();
  });

  // ---------- 锁屏 ----------
  function unlocked() {
    try { return sessionStorage.getItem(LOCK_KEY) === '1'; } catch { return true; }
  }
  function openLock() {
    const lock = $('lock');
    if (lock) lock.classList.add('open');
    const pw = $('lock-pw');
    if (pw) setTimeout(() => pw.focus(), 80);
  }
  function closeLock() {
    const lock = $('lock');
    if (lock) lock.classList.remove('open');
  }
  $('lock-go').addEventListener('click', tryLock);
  $('lock-pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLock(); });
  function tryLock() {
    const pw = ($('lock-pw').value || '').trim();
    const err = $('lock-err');
    if (!LOCK_PW || pw === LOCK_PW) {
      try { sessionStorage.setItem(LOCK_KEY, '1'); } catch {}
      $('lock-pw').value = '';
      if (err) err.textContent = '';
      closeLock();
      if (!S.history.length) setTimeout(() => input.focus(), 120);
      return;
    }
    if (err) err.textContent = '密码不对';
  }

  // ---------- 启动 ----------
  (function boot() {
    const had = load();
    if (!had) {
      S.threadId = newId();
      S.createdAt = new Date().toISOString();
    }
    shown = PAGE;
    renderAll();
    renderMem();
    renderEpisodes();
    syncModelUI();
    updateUsage();
    if (!unlocked()) openLock();
    autosize();
    if (had) setTimeout(() => input.focus(), 120);
    const el = $('ver');
    if (el) el.textContent = 'offline';
    if (!apiKey() && !viaProxy()) setStatus('没填 Key', false);
    // 走代理时，启动就摸一下服务器，第一时间告诉用户通不通
    if (viaProxy()) probeServer();
    // 首次进入就把当前状态落一次，后面刷新不丢
    persist();
  })();

  function probeServer() {
    let done = false;
    const timer = setTimeout(() => { if (!done) setStatus('连接有点慢…', true); }, 6000);
    fetch(CFG.baseUrl + '/ping', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        done = true;
        clearTimeout(timer);
        if (d && d.ok === false) setStatus('服务器没配好', false);
        else if (d && d.hasKey === false) setStatus('服务器缺 Key', false);
        else setStatus('在线', false);
        setTimeout(() => setStatus('', false), 2500);
      })
      .catch(() => {
        done = true;
        clearTimeout(timer);
        setStatus('连不上服务器', false);
      });
  }
})();
