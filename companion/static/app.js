(() => {
  const $ = (id) => document.getElementById(id);
  const list = $('list');
  const input = $('input');
  const sendBtn = $('send');
  const demoBar = $('demo');

  const LS = {
    hist: 'companion.history.v1',
    key: 'companion.key.v1',
    notes: 'companion.notes.v2',
  };

  const EMPTY_NOTES = { about_you: [], how_to_talk: [], between_us: [], about_me: [] };

  const S = {
    history: read(LS.hist, []),
    notes: read(LS.notes, EMPTY_NOTES),
    apiKey: read(LS.key, ''),
    gen: 0,
    queue: [],
    idx: 0,
    done: true,
    wake: null,
    typing: null,
    notesBusy: false,
  };
  let ctrl = null;

  // ---------- 存储 ----------
  function read(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : JSON.parse(v);
    } catch { return d; }
  }
  function write(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
  }
  function normalizeNotes(n) {
    const out = {};
    for (const k of Object.keys(EMPTY_NOTES)) {
      out[k] = Array.isArray(n && n[k]) ? n[k].filter((x) => typeof x === 'string') : [];
    }
    return out;
  }

  // ---------- 视图 ----------
  const pad = (n) => String(n).padStart(2, '0');
  function scrollBottom() {
    requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }
  function setStatus(text, typing) {
    const el = $('status');
    el.textContent = text;
    el.classList.toggle('typing', !!typing);
  }
  function refreshDemoBar() {
    demoBar.hidden = !!S.apiKey;
  }

  function makeBubble(role, text) {
    const row = document.createElement('div');
    row.className = 'row' + (role === 'user' ? ' mine' : '') + (role === 'err' ? ' err' : '');
    const b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = text;
    row.appendChild(b);
    return row;
  }
  function addBubble(role, text) {
    hideTyping();
    list.appendChild(makeBubble(role, text));
    scrollBottom();
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

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function wake() {
    if (S.wake) { const r = S.wake; S.wake = null; r(); }
  }
  function waitWake() {
    return new Promise((r) => { S.wake = r; });
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
        await wakeWait();
        continue;
      }
      const text = S.queue[S.idx++];
      await typeOut(text, gen);
      if (gen !== S.gen) return;
      addBubble('assistant', text);
      S.history.push({ role: 'assistant', content: text, ts: Date.now() });
      write(LS.hist, S.history);
      await sleep(150 + Math.random() * 220);
    }
  }
  async function wakeWait() { return waitWake(); }

  // ---------- 发送 ----------
  async function send() {
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    autosize();
    addBubble('user', text);
    S.history.push({ role: 'user', content: text, ts: Date.now() });
    write(LS.hist, S.history);

    S.gen += 1;
    const gen = S.gen;
    if (ctrl) ctrl.abort();
    ctrl = new AbortController();
    hideTyping();
    wake();
    S.queue = [];
    S.idx = 0;
    S.done = false;

    const kick = setTimeout(() => { if (gen === S.gen) showTyping(); }, 280);
    pump(gen);

    let got = 0;
    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: S.apiKey,
          notes: S.notes,
          messages: S.history.slice(-40),
        }),
        signal: ctrl.signal,
      });
      if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status);

      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue;
            let evt;
            try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
            if (gen !== S.gen) return;
            if (evt.type === 'bubble') { got += 1; S.queue.push(evt.text); wake(); }
            else if (evt.type === 'error') { showError(evt.message); }
          }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError' && gen === S.gen) showError('连不上本机服务：' + e.message);
    } finally {
      clearTimeout(kick);
      if (gen === S.gen) { S.done = true; wake(); }
      if (got > 0 && gen === S.gen) updateNotes();
    }
  }

  async function updateNotes() {
    if (!S.apiKey || S.notesBusy || S.history.length < 4) return;
    S.notesBusy = true;
    try {
      const r = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: S.apiKey,
          notes: S.notes,
          messages: S.history.slice(-14),
        }),
      });
      if (!r.ok) return;
      const d = await r.json();
      if (d.updated && d.notes) {
        S.notes = normalizeNotes(d.notes);
        write(LS.notes, S.notes);
        renderMem();
      }
    } catch {
      // 记不住就算了，不影响聊天
    } finally {
      S.notesBusy = false;
    }
  }

  function showError(msg) {
    hideTyping();
    list.appendChild(makeBubble('err', msg));
    scrollBottom();
  }

  // ---------- 记忆展示 ----------
  const MEM_LABELS = [
    ['about_you', '关于对方'],
    ['how_to_talk', 'TA 说过的习惯'],
    ['between_us', '你们之间'],
    ['about_me', '你自己'],
  ];
  function renderMem() {
    const box = $('mem');
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
    if (!any) {
      box.innerHTML = '<p class="mem-empty">还没记住什么，多聊几句就有了。</p>';
    }
  }

  // ---------- 输入框 ----------
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
  sendBtn.addEventListener('click', send);

  // ---------- 设置 ----------
  const panel = $('panel');
  function openPanel() {
    $('key').value = S.apiKey;
    renderMem();
    panel.classList.add('open');
  }
  $('gear').addEventListener('click', openPanel);
  $('demo-set').addEventListener('click', openPanel);
  $('close').addEventListener('click', () => panel.classList.remove('open'));
  panel.addEventListener('click', (e) => { if (e.target === panel) panel.classList.remove('open'); });

  $('save').addEventListener('click', () => {
    S.apiKey = $('key').value.trim();
    write(LS.key, S.apiKey);
    panel.classList.remove('open');
    refreshDemoBar();
  });

  $('clear-mem').addEventListener('click', () => {
    if (!confirm('清空它记住的东西？对话不会删。')) return;
    S.notes = normalizeNotes(EMPTY_NOTES);
    write(LS.notes, S.notes);
    renderMem();
  });

  $('reset').addEventListener('click', () => {
    if (!confirm('清空这段对话？记忆保留。')) return;
    S.gen += 1;
    if (ctrl) ctrl.abort();
    S.history = [];
    S.queue = []; S.idx = 0; S.done = true;
    write(LS.hist, S.history);
    list.innerHTML = '';
    hideTyping();
    panel.classList.remove('open');
  });

  // ---------- 启动 ----------
  (function boot() {
    S.notes = normalizeNotes(S.notes);
    if (S.history.length) {
      const d = new Date();
      addDivider(`${d.getMonth() + 1}月${d.getDate()}日`);
      S.history.forEach((m) => list.appendChild(makeBubble(m.role, m.content)));
      scrollBottom();
    }
    refreshDemoBar();
    renderMem();
    autosize();
    input.focus();
  })();
})();
