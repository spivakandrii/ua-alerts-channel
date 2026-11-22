// Перевіряє повітряні тривоги по областях і публікує зміни в Telegram-канал.
// Стан (які області зараз у тривозі) зберігається у state.json між запусками.
//
// Змінні середовища:
//   TELEGRAM_BOT_TOKEN   — токен бота (бот має бути адміністратором каналу)
//   TELEGRAM_CHANNEL_ID  — @username каналу або його числовий id (-100...)
//   REGIONS              — необов'язково: список областей через кому; порожньо = всі
//   DRY_RUN=1            — нічого не надсилати, лише вивести повідомлення в консоль

import { readFile, writeFile, appendFile } from 'node:fs/promises';

// Стан публікується через GitHub Pages — його читає PWA (docs/index.html).
const STATE_FILE = 'docs/status.json';
const CHANGES_FILE = 'changes.json'; // для send-push.mjs
const SOURCE = 'https://ubilling.net.ua/aerialalerts/';
const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHANNEL_ID: chatId, REGIONS = '', DRY_RUN } = process.env;
const filter = REGIONS.split(',').map(s => s.trim()).filter(Boolean);

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const kyivTime = () => new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' }).format(new Date());

// Час у джерелі має вигляд "2026-11-22 17:33:31" (київський). Для різниці беремо обидва як UTC — зсув скоротиться.
const parse = s => Date.parse(s.replace(' ', 'T') + 'Z');
function duration(from, to) {
  const min = Math.round((parse(to) - parse(from)) / 60000);
  if (!Number.isFinite(min) || min < 0) return '';
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h} год ${m} хв` : `${m} хв`;
}

async function fetchStates() {
  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'ua-alerts-channel' } });
  if (!res.ok) throw new Error(`Джерело відповіло HTTP ${res.status}`);
  const data = await res.json();
  if (!data || typeof data.states !== 'object') throw new Error('Неочікуваний формат відповіді');
  const states = {};
  for (const [name, s] of Object.entries(data.states)) {
    if (filter.length && !filter.includes(name)) continue;
    states[name] = { alert: !!s.alertnow, changed: s.changed };
  }
  return states;
}

async function loadState() {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch { return null; }
}

async function send(text) {
  if (DRY_RUN) { console.log('--- повідомлення (DRY_RUN) ---\n' + text + '\n------------------------------'); return; }
  if (!token || !chatId) throw new Error('Не задано TELEGRAM_BOT_TOKEN або TELEGRAM_CHANNEL_ID');
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) throw new Error(`Telegram: ${body.description || res.status}`);
}

async function saveState(active, changes) {
  const status = { updated: new Date().toISOString(), regions: Object.keys(states), active };
  await writeFile(STATE_FILE, JSON.stringify(status, null, 2) + '\n');
  if (changes) await writeFile(CHANGES_FILE, JSON.stringify(changes));
}

async function setOutput(changed) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
}

let states;
try {
  states = await fetchStates();
} catch (e) {
  // Джерело недоступне — нічого не змінюємо, спробуємо наступного запуску.
  console.warn(`Не вдалося отримати дані: ${e.message}`);
  await setOutput(false);
  process.exit(0);
}

const active = Object.fromEntries(Object.entries(states).filter(([, s]) => s.alert).map(([n, s]) => [n, s.changed]));
const prev = await loadState();

if (!prev) {
  // Перший запуск: запам'ятовуємо поточний стан і повідомляємо, що моніторинг працює.
  const list = Object.keys(active);
  await send(
    `📡 <b>Моніторинг тривог запущено</b>\n\n` +
    (list.length ? `Зараз тривога:\n${list.map(n => `• ${esc(n)}`).join('\n')}` : 'Зараз тривог немає 🟢') +
    `\n\n🕐 ${kyivTime()}`);
  await saveState(active, null);
  await setOutput(true);
  process.exit(0);
}

const started = Object.keys(active).filter(n => !(n in prev.active));
const ended = Object.keys(prev.active).filter(n => !(n in active));

if (!started.length && !ended.length) {
  console.log(`Без змін. Тривога в ${Object.keys(active).length} регіонах.`);
  await setOutput(false);
  process.exit(0);
}

const durations = Object.fromEntries(ended.map(n => [n, states[n] ? duration(prev.active[n], states[n].changed) : '']));
const parts = [];
if (started.length) parts.push(`🔴 <b>Повітряна тривога!</b>\n${started.map(n => `• ${esc(n)}`).join('\n')}`);
if (ended.length) parts.push(`🟢 <b>Відбій тривоги</b>\n${ended.map(n =>
  `• ${esc(n)}${durations[n] ? ` <i>(тривала ${durations[n]})</i>` : ''}`).join('\n')}`);
parts.push(`🕐 ${kyivTime()}`);

await send(parts.join('\n\n'));  // якщо надіслати не вдалося — стан не зберігаємо, повторимо наступного разу
await saveState(active, { started, ended, durations });
await setOutput(true);
console.log(`Надіслано: почалось ${started.length}, відбій ${ended.length}.`);
