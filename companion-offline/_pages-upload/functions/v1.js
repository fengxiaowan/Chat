/**
 * Cloudflare Pages Function：把 /v1/* 转发到中转站，并补上跨域许可头。
 * 浏览器才肯读一个「没声明允许跨域」的接口的回复，这一步绕不过去，
 * 所以必须有人在中间加这个头 —— 现在这个「人」是 Cloudflare 的一个小函数。
 *
 * 部署目录结构：
 *   public/index.html          <- 聊天页
 *   functions/v1/[[path]].js   <- 本文件，匹配 /v1/ 下任意路径
 *
 * Pages 项目 → Settings → Variables and production：
 *   RELAY_KEY = sk-ar-...      （必填，用 Secret 类型）
 *   RELAY_BASE = https://tmai.ak03.cn/v1   （可选）
 */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-liao',
  'access-control-max-age': '86400',
};

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(request.url);

  if (url.pathname === '/v1/ping') {
    return json({ ok: true, t: new Date().toISOString(), hasKey: !!env.RELAY_KEY });
  }

  const base = (env.RELAY_BASE || 'https://tmai.ak03.cn/v1').replace(/\/+$/, '');
  // /v1/chat/completions -> <base>/chat/completions
  const tail = url.pathname.replace(/^\/v1/, '');
  const target = base + tail + url.search;

  const key = env.RELAY_KEY;
  if (!key) return json({ error: '服务器没配置 RELAY_KEY' }, 500);

  const headers = new Headers();
  headers.set('authorization', 'Bearer ' + key);
  headers.set('content-type', request.headers.get('content-type') || 'application/json');
  headers.set('accept', request.headers.get('accept') || 'text/event-stream');

  let body;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    body = await request.arrayBuffer();
  }

  let upstream;
  try {
    upstream = await fetch(target, { method: request.method, headers, body });
  } catch (e) {
    return json({ error: '转发失败：' + ((e && e.message) || e) }, 502);
  }

  const out = new Headers();
  for (const [k, v] of upstream.headers) {
    const lk = k.toLowerCase();
    if (
      lk === 'content-encoding' ||
      lk === 'content-length' ||
      lk === 'transfer-encoding' ||
      lk === 'connection' ||
      lk.startsWith('access-control')
    ) {
      continue;
    }
    out.set(k, v);
  }
  for (const [k, v] of Object.entries(CORS)) out.set(k, v);
  out.set('cache-control', 'no-store');

  // 关键：不要 await upstream.text()，那样就没有流式吐字了
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
  });
}
