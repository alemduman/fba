// Делает один ролик из app.html в безголовом Chromium и готовит его к публикации.
// Результат: out/site/v/<имя>.mp4 (+ обложка .jpg), out/post.json, out/state.next.json
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { ROOT, OUT, SITE, loadConfig, loadState, writeJSON, pick, shuffle, setOutput, summary } from './lib.mjs';

// Подбор стран: либо готовая тематическая тройка (соперничества, общая история), либо случайная из списков «популярных».
function pickCurated(P, history, countries, [range]) {
  const known = new Set(countries.map(c => c.id));
  const ok = ids => ids.every(i => known.has(i));
  const key = ids => ids.slice().sort().join(',');
  const recent = new Set(history.slice(-60).map(h => key(h.sel || [])));
  const bad = P.neverTogether || [];
  const clash = ids => bad.some(([a, b]) => ids.includes(a) && ids.includes(b));
  const sets = (P.sets || []).filter(ok);
  const [a, b] = (range || [3, 3]).map(Number), lo = Math.max(2, Math.min(8, a || 3)), hi = Math.max(lo, Math.min(8, b || lo));
  const europe = (P.europe || []).filter(i => known.has(i)), world = (P.world || []).filter(i => known.has(i));
  if (sets.length && Math.random() < (P.setChance ?? 0.45)) {
    const fresh = sets.filter(s => !recent.has(key(s)));
    if (fresh.length) return shuffle(pick(fresh).slice());
  }
  for (let k = 0; k < 200; k++) {
    const n = lo + Math.floor(Math.random() * (hi - lo + 1)), ids = [];
    for (let t = 0; t < 50 && ids.length < n; t++) {
      const src = (Math.random() < (P.europeShare ?? 0.65) ? europe : world.length ? world : europe);
      const id = pick(src); if (!ids.includes(id)) ids.push(id);
    }
    if (ids.length === n && !clash(ids) && !recent.has(key(ids))) return ids;
  }
  throw new Error('Не удалось подобрать страны: проверь списки picks в config.json.');
}

async function main() {
  const cfg = loadConfig();
  const state = loadState();
  if (process.env.GITHUB_EVENT_NAME === 'schedule' && cfg.autoPublish !== true) {
    console.log('Публикация по расписанию выключена: в config.json стоит "autoPublish": false. Этот запуск ничего не делает.');
    summary('### Расписание на паузе\nВ `config.json` стоит `"autoPublish": false`, поэтому ролик не делался и не публиковался.\nЧтобы включить, поменяй на `true`.');
    setOutput('skip', 'true');
    return;
  }
  if (process.env.GITHUB_EVENT_NAME === 'schedule' && cfg.startDate) {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone || 'Asia/Baku' }).format(new Date());   // ГГГГ-ММ-ДД
    if (today < cfg.startDate) {
      console.log(`Публикации по расписанию начнутся с ${cfg.startDate} (сейчас ${today}). Этот запуск ничего не делает.`);
      summary(`### Ещё рано\nПубликации по расписанию начнутся с ${cfg.startDate} (в config.json поле \`startDate\`). Сейчас ${today}.`);
      setOutput('skip', 'true');
      return;
    }
  }
  const AD = String(cfg.ad || 'off').toLowerCase();
  if (!['off', 'musor', 'vpn'].includes(AD)) throw new Error(`В config.json "ad" может быть "off", "musor" или "vpn" (сейчас "${cfg.ad}").`);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(SITE, 'v'), { recursive: true });
  fs.writeFileSync(path.join(SITE, 'index.html'), '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>flag battle</title>');

  const t0 = Date.now();
  const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} с]`, ...a);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 520, height: 960 } });
  page.on('pageerror', e => console.error('Ошибка на странице:', e.message));
  await page.goto('file://' + path.join(ROOT, 'app.html'));
  await page.waitForFunction(() => window.FlagBattle && window.FlagBattle.ready, null, { timeout: 180000 });
  log('Приложение загружено');

  const countries = await page.evaluate(() => window.FlagBattle.countries());
  const byId = Object.fromEntries(countries.map(c => [c.id, c]));
  const inGroups = (c, groups) => groups.some(g => g === 'countries' ? c.country : g === 'all' ? true : c.group === g);
  const poolFor = groups => {
    const ids = new Set(countries.filter(c => inGroups(c, groups)).map(c => c.id));
    for (const id of cfg.include || []) if (byId[id]) ids.add(id);
    for (const id of cfg.exclude || []) ids.delete(id);
    return [...ids];
  };

  // язык нужен заранее: от него зависит название турнира по умолчанию
  await page.evaluate(lang => window.FlagBattle.configure({ lang }), cfg.language);

  const modes = Array.isArray(cfg.mode) ? cfg.mode : String(cfg.mode || 'lines').split(',').map(s => s.trim()).filter(Boolean);
  const ALL_MODES = ['lines', 'pegs', 'maze', 'spin', 'funnel', 'slope', 'roulette', 'collapse', 'territory', 'bounce'];
  const mode = modes[0] === 'random' ? pick(ALL_MODES) : pick(modes);

  let sel, tour = null;
  const T = cfg.tournament || {};
  if (T.enabled) {
    tour = state.tournament && state.tournament.phase !== 'done' ? state.tournament : null;
    if (!tour) {
      const size = [4, 8, 16].includes(+T.size) ? +T.size : 8;
      const groups = T.groups && T.groups.length ? T.groups : ['countries'];
      const pool = poolFor(groups);
      if (pool.length < size) throw new Error(`Для турнира на ${size} не хватает флагов в группах ${groups.join(', ')} (есть ${pool.length}).`);
      const src = groups.length === 1 ? (groups[0] === 'countries' ? 'all' : groups[0]) : 'all';
      const name = T.name || await page.evaluate(s => window.FlagBattle.tourDefaultName(s), src);
      const R = Math.log2(size);
      tour = { v: 1, phase: 'live', size, src, shuffle: false, outro: T.outro !== false, ids: shuffle(pool).slice(0, size), name,
        W: Array.from({ length: R }, (_, r) => Array(size >> (r + 1)).fill(null)), cur: null };
      log(`Новый турнир «${name}»: ${tour.ids.join(', ')}`);
    }
    tour.outro = T.outro !== false;
    let next = null;
    for (let r = 0; r < tour.W.length && !next; r++) for (let m = 0; m < tour.W[r].length; m++) if (!tour.W[r][m]) { next = { r, m }; break; }
    if (!next) throw new Error('В турнире не осталось матчей.');
    tour.cur = next;
    sel = next.r === 0 ? [tour.ids[2 * next.m], tour.ids[2 * next.m + 1]] : [tour.W[next.r - 1][2 * next.m], tour.W[next.r - 1][2 * next.m + 1]];
    log(`Матч турнира: раунд ${next.r + 1}, пара ${next.m + 1}: ${sel.join(' vs ')}`);
  } else if (cfg.picks) {
    sel = pickCurated(cfg.picks, state.history, countries, [cfg.countriesPerVideo]);
    log(`Страны: ${sel.join(', ')}`);
  } else {
    const pool = poolFor(cfg.groups && cfg.groups.length ? cfg.groups : ['countries']);
    const [a, b] = (cfg.countriesPerVideo || [2, 3]).map(Number);
    const lo = Math.max(2, Math.min(8, a || 2)), hi = Math.max(lo, Math.min(8, b || lo));
    if (pool.length < lo) throw new Error(`В выбранных группах всего ${pool.length} флагов.`);
    const recent = new Set(state.history.slice(-60).map(h => (h.sel || []).slice().sort().join(',')));
    for (let k = 0; k < 60; k++) {
      const n = lo + Math.floor(Math.random() * (hi - lo + 1));
      sel = shuffle(pool.slice()).slice(0, Math.min(n, pool.length));
      if (!recent.has(sel.slice().sort().join(','))) break;
    }
    log(`Страны: ${sel.join(', ')}`);
  }

  const conf = await page.evaluate(o => window.FlagBattle.configure(o), {
    mode, lang: cfg.language, speed: cfg.speed, lines: cfg.lines, ramp: cfg.ramp, len: cfg.length, music: cfg.music, snd: cfg.sound,
    wm: cfg.watermark || '', ad: AD === 'off' ? { on: false } : { on: true, kind: AD }, sel, tour, scale: 1, seedBase: Math.floor(Math.random() * 1e6), want: 'any',
  });
  log('Настройки:', JSON.stringify(conf));
  const plan = await page.evaluate(() => window.FlagBattle.plan());
  if (!plan) throw new Error('Не удалось подобрать партию с такими настройками.');
  log(`Партия №${plan.seed}, около ${Math.round(plan.seconds)} с`);

  const b64 = await page.evaluate(async () => {
    const blob = await window.FlagBattle.record();
    const u = new Uint8Array(await blob.arrayBuffer()); let s = '';
    for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768));
    return btoa(s);
  });
  log('Видео записано');
  const caption = await page.evaluate(() => window.FlagBattle.caption());
  const coverB64 = cfg.cover === false ? null : await page.evaluate(async style => {
    const b = await window.FlagBattle.cover({ style }); if (!b) return null;
    const u = new Uint8Array(await b.arrayBuffer()); let s = '';
    for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768));
    return btoa(s);
  }, cfg.coverStyle === 'frame' ? 'frame' : 'who');
  const tourAfter = await page.evaluate(() => window.FlagBattle.tourState());
  await browser.close();

  const date = new Date().toISOString().slice(0, 10);
  const slug = sel.map(id => (byId[id] ? byId[id].en : id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')).join('-').slice(0, 80);
  const name = `${date}-${slug}-${plan.seed}`;
  const raw = path.join(OUT, 'raw.mp4'), video = path.join(SITE, 'v', name + '.mp4');
  fs.writeFileSync(raw, Buffer.from(b64, 'base64'));
  // Instagram просит H.264 + AAC; браузер без проприетарных кодеков пишет VP9/Opus, поэтому перекодируем
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'medium', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-crf', '20', '-maxrate', '12M', '-bufsize', '24M',
    '-g', '120', '-keyint_min', '60', '-sc_threshold', '0', '-flags', '+cgop',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', video]);
  fs.rmSync(raw);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate:format=duration,size', '-of', 'json', video]).toString());
  log('Готово:', JSON.stringify(probe));
  let cover = null;
  if (coverB64) { cover = 'v/' + name + '.jpg'; fs.writeFileSync(path.join(SITE, cover), Buffer.from(coverB64, 'base64')); }

  // Instagram разрешает не больше 5 хэштегов: свои из extraHashtags идут первыми, остальные места занимают хэштеги приложения
  let text = caption.text;
  const extra = (cfg.extraHashtags || []).map(t => '#' + String(t).trim().replace(/^#+/, '').replace(/\s+/g, '')).filter(t => t.length > 1);
  if (extra.length) {
    const lines = text.split('\n'), last = (lines[lines.length - 1] || '').trim();
    const appTags = /^#\S+(\s+#\S+)*$/.test(last) ? (lines.pop(), last.split(/\s+/)) : [];
    text = lines.join('\n').trimEnd() + '\n\n' + [...new Set([...extra, ...appTags])].slice(0, 5).join(' ');
  }
  writeJSON(path.join(OUT, 'post.json'), { video: 'v/' + name + '.mp4', cover, caption: text, title: caption.title, sel, mode, seconds: plan.seconds, seed: plan.seed, createdAt: new Date().toISOString() });

  const next = { ...state, history: [...state.history, { date, sel, mode, seed: plan.seed, video: name + '.mp4' }].slice(-200) };
  if (T.enabled) next.tournament = tourAfter;
  writeJSON(path.join(OUT, 'state.next.json'), next);
  summary(`### Ролик готов\n- Страны: ${sel.map(id => byId[id] ? byId[id].en : id).join(' vs ')}\n- Режим: ${mode}, длина ≈ ${Math.round(plan.seconds)} с\n- Файл: \`${name}.mp4\`\n\n**Подпись:**\n\n${text.replace(/\n/g, '  \n')}\n`);
  log('Всё готово');
}

main().catch(e => { console.error('❌ ' + (e && e.message || e)); process.exit(1); });
