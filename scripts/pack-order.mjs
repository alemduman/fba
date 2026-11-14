// Порядок пачки роликов для TikTok по тем же правилам, что и автопостинг:
// страна не повторяется в cooldownVideos соседних роликах (по умолчанию 3), клубы и машины не идут подряд.
// node scripts/pack-order.mjs plan.json [сколько первых роликов уже вышло/запланировано — их не трогаем]
import fs from 'node:fs';
import { loadConfig } from './lib.mjs';

const [file, keepArg] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
const keep = +keepArg || 0;
const P = loadConfig().picks || {};
const cd = Math.max(1, +(process.env.COOLDOWN || P.cooldownVideos || 3));
const kind = s => s[0].startsWith('fc_') ? 'fc' : s[0].startsWith('cb_') ? 'cb' : 'fl';

function ok(seq) {
  for (let k = keep; k < seq.length; k++) {
    const prev = new Set(seq.slice(Math.max(0, k - cd), k).flatMap(x => x.sel));
    if (seq[k].sel.some(c => prev.has(c))) return false;
    if (k > 0 && kind(seq[k].sel) !== 'fl' && kind(seq[k - 1].sel) !== 'fl') return false;
  }
  return true;
}

const fixed = plan.slice(0, keep), rest = plan.slice(keep);
let best = null;
for (let t = 0; t < 200000 && !best; t++) {
  const order = [...fixed], pool = [...rest];
  while (pool.length) {
    const cand = pool.filter(x => ok([...order, x]));
    if (!cand.length) break;
    const x = cand[Math.floor(Math.random() * cand.length)];
    order.push(x); pool.splice(pool.indexOf(x), 1);
  }
  if (!pool.length) best = order;
}
if (!best) { console.error(`Не получилось расставить без повторов (пауза ${cd}). Нужно больше разных стран в пачке.`); process.exit(1); }
// даты и часы остаются на своих местах, меняются только ролики
const out = best.map((x, i) => ({ ...x, date: plan[i].date, hour: plan[i].hour, n: plan.indexOf(x) + 1 }));
console.log(JSON.stringify(out, null, 1));
