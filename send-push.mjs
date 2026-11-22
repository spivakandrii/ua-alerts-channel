// Розсилає Web Push-сповіщення підписникам PWA після зміни тривог.
// Запускається з workflow лише тоді, коли check-alerts.mjs записав changes.json.
//
// Змінні середовища:
//   SUBS_API          — адреса Cloudflare Worker із підписками (worker/worker.js)
//   PUSH_ADMIN_TOKEN  — токен адміністратора Worker (секрет ADMIN_TOKEN там)
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY — ключі VAPID (публічний також вписаний у docs/index.html)

import { readFile } from 'node:fs/promises';
import webpush from 'web-push';

const { SUBS_API, PUSH_ADMIN_TOKEN, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
if (!SUBS_API || !PUSH_ADMIN_TOKEN) { console.log('Push не налаштовано.'); process.exit(0); }
if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) throw new Error('Не задано VAPID-ключі');

const auth = { authorization: `Bearer ${PUSH_ADMIN_TOKEN}` };
const res = await fetch(`${SUBS_API}/subscriptions`, { headers: auth, signal: AbortSignal.timeout(20000) });
if (!res.ok) throw new Error(`Сервер підписок відповів ${res.status}`);
const subs = await res.json();
if (!subs.length) { console.log('Немає підписок.'); process.exit(0); }

const { started = [], ended = [], durations = {} } = JSON.parse(await readFile('changes.json', 'utf8'));
webpush.setVapidDetails('https://github.com/spivakandrii/ua-alerts-channel', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

let sent = 0;
const gone = [];
await Promise.all(subs.map(async sub => {
  const mine = list => (sub.regions && sub.regions.length ? list.filter(n => sub.regions.includes(n)) : list);
  const s = mine(started), e = mine(ended);
  if (!s.length && !e.length) return;

  const payload = s.length
    ? { title: '🔴 Повітряна тривога!', body: s.join(', '), tag: 'alert', alert: true }
    : { title: '🟢 Відбій тривоги', body: e.map(n => durations[n] ? `${n} (тривала ${durations[n]})` : n).join(', '), tag: 'alert', alert: false };
  if (s.length && e.length) payload.body += `\nВідбій: ${e.join(', ')}`;

  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), { TTL: 600, urgency: 'high' });
    sent++;
  } catch (err) {
    // 404/410 — підписка більше не дійсна (користувач відписався або видалив застосунок).
    if (err.statusCode === 404 || err.statusCode === 410) gone.push(sub.endpoint);
    else console.warn(`Помилка надсилання (${err.statusCode || ''}): ${err.body || err.message}`);
  }
}));

if (gone.length) {
  await fetch(`${SUBS_API}/remove`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ endpoints: gone }) }).catch(() => {});
}
console.log(`Push: підписок ${subs.length}, надіслано ${sent}, прибрано недійсних ${gone.length}.`);
