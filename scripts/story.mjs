// Разовая публикация сторис с картинкой в Instagram (Graph API, media_type=STORIES).
// Env: IG_TOKEN, IG_USER_ID, STORY_IMAGE (путь в репозитории), DRY_RUN, WAIT_UNTIL (ISO-время UTC, до которого ждать), ONLY_DATE (YYYY-MM-DD UTC, иначе выйти)
import fs from 'node:fs';
import { loadConfig } from './lib.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cfg = loadConfig();
const API = `https://graph.facebook.com/${cfg.apiVersion || 'v26.0'}`;
const TOKEN = (process.env.IG_TOKEN || '').trim(), UID = (process.env.IG_USER_ID || '').trim();
const DRY = /^(1|true|yes)$/i.test(process.env.DRY_RUN || '');
const img = process.env.STORY_IMAGE || 'assets/story-board.jpg';
if (process.env.ONLY_DATE && new Date().toISOString().slice(0, 10) !== process.env.ONLY_DATE) { console.log('Не та дата, выхожу.'); process.exit(0); }
if (!TOKEN || !UID) { console.error('Нет IG_TOKEN или IG_USER_ID'); process.exit(1); }
if (!fs.existsSync(img)) { console.error('Нет файла ' + img); process.exit(1); }
const url = `https://raw.githubusercontent.com/${process.env.GITHUB_REPOSITORY}/main/${img}`;
async function api(method, u, params) {
  const body = new URLSearchParams({ ...(params || {}), access_token: TOKEN });
  const full = method === 'GET' ? `${u}?${body}` : u;
  const res = await fetch(full, method === 'GET' ? { method } : { method, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`Instagram API: ${(data.error && data.error.message) || res.status}`);
  return data;
}
const head = await fetch(url, { method: 'HEAD' });
console.log(`Картинка ${url}: ${head.status} ${head.headers.get('content-type')}`);
if (!head.ok) { console.error('Картинка не открывается по ссылке'); process.exit(1); }
const me = await api('GET', `${API}/${UID}`, { fields: 'username' });
console.log(`Аккаунт: @${me.username}`);
if (DRY) { console.log('DRY RUN: сторис не публикую.'); process.exit(0); }
if (process.env.WAIT_UNTIL) { const t = Date.parse(process.env.WAIT_UNTIL); const ms = t - Date.now(); if (ms > 0) { console.log(`Жду ${Math.round(ms / 1000)} с до ${process.env.WAIT_UNTIL}`); await sleep(ms); } }
const c = await api('POST', `${API}/${UID}/media`, { media_type: 'STORIES', image_url: url });
console.log('Контейнер ' + c.id);
let st = '';
for (let i = 0; i < 20; i++) { await sleep(5000); const s = await api('GET', `${API}/${c.id}`, { fields: 'status_code' }); st = s.status_code; console.log('Статус ' + st); if (st === 'FINISHED' || st === 'ERROR' || st === 'EXPIRED') break; }
if (st !== 'FINISHED') { console.error('Сторис не обработана: ' + st); process.exit(1); }
const pub = await api('POST', `${API}/${UID}/media_publish`, { creation_id: c.id });
console.log('Сторис опубликована, ID ' + pub.id);
