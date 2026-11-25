(() => {
  const $ = (id) => document.getElementById(id);
  const list = $('list');
  const input = $('input');
  const sendBtn = $('send');

  // 折叠 / 展开侧栏（形象 + 下棋）
  const layout = $('companion-layout');
  const collapseBtn = $('avatar-collapse');
  const COLLAPSE_KEY = 'companion.avatarCollapsed.v1';
  if (layout && collapseBtn) {
    // 恢复上次的折叠状态
    if (localStorage.getItem(COLLAPSE_KEY) === '1') layout.classList.add('collapsed');
    const expandBtn0 = $('avatar-expand');
    if (expandBtn0) expandBtn0.hidden = localStorage.getItem(COLLAPSE_KEY) !== '1';
    collapseBtn.addEventListener('click', () => {
      const collapsed = layout.classList.toggle('collapsed');
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
      collapseBtn.title = collapsed ? '展开侧栏' : '收起侧栏';
      const expandBtn = $('avatar-expand');
      if (expandBtn) expandBtn.hidden = !collapsed;
    });
    const expandBtn = $('avatar-expand');
    if (expandBtn) expandBtn.addEventListener('click', () => collapseBtn.click());
  }

  // 拖拽分隔条调整侧栏与聊天区的上下比例（移动端）
  const splitBar = $('split-bar');
  if (splitBar && layout) {
    let dragging = false;
    const SPLIT_KEY = 'companion.splitHeight.v1';
    const savedH = parseFloat(localStorage.getItem(SPLIT_KEY));
    if (Number.isFinite(savedH) && savedH >= 20 && savedH <= 92) {
      layout.style.setProperty('--side-h', savedH + '%');
    }
    splitBar.addEventListener('pointerdown', (e) => {
      dragging = true;
      splitBar.setPointerCapture && splitBar.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    splitBar.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const rect = layout.getBoundingClientRect();
      let pct = ((e.clientY - rect.top) / rect.height) * 100;
      pct = Math.max(20, Math.min(92, pct));
      layout.style.setProperty('--side-h', pct + '%');
    });
    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      const pct = parseFloat(layout.style.getPropertyValue('--side-h')) || 72;
      localStorage.setItem(SPLIT_KEY, String(pct));
    };
    splitBar.addEventListener('pointerup', endDrag);
    splitBar.addEventListener('pointercancel', endDrag);
  }

  const BASE = '/liao';
  const LS = {
    hist: 'companion.history.v3',
    notes: 'companion.notes.v4',
    thread: 'companion.thread.v1',
  };
  const EMPTY_NOTES = { about_you: [], how_to_talk: [], between_us: [], about_me: [] };
  // 本地缓存多少条：够翻一段历史，又不至于把 localStorage 撑爆
  const CACHE_MAX = 600;

  const S = {
    history: [],
    total: 0,
    hasMore: false,
    notes: normalizeNotes(EMPTY_NOTES),
    threadId: '',
    title: '',
    limit: 26,
    model: '',
    gen: 0,
    queue: [],
    idx: 0,
    done: true,
    wake: null,
    typing: null,
    notesBusy: false,
  };
  let ctrl = null;
  let saveTimer = null;

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
  // 两个设备各自的本地记录取并集，避免后保存的一方覆盖另一方
  function mergeMessages(server, local) {
    const seen = new Set();
    const out = [];
    for (const m of (Array.isArray(server) ? server : [])) {
      const key = (m && m.ts || '') + '|' + (m && m.role) + '|' + (m && m.content);
      seen.add(key);
      out.push(m);
    }
    for (const m of (Array.isArray(local) ? local : [])) {
      const key = (m && m.ts || '') + '|' + (m && m.role) + '|' + (m && m.content);
      if (!seen.has(key)) { seen.add(key); out.push(m); }
    }
    // 服务器只返回最近一段时，本地更老的消息会被拼到后面；按时间戳重新排好
    out.sort((a, b) => (Number(a && a.ts) || 0) - (Number(b && b.ts) || 0));
    return out;
  }
  const newId = () => 't-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  const titleOf = (h) => {
    const first = (h || []).find((m) => m.role === 'user');
    return first ? first.content.slice(0, 20) : '未命名';
  };

  // ---------- 视图 ----------
  function scrollBottom() {
    requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }
  // 图片是异步加载的，加载完会把内容撑高；只要用户没往上翻，就一直贴在底部
  let followBottom = true;
  let lastScrollTop = 0;
  list.addEventListener('scroll', () => {
    const t = list.scrollTop;
    if (t < lastScrollTop - 4) followBottom = false;
    else if (t > lastScrollTop + 4) followBottom = true;
    lastScrollTop = t;
  });
  function keepBottom() {
    if (followBottom) scrollBottom();
  }
  function setStatus(text, typing) {
    const el = $('status');
    el.textContent = text;
    el.classList.toggle('typing', !!typing);
  }
  function avatarState(state) {
    window.dispatchEvent(new CustomEvent('companion-avatar', { detail: { state } }));
  }
  // 游戏心声：只显示气泡（可选朗读），不写入聊天历史，避免污染记忆/事件卡
  function gameSay(text, withTts) {
    if (!text) return;
    if (withTts) prefetchTts(text);
    const bubbleEl = addBubble('assistant', text);
    if (withTts) enqueueTts(text, bubbleEl);
    // 写进短期上下文（她这几轮能接上），但打 game 标记，保存/事件卡时过滤
    S.history.push({ role: 'assistant', content: text, ts: Date.now(), meta: { game: true } });
  }

  // ---------- 下棋：井字棋 + 五子棋 ----------
  // 棋盘用 canvas 渲染（五子棋 15×15 用 DOM 格子会卡），落子决策来自后端 game-move（小喵本人）。
  // 3D 形象已断开，不再参与；以后想恢复形象，见 git 历史里的 avatar.js。
  const GAME_KEY = 'companion.game.v2';
  const TIC_KEY = 'companion.game.tictactoe.v1';
  const GOMOKU_KEY = 'companion.game.gomoku.v1';
  const G = {
    kind: 'tictactoe',   // 'tictactoe' | 'gomoku'
    size: 3,
    board: Array(9).fill(''),
    turn: 'user',        // 用户先手
    over: false,
    winner: '',          // 'user' | 'assistant' | 'draw'
    busy: false,
    lastMove: -1,
  };
  const boardEl = $('board');
  const gameStatusEl = $('game-status');
  const gameTitleEl = $('game-title');

  function makeBoard(size) { return Array(size * size).fill(''); }
  function gameKey() { return G.kind === 'gomoku' ? GOMOKU_KEY : TIC_KEY; }

  function loadGame() {
    // 优先读新键，兼容旧键
    const g = read(gameKey(), null) || read(GAME_KEY, null);
    if (g && Array.isArray(g.board)) {
      const size = Number(g.size) || (g.board.length === 225 ? 15 : g.board.length === 9 ? 3 : 0);
      if (size === 3 || size === 15) {
        G.kind = size === 15 ? 'gomoku' : 'tictactoe';
        G.size = size;
        G.board = g.board.slice();
        G.turn = g.turn === 'assistant' ? 'assistant' : 'user';
        G.over = !!g.over;
        G.winner = ['user', 'assistant', 'draw'].includes(g.winner) ? g.winner : '';
        G.lastMove = Number.isInteger(g.lastMove) ? g.lastMove : -1;
      }
    }
  }
  function saveGame() {
    write(gameKey(), { kind: G.kind, size: G.size, board: G.board, turn: G.turn, over: G.over, winner: G.winner, lastMove: G.lastMove });
  }
  function checkWinner(board, size) {
    const win = size === 15 ? 5 : 3;
    const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
    let winCells = null;
    for (let i = 0; i < size * size; i++) {
      const v = board[i];
      if (!v) continue;
      const r = Math.floor(i / size), c = i % size;
      for (const [dr, dc] of dirs) {
        const cells = [i];
        for (let step = -1; step <= 1; step += 2) {
          let rr = r + dr * step, cc = c + dc * step;
          while (rr >= 0 && rr < size && cc >= 0 && cc < size && board[rr * size + cc] === v) {
            cells.push(rr * size + cc);
            rr += dr * step; cc += dc * step;
          }
        }
        if (cells.length >= win) {
          const uniq = [...new Set(cells)];
          if (!winCells) return { winner: v, line: uniq };
        }
      }
    }
    return board.every((v) => v) ? { winner: 'draw', line: null } : { winner: '', line: null };
  }
  function drawBoardImage() {
    const size = G.size;
    if (G.kind === 'tictactoe') return drawTicImage();
    return drawGomokuImage(size);
  }
  function drawTicImage() {
    const SZ = 300;
    const cv = document.createElement('canvas');
    cv.width = SZ; cv.height = SZ;
    const ctx = cv.getContext('2d');
    const cell = SZ / 3;
    ctx.fillStyle = '#fdfaf7'; ctx.fillRect(0, 0, SZ, SZ);
    ctx.strokeStyle = '#c9b8b0'; ctx.lineWidth = 4; ctx.lineCap = 'round';
    for (let k = 1; k < 3; k++) {
      const p = cell * k;
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, SZ); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(SZ, p); ctx.stroke();
    }
    for (let i = 0; i < 9; i++) {
      const v = G.board[i];
      if (!v) continue;
      const r = Math.floor(i / 3), c = i % 3;
      const cx = c * cell + cell / 2, cy = r * cell + cell / 2;
      ctx.lineWidth = 12;
      if (v === 'user') {
        ctx.strokeStyle = '#6f9ed9';
        const off = cell * 0.24;
        ctx.beginPath();
        ctx.moveTo(cx - off, cy - off); ctx.lineTo(cx + off, cy + off);
        ctx.moveTo(cx + off, cy - off); ctx.lineTo(cx - off, cy + off);
        ctx.stroke();
      } else {
        ctx.strokeStyle = '#d98b8b';
        ctx.beginPath(); ctx.arc(cx, cy, cell * 0.27, 0, Math.PI * 2); ctx.stroke();
      }
    }
    return cv.toDataURL('image/png');
  }
  function drawGomokuImage(size) {
    const SZ = size === 15 ? 600 : 300;
    const cv = document.createElement('canvas');
    cv.width = SZ; cv.height = SZ;
    const ctx = cv.getContext('2d');
    const pad = SZ / (size + 1) / 2;
    const step = (SZ - pad * 2) / (size - 1);
    ctx.fillStyle = '#f8f1ea'; ctx.fillRect(0, 0, SZ, SZ);
    ctx.strokeStyle = '#c9b8b0'; ctx.lineWidth = size === 15 ? 2 : 4; ctx.lineCap = 'round';
    for (let k = 0; k < size; k++) {
      const p = pad + k * step;
      ctx.beginPath(); ctx.moveTo(pad, p); ctx.lineTo(SZ - pad, p); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(p, pad); ctx.lineTo(p, SZ - pad); ctx.stroke();
    }
    for (let i = 0; i < size * size; i++) {
      const v = G.board[i];
      if (!v) continue;
      const r = Math.floor(i / size), c = i % size;
      const cx = pad + c * step, cy = pad + r * step;
      if (v === 'user') {
        ctx.fillStyle = '#2f2f2f'; ctx.beginPath(); ctx.arc(cx, cy, step * 0.38, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillStyle = '#f5f5f5'; ctx.beginPath(); ctx.arc(cx, cy, step * 0.38, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#d98b8b'; ctx.lineWidth = 2; ctx.stroke();
      }
    }
    return cv.toDataURL('image/png');
  }
  function renderBoard() {
    if (!boardEl) return;
    const size = G.size;
    boardEl.innerHTML = '';
    // 井字棋：用 DOM 格子（✕ / ◯），保持原有观感
    if (G.kind === 'tictactoe') {
      boardEl.classList.remove('gomoku');
      const winLine = G.winner && G.winner !== 'draw' ? (checkWinner(G.board, 3).line || []) : [];
      for (let i = 0; i < 9; i++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.setAttribute('role', 'gridcell');
        const v = G.board[i];
        if (v === 'user') { cell.textContent = '✕'; cell.classList.add('occupied', 'you'); }
        else if (v === 'assistant') { cell.textContent = '◯'; cell.classList.add('occupied', 'me'); }
        if (winLine.includes(i)) cell.classList.add('win');
        cell.addEventListener('click', () => userMove(i));
        boardEl.appendChild(cell);
      }
    } else {
      // 五子棋：canvas 黑白子
      boardEl.classList.add('gomoku');
      renderGomokuCanvas(boardEl, size);
    }
    // 状态文字
    if (G.over) {
      if (G.winner === 'user') gameStatusEl.textContent = '你赢啦';
      else if (G.winner === 'assistant') gameStatusEl.textContent = '小喵赢啦';
      else if (G.winner === 'draw') gameStatusEl.textContent = '平局';
      else gameStatusEl.textContent = '轮到你';
    } else {
      gameStatusEl.textContent = G.turn === 'user' ? '轮到你' : '小喵在想…';
    }
  }
  function renderGomokuCanvas(container, size) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 600;
    cv.style.width = '100%';
    cv.style.height = '100%';
    container.appendChild(cv);
    const ctx = cv.getContext('2d');
    const SZ = cv.width;
    const pad = SZ / (size + 1) / 2;
    const step = (SZ - pad * 2) / (size - 1);
    ctx.fillStyle = '#f8f1ea'; ctx.fillRect(0, 0, SZ, SZ);
    ctx.strokeStyle = '#c9b8b0'; ctx.lineWidth = size === 15 ? 2 : 4; ctx.lineCap = 'round';
    for (let k = 0; k < size; k++) {
      const p = pad + k * step;
      ctx.beginPath(); ctx.moveTo(pad, p); ctx.lineTo(SZ - pad, p); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(p, pad); ctx.lineTo(p, SZ - pad); ctx.stroke();
    }
    // 五子棋画星位
    ctx.fillStyle = '#c9b8b0';
    for (const [r, c] of [[3,3],[3,11],[7,7],[11,3],[11,11]]) {
      ctx.beginPath(); ctx.arc(pad + c * step, pad + r * step, 3, 0, Math.PI * 2); ctx.fill();
    }
    // 获胜连线高亮
    const winLine = G.winner && G.winner !== 'draw' ? (checkWinner(G.board, size).line || []) : [];
    if (winLine.length) {
      ctx.strokeStyle = '#ffd24a'; ctx.lineWidth = size === 15 ? 5 : 6; ctx.lineCap = 'round';
      ctx.beginPath();
      winLine.forEach((idx, n) => {
        const r = Math.floor(idx / size), c = idx % size;
        const x = pad + c * step, y = pad + r * step;
        if (n === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
    // 棋子
    for (let i = 0; i < size * size; i++) {
      const v = G.board[i];
      if (!v) continue;
      const r = Math.floor(i / size), c = i % size;
      const cx = pad + c * step, cy = pad + r * step;
      if (v === 'user') {
        ctx.fillStyle = '#2f2f2f'; ctx.beginPath(); ctx.arc(cx, cy, step * 0.4, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillStyle = '#f7f7f7'; ctx.beginPath(); ctx.arc(cx, cy, step * 0.4, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#d98b8b'; ctx.lineWidth = 2; ctx.stroke();
      }
    }
    if (G.lastMove >= 0) {
      const r = Math.floor(G.lastMove / size), c = G.lastMove % size;
      ctx.strokeStyle = '#07c160'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(pad + c * step, pad + r * step, step * 0.5, 0, Math.PI * 2); ctx.stroke();
    }
    cv.addEventListener('click', (e) => {
      const rect = cv.getBoundingClientRect();
      const x = (e.clientX - rect.left) * (SZ / rect.width);
      const y = (e.clientY - rect.top) * (SZ / rect.height);
      const c = Math.round((x - pad) / step);
      const r = Math.round((y - pad) / step);
      if (r >= 0 && r < size && c >= 0 && c < size) userMove(r * size + c);
    });
  }
  function currentGame() {
    return { kind: G.kind, size: G.size, board: G.board, turn: G.turn, over: G.over, winner: G.winner };
  }
  function resetGame() {
    G.board = makeBoard(G.size);
    G.turn = 'user';
    G.over = false;
    G.winner = '';
    G.busy = false;
    G.lastMove = -1;
    saveGame();
    renderBoard();
  }
  async function aiFirst() {
    if (G.busy) return;
    G.board = makeBoard(G.size);
    G.turn = 'assistant';
    G.over = false;
    G.winner = '';
    G.busy = false;
    G.lastMove = -1;
    saveGame();
    renderBoard();
    await assistantMove();
  }
  async function userMove(i) {
    if (G.over || G.busy || G.turn !== 'user' || G.board[i]) return;
    G.board[i] = 'user';
    G.lastMove = i;
    G.turn = 'assistant';
    applyResult();
    saveGame();
    renderBoard();
    if (G.over) { announceResult(); return; }
    await assistantMove();
  }
  function applyResult() {
    const r = checkWinner(G.board, G.size);
    G.winner = r.winner;
    G.over = !!r.winner;
    if (G.over) G.turn = '';
  }
  async function announceResult() {
    if (!G.over) return;
    try {
      const r = await fetch(BASE + '/game-over', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: G.kind,
          size: G.size,
          board: G.board,
          winner: G.winner,
          notes: S.notes,
          messages: S.history.slice(-S.limit),
        }),
      });
      if (!r.ok) return;
      const d = await r.json();
      if (d && d.say) {
        gameSay(d.say, true);
      }
    } catch {}
  }
  async function assistantMove() {
    G.busy = true;
    renderBoard();
    try {
      const image = drawBoardImage();
      const r = await fetch(BASE + '/game-move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: G.kind,
          size: G.size,
          board: G.board,
          image,
          notes: S.notes,
          messages: S.history.slice(-S.limit),
        }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      if (d && d.move && d.move.index != null && !G.board[d.move.index]) {
        G.board[d.move.index] = 'assistant';
        G.lastMove = d.move.index;
        G.turn = 'user';
        applyResult();
        saveGame();
        if (d.say) {
          gameSay(d.say, false);
        }
      }
      if (G.over) announceResult();
    } catch {
      G.turn = 'user';
    } finally {
      G.busy = false;
      renderBoard();
    }
  }
  // 模式切换：井字棋 / 五子棋 / 便签 / 形象（形象已隐藏）
  function switchGameMode(mode) {
    const avatarShell = $('avatar-shell');
    const gameShell = $('game-shell');
    const memoShell = $('memo-shell');
    const drawShell = $('draw-shell');
    const xiangqiShell = $('xiangqi-shell');
    if (avatarShell) avatarShell.hidden = mode !== 'avatar';
    if (gameShell) gameShell.hidden = mode !== 'game' && mode !== 'gomoku';
    if (memoShell) memoShell.hidden = mode !== 'memo';
    if (drawShell) drawShell.hidden = mode !== 'draw';
    if (xiangqiShell) xiangqiShell.hidden = mode !== 'xiangqi';
    if (mode === 'avatar') return;
    if (mode === 'memo') {
      localStorage.setItem('companion.panelMode.v1', mode);
      loadMemoList();
      return;
    }
    if (mode === 'draw') {
      localStorage.setItem('companion.panelMode.v1', mode);
      loadDraw();
      return;
    }
    if (mode === 'xiangqi') {
      localStorage.setItem('companion.panelMode.v1', mode);
      xqEnsure();
      return;
    }
    const kind = mode === 'gomoku' ? 'gomoku' : 'tictactoe';
    if (G.kind !== kind) {
      G.kind = kind;
      G.size = kind === 'gomoku' ? 15 : 3;
      const saved = read(gameKey(), null);
      if (saved && Array.isArray(saved.board) && saved.board.length === G.size * G.size) {
        G.board = saved.board.slice();
        G.turn = saved.turn === 'assistant' ? 'assistant' : 'user';
        G.over = !!saved.over;
        G.winner = ['user', 'assistant', 'draw'].includes(saved.winner) ? saved.winner : '';
        G.lastMove = Number.isInteger(saved.lastMove) ? saved.lastMove : -1;
      } else {
        G.board = makeBoard(G.size);
        G.turn = 'user';
        G.over = false;
        G.winner = '';
        G.lastMove = -1;
      }
      if (gameTitleEl) gameTitleEl.textContent = kind === 'gomoku' ? '五子棋' : '井字棋';
      renderBoard();
    }
    localStorage.setItem('companion.panelMode.v1', mode);
  }
  document.querySelectorAll('.mode-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.mode-tab').forEach((t) => t.classList.toggle('active', t === tab));
      switchGameMode(tab.dataset.mode);
    });
  });
  // 默认井字棋（形象已隐藏）
  const savedMode = ['gomoku', 'memo', 'draw', 'xiangqi'].includes(localStorage.getItem('companion.panelMode.v1'))
    ? localStorage.getItem('companion.panelMode.v1')
    : 'game';
  localStorage.setItem('companion.panelMode.v1', savedMode);
  // 延迟恢复默认模式：等所有模块（尤其象棋的 XQ）初始化完毕，避免 TDZ 报错
  setTimeout(() => {
    document.querySelectorAll('.mode-tab').forEach((t) => {
      if (t.dataset.mode === savedMode) t.click();
    });
  }, 0);

  // ---------- 便签纸 ----------
  // 第一步：纯文字便签，可新建/编辑/删除，服务端自动保存，电脑手机同步。
  const M = {
    list: [],
    currentId: '',
    authors: [],
    pendingWrite: '',
    saveTimer: null,
    reqSeq: 0,
  };
  const memoListEl = $('memo-list');
  const memoEditorEl = $('memo-editor');

  async function loadMemoList(preferredId) {
    const seq = ++M.reqSeq;
    try {
      const r = await fetch(BASE + '/memos', { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      if (seq !== M.reqSeq) return;
      M.list = Array.isArray(d.memos) ? d.memos : [];
      renderMemoList();
      if (preferredId) {
        const m = M.list.find((x) => x.id === preferredId);
        if (m && memoEditorEl && memoEditorEl.value === '') {
          M.currentId = m.id;
          memoEditorEl.value = m.content || '';
          renderMemoList();
        }
      }
    } catch {}
  }
  function renderMemoList() {
    if (!memoListEl) return;
    memoListEl.innerHTML = '';
    for (const m of M.list) {
      const wrap = document.createElement('span');
      wrap.className = 'memo-tab-wrap';
      const b = document.createElement('button');
      b.className = 'memo-tab-item' + (m.id === M.currentId ? ' active' : '');
      b.textContent = m.title || '未命名';
      b.addEventListener('click', () => selectMemo(m.id));
      const edit = document.createElement('button');
      edit.className = 'draw-list-edit';
      edit.textContent = '改';
      edit.title = '重命名';
      edit.addEventListener('click', (e) => { e.stopPropagation(); memoInlineRename(wrap, m.id); });
      wrap.appendChild(b);
      wrap.appendChild(edit);
      memoListEl.appendChild(wrap);
    }
  }
  // 就地重命名便签：标签变成输入框 + 存/取消
  function memoInlineRename(wrap, id) {
    const cur = M.list.find((x) => x.id === id);
    const input = document.createElement('input');
    input.type = 'text';
    input.value = (cur && cur.title && cur.title !== '未命名') ? cur.title : '';
    input.className = 'mem-edit-input';
    input.maxLength = 6;
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'mini';
    save.textContent = '存';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'mini';
    cancel.textContent = '取消';
    wrap.innerHTML = '';
    wrap.appendChild(input);
    wrap.appendChild(save);
    wrap.appendChild(cancel);
    for (const el of [input, save, cancel]) {
      el.addEventListener('click', (e) => e.stopPropagation());
      el.addEventListener('dblclick', (e) => e.stopPropagation());
    }
    input.focus();
    let done = false;
    const finish = () => { if (!done) { done = true; renderMemoList(); } };
    save.addEventListener('click', async () => {
      const title = input.value.trim().slice(0, 6) || '未命名';
      try {
        const r = await fetch(BASE + '/memo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'rename', id, title }),
        });
        if (r.ok) {
          const d = await r.json();
          if (d && d.memo) {
            const i = M.list.findIndex((x) => x.id === id);
            if (i >= 0) M.list[i].title = d.memo.title;
          }
        }
      } catch {}
      finish();
    });
    cancel.addEventListener('click', finish);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save.click();
      if (e.key === 'Escape') finish();
    });
  }
  async function selectMemo(id, silent) {
    const seq = ++M.reqSeq;
    try {
      // 切换前先保存当前编辑内容，避免丢失
      if (memoEditorEl && memoEditorEl.value.trim()) {
        await saveMemoNow();
      }
      const r = await fetch(BASE + '/memo?id=' + encodeURIComponent(id), { cache: 'no-store' });
      if (!r.ok) return;
      const memo = await r.json();
      if (seq !== M.reqSeq) return;
      if (memo && memo.id) {
        M.currentId = memo.id;
        if (memoEditorEl) memoEditorEl.value = memo.content || '';
        M.authors = Array.isArray(memo.events) ? memo.events : (Array.isArray(memo.authors) ? memo.authors : []);
        renderMemoList();
        if (!silent) localStorage.setItem('companion.memo.current', memo.id);
      }
    } catch {}
  }
  async function saveMemoNow(author) {
    if (!memoEditorEl) return;
    const content = memoEditorEl.value;
    // 空内容且还没有 id 时，不落盘，避免积累空便签
    if (!content.trim() && !M.currentId) return;
    const id = M.currentId || undefined;
    const title = content.split('\n').find((l) => l.trim()) || '';
    try {
      const r = await fetch(BASE + '/memo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save', id, content, title: title.slice(0, 6), author: author || 'user' }),
      });
      if (!r.ok) return;
      const d = await r.json();
      if (d && d.memo) {
        M.currentId = d.memo.id;
        M.authors = Array.isArray(d.memo.events) ? d.memo.events : (Array.isArray(d.memo.authors) ? d.memo.authors : M.authors);
        localStorage.setItem('companion.memo.current', d.memo.id);
        const i = M.list.findIndex((x) => x.id === d.memo.id);
        const item = { id: d.memo.id, title: d.memo.title || '未命名', content: d.memo.content, createdAt: d.memo.createdAt, updatedAt: d.memo.updatedAt };
        if (i >= 0) M.list[i] = item;
        else M.list.unshift(item);
        renderMemoList();
      }
    } catch {}
  }
  function scheduleMemoSave() {
    clearTimeout(M.saveTimer);
    M.saveTimer = setTimeout(saveMemoNow, 800);
  }
  async function newMemo() {
    // 新建前先保存当前内容，避免丢掉刚写的东西
    if (memoEditorEl && memoEditorEl.value.trim()) {
      await saveMemoNow();
    }
    if (memoEditorEl) memoEditorEl.value = '';
    M.currentId = '';
    M.authors = [];
    renderMemoList();
    if (memoEditorEl) memoEditorEl.focus();
  }
  async function deleteMemo() {
    if (!M.currentId) return;
    const id = M.currentId;
    try {
      const r = await fetch(BASE + '/memo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id }),
      });
      if (!r.ok) return;
      M.currentId = '';
      if (memoEditorEl) memoEditorEl.value = '';
      localStorage.removeItem('companion.memo.current');
      await loadMemoList();
    } catch {}
  }
  // 她写在纸上：把她写的内容追加到便签
  async function applyMemoWrite(clean) {
    clean = String(clean || '').trim();
    if (!clean) return;
    // 若还没有当前便签，先创建一个
    if (!M.currentId && memoEditorEl) {
      M.currentId = '';
    }
    let existing = '';
    if (M.currentId) {
      try {
        const r = await fetch(BASE + '/memo?id=' + encodeURIComponent(M.currentId), { cache: 'no-store' });
        if (r.ok) {
          const memo = await r.json();
          existing = memo && memo.content ? memo.content : '';
        }
      } catch {}
    }
    const merged = existing.trim() ? existing.replace(/\s+$/, '') + '\n\n' + clean : clean;
    if (memoEditorEl) memoEditorEl.value = merged;
    await saveMemoNow('assistant');
  }
  // 让她续写：调用独立接口，把她的续写落到纸上
  async function askMemoWrite(instructionText) {
    const statusEl = $('memo-status');
    if (statusEl) statusEl.textContent = '小喵在想…';
    if (!M.currentId) {
      // 没有当前便签时，先把编辑器现有内容存成一张
      if (memoEditorEl && memoEditorEl.value.trim()) {
        await saveMemoNow('user');
      }
      if (!M.currentId) {
        // 仍然没有（完全空白）：先创建一张空的
        if (memoEditorEl) memoEditorEl.value = '';
        M.currentId = '';
        if (statusEl) statusEl.textContent = '';
        return;
      }
    }
    const instruction = instructionText || input.value.trim();
    try {
      const r = await fetch(BASE + '/memo-write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: M.currentId,
          instruction,
          notes: S.notes,
          messages: S.history.slice(-S.limit),
        }),
      });
      if (!r.ok) { if (statusEl) statusEl.textContent = ''; return; }
      const d = await r.json();
      if (d && d.written) {
        const memo = d.memo || null;
        if (memoEditorEl && memo) memoEditorEl.value = memo.content || '';
        if (memo) M.authors = Array.isArray(memo.events) ? memo.events : M.authors;
        // 提示用户她写到了纸上
        addBubble('assistant', '我写在纸上了：' + d.written);
        S.history.push({ role: 'assistant', content: '我写在纸上了：' + d.written, ts: Date.now() });
        scheduleSave(200);
        await loadMemoList(M.currentId);
      }
    } catch {} finally {
      if (statusEl) statusEl.textContent = '';
    }
  }
  // 事件绑定
  const memoNewBtn = $('memo-new');
  if (memoNewBtn) memoNewBtn.addEventListener('click', newMemo);
  const memoDelBtn = $('memo-del');
  if (memoDelBtn) memoDelBtn.addEventListener('click', deleteMemo);
  const memoAiWriteBtn = $('memo-ai-write');
  if (memoAiWriteBtn) memoAiWriteBtn.addEventListener('click', askMemoWrite);
  if (memoEditorEl) memoEditorEl.addEventListener('input', scheduleMemoSave);

  // ---------- 画板 ----------
  // 一张一张的画纸：可新建/切换/删除/重命名，服务端同步；默认自由画画。
  const DRAW_KEY = 'companion.drawing.v1';
  const D = {
    id: '',
    list: [],
    strokes: [],
    tool: 'pen',
    drawing: false,
    current: null,
    color: '#5a4a3f',
    size: 3,
    reqSeq: 0,
    loadedFromServer: false,
    ready: false,
  };
  const drawCanvasEl = $('draw-canvas');
  const drawStatusEl = $('draw-status');
  const drawListEl = $('draw-list');

  function drawId() {
    if (!D.id) {
      D.id = read('companion.drawing.current', '');
      if (!D.id) D.id = 'draw-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    }
    return D.id;
  }
  function drawTitle(id) {
    const item = D.list.find((x) => x.id === id);
    return item ? (item.title || '未命名') : '未命名';
  }
  function renderDrawList() {
    if (!drawListEl) return;
    drawListEl.innerHTML = '';
    for (const item of D.list) {
      const wrap = document.createElement('span');
      wrap.className = 'draw-list-item-wrap';
      const b = document.createElement('button');
      b.className = 'draw-list-item' + (item.id === D.id ? ' active' : '');
      b.textContent = (item.title || '未命名') + ' ' + (item.strokes || 0) + '笔';
      b.addEventListener('click', () => selectDraw(item.id));
      const edit = document.createElement('button');
      edit.className = 'draw-list-edit';
      edit.textContent = '改';
      edit.title = '重命名';
      edit.addEventListener('click', (e) => { e.stopPropagation(); drawInlineRename(wrap, item.id); });
      wrap.appendChild(b);
      wrap.appendChild(edit);
      drawListEl.appendChild(wrap);
    }
  }
  // 就地重命名：标签变成输入框 + 存/取消
  function drawInlineRename(wrap, id) {
    // 临时禁用 wrap 的点击切换，防止输入框被重建掉
    wrap.dataset.editing = '1';
    const cur = drawTitle(id);
    const input = document.createElement('input');
    input.type = 'text';
    input.value = cur === '未命名' ? '' : cur;
    input.className = 'mem-edit-input';
    input.maxLength = 12;
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'mini';
    save.textContent = '存';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'mini';
    cancel.textContent = '取消';
    wrap.innerHTML = '';
    wrap.appendChild(input);
    wrap.appendChild(save);
    wrap.appendChild(cancel);
    // 阻止点击输入框/按钮时冒泡触发 wrap 的 click（避免误切换）
    for (const el of [input, save, cancel]) {
      el.addEventListener('click', (e) => e.stopPropagation());
      el.addEventListener('dblclick', (e) => e.stopPropagation());
    }
    input.focus();
    let done = false;
    const finish = () => { if (!done) { done = true; renderDrawList(); } };
    save.addEventListener('click', async () => {
      const title = input.value.trim().slice(0, 12) || '未命名';
      try {
        const r = await fetch(BASE + '/drawing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'rename', id, title }),
        });
        if (r.ok) {
          const d = await r.json();
          if (d && d.drawing) {
            const i = D.list.findIndex((x) => x.id === id);
            if (i >= 0) D.list[i].title = d.drawing.title;
          }
        }
      } catch {}
      finish();
    });
    cancel.addEventListener('click', finish);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save.click();
      if (e.key === 'Escape') finish();
    });
  }
  async function loadDrawList(preferredId) {
    const seq = ++D.reqSeq;
    try {
      const r = await fetch(BASE + '/drawings', { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      if (seq !== D.reqSeq) return;
      D.list = Array.isArray(d.drawings) ? d.drawings : [];
      renderDrawList();
    } catch {}
  }
  async function selectDraw(id, silent) {
    const seq = ++D.reqSeq;
    try {
      const r = await fetch(BASE + '/drawing?id=' + encodeURIComponent(id), { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      if (seq !== D.reqSeq) return;
      if (d && d.id) {
        D.id = d.id;
        D.strokes = Array.isArray(d.strokes) ? d.strokes : [];
        D.loadedFromServer = true;
        D.ready = true;
        renderDraw();
        renderDrawList();
        if (!silent) write('companion.drawing.current', D.id);
      }
    } catch {}
  }
  function renderDraw() {
    if (!drawCanvasEl) return;
    const cv = drawCanvasEl;
    const wrap = cv.parentElement;
    if (!wrap) return;
    const side = Math.max(1, Math.floor(Math.min(wrap.clientWidth, wrap.clientHeight || wrap.clientWidth)));
    if (side > 0 && (cv.width !== side || cv.height !== side)) {
      cv.width = side;
      cv.height = side;
    }
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = '#fffdf7';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of D.strokes) {
      if (!s || !Array.isArray(s.points) || s.points.length < 1) continue;
      const pts = s.points.map((p) => [p[0] * cv.width, p[1] * cv.height]);
      ctx.strokeStyle = s.color || '#5a4a3f';
      ctx.lineWidth = s.size || 3;
      if (pts.length === 1) {
        ctx.fillStyle = s.color || '#5a4a3f';
        ctx.beginPath();
        ctx.arc(pts[0][0], pts[0][1], (s.size || 3) / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.stroke();
      }
    }
  }
  function saveDraw() {
    if (!D.ready) return;
    try {
      const id = drawId();
      fetch(BASE + '/drawing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save', id, strokes: D.strokes, title: drawTitle(id) }),
      }).then(() => loadDrawList(id));
      write('companion.drawing.current', id);
      write(DRAW_KEY, D.strokes);
    } catch {}
  }
  async function loadDraw() {
    D.ready = false;
    const id = read('companion.drawing.current', '');
    if (id) D.id = id;
    // 拉列表，确定要加载哪张
    await loadDrawList();
    let target = D.id;
    if (!D.list.find((x) => x.id === target)) {
      target = D.list.length ? D.list[0].id : '';
    }
    if (target) {
      await selectDraw(target, true);
    } else {
      // 没有画纸：新建一张空的，并标记 ready，避免误保存覆盖
      D.id = 'draw-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
      D.strokes = [];
      D.ready = true;
      write('companion.drawing.current', D.id);
      renderDraw();
    }
  }
  // 画布尺寸：用 ResizeObserver 跟随容器，修复刷新后压扁的问题
  if (drawCanvasEl && typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => renderDraw());
    const wrap = drawCanvasEl.parentElement;
    if (wrap) ro.observe(wrap);
  }
  function toNorm(e, cv) {
    const rect = cv.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width);
    const y = ((e.clientY - rect.top) / rect.height);
    return [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))];
  }
  function exportDrawImage() {
    try {
      if (!D.strokes.length) return '';
      const cv = document.createElement('canvas');
      cv.width = cv.height = 640;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fffdf7';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const s of D.strokes) {
        if (!s || !Array.isArray(s.points) || s.points.length < 1) continue;
        const pts = s.points.map((p) => [p[0] * cv.width, p[1] * cv.height]);
        ctx.strokeStyle = s.color || '#5a4a3f';
        ctx.lineWidth = (s.size || 3) * 3;
        if (pts.length === 1) {
          ctx.fillStyle = s.color || '#5a4a3f';
          ctx.beginPath();
          ctx.arc(pts[0][0], pts[0][1], (s.size || 3), 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.moveTo(pts[0][0], pts[0][1]);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
          ctx.stroke();
        }
      }
      return cv.toDataURL('image/png');
    } catch { return ''; }
  }
  if (drawCanvasEl) {
    drawCanvasEl.addEventListener('pointerdown', (e) => {
      if (D.tool === 'eraser') return;
      e.preventDefault();
      drawCanvasEl.setPointerCapture && drawCanvasEl.setPointerCapture(e.pointerId);
      D.drawing = true;
      D.current = {
        kind: 'stroke',
        points: [toNorm(e, drawCanvasEl)],
        color: D.color,
        size: D.size,
        author: 'user',
        ts: Date.now(),
      };
      D.strokes.push(D.current);
      renderDraw();
    });
    drawCanvasEl.addEventListener('pointermove', (e) => {
      if (!D.drawing || !D.current) return;
      D.current.points.push(toNorm(e, drawCanvasEl));
      renderDraw();
    });
    const endDraw = () => {
      if (D.drawing) {
        D.drawing = false;
        D.current = null;
        saveDraw();
      }
    };
    drawCanvasEl.addEventListener('pointerup', endDraw);
    drawCanvasEl.addEventListener('pointercancel', endDraw);
    drawCanvasEl.addEventListener('click', (e) => {
      if (D.tool === 'eraser') {
        const [nx, ny] = toNorm(e, drawCanvasEl);
        let best = -1;
        let bestDist = 0.05;
        D.strokes.forEach((s, i) => {
          for (const p of (s.points || [])) {
            const d = Math.hypot(p[0] - nx, p[1] - ny);
            if (d < bestDist) { bestDist = d; best = i; }
          }
        });
        if (best >= 0) {
          D.strokes.splice(best, 1);
          renderDraw();
          saveDraw();
        }
      }
    });
  }
  const penBtn = $('tool-pen');
  const eraserBtn = $('tool-eraser');
  if (penBtn && eraserBtn) {
    penBtn.addEventListener('click', () => {
      D.tool = 'pen';
      penBtn.classList.add('active');
      eraserBtn.classList.remove('active');
      drawCanvasEl.style.cursor = 'crosshair';
    });
    eraserBtn.addEventListener('click', () => {
      D.tool = 'eraser';
      eraserBtn.classList.add('active');
      penBtn.classList.remove('active');
      drawCanvasEl.style.cursor = 'cell';
    });
  }
  const undoBtn = $('draw-undo');
  if (undoBtn) undoBtn.addEventListener('click', () => {
    D.strokes.pop();
    renderDraw();
    saveDraw();
  });
  const clearBtn = $('draw-clear');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    D.strokes = [];
    renderDraw();
    saveDraw();
  });
  const drawNewBtn = $('draw-new');
  if (drawNewBtn) drawNewBtn.addEventListener('click', async () => {
    if (D.id) saveDraw();
    D.id = 'draw-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    write('companion.drawing.current', D.id);
    D.strokes = [];
    D.loadedFromServer = true;
    renderDraw();
    renderDrawList();
    saveDraw();
  });
  const drawDelBtn = $('draw-del');
  if (drawDelBtn) drawDelBtn.addEventListener('click', async () => {
    if (!D.id) return;
    const id = D.id;
    try {
      const r = await fetch(BASE + '/drawing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id }),
      });
      if (!r.ok) return;
      D.id = '';
      D.strokes = [];
      renderDraw();
      localStorage.removeItem('companion.drawing.current');
      await loadDrawList();
    } catch {}
  });
  const drawShowBtn = $('draw-show');
  if (drawShowBtn) drawShowBtn.addEventListener('click', () => {
    if (!D.strokes.length) {
      if (drawStatusEl) drawStatusEl.textContent = '还没有画呢';
      setTimeout(() => { if (drawStatusEl) drawStatusEl.textContent = ''; }, 1500);
      return;
    }
    const img = exportDrawImage();
    if (!img) return;
    pendingImages.push(img);
    input.value = '你看我画了什么？';
    autosize();
    send();
  });


  // ---------- 中国象棋 ----------
  // 引擎用现成的 WUKONG（MIT），她只负责把 AI 的下一步意图说成人话。
  const XQ_KEY = 'companion.xq.v1';
  const XQ = {
    id: 'xq-main',
    board: [],
    side: 0,          // 0=红(你), 1=黑(她)
    over: false,
    winner: '',
    busy: false,
    selected: -1,
    legalMoves: [],
    engine: null,
    aiSide: 1,
    depth: 1,
    lastMove: -1,
    startFen: '',
  };
  const xqBoardEl = $('xiangqi-board');
  const xqStatusEl = $('xiangqi-status');

  function initXq() {
    if (XQ.engine) return;
    try {
      if (typeof Engine === 'function') {
        XQ.engine = new Engine();
        // 引擎构造后不会自动摆初始局面，需要显式设置
        XQ.engine.setBoard(XQ.engine.START_FEN);
        XQ.startFen = XQ.engine.START_FEN;
      }
    } catch (e) { console.error('[xq] 引擎初始化失败', e); }
  }
  function xqPieceAt(sq) {
    if (!XQ.engine) return 0;
    return XQ.engine.getPiece(sq);
  }
  // 把 mailbox square index 转成 UI 行/列（红方在底部）
  // COORDINATES: a9 在 rank2, a0 在 rank12；我们 UI 行 0=黑方顶(a9)，行 9=红方底(a0)
  function xqSquareToRC(sq) {
    if (!XQ.engine) return null;
    const coord = XQ.engine.squareToString(sq);
    const m = coord.match(/^([a-i])(\d)$/);
    if (!m) return null;
    const file = m[1].charCodeAt(0) - 'a'.charCodeAt(0);
    const rank = 9 - Number(m[2]);  // rank 9 -> 行0(黑顶)，rank 0 -> 行9(红底)
    return { r: rank, c: file, sq };
  }
  function xqRCToSquare(r, c) {
    if (!XQ.engine) return -1;
    const rank = 9 - r;
    const file = String.fromCharCode('a'.charCodeAt(0) + c);
    return XQ.engine.moveFromString(file + rank + file + rank); // 占位，用 squareToString 反查
  }
  // 引擎没有直接 squareFromString 的公开接口，用遍历 getPiece 对应
  function xqFindSquareByRC(r, c) {
    if (!XQ.engine) return -1;
    const rank = 9 - r;
    const file = String.fromCharCode('a'.charCodeAt(0) + c);
    for (let sq = 0; sq < 154; sq++) {
      if (XQ.engine.squareToString(sq) === file + rank) return sq;
    }
    return -1;
  }
  function xqLoadBoard() {
    if (!XQ.engine) return;
    XQ.board = [];
    for (let sq = 0; sq < 154; sq++) {
      const coord = XQ.engine.squareToString(sq);
      if (coord && coord !== 'xx') XQ.board.push({ sq, coord, piece: XQ.engine.getPiece(sq) });
    }
  }
  function xqRender() {
    if (!xqBoardEl) return;
    const pieceNames = {
      1: '兵', 2: '仕', 3: '相', 4: '傌', 5: '炮', 6: '俥', 7: '帥',
      8: '卒', 9: '士', 10: '象', 11: '馬', 12: '砲', 13: '車', 14: '將',
    };
    let cv = xqBoardEl.querySelector('canvas');
    if (!cv) {
      cv = document.createElement('canvas');
      cv.className = 'xiangqi-canvas';
      xqBoardEl.appendChild(cv);
      cv.addEventListener('click', xqClickFromEvent);
    }
    const W = 900, H = 960;
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d');
    const padX = 60, padY = 60;
    const stepX = (W - padX * 2) / 8;
    const stepY = (H - padY * 2) / 9;
    // 背景
    ctx.fillStyle = '#f4e9d3';
    ctx.fillRect(0, 0, W, H);
    // 棋盘线
    ctx.strokeStyle = '#8a6a42';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    // 横线
    for (let r = 0; r < 10; r++) {
      const y = padY + r * stepY;
      ctx.beginPath();
      ctx.moveTo(padX, y);
      ctx.lineTo(W - padX, y);
      ctx.stroke();
    }
    // 竖线：上下两半中间断开（楚河汉界）
    for (let c = 0; c < 9; c++) {
      const x = padX + c * stepX;
      ctx.beginPath();
      ctx.moveTo(x, padY);
      ctx.lineTo(x, padY + 4 * stepY);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, padY + 5 * stepY);
      ctx.lineTo(x, H - padY);
      ctx.stroke();
    }
    // 两条边竖线贯通
    ctx.beginPath();
    ctx.moveTo(padX, padY); ctx.lineTo(padX, H - padY); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(W - padX, padY); ctx.lineTo(W - padX, H - padY); ctx.stroke();
    // 九宫格斜线
    const gx = [padX + 3 * stepX, padX + 5 * stepX];
    const gyTop = [padY, padY + 2 * stepY];
    const gyBot = [H - padY - 2 * stepY, H - padY];
    for (const [a, b] of [[0, 1], [1, 0]]) {
      ctx.beginPath();
      ctx.moveTo(gx[0], gyTop[a]); ctx.lineTo(gx[1], gyTop[b]); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(gx[0], gyBot[a]); ctx.lineTo(gx[1], gyBot[b]); ctx.stroke();
    }
    // 炮/兵位标记
    const marks = [
      [1, 2], [7, 2], [1, 7], [7, 7],
      [0, 3], [2, 3], [4, 3], [6, 3], [8, 3],
      [0, 6], [2, 6], [4, 6], [6, 6], [8, 6],
    ];
    ctx.fillStyle = '#8a6a42';
    for (const [c, r] of marks) {
      const x = padX + c * stepX;
      const y = padY + r * stepY;
      const d = 5;
      if (c === 0 || c === 8) {
        ctx.beginPath();
        ctx.moveTo(x - 8, y - 8); ctx.lineTo(x - 2, y - 2); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x + 8, y - 8); ctx.lineTo(x + 2, y - 2); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x - 8, y + 8); ctx.lineTo(x - 2, y + 2); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x + 8, y + 8); ctx.lineTo(x + 2, y + 2); ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.moveTo(x - 8, y - 8); ctx.lineTo(x - 2, y - 2); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x + 8, y - 8); ctx.lineTo(x + 2, y - 2); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x - 8, y + 8); ctx.lineTo(x - 2, y + 2); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x + 8, y + 8); ctx.lineTo(x + 2, y + 2); ctx.stroke();
      }
    }
    // 楚河汉界文字
    ctx.fillStyle = '#8a6a42';
    ctx.font = 'bold 28px "KaiTi", "STKaiti", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('楚  河', W * 0.27, padY + 4.5 * stepY);
    ctx.fillText('汉  界', W * 0.73, padY + 4.5 * stepY);
    // 棋子：画在交叉点上
    const pieceColors = { red: '#b4443c', black: '#333' };
    const threatened = new Set(xqThreatenedSquares());
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 9; c++) {
        const sq = xqFindSquareByRC(r, c);
        const piece = XQ.engine ? XQ.engine.getPiece(sq) : 0;
        if (!piece || !pieceNames[piece]) continue;
        const x = padX + c * stepX;
        const y = padY + r * stepY;
        const radius = Math.min(stepX, stepY) * 0.42;
        // 合法落点提示
        if (XQ.legalMoves.includes(sq)) {
          ctx.fillStyle = 'rgba(124, 191, 85, 0.45)';
          ctx.beginPath(); ctx.arc(x, y, radius + 4, 0, Math.PI * 2); ctx.fill();
        }
        // 棋子本体
        ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = '#fff9ef';
        ctx.fill();
        ctx.strokeStyle = '#b89a68';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = piece < 8 ? pieceColors.red : pieceColors.black;
        ctx.font = 'bold 50px "KaiTi", "STKaiti", "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(pieceNames[piece], x, y + 1);
        // 她下一步能直接吃掉的你的子：标红
        if (threatened.has(sq)) {
          ctx.strokeStyle = '#e04a3a';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(x, y, radius + 5, 0, Math.PI * 2);
          ctx.stroke();
        }
        // 最新一步的棋子加一圈标识
        if (XQ.lastMove === sq) {
          ctx.strokeStyle = '#07c160';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(x, y, radius + 5, 0, Math.PI * 2);
          ctx.stroke();
        }
        // 选中高亮：最后画，最醒目
        if (XQ.selected === sq) {
          ctx.fillStyle = 'rgba(255, 214, 74, 0.38)';
          ctx.beginPath(); ctx.arc(x, y, radius + 8, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
    if (XQ.over) {
      if (XQ.winner === 'user') xqStatusEl.textContent = '你赢啦';
      else if (XQ.winner === 'assistant') xqStatusEl.textContent = '她赢啦';
      else xqStatusEl.textContent = '和棋';
    } else {
      xqStatusEl.textContent = XQ.engine && XQ.engine.getSide() === XQ.aiSide ? '她在想…' : '轮到你';
    }
  }
  function xqClickFromEvent(e) {
    const cv = e.currentTarget;
    const rect = cv.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (cv.width / rect.width);
    const y = (e.clientY - rect.top) * (cv.height / rect.height);
    const padX = 60, padY = 60;
    const stepX = (cv.width - padX * 2) / 8;
    const stepY = (cv.height - padY * 2) / 9;
    const c = Math.round((x - padX) / stepX);
    const r = Math.round((y - padY) / stepY);
    if (r < 0 || r > 9 || c < 0 || c > 8) return;
    const sq = xqFindSquareByRC(r, c);
    if (sq >= 0) xqCellClick(sq);
  }
  function xqCellClick(sq) {
    if (!XQ.engine || XQ.over || XQ.busy) return;
    const side = XQ.engine.getSide();
    if (side !== 0) return; // 只允许用户走红方
    const piece = XQ.engine.getPiece(sq);
    // 点另一个己方棋子：直接切换选中
    if (piece >= 1 && piece <= 7 && sq !== XQ.selected) {
      XQ.selected = sq;
      const moves = XQ.engine.generateLegalMoves();
      XQ.legalMoves = moves.filter((m) => XQ.engine.getSourceSquare(m.move) === sq).map((m) => XQ.engine.getTargetSquare(m.move));
      xqRender();
      return;
    }
    if (XQ.selected === -1) {
      // 点的是空位或对方子且没有选中：忽略
      return;
    } else {
      const moves = XQ.engine.generateLegalMoves();
      const move = moves.find((m) => XQ.engine.getSourceSquare(m.move) === XQ.selected && XQ.engine.getTargetSquare(m.move) === sq);
      if (move) {
        // 吃子提示
        const capturedPiece = XQ.engine.getPiece(sq);
        const capturedName = capturedPiece ? xqPieceName(capturedPiece) : '';
        XQ.engine.makeMove(move.move);
        XQ.lastMove = sq;
        XQ.selected = -1;
        XQ.legalMoves = [];
        xqSave();
        xqRender();
        if (capturedName) {
          xqStatusEl.textContent = '你吃了她的' + capturedName;
          xqUserCaptureSay(capturedName);
        }
        // 你将军她（黑方 BLACK=1 被将军）：让她说一句
        if (XQ.engine.inCheck(1) === 1) {
          xqUserCheckSay();
        }
        xqCheckOver();
        if (!XQ.over) xqAiTurn();
      } else {
        XQ.selected = -1;
        XQ.legalMoves = [];
        xqRender();
      }
    }
  }
  async function xqAiTurn() {
    if (!XQ.engine || XQ.over) return;
    XQ.busy = true;
    xqStatusEl.textContent = '她在想…';
    try {
      // 给人「她在犹豫」的节奏：落子前停顿
      await new Promise((r) => setTimeout(r, 1000 + Math.random() * 900));
      if (XQ.over) { XQ.busy = false; return; }
      // 引擎计算下一步
      const move = XQ.engine.search(XQ.depth);
      if (move == null) { XQ.busy = false; return; }
      const from = XQ.engine.getSourceSquare(move);
      const to = XQ.engine.getTargetSquare(move);
      const moveStr = XQ.engine.moveToString(move);
      // 她走的这个子的名字
      const movingPiece = XQ.engine.getPiece(from);
      const movingName = movingPiece ? xqPieceName(movingPiece) : '';
      // 执行前读目标格：是否有被吃的子
      const capturedPiece = XQ.engine.getPiece(to);
      const capturedName = capturedPiece ? xqPieceName(capturedPiece) : '';
      // 行为和话语一起放出
      XQ.engine.makeMove(move);
      XQ.lastMove = to;
      // 走子后检测她是否将军你（红方 RED=0 被将军）
      const check = XQ.engine.inCheck(0) === 1;
      // 让语言模型解释这一步（若将军则明确说将军）
      const boardDesc = xqDescribeBoard();
      const say = await xqFetchSay(boardDesc, moveStr, check, capturedName);
      xqCheckOver();
      xqSave();
      xqRender();
      // 普通走子说「动一下XX」；吃子/将军用她生成的话
      const normalSay = movingName
        ? ['我动一下' + movingName + '。', '先走走我的' + movingName + '。', movingName + '往那边挪一下。'][Math.floor(Math.random() * 3)]
        : '';
      const finalSay = say || normalSay;
      if (finalSay) {
        gameSay(finalSay, false);
      }
    } catch (e) {
      console.error('[xq] AI 走子失败', e);
    } finally {
      XQ.busy = false;
    }
  }
  function xqDescribeBoard() {
    const pieceNames = {
      1: '兵', 2: '仕', 3: '相', 4: '傌', 5: '炮', 6: '俥', 7: '帥',
      8: '卒', 9: '士', 10: '象', 11: '馬', 12: '砲', 13: '車', 14: '將',
    };
    const lines = [];
    for (let r = 0; r < 10; r++) {
      const row = [];
      for (let c = 0; c < 9; c++) {
        const sq = xqFindSquareByRC(r, c);
        const p = XQ.engine.getPiece(sq);
        row.push(p ? (p < 8 ? '红' : '黑') + pieceNames[p] : '·');
      }
      lines.push(row.join(' '));
    }
    return lines.join('\n');
  }
  function xqPieceName(piece) {
    const pieceNames = {
      1: '兵', 2: '仕', 3: '相', 4: '傌', 5: '炮', 6: '俥', 7: '帥',
      8: '卒', 9: '士', 10: '象', 11: '馬', 12: '砲', 13: '車', 14: '將',
    };
    return pieceNames[piece] || '';
  }
  // 轮到你时：找出她下一步能直接吃掉的你的红子（黑方着法目标格是红子）
  function xqThreatenedSquares() {
    if (!XQ.engine || XQ.over) return [];
    const side = XQ.engine.getSide();
    if (side !== 0) return []; // 只在轮到你（红方）时提示
    // 引擎的 generateLegalMoves 只生成当前方；临时切到黑方来拿黑方着法
    const savedFen = xqExportFen();
    if (!savedFen) return [];
    const savedMoves = XQ.engine.getMoves().join(' ');
    const blackFen = savedFen.replace(/ (\w) - - 0 1$/, ' b - - 0 1');
    XQ.engine.setBoard(blackFen);
    const moves = XQ.engine.generateLegalMoves();
    const threatened = new Set();
    for (const m of moves) {
      const target = XQ.engine.getTargetSquare(m.move);
      const piece = XQ.engine.getPiece(target);
      if (piece >= 1 && piece <= 7) threatened.add(target);
    }
    // 恢复红方局面
    XQ.engine.setBoard(XQ.startFen || XQ.engine.START_FEN);
    if (savedMoves) XQ.engine.loadMoves(savedMoves);
    return [...threatened];
  }
  async function xqFetchSay(boardDesc, moveStr, check, capturedName) {
    try {
      const r = await fetch(BASE + '/xq-say', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          board: boardDesc,
          move: moveStr,
          check: !!check,
          captured: capturedName || '',
          notes: S.notes,
          messages: S.history.slice(-S.limit),
        }),
      });
      if (!r.ok) return '';
      const d = await r.json();
      return d && d.say ? d.say : '';
    } catch { return ''; }
  }
  // 你将军她：她反应过来自己被将军
  async function xqUserCheckSay() {
    try {
      const r = await fetch(BASE + '/xq-say', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          board: xqDescribeBoard(),
          move: '',
          check: 'self',
          notes: S.notes,
          messages: S.history.slice(-S.limit),
        }),
      });
      if (!r.ok) return;
      const d = await r.json();
      if (d && d.say) {
        gameSay(d.say, false);
      }
    } catch {}
  }
  // 你吃了她的子：她反应过来
  async function xqUserCaptureSay(capturedName) {
    try {
      const r = await fetch(BASE + '/xq-say', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          board: xqDescribeBoard(),
          move: '',
          check: '',
          captured: 'self:' + capturedName,
          notes: S.notes,
          messages: S.history.slice(-S.limit),
        }),
      });
      if (!r.ok) return;
      const d = await r.json();
      if (d && d.say) {
        gameSay(d.say, false);
      }
    } catch {}
  }
  function xqCheckOver() {
    if (!XQ.engine) return;
    // 简化判定：无合法着法即输
    const moves = XQ.engine.generateLegalMoves();
    if (!moves.length) {
      XQ.over = true;
      XQ.winner = XQ.engine.getSide() === XQ.aiSide ? 'user' : 'assistant';
      xqAnnounceResult();
    }
  }
  // 终局结算：像五子棋一样朗读一句收尾
  async function xqAnnounceResult() {
    if (!XQ.over) return;
    try {
      const r = await fetch(BASE + '/xq-over', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          winner: XQ.winner,
          notes: S.notes,
          messages: S.history.slice(-S.limit),
        }),
      });
      if (!r.ok) return;
      const d = await r.json();
      if (d && d.say) {
        gameSay(d.say, true);
      }
    } catch {}
  }
  // 把当前局面导出成 FEN（适配层实现，引擎只支持导入）
  function xqExportFen() {
    if (!XQ.engine) return '';
    const PIECE_TO_CHAR = ['.', 'P', 'A', 'B', 'N', 'C', 'R', 'K', 'p', 'a', 'b', 'n', 'c', 'r', 'k'];
    const rows = [];
    for (let r = 0; r < 10; r++) {
      let row = '';
      let empty = 0;
      for (let c = 0; c < 9; c++) {
        const sq = xqFindSquareByRC(r, c);
        const p = XQ.engine.getPiece(sq);
        if (p && PIECE_TO_CHAR[p] && PIECE_TO_CHAR[p] !== '.') {
          if (empty) { row += String(empty); empty = 0; }
          row += PIECE_TO_CHAR[p];
        } else {
          empty++;
        }
      }
      if (empty) row += String(empty);
      rows.push(row);
    }
    const side = XQ.engine.getSide() === 0 ? 'w' : 'b';
    return rows.join('/') + ' ' + side + ' - - 0 1';
  }
  function xqSave() {
    try {
      const fen = xqExportFen();
      if (!fen) return;
      write(XQ_KEY, { fen, over: XQ.over, winner: XQ.winner });
    } catch {}
  }
  function xqLoad() {
    try {
      const saved = read(XQ_KEY, null);
      if (saved && typeof saved.fen === 'string' && saved.fen) {
        XQ.engine.setBoard(saved.fen);
        XQ.startFen = saved.fen;
        XQ.over = !!saved.over;
        XQ.winner = saved.winner || '';
      } else {
        XQ.engine.setBoard(XQ.engine.START_FEN);
        XQ.startFen = XQ.engine.START_FEN;
        XQ.over = false;
        XQ.winner = '';
      }
      XQ.selected = -1;
      XQ.legalMoves = [];
      XQ.lastMove = -1;
      xqRender();
    } catch {}
  }
  function xqNew() {
    initXq();
    if (!XQ.engine) return;
    XQ.engine.setBoard(XQ.engine.START_FEN);
    XQ.startFen = XQ.engine.START_FEN;
    XQ.over = false;
    XQ.winner = '';
    XQ.selected = -1;
    XQ.legalMoves = [];
    XQ.lastMove = -1;
    xqSave();
    xqRender();
  }
  async function xqAiFirst() {
    xqNew();
    await xqAiTurn();
  }
  // 悔棋：撤销她的一步和你的上一步，回到轮到你
  function xqUndo() {
    console.log('[xq] 悔棋点击: engine=', !!XQ.engine, 'over=', XQ.over, 'busy=', XQ.busy);
    if (!XQ.engine || XQ.busy) {
      if (xqStatusEl) xqStatusEl.textContent = '等她想完';
      return;
    }
    const stack = XQ.engine.moveStack();
    console.log('[xq] moveStack 长度:', Array.isArray(stack) ? stack.length : typeof stack);
    if (!Array.isArray(stack) || !stack.length) {
      if (xqStatusEl) xqStatusEl.textContent = '没有可悔的步';
      return;
    }
    // 撤销最后两步（她的 + 你的）；若只有一步（让她先手后的局面），撤一步
    const steps = Math.min(2, stack.length);
    for (let i = 0; i < steps; i++) {
      XQ.engine.takeBack();
    }
    XQ.selected = -1;
    XQ.legalMoves = [];
    XQ.lastMove = -1;
    XQ.over = false;
    XQ.winner = '';
    xqSave();
    xqRender();
  }
  // 绑定
  const xqNewBtn = $('xiangqi-new');
  if (xqNewBtn) xqNewBtn.addEventListener('click', xqNew);
  const xqUndoBtn = $('xiangqi-undo');
  if (xqUndoBtn) xqUndoBtn.addEventListener('click', xqUndo);
  const xqAiFirstBtn = $('xiangqi-ai-first');
  if (xqAiFirstBtn) xqAiFirstBtn.addEventListener('click', xqAiFirst);
  // 切到象棋 tab 时初始化
  function xqEnsure() {
    initXq();
    if (XQ.engine) {
      xqLoad();
    }
  }

  let ttsAudio = null;
  let playingEl = null;
  let playEndCb = null;
  let ttsQueue = [];
  let ttsQueueActive = false;
  let autoPlay = read('companion.autoplay', false);

  // ---------- 语音预取 ----------
  // 目的：气泡还在「逐字打」的同时就把语音生成好，出声不用再等 1.2~1.6 秒。
  // 做法：拿到一句文本立刻发起请求，把 blob 存进 ttsPrefetch，播放时直接用。
  const ttsPrefetch = new Map();
  // 串行预取队列：手机走蜂窝/Tailscale 时并发打满会互相拖累、也更容易断，
  // 改成同一时刻最多一个在途请求，一条条稳稳拿。
  let ttsPrefetchBusy = false;
  const ttsPrefetchQueue = [];
  function drainTtsPrefetch() {
    if (ttsPrefetchBusy) return;
    const job = ttsPrefetchQueue.shift();
    if (!job) return;
    ttsPrefetchBusy = true;
    const { key } = job;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const url = BASE + '/tts?text=' + encodeURIComponent(key);
      fetch(url, { credentials: 'same-origin', signal: ctl.signal })
        .then((r) => (r.ok ? r.blob() : null))
        .then((blob) => {
          if (blob && blob.size > 0) {
            ttsPrefetch.set(key, URL.createObjectURL(blob));
            // 防止无限增长：超过 60 条就丢掉最早的
            if (ttsPrefetch.size > 60) {
              for (const [k, v] of ttsPrefetch) {
                if (ttsPrefetch.size <= 45) break;
                if (typeof v === 'string') URL.revokeObjectURL(v);
                ttsPrefetch.delete(k);
              }
            }
          } else {
            ttsPrefetch.delete(key);
          }
        })
        .catch(() => { ttsPrefetch.delete(key); })
        .finally(() => {
          clearTimeout(timer);
          ttsPrefetchBusy = false;
          drainTtsPrefetch();
          kickPump();
        });
    } catch { clearTimeout(timer); ttsPrefetch.delete(key); ttsPrefetchBusy = false; drainTtsPrefetch(); }
  }
  function prefetchTts(text) {
    const key = String(text || '').trim();
    if (!key || ttsPrefetch.has(key)) return;
    ttsPrefetch.set(key, null); // 占位，避免重复请求
    ttsPrefetchQueue.push({ key });
    drainTtsPrefetch();
  }

  // 单例 audio：解锁一次，之后换 src 复用（新 Audio 每次都会被拦）
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
    avatarState('idle');
    const cb = playEndCb;
    playEndCb = null;
    if (cb) cb();
  }
  // 在用户手势里先播一次静音，解锁自动播放
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
    avatarState('idle');
  }
  function playOne(text, bubbleEl, onEnd) {
    console.log('[tts] 播放:', JSON.stringify(text).slice(0, 60));
    const a = getAudio();
    try { a.pause(); } catch {}
    if (playingEl) playingEl.classList.remove('playing');
    playingEl = bubbleEl || null;
    if (playingEl) playingEl.classList.add('playing');
    playEndCb = onEnd || null;
    avatarState('speaking');
    a.muted = false;
    const key = String(text || '').trim();
    const ready = ttsPrefetch.get(key);
    if (typeof ready === 'string') {
      // 预取好了：本地 blob，零网络等待
      a.src = ready;
      a.play().catch(() => { finishPlay(); });
      return;
    }
    // 还没预取完，先等它（此时通常只差一点点）
    if (ttsPrefetch.has(key)) {
      waitPrefetch(key, (blobUrl) => {
        if (playingEl !== (bubbleEl || null)) return; // 期间被停掉了
        if (blobUrl) {
          a.src = blobUrl;
          a.play().catch(() => { finishPlay(); });
        } else {
          a.src = BASE + '/tts?text=' + encodeURIComponent(key);
          a.play().catch(() => { finishPlay(); });
        }
      });
      return;
    }
    a.src = BASE + '/tts?text=' + encodeURIComponent(key);
    a.play().catch(() => { finishPlay(); });
  }
  // 等某句的预取结果（最多等 8 秒，超时就用普通请求）
  function waitPrefetch(key, cb) {
    const t0 = Date.now();
    const tick = () => {
      const v = ttsPrefetch.get(key);
      if (typeof v === 'string') return cb(v);
      if (!ttsPrefetch.has(key)) return cb(null);
      if (Date.now() - t0 > 8000) return cb(null);
      setTimeout(tick, 60);
    };
    tick();
  }
  function toggleBubble(text, bubbleEl) {
    if (playingEl === bubbleEl && ttsAudio && !ttsAudio.paused) {
      stopAllTts();
    } else {
      stopAllTts();
      prefetchTts(text);   // 手动点读也走预取（多半已缓存，只剩 2ms）
      playOne(text, bubbleEl);
    }
  }
  function enqueueTts(text, bubbleEl) {
    if (!autoPlay) return;
    console.log('[tts] 入队:', JSON.stringify(text).slice(0, 60));
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

  function makeBubble(role, text, imgs, meta, ts) {
    const row = document.createElement('div');
    row.className = 'row' + (role === 'user' ? ' mine' : '') + (role === 'err' ? ' err' : '');
    if (ts) row.dataset.ts = String(ts);
    const b = document.createElement('div');
    b.className = 'bubble';
    // 引用入口：电脑悬停显示，手机长按触发
    let qbtn = null;
    if (role !== 'err' && text) {
      qbtn = document.createElement('button');
      qbtn.type = 'button';
      qbtn.className = 'bubble-quote-btn';
      qbtn.textContent = '❝';
      qbtn.title = '引用这句';
      qbtn.addEventListener('click', (e) => {
        e.stopPropagation();
        startQuote(text, ts || '');
      });
      // 手机长按
      let longTimer = null;
      b.addEventListener('touchstart', () => {
        longTimer = setTimeout(() => { startQuote(text, ts || ''); }, 450);
      });
      b.addEventListener('touchend', () => clearTimeout(longTimer));
      b.addEventListener('touchmove', () => clearTimeout(longTimer));
    }
    // 引用块：像微信一样显示被引用的原文
    if (meta && typeof meta.quote === 'string' && meta.quote) {
      const q = document.createElement('div');
      q.className = 'bubble-quote';
      q.textContent = meta.quote;
      q.title = '点击定位到原文';
      q.addEventListener('click', (e) => {
        e.stopPropagation();
        locateQuotedMessage(meta.quoteTs);
      });
      b.appendChild(q);
    }
    const list0 = Array.isArray(imgs) ? imgs : (imgs ? [imgs] : []);
    if (list0.length) {
      b.classList.add('img-bubble');
      for (const im of list0) {
        const el = document.createElement('img');
        el.className = 'chat-img';
        el.loading = 'lazy';
        el.decoding = 'async';
        el.src = String(im).startsWith('data:') ? String(im) : BASE + '/img/' + im;
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
      if (text) {
        const t = document.createElement('div');
        t.className = 'bubble-text';
        t.textContent = text;
        b.appendChild(t);
      }
    }
    if (role === 'assistant') {
      b.classList.add('tts');
      b.title = '点击朗读 / 再点停止';
      b.addEventListener('click', () => toggleBubble(text, b));
    }
    row.appendChild(b);
    // 引用按钮放在气泡内部，靠气泡定位，避免被 flex 推到窗口边缘
    if (qbtn) b.appendChild(qbtn);
    return row;
  }
  function addBubble(role, text, img, meta) {
    hideTyping();
    const row = makeBubble(role, text, img, meta);
    list.appendChild(row);
    scrollBottom();
    if (role === 'user') avatarState('listening');
    if (role === 'assistant') avatarState('reply');
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
    // 计时：让她「还在想」这件事有可见的进展，而不是一片死寂
    S.typingAt = Date.now();
    S.typingLabel = '正在输入…';
    setStatus(S.typingLabel, true);
    avatarState('thinking');
    clearInterval(S.typingTick);
    S.typingTick = setInterval(() => {
      if (!S.typing) return;
      const sec = Math.floor((Date.now() - S.typingAt) / 1000);
      if (sec >= 4) setStatus((S.typingLabel || '正在输入…') + ' ' + sec + 's', true);
    }, 1000);
    scrollBottom();
  }
  // 只想换提示语、不想重开计时的时候用
  function setTypingLabel(text) {
    S.typingLabel = text;
    if (S.typing) setStatus(text, true);
  }
  function hideTyping() {
    clearInterval(S.typingTick);
    S.typingTick = null;
    if (S.typing) { S.typing.remove(); S.typing = null; }
    setStatus('', false);
    if (!S.queue.length) avatarState('idle');
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function wake() { if (S.wake) { const r = S.wake; S.wake = null; r(); } }
  function waitWake() { return new Promise((r) => { S.wake = r; }); }
  function kickPump() { if (S.idx < S.queue.length) wake(); }

  function stamp() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
  }

  function renderAll(keepScroll) {
    const prevHeight = list.scrollHeight;
    const prevTop = list.scrollTop;
    list.innerHTML = '';
    if (S.hasMore) {
      const more = document.createElement('div');
      more.className = 'load-more';
      more.textContent = '加载更早的聊天';
      more.addEventListener('click', loadMore);
      list.appendChild(more);
    }
    if (S.history.length) {
      addDivider(stamp());
      for (const m of S.history) list.appendChild(makeBubble(m.role, m.content, m.imgs || m.img, m.meta, m.ts));
      if (keepScroll) { list.scrollTop = list.scrollHeight - prevHeight + prevTop; followBottom = false; }
      else scrollBottom();
    }
    updateUsage();
  }

  async function loadMore() {
    try {
      // 用当前已加载里最早一条的时间戳做游标，向上翻页；避免靠「条数」估算，翻到中间会错位
      const earliest = S.history.reduce((a, m) => {
        const t = Number(m && m.ts) || 0;
        return t > 0 && (a === 0 || t < a) ? t : a;
      }, 0);
      const before = earliest ? '&before=' + earliest : '';
      const r = await fetch(BASE + '/current?limit=600' + before);
      if (!r.ok) return;
      const d = await r.json();
      if (!d || !Array.isArray(d.messages)) return;
      S.history = mergeMessages(d.messages, S.history);
      S.total = d.total || S.total;
      S.hasMore = !!d.hasMore;
      renderAll(true);
    } catch {}
  }

  function updateUsage() {
    const el = $('usage');
    if (!el) return;
    const n = S.history.length;
    const t = S.total || n;
    const seen = Math.min(n, S.limit || 26);
    el.textContent = n
      ? `已加载 ${n} 条${t > n ? `（这段共 ${t} 条）` : ''} · 每轮模型看最近 ${seen} 条（上限 ${S.limit || 26}）`
      : '还没开始聊';
  }

  // ---------- 落盘 ----------
  function scheduleSave(delay = 120) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveNow(); }, delay);
  }
  async function saveNow() {
    clearTimeout(saveTimer);
    if (!S.threadId) S.threadId = newId();
    if (!S.title && S.history.length) S.title = titleOf(S.history);
    // 先拉服务器，合并（并集），避免两个设备互相覆盖
    try {
      const cur = await (await fetch(BASE + '/current')).json();
      if (cur && Array.isArray(cur.messages) && cur.threadId === S.threadId && cur.messages.length) {
        S.history = mergeMessages(cur.messages, S.history);
      }
    } catch {}
    const payload = {
      threadId: S.threadId,
      title: S.title,
      notes: S.notes,
      messages: S.history,
      createdAt: S.createdAt || new Date().toISOString(),
    };
    try {
      await fetch(BASE + '/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {}
    write(LS.hist, S.history.slice(-CACHE_MAX));
    write(LS.notes, S.notes);
    write(LS.thread, S.threadId);
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
      S.history.push({ role: 'assistant', content: text, ts: Date.now() });
      scheduleSave();
      updateUsage();
      await sleep(150 + Math.random() * 220);
    }
  }

  // ---------- 发图片（支持多张）----------
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
    const list = Array.from(files || []).filter((f) => f && f.type && f.type.startsWith('image/')).slice(0, 9);
    for (const f of list) {
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

  // 粘贴图片（电脑上 Ctrl+V）
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

  // 拖拽图片到页面任意位置
  ['dragenter', 'dragover'].forEach((t) => {
    document.body.addEventListener(t, (e) => e.preventDefault());
  });
  document.body.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files) await addFiles(e.dataTransfer.files);
  });

  // ---------- 发送 ----------
  async function send() {
    const text = input.value.trim();
    const images = pendingImages.slice();
    const quoteText = pendingQuote ? pendingQuote.text : '';
    const quoteTs = pendingQuote ? pendingQuote.ts : '';
    if (!text && !images.length && !quoteText) return;
    unlockAudio();
    input.value = '';
    autosize();
    const bubbleText = quoteText
      ? (text ? text : '')
      : text;
    if (images.length) {
      addBubble('user', bubbleText, images, quoteText ? { quote: quoteText, quoteTs } : undefined);
    } else {
      addBubble('user', bubbleText, undefined, quoteText ? { quote: quoteText, quoteTs } : undefined);
    }
    // 引用：content 存用户的文字，meta.quote 存被引用原文
    S.history.push({
      role: 'user',
      content: bubbleText || '（引用）',
      ts: Date.now(),
      ...(quoteText ? { meta: { quote: quoteText, quoteTs } } : {}),
    });
    pendingImages = [];
    pendingQuote = null;
    renderQuotePreview();
    renderPreviews();
    if (!S.title) S.title = titleOf(S.history);
    scheduleSave(300);
    updateUsage();
    // 用户让她把讨论结果写上去：聊天照常回复，之后自动触发写便签
    const askWrite = /写(?:上去|进|到|在)(?:便签|纸上?)?|写到纸上|写上去|记(?:下来|到)(?:便签|纸上?)?|落到(?:便签|纸上?)?/.test(text);
    if (askWrite && M.currentId) M.pendingWrite = text;
    runTurn(bubbleText, false, images);
  }

  async function runTurn(text, isRetry, images) {
    const gen = ++S.gen;
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
    let timedOut = false;
    let idleTimer = null;
    let shownError = false;
    // 服务端每 2 秒会发心跳；但手机走蜂窝/Tailscale 时抖动大、心跳可能被缓冲推迟，
    // 所以「静默」判定放宽到 90 秒（和后端 stall 一致），只要收到过任意字节就重置。
    const timeoutMs = 90000;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (gen !== S.gen) return;
        timedOut = true;
        try { ctrl.abort(); } catch {}
      }, timeoutMs);
    };
    armIdle();

    try {
      // 只发最近 S.limit 条（后端 historyTurns 也按这个数切），省上行带宽、更快拿到首字节
      const payload = { notes: S.notes, messages: S.history.slice(-S.limit) };
      // 只在棋局进行中、且当前正开着棋类侧栏时才带上棋局，避免她凭空催人下棋
      const activeMode = localStorage.getItem('companion.panelMode.v1') || 'game';
      const gomokuOrTic = activeMode === 'game' || activeMode === 'gomoku';
      // 空棋盘不算「正在下棋」：只有棋盘上真有落子才带棋局，否则她会每轮都被
      // 系统提示「正在下棋、轮到对方」，聊着聊着就催人下棋。
      if (gomokuOrTic && !G.over && G.board.some((c) => c)) payload.game = currentGame();
      // 带上当前便签内容，让她能看到纸上写了什么
      const memoText = memoEditorEl ? memoEditorEl.value.trim() : '';
      // 只要有当前便签（哪怕空白纸），就发给她，让她知道有这张纸
      if (memoText || M.currentId) {
        payload.memo = {
          id: M.currentId || '',
          content: memoText.slice(0, 12000),
          events: M.authors || [],
        };
      }
      // 带上画板截图，让她真的看到你画了什么
      if (drawCanvasEl && D.strokes.length) {
        payload.drawingImage = exportDrawImage();
      }
      if (images && images.length) payload.images = images;
      const resp = await fetch(BASE + '/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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
            if (evt.type === 'bubble') {
              got += 1;
              // 检测她往纸上写的标记：这行落便签，其余正常显示
              const writeMatch = String(evt.text).match(/✍纸上[:：]\s*([\s\S]+?)(?:[。！？]|$)/);
              if (writeMatch && writeMatch[1] && writeMatch[1].trim()) {
                const written = writeMatch[1].trim();
                applyMemoWrite(written);
                // 同时以气泡形式提示用户，让她写的内容可见
                S.queue.push('我写在纸上了：' + written);
                if (autoPlay) prefetchTts('我写在纸上了：' + written);
              } else {
                S.queue.push(evt.text);
                if (autoPlay) prefetchTts(evt.text);
              }
              wake(); armIdle();
            }
            else if (evt.type === 'thinking') { if (!S.typing) showTyping(); armIdle(); }
            else if (evt.type === 'wait') { setTypingLabel(evt.text || '她那边有点挤，我排一下队…'); armIdle(); }
            else if (evt.type === 'error') { shownError = true; showError(evt.message, !!evt.quota); }
            else if (evt.type === 'info') {
              if (evt.limit) S.limit = evt.limit;
              if (evt.imgs && evt.imgs.length) {
                const last = [...S.history].reverse().find((m) => m.role === 'user');
                if (last && !last.imgs) { last.imgs = evt.imgs; scheduleSave(300); }
              }
              updateUsage();
            }
          }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError' && gen === S.gen) {
        if (isNetworkError(e) && got === 0) {
          // 断网：不弹死错，进入自动重连，等网络回来把这句话补发出去
          markOffline();
          pendingResend = () => { if (gen === S.gen) runTurn(text, isRetry, images); };
        } else {
          shownError = true;
          showError('连不上：' + e.message);
        }
      }
    } finally {
      clearTimeout(kick);
      clearTimeout(idleTimer);
      if (gen === S.gen) {
        S.done = true;
        wake();
        if (timedOut && got === 0) {
          if (!isRetry) {
            // 连接确实断了才重连，而且先让状态栏自己说话，别让她莫名其妙来一句「诶」
            setTypingLabel('连接断了，我重连一下…');
            showTyping();
            setTimeout(() => { if (gen === S.gen) runTurn(text, true, images); }, 800);
          } else {
            addBubble('assistant', '好像还是没接上，你等会儿再说一句？');
          }
        } else if (got === 0 && !shownError) {
          // 兜底：本轮一个气泡都没收到、也没报过错（比如服务端空回复后静默收尾），
          // 绝不能就这么把「正在输入」收掉完事——那对用户就是「踩空」。
          addBubble('assistant', '刚才那下没接上话，你再说一句？');
        }
      }
      if (got > 0 && gen === S.gen) {
        S.notesTick = (S.notesTick || 0) + 1;
        if (S.notesTick % 5 === 0) updateNotes();
      }
      // 用户让她把讨论结果写上去：聊天回复结束后自动落纸
      if (!isRetry && gen === S.gen && M.pendingWrite && M.currentId) {
        const instr = M.pendingWrite;
        M.pendingWrite = '';
        askMemoWrite(instr);
      }
    }
  }

  async function updateNotes() {
    if (S.notesBusy || S.history.length < 4) return;
    S.notesBusy = true;
    try {
      const r = await fetch(BASE + '/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: S.notes, messages: S.history.slice(-60) }),
      });
      if (!r.ok) return;
      const d = await r.json();
      if (d.updated && d.notes) {
        S.notes = normalizeNotes(d.notes);
        renderMem();
        scheduleSave();
      }
    } catch {} finally {
      S.notesBusy = false;
    }
  }

  function showError(msg, isQuota) {
    hideTyping();
    if (isQuota) {
      // 日卡额度耗尽：用她的口吻提示，别用冷冰冰的报错
      const row = makeBubble('err', '猫粮吃完啦，我这边断粮了 (´｡• ᵕ •｡) 去续一下再接着聊～');
      const el = row.querySelector('.bubble');
      if (el) el.classList.add('quota-bubble');
      list.appendChild(row);
      scrollBottom();
      return;
    }
    if (/429|并发|拥挤|稍后重试|rate.?limit/i.test(String(msg)) && !isQuota) {
      // 并发被占满：这不是坏了，就是排队，用她的口吻轻轻带过
      const row = makeBubble('err', '刚才有点挤，没接上话。你再发一次就好～');
      list.appendChild(row);
      scrollBottom();
      return;
    }
    list.appendChild(makeBubble('err', msg));
    scrollBottom();
  }

  // ---------- 断线自动重连 ----------
  // 背景：手机走 Tailscale 中继（常经香港），网络一抖动就 Failed to fetch。
  // 做法：探活失败不弹死错，先静默重试；恢复后自动把没发出去的那句补发。
  let netDown = false;        // 当前是否认为断网
  let probeTimer = null;      // 重试定时器
  let probeDelay = 0;         // 当前退避间隔
  let pendingResend = null;   // 断线时没发出去的消息

  function isNetworkError(e) {
    if (!e) return false;
    const m = String(e.message || e);
    return e.name === 'TypeError' || /Failed to fetch|NetworkError|load failed|timeout|The operation was aborted/i.test(m);
  }

  function markOnline() {
    if (!netDown) return;
    netDown = false;
    probeDelay = 0;
    if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
    setStatus('网络回来了', false);
    setTimeout(() => { if (!netDown) setStatus('', false); }, 1600);
    // 把断线期间没发出去的那句补发
    if (pendingResend) {
      const job = pendingResend;
      pendingResend = null;
      setTimeout(() => { try { job(); } catch {} }, 200);
    } else {
      // 没有待补发的，就静默补拉一次历史，把断线期间别处发的内容并进来
      setTimeout(() => { try { syncFromServer(); } catch {} }, 300);
    }
  }

  async function syncFromServer() {
    if (netDown) return;
    try {
      const cur = await (await fetch(BASE + '/current?limit=300', { cache: 'no-store' })).json();
      if (!cur || !Array.isArray(cur.messages) || !cur.messages.length) return;
      if (cur.threadId && cur.threadId !== S.threadId) return;
      const merged = mergeMessages(cur.messages, S.history);
      if (merged.length === S.history.length) return; // 没变化，别重绘
      S.history = merged.length > CACHE_MAX ? merged.slice(-CACHE_MAX) : merged;
      S.total = cur.total || S.history.length;
      write(LS.hist, S.history.slice(-CACHE_MAX));
      renderAll();
      updateUsage();
    } catch {}
  }

  function markOffline() {
    netDown = true;
    if (probeTimer) return; // 已经在重试循环里
    probeDelay = 0;
    scheduleProbe();
  }

  function scheduleProbe() {
    if (!netDown) return;
    // 退避：1s → 2s → 3s → 5s，然后一直 5s
    probeDelay = probeDelay === 0 ? 1000 : Math.min(probeDelay + 1000, 5000);
    setStatus('网络断了，正在重连…', false);
    probeTimer = setTimeout(runProbe, probeDelay);
  }

  async function runProbe() {
    probeTimer = null;
    if (!netDown) return;
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 4000);
      const r = await fetch(BASE + '/info', { cache: 'no-store', signal: ctl.signal });
      clearTimeout(to);
      if (r.ok) { markOnline(); return; }
    } catch {}
    scheduleProbe();
  }

  // 浏览器自己报网络恢复时，立刻探一次（不用等退避）
  window.addEventListener('online', () => { if (netDown) { probeDelay = 0; runProbe(); } });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    // Android 浏览器切回前台后可能暂停 audio，即使页面还活着；尝试继续
    // 当前句子。预取请求自身带超时，完成/失败后会继续队列。
    if (ttsAudio && playingEl && ttsAudio.paused) ttsAudio.play().catch(() => {});
    if (netDown) { probeDelay = 0; runProbe(); }
  });

  // ---------- 记忆展示 ----------
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
      items.forEach((it, idx) => {
        const li = document.createElement('li');
        li.className = 'mem-item';
        const txt = document.createElement('span');
        txt.className = 'mem-text';
        txt.textContent = it;
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'mini';
        edit.textContent = '改';
        edit.title = '编辑';
        edit.addEventListener('click', () => memInlineEdit(li, key, idx, it));
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'mini';
        del.textContent = '删';
        del.title = '删除';
        del.addEventListener('click', () => memDelete(key, idx));
        li.appendChild(txt);
        li.appendChild(edit);
        li.appendChild(del);
        ul.appendChild(li);
      });
      wrap.appendChild(ul);
      box.appendChild(wrap);
    }
    if (!any) box.innerHTML = '<p class="mem-empty">还没记住什么，多聊几句就有了。</p>';
  }

  // L0 人物词条渲染（默认折叠，可展开编辑）
  async function renderFacts() {
    const box = $('facts');
    if (!box) return;
    box.innerHTML = '<p class="mem-empty">读取中…</p>';
    try {
      const r = await fetch(BASE + '/facts', { cache: 'no-store' });
      if (!r.ok) return;
      const facts = await r.json();
      box.innerHTML = '';
      if (!Array.isArray(facts) || !facts.length) {
        box.innerHTML = '<p class="mem-empty">还没有人物词条。</p>';
        return;
      }
      for (const f of facts) {
        if (!f || typeof f.key !== 'string') continue;
        const div = document.createElement('div');
        div.className = 'fact-item' + (f.sensitive ? ' fact-sensitive' : '');
        const head = document.createElement('div');
        head.className = 'fact-key';
        head.textContent = f.key + (f.sensitive ? '（敏感）' : '');
        const body = document.createElement('div');
        body.className = 'fact-content';
        body.textContent = (f.facts || []).join('；');
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'mini';
        edit.textContent = '改';
        edit.title = '编辑词条';
        edit.addEventListener('click', () => factInlineEdit(div, f));
        div.appendChild(head);
        div.appendChild(body);
        div.appendChild(edit);
        box.appendChild(div);
      }
    } catch {}
  }

  // 词条就地编辑：改 key、facts（逗号分隔）、sensitive 开关
  function factInlineEdit(div, f) {
    const keyIn = document.createElement('input');
    keyIn.type = 'text';
    keyIn.value = f.key;
    keyIn.className = 'mem-edit-input';
    keyIn.placeholder = '关键词';
    const factsIn = document.createElement('textarea');
    factsIn.value = (f.facts || []).join('\n');
    factsIn.className = 'mem-edit-input';
    factsIn.placeholder = '每行一条事实';
    factsIn.rows = 4;
    const sensIn = document.createElement('label');
    sensIn.className = 'checkbox';
    sensIn.innerHTML = '<input type="checkbox"> 敏感（不主动提）';
    sensIn.querySelector('input').checked = !!f.sensitive;
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'mini';
    save.textContent = '存';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'mini';
    cancel.textContent = '取消';
    div.innerHTML = '';
    div.appendChild(keyIn);
    div.appendChild(factsIn);
    div.appendChild(sensIn);
    div.appendChild(save);
    div.appendChild(cancel);
    keyIn.focus();
    let done = false;
    const finish = () => { if (!done) { done = true; renderFacts(); } };
    save.addEventListener('click', async () => {
      const key = keyIn.value.trim();
      const facts = factsIn.value.split('\n').map((s) => s.trim()).filter(Boolean);
      if (!key) { finish(); return; }
      try {
        await fetch(BASE + '/facts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, facts, sensitive: sensIn.querySelector('input').checked }),
        });
      } catch {}
      finish();
    });
    cancel.addEventListener('click', finish);
  }

  // 单条记忆就地编辑：把文字换成输入框 + 保存/取消
  function memInlineEdit(li, field, idx, oldText) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = oldText;
    input.className = 'mem-edit-input';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'mini';
    save.textContent = '存';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'mini';
    cancel.textContent = '取消';
    const actions = document.createElement('span');
    actions.className = 'mem-actions';
    actions.appendChild(save);
    actions.appendChild(cancel);
    li.innerHTML = '';
    li.appendChild(input);
    li.appendChild(actions);
    input.focus();
    let done = false;
    const finish = () => { if (!done) { done = true; renderMem(); } };
    save.addEventListener('click', async () => {
      const text = input.value.trim();
      if (!text) { finish(); return; }
      await memEdit(field, idx, 'edit', text);
      finish();
    });
    cancel.addEventListener('click', finish);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save.click();
      if (e.key === 'Escape') finish();
    });
  }

  async function memEdit(field, idx, action, text) {
    try {
      const r = await fetch(BASE + '/mem-edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: S.threadId, field, index: idx, action, text }),
      });
      const d = await r.json();
      if (r.ok && d.notes) {
        S.notes = normalizeNotes(d.notes);
        renderMem();
        write(LS.notes, S.notes);
      } else if (!r.ok) {
        alert((d && d.error) || '操作失败');
      }
    } catch {
      alert('操作失败');
    }
  }

  async function memDelete(field, idx) {
    if (!confirm('删掉这条记忆？')) return;
    await memEdit(field, idx, 'delete');
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

  // ---------- 会话切换 ----------
  const panel = $('panel');

  async function newThread() {
    await saveNow();
    S.gen += 1;
    if (ctrl) ctrl.abort();
    S.queue = []; S.idx = 0; S.done = true;
    S.history = [];
    S.threadId = newId();
    S.title = '';
    S.createdAt = new Date().toISOString();
    write(LS.hist, []);
    renderAll();
    await saveNow();
  }

  async function openThread(id) {
    if (!id || id === S.threadId) { panel.classList.remove('open'); return; }
    await saveNow();
    try {
      const t = await (await fetch(BASE + '/thread?id=' + encodeURIComponent(id))).json();
      if (!t || !Array.isArray(t.messages)) return;
      S.gen += 1;
      if (ctrl) ctrl.abort();
      S.queue = []; S.idx = 0; S.done = true;
      S.history = t.messages;
      S.notes = normalizeNotes(t.notes);
      S.threadId = t.threadId;
      S.title = t.title || '';
      S.createdAt = t.createdAt;
      renderAll();
      renderMem();
      await saveNow();
      panel.classList.remove('open');
    } catch {}
  }

  async function renderThreads() {
    const box = $('threads');
    if (!box) return;
    box.innerHTML = '<p class="mem-empty">读取中…</p>';
    try {
      const d = await (await fetch(BASE + '/threads')).json();
      const items = (d.threads || []).filter((t) => t.threadId !== S.threadId);
      box.innerHTML = '';
      if (!items.length) {
        box.innerHTML = '<p class="mem-empty">还没有别的对话。</p>';
        return;
      }
      for (const t of items) {
        const btn = document.createElement('button');
        btn.className = 'thread';
        const when = t.updatedAt ? t.updatedAt.slice(5, 16).replace('T', ' ') : '';
        btn.innerHTML = `<span class="thread-title"></span><span class="thread-meta"></span>`;
        btn.querySelector('.thread-title').textContent = t.title;
        btn.querySelector('.thread-meta').textContent = `${t.count} 条 · ${when}`;
        btn.addEventListener('click', () => openThread(t.threadId));
        box.appendChild(btn);
      }
    } catch {
      box.innerHTML = '<p class="mem-empty">读取失败。</p>';
    }
  }

  async function renderEpisodes() {
    const box = $('episodes');
    if (!box) return;
    box.innerHTML = '<p class="mem-empty">读取中…</p>';
    try {
      const d = await (await fetch(BASE + '/episodes')).json();
      const items = d.episodes || [];
      box.innerHTML = '';
      // 周归纳和月印象：展示古早记忆的沉降结果，并支持就地编辑
      const monthly = Array.isArray(d.monthly) ? d.monthly : [];
      const weekly = Array.isArray(d.weekly) ? d.weekly : [];
      if (monthly.length) {
        const h = document.createElement('div');
        h.className = 'episode-section-title';
        h.textContent = '月印象';
        box.appendChild(h);
        for (const m of monthly) {
          box.appendChild(makeArchiveDiv(m, 'monthly'));
        }
      }
      if (weekly.length) {
        const h = document.createElement('div');
        h.className = 'episode-section-title';
        h.textContent = '周归纳';
        box.appendChild(h);
        for (const w of weekly) {
          box.appendChild(makeArchiveDiv(w, 'weekly'));
        }
      }
      if (!items.length) {
        if (!monthly.length && !weekly.length) {
          box.innerHTML = '<p class="mem-empty">还没有事件卡，多聊几句就有了。</p>';
          return;
        }
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
        const actions = document.createElement('div');
        actions.className = 'episode-actions';
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'mini';
        edit.textContent = '改';
        edit.title = '编辑';
        edit.addEventListener('click', () => episodeInlineEdit(div, e));
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'mini';
        del.textContent = '删';
        del.title = '删除';
        del.addEventListener('click', () => episodeDelete(e));
        actions.appendChild(edit);
        actions.appendChild(del);
        div.appendChild(actions);
        box.appendChild(div);
      }
    } catch {
      box.innerHTML = '<p class="mem-empty">读取失败。</p>';
    }
  }

  // 渲染一条周归纳 / 月印象（带改、删按钮）
  function makeArchiveDiv(item, kind) {
    const div = document.createElement('div');
    div.className = 'episode episode-archive';
    const key = kind === 'weekly' ? (item.day || '') : (item.month || '');
    const label = key || '(未标注日期)';
    const head = document.createElement('div');
    head.className = 'episode-theme';
    head.textContent = label;
    div.appendChild(head);
    const body = document.createElement('div');
    body.className = 'episode-content';
    const raw = item.raw || '';
    if (raw) {
      body.textContent = raw.length > 400 ? raw.slice(0, 400) + '…' : raw;
      body.title = raw;
    } else {
      body.textContent = (item.themes || []).join('、');
    }
    div.appendChild(body);
    const actions = document.createElement('div');
    actions.className = 'episode-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'mini';
    edit.textContent = '改';
    edit.title = '编辑这段归纳';
    edit.addEventListener('click', () => archiveInlineEdit(div, item, kind));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'mini';
    del.textContent = '删';
    del.title = '删除这段归纳';
    del.addEventListener('click', async () => {
      if (!confirm('删掉这段归纳？')) return;
      await archiveEdit(kind, key, 'delete');
      renderEpisodes();
    });
    actions.appendChild(edit);
    actions.appendChild(del);
    div.appendChild(actions);
    return div;
  }

  // 归纳就地编辑：日期标签 + 完整文本
  function archiveInlineEdit(div, item, kind) {
    const keyField = kind === 'weekly' ? 'day' : 'month';
    const key = item[keyField] || '';
    const raw = item.raw || '';
    const labelIn = document.createElement('input');
    labelIn.type = 'text';
    labelIn.value = key;
    labelIn.className = 'mem-edit-input';
    labelIn.placeholder = kind === 'weekly' ? '日期 YYYY-MM-DD' : '月份 YYYY-MM';
    const rawIn = document.createElement('textarea');
    rawIn.value = raw;
    rawIn.className = 'mem-edit-input archive-raw';
    rawIn.rows = 12;
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'mini';
    save.textContent = '存';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'mini';
    cancel.textContent = '取消';
    const actions = document.createElement('div');
    actions.className = 'episode-actions';
    actions.appendChild(save);
    actions.appendChild(cancel);
    div.innerHTML = '';
    div.appendChild(labelIn);
    div.appendChild(rawIn);
    div.appendChild(actions);
    labelIn.focus();
    let done = false;
    const finish = () => { if (!done) { done = true; renderEpisodes(); } };
    save.addEventListener('click', async () => {
      const fields = { raw: rawIn.value };
      fields[keyField] = labelIn.value.trim();
      await archiveEdit(kind, key, 'edit', fields);
      finish();
    });
    cancel.addEventListener('click', finish);
    [labelIn, rawIn].forEach((el) => {
      el.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') finish();
      });
    });
  }

  async function archiveEdit(kind, key, action, fields) {
    try {
      const r = await fetch(BASE + '/archive-edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, key, action, ...(fields || {}) }),
      });
      const d = await r.json();
      if (!r.ok) alert((d && d.error) || '操作失败');
    } catch {
      alert('操作失败');
    }
  }

  // 事件卡就地编辑：主题 + 内容 + 心情 三个输入框
  function episodeInlineEdit(div, e) {
    const themeIn = document.createElement('input');
    themeIn.type = 'text';
    themeIn.value = e.theme || '';
    themeIn.className = 'mem-edit-input';
    const contentIn = document.createElement('input');
    contentIn.type = 'text';
    contentIn.value = e.content || '';
    contentIn.className = 'mem-edit-input';
    const moodIn = document.createElement('input');
    moodIn.type = 'text';
    moodIn.value = e.mood || '';
    moodIn.className = 'mem-edit-input';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'mini';
    save.textContent = '存';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'mini';
    cancel.textContent = '取消';
    const actions = document.createElement('div');
    actions.className = 'episode-actions';
    actions.appendChild(save);
    actions.appendChild(cancel);
    div.innerHTML = '';
    div.appendChild(themeIn);
    div.appendChild(contentIn);
    div.appendChild(moodIn);
    div.appendChild(actions);
    themeIn.focus();
    let done = false;
    const finish = () => { if (!done) { done = true; renderEpisodes(); } };
    save.addEventListener('click', async () => {
      await episodeEdit(e.id, 'edit', {
        theme: themeIn.value,
        content: contentIn.value,
        mood: moodIn.value,
      });
      finish();
    });
    cancel.addEventListener('click', finish);
    [themeIn, contentIn, moodIn].forEach((el) => {
      el.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') save.click();
        if (ev.key === 'Escape') finish();
      });
    });
  }

  async function episodeEdit(id, action, fields) {
    try {
      const r = await fetch(BASE + '/episode-edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action, ...fields }),
      });
      const d = await r.json();
      if (!r.ok) {
        alert((d && d.error) || '操作失败');
      }
    } catch {
      alert('操作失败');
    }
  }

  async function episodeDelete(e) {
    if (!confirm('删掉这张事件卡？')) return;
    await episodeEdit(e.id, 'delete');
    renderEpisodes();
  }


  // ---------- 聊天记录搜索 + 引用 ----------
  // 搜索命中后可以引用给 AI 看前后 10 句，并触发一次针对该主题的记忆补强。
  const searchPanel = $('search-panel');
  const searchInput = $('search-input');
  const searchResults = $('search-results');
  // 待发送的引用：{text, ts}
  let pendingQuote = null;

  function openSearch() {
    if (!searchPanel) return;
    searchPanel.classList.add('open');
    if (searchInput) searchInput.focus();
  }
  function closeSearch() {
    if (searchPanel) searchPanel.classList.remove('open');
  }
  const searchBtn = $('search');
  if (searchBtn) searchBtn.addEventListener('click', openSearch);
  const closeSearchBtn = $('close-search');
  if (closeSearchBtn) closeSearchBtn.addEventListener('click', closeSearch);
  if (searchPanel) searchPanel.addEventListener('click', (e) => { if (e.target === searchPanel) closeSearch(); });

  async function doSearch() {
    if (!searchInput || !searchResults) return;
    const q = searchInput.value.trim();
    if (!q) return;
    searchResults.innerHTML = '<p class="mem-empty">搜索中…</p>';
    try {
      const r = await fetch(BASE + '/search-history?q=' + encodeURIComponent(q), { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      const hits = d.hits || [];
      searchResults.innerHTML = '';
      if (!hits.length) {
        searchResults.innerHTML = '<p class="mem-empty">没找到相关内容。</p>';
        return;
      }
      hits.forEach((h) => {
        const div = document.createElement('div');
        div.className = 'search-hit';
        const msg = document.createElement('div');
        msg.className = 'hit-msg';
        msg.textContent = h.message;
        div.appendChild(msg);
        const ctx = document.createElement('div');
        ctx.className = 'hit-context';
        (h.context || []).forEach((c) => {
          const line = document.createElement('div');
          line.className = 'hit-ctx-line' + (c.role === 'user' ? ' me' : '');
          line.textContent = (c.role === 'user' ? '我：' : '小喵：') + c.content;
          ctx.appendChild(line);
        });
        div.appendChild(ctx);
        const quote = document.createElement('button');
        quote.className = 'hit-quote';
        quote.textContent = '引用给她看';
        quote.addEventListener('click', () => quoteHit(h));
        div.appendChild(quote);
        searchResults.appendChild(div);
      });
    } catch {}
  }
  const searchGoBtn = $('search-go');
  if (searchGoBtn) searchGoBtn.addEventListener('click', doSearch);
  if (searchInput) searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

  // 引用：把前后文发给她看，并触发记忆补强
  async function quoteHit(h) {
    closeSearch();
    const quoteText = String(h.message || '').trim();
    if (!quoteText) return;
    startQuote(quoteText, h.ts || '');
    if (searchInput) searchInput.value = '';
  }

  // 设置待引用内容并显示预览（供搜索引用和气泡引用共用）
  function startQuote(text, ts) {
    const t = String(text || '').trim();
    if (!t) return;
    pendingQuote = { text: t, ts: ts || '' };
    renderQuotePreview();
    input.focus();
  }

  function renderQuotePreview() {
    const box = $('quote-preview');
    const txt = box ? box.querySelector('.quote-preview-text') : null;
    if (!box) return;
    if (pendingQuote) {
      box.hidden = false;
      if (txt) txt.textContent = pendingQuote.text;
    } else {
      box.hidden = true;
      if (txt) txt.textContent = '';
    }
  }
  const quotePreviewX = $('quote-preview-x');
  if (quotePreviewX) quotePreviewX.addEventListener('click', () => {
    pendingQuote = null;
    renderQuotePreview();
  });

  // 点击引用块：先到服务端按时间戳取原文前后文，再渲染并滚动高亮。
  // 不依赖前端已经「翻到」哪里，直接定位，避免出现「看到的还是另一段对话」。
  async function locateQuotedMessage(quoteTs) {
    if (!quoteTs) return;
    try {
      const r = await fetch(BASE + '/current?around=' + encodeURIComponent(quoteTs) + '&pad=30', { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      if (!d || !Array.isArray(d.messages)) return;
      const targetIdx = d.messages.findIndex((m) => m && String(m.ts) === String(quoteTs));
      if (targetIdx < 0) return;
      // 用服务端返回的上下文替换当前历史，保证用户看到的就是这条原文所在的那一段
      S.history = d.messages;
      S.total = d.total || S.history.length;
      S.hasMore = true;
      renderAll(false);
      // 渲染完成后再定位到目标行
      requestAnimationFrame(() => {
        const target = list.querySelector('.row[data-ts="' + CSS.escape(String(quoteTs)) + '"]');
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.classList.add('locate-flash');
          setTimeout(() => target.classList.remove('locate-flash'), 1800);
        }
      });
    } catch {}
  }

  // ---------- 设置 ----------
  $('gear').addEventListener('click', () => {
    renderMem();
    updateUsage();
    renderThreads();
    renderEpisodes();
    renderFacts();
    panel.classList.add('open');
  });
  panel.addEventListener('click', (e) => { if (e.target === panel) panel.classList.remove('open'); });
  $('save').addEventListener('click', () => panel.classList.remove('open'));
  const closePanel = $('close-panel');
  if (closePanel) closePanel.addEventListener('click', () => panel.classList.remove('open'));

  // 记忆区块折叠开关（默认全部收起）
  function bindFoldToggle(toggleId, bodyId) {
    const t = $(toggleId);
    const b = $(bodyId);
    if (t && b) {
      t.addEventListener('click', () => {
        const open = b.hidden;
        b.hidden = !open;
        t.classList.toggle('open', open);
      });
    }
  }
  bindFoldToggle('mem-toggle', 'mem-body');
  bindFoldToggle('episodes-toggle', 'episodes-body');
  bindFoldToggle('facts-toggle', 'facts-body');

  // 自动朗读开关
  const apEl = $('autoplay');
  if (apEl) {
    apEl.checked = autoPlay;
    apEl.addEventListener('change', () => {
      autoPlay = apEl.checked;
      write('companion.autoplay', autoPlay);
      if (autoPlay) unlockAudio();
      else stopAllTts();
    });
  }

  // 聊天背景图：上传到服务端同步，应用到聊天窗口 + 全页背景
  const bgToggle = $('bg-toggle');
  const bgBody = $('bg-body');
  if (bgToggle && bgBody) {
    bgToggle.addEventListener('click', () => {
      const open = bgBody.hidden;
      bgBody.hidden = !open;
      bgToggle.classList.toggle('open', open);
    });
  }
  function applyBackground(url) {
    const phone = document.querySelector('.phone');
    if (url) {
      if (phone) {
        phone.style.backgroundImage = 'url("' + url + '")';
        phone.style.backgroundSize = 'cover';
        phone.style.backgroundPosition = 'center';
        phone.style.backgroundRepeat = 'no-repeat';
      }
      document.body.classList.add('has-chat-bg');
      document.body.style.backgroundImage = 'url("' + url + '")';
    } else {
      if (phone) {
        phone.style.backgroundImage = '';
        phone.style.backgroundSize = '';
        phone.style.backgroundPosition = '';
        phone.style.backgroundRepeat = '';
      }
      document.body.classList.remove('has-chat-bg');
      document.body.style.backgroundImage = '';
    }
    const prev = $('bg-preview');
    if (prev) {
      if (url) {
        prev.hidden = false;
        prev.innerHTML = '';
        const img = document.createElement('img');
        img.src = url;
        prev.appendChild(img);
      } else {
        prev.hidden = true;
        prev.innerHTML = '';
      }
    }
  }
  // 启动时从服务端拉取背景
  (async () => {
    try {
      const r = await fetch(BASE + '/chat-bg', { cache: 'no-store' });
      if (r.ok) {
        const d = await r.json();
        if (d && d.hash) applyBackground(BASE + '/img/' + d.hash);
      }
    } catch {}
  })();
  const bgUploadBtn = $('bg-upload');
  const bgFileInput = $('bg-file');
  if (bgUploadBtn && bgFileInput) {
    bgUploadBtn.addEventListener('click', () => bgFileInput.click());
    bgFileInput.addEventListener('change', async () => {
      const file = bgFileInput.files && bgFileInput.files[0];
      if (!file || !file.type.startsWith('image/')) return;
      const url = await compressImage(file);
      if (url) {
        try {
          const r = await fetch(BASE + '/chat-bg', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'set', image: url }),
          });
          if (r.ok) {
            const d = await r.json();
            if (d && d.hash) applyBackground(BASE + '/img/' + d.hash);
          }
        } catch {}
      }
      bgFileInput.value = '';
    });
  }
  const bgClearBtn = $('bg-clear');
  if (bgClearBtn) {
    bgClearBtn.addEventListener('click', () => {
      try {
        fetch(BASE + '/chat-bg', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'clear' }),
        }).then(() => applyBackground(''));
      } catch {}
      applyBackground('');
    });
  }
  // 背景缩放与位置微调（存 localStorage）
  const BG_SET_KEY = 'companion.chatBgSettings.v1';
  function applyBgSettings() {
    const s = read(BG_SET_KEY, { scale: 135, pos: 62, posy: 50 });
    const scale = Number(s.scale) || 135;
    const pos = Number(s.pos) || 62;
    const posy = Number(s.posy) || 50;
    document.body.style.setProperty('--bg-scale', scale + '%');
    document.body.style.setProperty('--bg-pos', pos + '% ' + posy + '%');
    const sv = $('bg-scale-val');
    const pv = $('bg-pos-val');
    const pyv = $('bg-posy-val');
    const sl = $('bg-scale');
    const pl = $('bg-pos');
    const pyl = $('bg-posy');
    if (sv) sv.textContent = scale + '%';
    if (pv) pv.textContent = pos + '%';
    if (pyv) pyv.textContent = posy + '%';
    if (sl) sl.value = scale;
    if (pl) pl.value = pos;
    if (pyl) pyl.value = posy;
  }
  applyBgSettings();
  const bgScaleEl = $('bg-scale');
  if (bgScaleEl) bgScaleEl.addEventListener('input', () => {
    const scale = Number(bgScaleEl.value) || 135;
    const s = read(BG_SET_KEY, { scale: 135, pos: 62, posy: 50 });
    s.scale = scale;
    write(BG_SET_KEY, s);
    applyBgSettings();
  });
  const bgPosEl = $('bg-pos');
  if (bgPosEl) bgPosEl.addEventListener('input', () => {
    const pos = Number(bgPosEl.value) || 62;
    const s = read(BG_SET_KEY, { scale: 135, pos: 62, posy: 50 });
    s.pos = pos;
    write(BG_SET_KEY, s);
    applyBgSettings();
  });
  const bgPosyEl = $('bg-posy');
  if (bgPosyEl) bgPosyEl.addEventListener('input', () => {
    const posy = Number(bgPosyEl.value) || 50;
    const s = read(BG_SET_KEY, { scale: 135, pos: 62, posy: 50 });
    s.posy = posy;
    write(BG_SET_KEY, s);
    applyBgSettings();
  });

  $('new').addEventListener('click', async () => {
    if (S.history.length && !confirm('开一段新的对话？现在这段会存进归档，随时能翻回来。')) return;
    await newThread();
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

  $('clear-mem').addEventListener('click', async () => {
    if (!confirm('清空它记住的东西？对话不会删。')) return;
    S.notes = normalizeNotes(EMPTY_NOTES);
    renderMem();
    scheduleSave(100);
  });

  $('reset').addEventListener('click', async () => {
    if (!confirm('清空全部？这段对话和它记住的东西都会从当前这段里删掉（磁盘上的归档还在）。')) return;
    await saveNow();
    S.gen += 1;
    if (ctrl) ctrl.abort();
    S.history = [];
    S.notes = normalizeNotes(EMPTY_NOTES);
    S.threadId = newId();
    S.title = '';
    S.queue = []; S.idx = 0; S.done = true;
    write(LS.hist, []);
    renderAll();
    renderMem();
    await saveNow();
    panel.classList.remove('open');
  });

  // 关页面 / 切走时立刻写一次（sendBeacon 在页面卸载时也能发出去）
  function flush() {
    try {
      const payload = JSON.stringify({
        threadId: S.threadId, title: S.title, notes: S.notes,
        messages: S.history, createdAt: S.createdAt,
      });
      navigator.sendBeacon(BASE + '/save', new Blob([payload], { type: 'application/json' }));
    } catch {}
  }
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });

  // ---------- 启动 ----------
  (function boot() {
    // 下棋：恢复本地棋局并渲染，绑定新一局按钮
    loadGame();
    renderBoard();
    const gameNewBtn = $('game-new');
    if (gameNewBtn) gameNewBtn.addEventListener('click', resetGame);
    const gameAiFirstBtn = $('game-ai-first');
    if (gameAiFirstBtn) gameAiFirstBtn.addEventListener('click', aiFirst);

    // 便签：恢复上次打开的便签
    const lastMemoId = localStorage.getItem('companion.memo.current') || '';
    if (lastMemoId) M.currentId = lastMemoId;
    loadMemoList(lastMemoId);

    // 画板：恢复画纸列表和当前画纸
    loadDraw();

    // 先用本地缓存立刻上屏，绝不等网络。手机上走 Tailscale 拉一次要好几百毫秒到几秒，
    // 干等着就是那个「空白聊天窗口」。
    const localHist = read(LS.hist, []);
    const localThread = read(LS.thread, '');    S.history = Array.isArray(localHist) ? localHist : [];
    S.total = S.history.length;
    S.hasMore = false;
    S.notes = normalizeNotes(read(LS.notes, EMPTY_NOTES));
    S.threadId = localThread || newId();
    S.title = S.history.length ? titleOf(S.history) : '';
    renderAll();
    renderMem();
    autosize();
    try { const el = $('ver'); if (el) el.textContent = 'v20261120k'; } catch {}

    // 缓存里的东西先给用户用起来，剩下的在后台补
    let painted = S.history.length > 0;
    const firstPaint = () => {
      if (painted) return;
      painted = true;
      renderAll();
    };
    // 本地一条都没有时，别让页面干瞪眼：给个「正在读取」的提示
    if (!painted) setStatus('读取中…', false);

    (async () => {
      let remote = null;
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 5000);
        remote = await (await fetch(BASE + '/current?limit=300', { cache: 'no-store', signal: ctl.signal })).json();
        clearTimeout(timer);
      } catch {
        // 首屏断网：先显示本地记录，并进入自动重连循环，网络一恢复就补齐
        if (!painted) setStatus('连不上，先看本地的', false);
        firstPaint();
        markOffline();
        return;
      }
      const remoteOk = remote && Array.isArray(remote.messages) && remote.messages.length;

      if (remoteOk) {
        // 合并服务器和本地（并集），两边都不丢
        const merged = mergeMessages(remote.messages, localHist);
        S.history = merged.length > CACHE_MAX ? merged.slice(-CACHE_MAX) : merged;
        S.total = remote.total || S.history.length;
        S.hasMore = !!remote.hasMore;
        S.notes = normalizeNotes(remote.notes);
        S.threadId = remote.threadId || S.threadId;
        S.title = remote.title || S.title;
        S.createdAt = remote.createdAt;
        write(LS.thread, S.threadId);
        write(LS.hist, S.history.slice(-CACHE_MAX));
        write(LS.notes, S.notes);
        renderAll();
        renderMem();
      } else if (!painted) {
        renderAll();
        renderMem();
      }
      setStatus('', false);
      scheduleSave(200);
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 4000);
        const info = await (await fetch(BASE + '/info', { cache: 'no-store', signal: ctl.signal })).json();
        clearTimeout(timer);
        if (info && info.historyTurns) S.limit = info.historyTurns;
        if (info && info.model) S.model = info.model;
        updateUsage();
      } catch {}
    })();

    input.focus();
  })();
})();
