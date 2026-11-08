// Автоответы на комментарии в Instagram. Без состояния: уже отвеченные комментарии определяются по нашим ответам в ветке.
// Env: IG_TOKEN, IG_USER_ID, ACCOUNT_DESC (о чём аккаунт), DRY_RUN, MAX_REPLIES (8), MAX_AGE_H (72), POSTS (10), ANTHROPIC_API_KEY (необязательно), REPLY_MODEL
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TOKEN = (process.env.IG_TOKEN || '').trim(), UID = (process.env.IG_USER_ID || '').trim();
const DRY = /^(1|true|yes)$/i.test(process.env.DRY_RUN || '');
const MAX = +process.env.MAX_REPLIES || 8, MAX_AGE = (+process.env.MAX_AGE_H || 72) * 3600e3, POSTS = +process.env.POSTS || 10;
const DESC = process.env.ACCOUNT_DESC || 'короткие видео';
const API = 'https://graph.facebook.com/v26.0';
if (!TOKEN || !UID) { console.error('Нет IG_TOKEN или IG_USER_ID'); process.exit(1); }

async function ig(method, path, params) {
  const body = new URLSearchParams({ ...(params || {}), access_token: TOKEN });
  const res = await fetch(method === 'GET' ? `${API}/${path}?${body}` : `${API}/${path}`, method === 'GET' ? { method } : { method, body });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || d.error) throw new Error(`IG ${path}: ${(d.error && d.error.message) || res.status}`);
  return d;
}

const SPAM = /(https?:\/\/|www\.|\.com|\.ru|t\.me|@\w|dm me|follow (me|back)|f4f|l4l|sub4sub|подпиш(и|ись|итесь) (на|в) |заработ|крипт|казино|ставк|promo|giveaway)/i;
const BAD = /(fuck|shit|bitch|nigg|идиот|тупой|сдохни|хуй|пизд|еб[аую]|суч?к[аи]|мразь)/i;
const emojiOnly = t => !/[\p{L}\p{N}]/u.test(t);
const isRu = t => /[а-яё]/i.test(t);
const T = {
  ru: ['Спасибо! 🙌', 'Классно, что смотришь! 🔥', 'Рады, что зашло 😎', 'Благодарим за комментарий! 🙌', 'Ого, мнение принято! 👀'],
  en: ['Thanks for watching! 🙌', 'Glad you liked it! 🔥', 'Appreciate it! 😎', 'Thank you for the comment! 🙌', 'Love the energy! 👀'],
};
const pick = a => a[Math.floor(Math.random() * a.length)];

async function llm(comment, caption) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const prompt = `Ты живой человек, который ведёт Instagram-аккаунт (${DESC}) и болтает с подписчиками в комментариях. Под видео (подпись: «${(caption || '').slice(0, 300)}») написали:\n«${comment.slice(0, 400)}»\n\nОтветь так, как ответил бы обычный дружелюбный парень в комментах: по-простому, тепло, с лёгким сленгом и юмором, на языке комментария (подстраивайся под стиль автора: если он пишет коротко и с маленькой буквы, отвечай так же). Правила: до 90 символов, максимум один эмодзи (а можно и без), не начинай с «Спасибо» и не пиши шаблонно, не повторяй одну и ту же конструкцию, не всегда задавай вопрос (вопрос только если он реально уместен), никаких ссылок, хэштегов и @. Не выдумывай факты о видео, держись того, что в подписи и комментарии. Не пиши о себе «я человек» и никогда не отрицай, что аккаунт может отвечать автоматически: если спрашивают «ты бот?», ответь шуткой и не ври ни в одну сторону (например «просто аккаунт, который любит флаги»). Ничего не обещай (ни новых видео, ни стран, ни конкурсов). Выводи только сам ответ одной строкой, без пояснений, рассуждений и кавычек. Отвечай на любой комментарий, ничего не пропускай. Если комментарий провокационный, злой, с оскорблениями, политикой, спорами про страны или нации, или просто троллинг: ответь с добрым юмором и самоиронией, разряди обстановку, не вставай ни на чью сторону, не спорь, не оскорбляй в ответ, не повторяй чужие оскорбления и не развивай острую тему. Если это спам или реклама со ссылкой: ответь коротко и шутливо, без ссылки и без продвижения. Верни только текст ответа.`;
  try {
    const r = await fetch(process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: process.env.REPLY_MODEL || 'claude-sonnet-5-5', max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }) });
    const j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || r.status);
    const t = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim().replace(/^["«]|["»]$/g, '');
    if (t && (/\n/.test(t) || t.length > 130 || /(комментари[йяю] на|отвечаю на|the comment is|i'll reply|reply in)/i.test(t))) return 'SKIP';   // защита от «рассуждений» вместо ответа
    return t || null;
  } catch (e) { console.log('LLM недоступна, беру шаблон: ' + e.message); return null; }
}

if (process.env.SAMPLE_COMMENTS) { for (const t of process.env.SAMPLE_COMMENTS.split('|')) console.log(`«${t}» → «${await llm(t, process.env.SAMPLE_CAPTION || '')}»`); process.exit(0); }
const me = await ig('GET', UID, { fields: 'username' });
console.log(`Аккаунт @${me.username}${DRY ? ' (DRY RUN)' : ''}`);
const media = (await ig('GET', `${UID}/media`, { fields: 'id,caption,timestamp,comments_count', limit: String(POSTS) })).data || [];
let sent = 0, seen = 0;
for (const m of media) {
  if (!m.comments_count) continue;
  let list;
  try { list = (await ig('GET', `${m.id}/comments`, { fields: 'id,text,username,timestamp,replies{username}', limit: '50' })).data || []; }
  catch (e) { console.log(`Комментарии ${m.id}: ${e.message}`); continue; }
  for (const c of list) {
    seen++;
    const text = (c.text || '').trim();
    if (c.username === me.username) continue;
    if (Date.now() - Date.parse(c.timestamp) > MAX_AGE) continue;
    if ((c.replies && c.replies.data || []).some(r => r.username === me.username)) continue;
    // комментарий без текста (гифка, стикер) или только эмодзи: отвечаем эмодзи
    if (sent >= MAX) break;
    let reply = (text.length < 1 || emojiOnly(text)) ? pick(['🔥', '🙌', '😎', '👀', '😂', '💪', '🤝']) : await llm(text, m.caption);
    if (reply === null) { console.log(`нет ответа от LLM, пропускаю до следующего запуска: «${text.slice(0, 40)}»`); continue; }   // шаблонов нет: лучше промолчать, чем ответить как бот
    if (/^SKIP\b/i.test(reply)) { console.log(`LLM: пропуск «${text.slice(0, 40)}»`); continue; }
    reply = reply.slice(0, 200);
    console.log(`${c.username}: «${text.slice(0, 60)}» → «${reply}»`);
    if (!DRY) {
      try { await ig('POST', `${c.id}/replies`, { message: reply }); sent++; await sleep(20000 + Math.random() * 40000); }
      catch (e) { console.log('Ошибка ответа: ' + e.message); }
    } else sent++;
  }
}
console.log(`Просмотрено комментариев: ${seen}, ответов: ${sent}`);
