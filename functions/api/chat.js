// Cloudflare Pages Function: POST /api/chat
// Safe proxy to an AI provider: Groq (GROQ_API_KEY) or Anthropic (ANTHROPIC_API_KEY).
// Keys live only in Cloudflare secrets and are never sent to the browser.
// Rate limit per IP (CF-Connecting-IP) using the RATE_LIMIT KV namespace.

const MODELS = { quick: 'claude-haiku-5-5', default: 'claude-sonnet-5-5' };           // Anthropic
const GROQ_MODELS = { quick: 'llama-3.3-70b-versatile', default: 'llama-3.3-70b-versatile' };   // Groq (override with MODEL)
const MAX_BODY = 40_000;     // bytes
const MAX_MESSAGES = 20;
const MAX_CHARS = 24_000;

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
});
const fail = (status, code, message, headers) => json({ code, message }, status, headers);
const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);

function validate(b) {
  if (!b || typeof b !== 'object') return { error: 'リクエストの形式が正しくありません。' };
  const msgs = b.messages;
  if (!Array.isArray(msgs) || msgs.length < 1 || msgs.length > MAX_MESSAGES) return { error: 'messages は1〜20件で指定してください。' };
  let chars = 0;
  for (const m of msgs) {
    if (!m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content) return { error: 'messages の内容が正しくありません。' };
    chars += m.content.length;
  }
  if (b.system !== undefined && typeof b.system !== 'string') return { error: 'system は文字列で指定してください。' };
  chars += (b.system || '').length;
  if (chars > MAX_CHARS) return { error: '入力が長すぎます。' };
  if (msgs[msgs.length - 1].role !== 'user') return { error: '最後のメッセージは user にしてください。' };
  return {
    messages: msgs.map((m) => ({ role: m.role, content: m.content })),
    system: b.system || undefined,
    tier: b.tier === 'default' ? 'default' : 'quick',
    maxTokens: Math.min(num(b.maxTokens, 1000) || 1000, 1000),
    stream: b.stream === true
  };
}

async function count(kv, key) {
  const v = await kv.get(key);
  return v ? Number(v) || 0 : 0;
}

// Pick the provider from the configured secrets (AI_PROVIDER can force one).
function pickProvider(env) {
  const want = env.AI_PROVIDER;
  if (want === 'groq') return env.GROQ_API_KEY ? 'groq' : null;
  if (want === 'anthropic') return env.ANTHROPIC_API_KEY ? 'anthropic' : null;
  if (env.GROQ_API_KEY) return 'groq';
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}

function buildUpstream(provider, env, v) {
  if (provider === 'groq') {
    return {
      url: 'https://api.groq.com/openai/v1/chat/completions',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.GROQ_API_KEY}` },
      body: {
        model: env.MODEL || GROQ_MODELS[v.tier],
        max_tokens: v.maxTokens,
        messages: v.system ? [{ role: 'system', content: v.system }, ...v.messages] : v.messages,
        stream: v.stream
      }
    };
  }
  return {
    url: 'https://api.anthropic.com/v1/messages',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: { model: env.MODEL || MODELS[v.tier], max_tokens: v.maxTokens, system: v.system, messages: v.messages, stream: v.stream }
  };
}

export async function onRequestPost({ request, env }) {
  // Fail closed: never call the paid API without a key and a working limiter.
  const provider = pickProvider(env);
  if (!provider) return fail(500, 'not_configured', 'サーバーにAPIキー（GROQ_API_KEY または ANTHROPIC_API_KEY）が設定されていません。');
  if (!env.RATE_LIMIT) return fail(500, 'not_configured', '利用制限用のKV（RATE_LIMIT）が設定されていません。');

  // Same-origin only.
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return fail(403, 'forbidden', '許可されていないアクセス元です。');

  if (Number(request.headers.get('content-length') || 0) > MAX_BODY) return fail(413, 'too_large', 'リクエストが大きすぎます。');
  let parsed;
  try { parsed = JSON.parse(await request.text()); } catch { return fail(400, 'bad_request', 'JSONの形式が正しくありません。'); }
  const v = validate(parsed);
  if (v.error) return fail(400, 'bad_request', v.error);

  // ---- rate limit (per IP): daily + per-minute. Set a limit to 0 to disable it. ----
  const dailyLimit = num(env.DAILY_LIMIT, 5);
  const minuteLimit = num(env.MINUTE_LIMIT, 3);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const dKey = `rl:d:${day}:${ip}`;
  const mKey = `rl:m:${Math.floor(now / 60000)}:${ip}`;
  const [d, m] = await Promise.all([count(env.RATE_LIMIT, dKey), count(env.RATE_LIMIT, mKey)]);

  if (dailyLimit > 0 && d >= dailyLimit) {
    const secs = Math.ceil((Date.parse(day + 'T00:00:00Z') + 86400000 - now) / 1000);
    return fail(429, 'daily_limit', '本日の利用上限に達しました。明日またお試しください。', {
      'retry-after': String(secs), 'x-ratelimit-limit': String(dailyLimit), 'x-ratelimit-remaining': '0'
    });
  }
  if (minuteLimit > 0 && m >= minuteLimit) {
    return fail(429, 'minute_limit', '短時間にリクエストが集中しています。少し待ってからもう一度お試しください。', {
      'retry-after': String(60 - Math.floor((now / 1000) % 60)), 'x-ratelimit-limit': String(minuteLimit), 'x-ratelimit-remaining': '0'
    });
  }
  await Promise.all([
    env.RATE_LIMIT.put(dKey, String(d + 1), { expirationTtl: 90000 }),
    env.RATE_LIMIT.put(mKey, String(m + 1), { expirationTtl: 120 })
  ]);
  const remaining = dailyLimit > 0 ? Math.max(0, dailyLimit - d - 1) : -1;
  const rateHeaders = dailyLimit > 0 ? { 'x-ratelimit-limit': String(dailyLimit), 'x-ratelimit-remaining': String(remaining) } : {};

  // ---- call the AI provider (server side only) ----
  const up = buildUpstream(provider, env, v);
  let upstream;
  try {
    upstream = await fetch(up.url, { method: 'POST', headers: up.headers, body: JSON.stringify(up.body) });
  } catch {
    return fail(502, 'upstream_error', 'AIサービスに接続できませんでした。', rateHeaders);
  }

  if (!upstream.ok) {
    console.error(JSON.stringify({ level: 'error', msg: 'upstream', provider, status: upstream.status }));
    return upstream.status === 429 || upstream.status === 529
      ? fail(503, 'busy', 'AIが混み合っています。少し待ってからもう一度お試しください。', rateHeaders)
      : fail(502, 'upstream_error', 'AIサービスでエラーが発生しました。', rateHeaders);
  }

  // Streaming: pass the server-sent events straight through.
  if (v.stream) {
    return new Response(upstream.body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', ...rateHeaders }
    });
  }

  const data = await upstream.json();
  const text = provider === 'groq'
    ? (data.choices?.[0]?.message?.content || '')
    : (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return json({ text }, 200, rateHeaders);
}

// Anything other than POST.
export async function onRequest() {
  return fail(405, 'method_not_allowed', 'POSTのみ対応しています。', { allow: 'POST' });
}
