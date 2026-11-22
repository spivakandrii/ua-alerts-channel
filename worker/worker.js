// Cloudflare Worker: зберігає push-підписки PWA разом із вибраними регіонами (Workers KV).
//
//   POST /subscribe     { subscription: { endpoint, keys: { p256dh, auth } }, regions: [..] }   — з PWA
//   POST /unsubscribe   { endpoint }                                                             — з PWA
//   GET  /subscriptions                         Authorization: Bearer <ADMIN_TOKEN>              — з GitHub Actions
//   POST /remove        { endpoints: [..] }     Authorization: Bearer <ADMIN_TOKEN>              — прибрати недійсні
//
// Прив'язки (wrangler.toml): KV-простір SUBS, змінна ALLOWED_ORIGIN, секрет ADMIN_TOKEN.

const MAX_REGIONS = 30;

async function keyOf(endpoint) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function validSubscription(s) {
  return s && typeof s.endpoint === 'string' && s.endpoint.startsWith('https://') && s.endpoint.length < 1000
    && s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string'
    && s.keys.p256dh.length < 200 && s.keys.auth.length < 100;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, authorization',
      'Access-Control-Max-Age': '86400',
    };
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
    const isAdmin = () => env.ADMIN_TOKEN && request.headers.get('authorization') === `Bearer ${env.ADMIN_TOKEN}`;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      if (request.method === 'POST' && url.pathname === '/subscribe') {
        const { subscription, regions = [] } = await request.json();
        if (!validSubscription(subscription)) return json({ error: 'bad subscription' }, 400);
        const clean = Array.isArray(regions)
          ? [...new Set(regions.filter(r => typeof r === 'string' && r.length <= 60))].slice(0, MAX_REGIONS)
          : [];
        const record = { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth }, regions: clean, ts: Date.now() };
        await env.SUBS.put(await keyOf(subscription.endpoint), JSON.stringify(record));
        return json({ ok: true, regions: clean });
      }

      if (request.method === 'POST' && url.pathname === '/unsubscribe') {
        const { endpoint } = await request.json();
        if (typeof endpoint !== 'string') return json({ error: 'bad endpoint' }, 400);
        await env.SUBS.delete(await keyOf(endpoint));
        return json({ ok: true });
      }

      if (request.method === 'GET' && url.pathname === '/subscriptions') {
        if (!isAdmin()) return json({ error: 'unauthorized' }, 401);
        const out = [];
        let cursor;
        do {
          const page = await env.SUBS.list({ cursor });
          for (const k of page.keys) {
            const v = await env.SUBS.get(k.name);
            if (v) out.push(JSON.parse(v));
          }
          cursor = page.list_complete ? undefined : page.cursor;
        } while (cursor);
        return json(out);
      }

      if (request.method === 'POST' && url.pathname === '/remove') {
        if (!isAdmin()) return json({ error: 'unauthorized' }, 401);
        const { endpoints = [] } = await request.json();
        for (const e of endpoints) if (typeof e === 'string') await env.SUBS.delete(await keyOf(e));
        return json({ ok: true, removed: endpoints.length });
      }

      if (url.pathname === '/') return json({ ok: true, service: 'ua-alerts push subscriptions' });
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: 'bad request' }, 400);
    }
  },
};
