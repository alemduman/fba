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

// Участники турнира: сначала пары-соперники из picks.pairs (четвертьфиналы будут «принципиальными»), остальное добираем из популярных
function pickTeams(P, size, countries, rivals) {
  const known = new Set(countries.map(c => c.id));
  const europe = (P.europe || []).filter(i => known.has(i)), world = (P.world || []).filter(i => known.has(i));
  const ids = [], used = new Set();
  if (rivals) for (const pr of shuffle((P.pairs || []).filter(pr => pr.length === 2 && pr.every(i => known.has(i))))) {
    if (ids.length >= size) break;
    if (pr.some(i => used.has(i))) continue;
    ids.push(...(Math.random() < 0.5 ? pr : pr.slice().reverse())); pr.forEach(i => used.add(i));
  }
  for (let t = 0; t < 500 && ids.length < size; t += 2) {
    const two = [];
    for (let k = 0; k < 50 && two.length < 2; k++) {
      const src = Math.random() < (P.europeShare ?? 0.65) ? europe : (world.length ? world : europe), id = pick(src);
      if (!used.has(id) && !two.includes(id)) two.push(id);
    }
    if (two.length === 2) { ids.push(...two); two.forEach(i => used.add(i)); }
  }
  if (ids.length < size) throw new Error('Не удалось подобрать участников турнира: проверь списки picks в config.json.');
  return ids.slice(0, size);
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
  const NOW = process.env.FAKE_NOW ? new Date(process.env.FAKE_NOW) : new Date();   // FAKE_NOW нужен только для проверок
  const TZ = cfg.timezone || 'Asia/Baku';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(NOW);                         // ГГГГ-ММ-ДД
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(NOW).toLowerCase();   // mon…sun
  if (process.env.GITHUB_EVENT_NAME === 'schedule' && cfg.startDate) {
    if (today < cfg.startDate) {
      console.log(`Публикации по расписанию начнутся с ${cfg.startDate} (сейчас ${today}). Этот запуск ничего не делает.`);
      summary(`### Ещё рано\nПубликации по расписанию начнутся с ${cfg.startDate} (в config.json поле \`startDate\`). Сейчас ${today}.`);
      setOutput('skip', 'true');
      return;
    }
  }
  // Защита от опоздавших запусков: GitHub иногда запускает расписание с задержкой в часы. Если запуск опоздал больше maxDelayMinutes
  // относительно ближайшего слота из schedule.hours, он ничего не делает (ролик не выходит не вовремя).
  if (process.env.GITHUB_EVENT_NAME === 'schedule' && cfg.schedule && Array.isArray(cfg.schedule.hours) && cfg.schedule.hours.length) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(NOW).map(x => [x.type, x.value]));
    const m = (+parts.hour % 24) * 60 + +parts.minute, min = +cfg.schedule.minute || 0, maxD = +cfg.schedule.maxDelayMinutes || 120;
    const ok = cfg.schedule.hours.some(h => [-1440, 0, 1440].some(sh => { const d = m + sh - (h * 60 + min); return d >= -20 && d <= maxD; }));
    if (!ok) {
      console.log(`Запуск пришёл в ${parts.hour}:${parts.minute} по ${TZ}, это слишком далеко от слотов расписания (допустимое опоздание ${maxD} мин). Пропускаем.`);
      summary(`### Опоздавший запуск пропущен\nЗапуск пришёл в ${parts.hour}:${parts.minute} (${TZ}), а ближайший слот был больше ${maxD} минут назад. Ролик не делался и не публиковался.`);
      setOutput('skip', 'true');
      return;
    }
  }
  const AD = String(cfg.ad || 'off').toLowerCase();
  if (!['off', 'musor', 'vpn'].includes(AD)) throw new Error(`В config.json "ad" может быть "off", "musor" или "vpn" (сейчас "${cfg.ad}").`);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(SITE, 'v'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'static'), SITE, { recursive: true });

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
  // Турнир идёт, если он включён и (уже начат и не закончен, либо сегодня день турнира и сегодня турнир ещё не проходил)
  const active = !!(state.tournament && state.tournament.phase !== 'done');
  const dayOk = !T.weekday || String(T.weekday).toLowerCase().slice(0, 3) === weekday;
  const doneToday = !!(T.weekday && state.tournament && state.tournament.phase === 'done' && state.tournament.date === today);
  const tourMode = !!T.enabled && (active || (dayOk && !doneToday));
  if (tourMode) {
    tour = active ? state.tournament : null;
    if (!tour) {
      const size = [4, 8, 16].includes(+T.size) ? +T.size : 8;
      let ids, src = 'all';
      if (cfg.picks) {
        ids = pickTeams(cfg.picks, size, countries, T.teams !== 'random');
        const eu = new Set(cfg.picks.europe || []);
        if (ids.every(i => eu.has(i))) src = 'eu';
      } else {
        const groups = T.groups && T.groups.length ? T.groups : ['countries'];
        const pool = poolFor(groups);
        if (pool.length < size) throw new Error(`Для турнира на ${size} не хватает флагов в группах ${groups.join(', ')} (есть ${pool.length}).`);
        src = groups.length === 1 ? (groups[0] === 'countries' ? 'all' : groups[0]) : 'all';
        ids = shuffle(pool).slice(0, size);
      }
      const name = T.name || await page.evaluate(s => window.FlagBattle.tourDefaultName(s), src);
      const R = Math.log2(size);
      tour = { v: 1, phase: 'live', size, src, shuffle: false, outro: T.outro !== false, ids, name, date: today,
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

  const MAXS = +cfg.maxSeconds > 0 ? +cfg.maxSeconds : 30;
  const len = tourMode ? (T.length || '18-25') : cfg.length;   // в турнирном ролике ещё 3 секунды сетки в конце
  let plan = null;
  for (let attempt = 1; attempt <= 12 && !plan; attempt++) {
    const conf = await page.evaluate(o => window.FlagBattle.configure(o), {
      mode, lang: cfg.language, speed: cfg.speed, lines: cfg.lines, ramp: cfg.ramp, len, music: cfg.music, snd: cfg.sound,
      wm: cfg.watermark || '', ad: AD === 'off' ? { on: false } : { on: true, kind: AD }, sel, tour, scale: 1,
      seedBase: Math.floor(Math.random() * 1e6), want: 'any', bitrate: cfg.recordBitrate || 20e6,
    });
    if (attempt === 1) log('Настройки:', JSON.stringify(conf));
    const p = await page.evaluate(() => window.FlagBattle.plan());
    if (p && p.seconds <= MAXS) plan = p;
    else log(`Партия не подошла (${p ? Math.round(p.seconds * 10) / 10 + ' с' : 'не найдена'}, нужно не больше ${MAXS} с), пробую ещё раз`);
  }
  if (!plan) throw new Error(`Не удалось подобрать партию не длиннее ${MAXS} с: уменьши "length" или увеличь "speed" в config.json.`);
  log(`Партия №${plan.seed}, около ${Math.round(plan.seconds)} с`);

  // обложку делаем до записи: после записи турнир переходит к следующему матчу и подпись на обложке сбилась бы
  const coverB64 = cfg.cover === false ? null : await page.evaluate(async style => {
    const b = await window.FlagBattle.cover({ style }); if (!b) return null;
    const u = new Uint8Array(await b.arrayBuffer()); let s = '';
    for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768));
    return btoa(s);
  }, cfg.coverStyle === 'frame' ? 'frame' : 'who');

  // запись; видео большое (высокий битрейт), поэтому забираем из браузера кусками
  const raw = path.join(OUT, 'raw.mp4');
  const size = await page.evaluate(async () => { window.__blob = await window.FlagBattle.record(); return window.__blob.size; });
  {
    const fd = fs.openSync(raw, 'w'), CH = 3 * 1024 * 1024;
    for (let off = 0; off < size; off += CH) {
      const part = await page.evaluate(async ([o, n]) => {
        const u = new Uint8Array(await window.__blob.slice(o, o + n).arrayBuffer()); let s = '';
        for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768));
        return btoa(s);
      }, [off, CH]);
      fs.writeSync(fd, Buffer.from(part, 'base64'));
    }
    fs.closeSync(fd);
  }
  log(`Видео записано (${(size / 1048576).toFixed(1)} МБ до перекодирования)`);
  const caption = await page.evaluate(() => window.FlagBattle.caption());
  const tourAfter = await page.evaluate(() => window.FlagBattle.tourState());
  await browser.close();

  const date = new Date().toISOString().slice(0, 10);
  const slug = sel.map(id => (byId[id] ? byId[id].en : id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')).join('-').slice(0, 80);
  const name = `${date}-${slug}-${plan.seed}`;
  const video = path.join(SITE, 'v', name + '.mp4');
  // Instagram просит H.264 + AAC; браузер без проприетарных кодеков пишет VP9/Opus, поэтому перекодируем.
  // Качество максимальное из разрешённого: низкий CRF и неспешный пресет; потолок Instagram для видео 25 Мбит/с, для звука 128 кбит/с
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', raw, '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-crf', '14', '-maxrate', '24M', '-bufsize', '48M',
    '-g', '120', '-keyint_min', '60', '-sc_threshold', '0', '-flags', '+cgop',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', video]);
  fs.rmSync(raw);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate:format=duration,size', '-of', 'json', video]).toString());
  log('Готово:', JSON.stringify(probe));
  const dur = +probe.format.duration;
  if (!(dur > 3 && dur <= MAXS + 0.5)) throw new Error(`Длина готового видео ${dur.toFixed(1)} с, а допустимо до ${MAXS} с.`);
  let cover = null;
  if (coverB64) { cover = 'v/' + name + '.jpg'; fs.writeFileSync(path.join(SITE, cover), Buffer.from(coverB64, 'base64')); }

  // Instagram разрешает не больше 5 хэштегов: свои из extraHashtags идут первыми, остальные места занимают хэштеги приложения
  let text = caption.text;
  // Текст для охвата: короткий призыв выбрать победителя в комментариях + широкие хэштеги (до 5, лимит Instagram).
  {
    const paras = text.split(/\n\s*\n/).map(x => x.trim()).filter(Boolean);
    const body = paras.filter(x => !/^Cut every rival/i.test(x) && !/^Follow for/i.test(x) && !/^#\S+(\s+#\S+)*$/.test(x));
    if (body.length < paras.length) {
      const tags = sel.slice(0, 2).map(id => '#' + (byId[id] ? byId[id].en : id).toLowerCase().replace(/[^a-z0-9]+/g, ''));
      text = [...body, 'Which flag survives? Pick your winner in the comments 👇', 'Follow for a new battle every 2 hours ⚔️', [...tags, '#flagbattle', '#geography', '#countries'].join(' ')].join('\n\n');
    }
  }
  const extra = (cfg.extraHashtags || []).map(t => '#' + String(t).trim().replace(/^#+/, '').replace(/\s+/g, '')).filter(t => t.length > 1);
  if (extra.length) {
    const lines = text.split('\n'), last = (lines[lines.length - 1] || '').trim();
    const appTags = /^#\S+(\s+#\S+)*$/.test(last) ? (lines.pop(), last.split(/\s+/)) : [];
    text = lines.join('\n').trimEnd() + '\n\n' + [...new Set([...extra, ...appTags])].slice(0, 5).join(' ');
  }
  writeJSON(path.join(OUT, 'post.json'), { video: 'v/' + name + '.mp4', cover, caption: text, title: caption.title, sel, mode, seconds: plan.seconds, seed: plan.seed, createdAt: new Date().toISOString() });

  const next = { ...state, history: [...state.history, { date, sel, mode, seed: plan.seed, video: name + '.mp4' }].slice(-200) };
  if (tourMode) next.tournament = tourAfter;
  writeJSON(path.join(OUT, 'state.next.json'), next);
  summary(`### Ролик готов\n- Страны: ${sel.map(id => byId[id] ? byId[id].en : id).join(' vs ')}\n- Режим: ${mode}${tourMode ? ' (турнир «' + tour.name + '»)' : ''}, длина ≈ ${Math.round(plan.seconds)} с\n- Файл: \`${name}.mp4\`\n\n**Подпись:**\n\n${text.replace(/\n/g, '  \n')}\n`);
  log('Всё готово');
}

main().catch(e => { console.error('❌ ' + (e && e.message || e)); process.exit(1); });
