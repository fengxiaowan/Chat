# -*- coding: utf-8 -*-
"""极简「微信式」闲聊原型。

- 浏览器打开 http://127.0.0.1:8777 就能聊
- 不填 Key 是演示模式（本地预设回复，用来感受节奏）
- 填了 Key 走 DeepSeek，流式边生成边按句切气泡
- 每轮聊完会顺手更新一次「记忆」，不需要任何表单
- 除 persona.py 外全部标准库，不需要装依赖

用法： python server.py
"""

import json
import random
import re
import sys
import time
from datetime import datetime
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
HOST = "127.0.0.1"
PORT = 8777
API_URL = "https://api.deepseek.com/chat/completions"
MODEL = "deepseek-flash"

sys.path.insert(0, str(ROOT))
from persona import (  # noqa: E402
    MOCK_DEFAULT,
    MOCK_RULES,
    NOTES_PROMPT,
    SYSTEM_PROMPT,
)

MAX_BUBBLES = 4
MAX_TOKENS = 150
HISTORY_TURNS = 26
MAX_NOTES = 8
NOTES_FIELDS = ("about_you", "how_to_talk", "between_us", "about_me")

HARD_END = "。！？!?…\n"
SOFT_END = "，,；;、：: "
_BULLET = re.compile(r"^\s*(?:[-*•·—]|\d+[.、)])\s+")


# ---------- 文本处理 ----------

def build_memory_block(notes) -> str:
    lines = []
    for field, label in (
        ("about_you", "关于对方"),
        ("how_to_talk", "TA 明确说过的习惯"),
        ("between_us", "你们之间"),
        ("about_me", "你自己"),
    ):
        items = notes.get(field) or []
        if items:
            lines.append("· %s：%s" % (label, "；".join(items)))
    if not lines:
        return "（还什么都没记住，正常聊就行）"
    return "\n".join(lines)


def build_prompt(notes) -> str:
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    return (SYSTEM_PROMPT + f"\n\n现在是 {now}（北京时间）。").replace("{memory}", build_memory_block(notes))


def _fmt_ts(ts) -> str:
    """把毫秒级 unix 时间戳格式化成 MM-DD HH:mm，无效返回空串。"""
    if not ts:
        return ""
    try:
        t = datetime.fromtimestamp(float(ts) / 1000.0)
        if t.year < 2000:
            return ""
        return t.strftime("%m-%d %H:%M")
    except Exception:
        return ""


def _stamp_messages(messages):
    """返回带时间戳前缀的消息数组，给 API 用。"""
    out = []
    for m in messages:
        role = m.get("role")
        content = (m.get("content") or "").strip()
        if not content or role not in ("user", "assistant"):
            continue
        ts = _fmt_ts(m.get("ts"))
        out.append({"role": role, "content": f"[{ts}] {content}" if ts else content})
    return out


def clean_bubble(s: str) -> str:
    s = _BULLET.sub("", s.strip())
    s = s.replace("**", "").replace("`", "").replace("#", "").strip()
    s = re.sub(r"[ \t]+", " ", s)
    s = s.strip().rstrip("。，,；;、：:")
    s = s.strip()
    if s == "嗯":
        s = "嗯嗯"
    return s


def split_long(s: str, limit: int = 52):
    parts = []
    rest = s
    while len(rest) > limit:
        window = rest[:limit]
        cut = max(window.rfind(c) for c in "，,；;、")
        if cut < limit // 2:
            cut = limit
        head = rest[:cut].strip("，,；;、 ")
        if head:
            parts.append(head)
        rest = rest[cut + 1:].lstrip("，,；;、 ")
    if rest.strip():
        parts.append(rest.strip())
    return parts or [s]


def bubble_stream(chunks):
    """把流式文本切成一条条消息。"""
    buf = ""
    for ch in chunks:
        buf += ch
        emit = False
        if ch in HARD_END:
            emit = True
        elif len(buf) >= 24 and ch in SOFT_END:
            emit = True
        elif len(buf) >= 38:
            emit = True
        if emit:
            piece, buf = buf, ""
            b = clean_bubble(piece)
            if b:
                for x in split_long(b):
                    yield x
    b = clean_bubble(buf)
    if b:
        for x in split_long(b):
            yield x


def deepseek_chunks(api_key: str, messages):
    """向 DeepSeek 发起流式请求，逐字符产出。"""
    payload = {
        "model": MODEL,
        "messages": messages,
        "max_tokens": MAX_TOKENS,
        "temperature": 0.95,
        "stream": True,
        "thinking": {"type": "disabled"},
    }
    req = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "Authorization": "Bearer " + api_key,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        for raw in resp:
            line = raw.decode("utf-8", "ignore").strip()
            if not line or not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                obj = json.loads(data)
                delta = obj["choices"][0].get("delta") or {}
                text = delta.get("content") or ""
            except Exception:
                continue
            for ch in text:
                yield ch


def call_once(api_key: str, system: str, user: str, max_tokens: int = 600) -> str:
    payload = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "max_tokens": max_tokens,
        "temperature": 0.3,
        "stream": False,
        "thinking": {"type": "disabled"},
    }
    req = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + api_key,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        obj = json.loads(resp.read().decode("utf-8"))
    return obj["choices"][0]["message"].get("content") or ""


def parse_json_block(text: str):
    t = (text or "").strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\s*", "", t)
        t = re.sub(r"\s*```$", "", t)
    i, j = t.find("{"), t.rfind("}")
    if i < 0 or j <= i:
        raise ValueError("no json")
    return json.loads(t[i:j + 1])


def clean_notes(obj) -> dict:
    out = {}
    for field in NOTES_FIELDS:
        items = obj.get(field) if isinstance(obj, dict) else None
        if not isinstance(items, list):
            items = []
        seen = []
        for it in items:
            if not isinstance(it, str):
                continue
            s = it.strip().strip("。·-「」 ")
            if not s or s in seen:
                continue
            seen.append(s[:36])
        out[field] = seen[-MAX_NOTES:]
    return out


# ---------- 演示模式 ----------

def last_of(messages, role):
    for m in reversed(messages or []):
        if m.get("role") == role:
            return m.get("content") or ""
    return ""


def mock_bubbles(messages):
    text = last_of(messages, "user")
    prev = last_of(messages, "assistant")

    m = re.search(r"我叫([\u4e00-\u9fa5A-Za-z0-9]{1,8})", text)
    if m:
        name = m.group(1)
        if prev.startswith(name):
            return ["嗯嗯，我记得"]
        return ["%s，记住了" % name, "这名字有点意思"]

    for pattern, bubbles in MOCK_RULES:
        if bubbles is None:
            continue
        if re.search(pattern, text, re.I):
            return bubbles

    pool = [b for b in MOCK_DEFAULT if b[0] != prev]
    return random.choice(pool or MOCK_DEFAULT)


# ---------- HTTP ----------

class Handler(BaseHTTPRequestHandler):
    server_version = "companion/0.2"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body: bytes, ctype="application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def _sse_start(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.close_connection = True

    def _sse(self, obj):
        self.wfile.write(("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode("utf-8"))
        self.wfile.flush()

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length).decode("utf-8") or "{}")

    # --- 路由 ---
    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/", "/index.html"):
            return self._file("index.html", "text/html; charset=utf-8")
        if path.startswith("/static/"):
            name = path[len("/static/"):]
            ctype = {
                ".js": "application/javascript; charset=utf-8",
                ".css": "text/css; charset=utf-8",
                ".svg": "image/svg+xml",
                ".png": "image/png",
            }.get(Path(name).suffix, "application/octet-stream")
            return self._file(name, ctype)
        if path == "/api/health":
            return self._json(200, {"ok": True})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        try:
            payload = self._body()
        except Exception as e:
            return self._json(400, {"error": "bad json: %s" % e})
        if path == "/api/chat":
            return self._chat(payload)
        if path == "/api/notes":
            return self._notes(payload)
        self._json(404, {"error": "not found"})

    def _chat(self, payload):
        api_key = (payload.get("apiKey") or "").strip()
        notes = clean_notes(payload.get("notes") or {})
        messages = payload.get("messages") or []
        messages = [m for m in messages if m.get("role") in ("user", "assistant") and m.get("content")]
        messages = messages[-HISTORY_TURNS:]

        self._sse_start()
        try:
            if not api_key:
                self._mock_turn(messages, notes)
                return
            self._model_turn(api_key, notes, messages)
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", "ignore")[:300]
            except Exception:
                pass
            hint = {401: "Key 不对（401）", 402: "余额不足（402）", 429: "太频繁了（429）"}.get(
                e.code, "HTTP %s" % e.code
            )
            self._safe({"type": "error", "message": "%s %s" % (hint, detail)})
        except Exception as e:
            self._safe({"type": "error", "message": "连接出错了：%s" % e})
        finally:
            try:
                self._sse({"type": "done"})
            except Exception:
                pass

    def _mock_turn(self, messages, notes):
        self._safe({"type": "mode", "mode": "mock"})
        for i, b in enumerate(mock_bubbles(messages)[:MAX_BUBBLES]):
            if i:
                time.sleep(random.uniform(0.35, 0.9))
            self._sse({"type": "bubble", "text": b})

    def _model_turn(self, api_key, notes, messages):
        self._safe({"type": "mode", "mode": "live"})
        convo = [{"role": "system", "content": build_prompt(notes)}] + _stamp_messages(messages)
        count, tail = 0, ""
        for b in bubble_stream(deepseek_chunks(api_key, convo)):
            count += 1
            if count > MAX_BUBBLES:
                tail += b
                continue
            self._sse({"type": "bubble", "text": b})
        if tail:
            self._sse({"type": "bubble", "text": tail})

    def _notes(self, payload):
        api_key = (payload.get("apiKey") or "").strip()
        notes = clean_notes(payload.get("notes") or {})
        messages = [m for m in (payload.get("messages") or [])
                    if m.get("role") in ("user", "assistant") and m.get("content")][-12:]
        if not api_key or len(messages) < 2:
            return self._json(200, {"notes": notes, "updated": False})

        t_lines = []
        for m in messages:
            role = "对方" if m["role"] == "user" else "你"
            ts = _fmt_ts(m.get("ts"))
            if ts:
                t_lines.append(f"[{ts}] {role}：{m['content']}")
            else:
                t_lines.append(f"{role}：{m['content']}")
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M")
        convo = f"现在是 {now_str}（北京时间）。\n" + "\n".join(t_lines)
        old = json.dumps(notes, ensure_ascii=False)
        try:
            raw = call_once(api_key, NOTES_PROMPT, "旧记忆：\n%s\n\n最近的对话：\n%s" % (old, convo))
            updated = clean_notes(parse_json_block(raw))
        except Exception as e:
            return self._json(200, {"notes": notes, "updated": False, "error": str(e)[:120]})
        return self._json(200, {"notes": updated, "updated": True})

    def _safe(self, obj):
        try:
            self._sse(obj)
        except Exception:
            pass

    def _file(self, name, ctype):
        target = (STATIC / name).resolve()
        if not str(target).startswith(str(STATIC.resolve())) or not target.is_file():
            return self._json(404, {"error": "not found"})
        self._send(200, target.read_bytes(), ctype)


def main():
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    srv.daemon_threads = True
    print("companion running at http://%s:%d" % (HOST, PORT), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
