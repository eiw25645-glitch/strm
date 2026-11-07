import { Redis } from '@upstash/redis';
import crypto from 'crypto';

const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN });
const PEPPER = process.env.PIN_PEPPER || '';   // same value as Voting Space if you share accounts
const ADMINS = (process.env.ADMIN_ACCOUNTS || '').split(',').map((x) => x.trim().replace(/^@/, '').toLowerCase()).filter(Boolean);
const DAY_H = 7;   // 7 = a day starts at Thai midnight; 9 = Korean midnight (22:00 Thai) like Voting Space

// [minEXP, name] — level = number of thresholds reached (Lv4 = 600–999)
const LV_AT = [0, 100, 300, 600, 1000, 1500, 2100, 2800, 3600, 4500];   // XP needed for LV.1 ... LV.10 (same as Voting Space)
const PLATFORMS = ['Spotify', 'Apple Music', 'YouTube Music', 'Stationhead', 'Other'];
const AVATARS = ['🐰', '🐱', '🐻', '🦊', '🐼', '🐨', '🐯', '🐸'];

// ---------- helpers ----------
const today = () => new Date(Date.now() + DAY_H * 3600e3).toISOString().slice(0, 10); // Thai time UTC+7
const addDays = (d, n) => new Date(new Date(d + 'T00:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10);
const weekDates = () => {
  const t = today();
  const dow = (new Date(t + 'T00:00:00Z').getUTCDay() + 6) % 7; // Mon=0
  const start = addDays(t, -dow);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
};
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s));
const fail = (msg, code = 400) => { const e = new Error(msg); e.code = code; throw e; };
const levelOf = (exp) => LV_AT.filter((x) => exp >= x).length;

const lc = (x) => String(x).toLowerCase();
const cleanAcc = (v) => String(v || '').trim().replace(/^@+/, '');
const ACC_RE = /^[A-Za-z0-9_]{1,40}$/;
const SESS_TTL = 60 * 60 * 24 * 180, MAX_FAILS = 5, LOCK_SEC = 15 * 60;
const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt + PEPPER, 32).toString('hex');
const same = (x, y) => { const a = Buffer.from(String(x)), b = Buffer.from(String(y)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const isAdminAcc = (id) => ADMINS.includes(lc(id));
async function newSession(id) {
  const token = crypto.randomBytes(24).toString('hex');
  await redis.set('sess:' + token, 'a|' + id, { ex: SESS_TTL });
  return token;
}
async function sessionAcc(token) {
  if (!/^[a-f0-9]{48}$/.test(String(token || ''))) return null;
  const v = await redis.get('sess:' + token);
  return typeof v === 'string' && v.startsWith('a|') ? v.slice(2) : null;
}
async function checkPin(u, pin) {
  const id = lc(u.account), k = 'pinfail:' + id;
  if (Number((await redis.get(k)) || 0) >= MAX_FAILS) {
    const t = await redis.ttl(k);
    fail(`Too many attempts. Try again in ${Math.ceil((t > 0 ? t : LOCK_SEC) / 60)} min.`, 429);
  }
  if (/^\d{4}$/.test(String(pin || '')) && same(hashPin(pin, u.salt), u.hash)) { await redis.del(k); return; }
  const n = await redis.incr(k);
  if (n === 1 || n >= MAX_FAILS) await redis.expire(k, LOCK_SEC);
  fail(n >= MAX_FAILS ? `Too many attempts. Try again in ${LOCK_SEC / 60} min.` : `Incorrect PIN. ${MAX_FAILS - n} attempt(s) left.`, 401);
}
const okUrl = (u) => typeof u === 'string' && /^https:\/\/[^\s]+$/.test(u) && u.length < 500;
// Spotify cover via the public oEmbed endpoint (no API key). Returns '' if unavailable.
async function spCover(url) {
  if (!/^https:\/\/open\.spotify\.com\//.test(url || '')) return '';
  try {
    const r = await fetch('https://open.spotify.com/oembed?url=' + encodeURIComponent(url), { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return '';
    const j = await r.json();
    return okUrl(j.thumbnail_url) ? j.thumbnail_url : '';
  } catch { return ''; }
}

async function getUser(id) {
  const u = await redis.hgetall(`ss:user:${id}`);
  if (u && u.username) return u;
  const acc = await redis.hget('users', id);
  if (!acc) fail('User not found', 404);
  await redis.hset(`ss:user:${id}`, { id, username: acc.account, avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)], exp: 0, level: 1, streak: 0, bestStreak: 0, lastCheckin: '', totalHours: 0, totalStreams: 0, public: 1 });
  await redis.zadd('ss:leaderboard', { score: 0, member: id });
  return getUser(id);
}
function view(u) {
  const exp = Number(u.exp) || 0;
  const level = levelOf(exp);
  const best = Number(u.bestStreak) || 0;
  const badges = [
    exp > 0 || u.lastCheckin ? 'first' : null,
    best >= 5 ? 'streak5' : null,
    Number(u.totalHours) >= 10 ? 'listener' : null,
    level >= 4 ? 'dedicated' : null,
    level >= 6 ? 'crown' : null,
    level >= 7 ? 'diamond' : null,
  ].filter(Boolean);
  return {
    id: u.id, username: String(u.username), avatar: u.avatar, exp, level, levelName: '', isAdmin: isAdminAcc(u.id),
    prevExp: LV_AT[level - 1], nextExp: LV_AT[level] ?? null,
    streak: Number(u.streak) || 0, totalHours: Number(u.totalHours) || 0, totalStreams: Number(u.totalStreams) || 0,
    public: u.public !== 0 && u.public !== '0' && u.public !== false, badges,
  };
}
async function addExp(id, n) {
  const exp = await redis.hincrby(`ss:user:${id}`, 'exp', n);
  await redis.zadd('ss:leaderboard', { score: exp, member: id });
  await redis.hset(`ss:user:${id}`, { level: levelOf(exp) });
  return exp;
}
async function limit(key, max, secs) {
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, secs);
  if (n > max) fail('Too many attempts. Try again later.', 429);
}
async function weekDays(id) {
  const dates = weekDates();
  const p = redis.pipeline();
  dates.forEach((d) => p.hget(`ss:daily:${id}:${d}`, 'hours'));
  const hours = (await p.exec()).map((h) => Number(h) || 0);
  return { dates, hours };
}

// ---------- actions ----------
const A = {
  async register({ username, pin }, ctx) {
    await limit(`ss:rl:reg:${ctx.ip}`, 10, 3600);
    const account = cleanAcc(username);
    if (!ACC_RE.test(account)) fail('Enter your Twitter account (letters, numbers, _)');
    if (!/^\d{4}$/.test(String(pin || ''))) fail('PIN must be 4 digits');
    const id = lc(account), salt = crypto.randomBytes(16).toString('hex');
    const made = await redis.hsetnx('users', id, { account, salt, hash: hashPin(pin, salt), created: Date.now(), updated: Date.now() });
    if (!made) fail('This account already exists. Please log in.', 409);
    return { token: await newSession(id), user: view(await getUser(id)) };
  },
  async login({ username, pin }, ctx) {
    await limit(`ss:rl:login:${ctx.ip}`, 30, 600);
    const id = lc(cleanAcc(username));
    const rec = ACC_RE.test(id) ? await redis.hget('users', id) : null;
    if (!rec) fail('Wrong account or PIN', 401);
    await checkPin(rec, pin);
    return { token: await newSession(id), user: view(await getUser(id)) };
  },
  async me(_, ctx) {
    const u = await getUser(ctx.need());
    const t = today();
    return { user: view(u), checkedIn: !!(await redis.exists(`ss:checkin:${u.id}:${t}`)), today: t };
  },
  async today() {
    const t = today();
    let [pl, room] = await Promise.all([redis.get(`ss:playlist:${t}`), redis.get('ss:config:room')]);
    if (pl && pl.img === undefined) {   // playlist saved before covers existed: fetch once and keep it
      pl.img = await spCover(pl.url);
      await redis.set(`ss:playlist:${t}`, pl, { keepTtl: true });
    }
    return { date: t, playlist: pl || null, room: room || null, guide: (await redis.get('ss:config:guide')) || null };
  },
  async schedule() {
    const t = today();
    const p = redis.pipeline();
    for (let i = 0; i < 7; i++) p.get(`ss:playlist:${addDays(t, i)}`);
    const r = await p.exec();
    return { items: r.map((pl, i) => ({ date: addDays(t, i), title: pl ? pl.title : null })) };
  },
  async checkin(_, ctx) {
    const id = ctx.need();
    const t = today();
    const first = await redis.set(`ss:checkin:${id}:${t}`, 1, { nx: true, ex: 172800 });
    const u = await getUser(id);
    if (!first) return { already: true, user: view(u) };
    const streak = u.lastCheckin === addDays(t, -1) ? (Number(u.streak) || 0) + 1 : 1;
    await redis.hset(`ss:user:${id}`, { streak, bestStreak: Math.max(streak, Number(u.bestStreak) || 0), lastCheckin: t });
    await addExp(id, 10);
    return { gained: 10, user: view(await getUser(id)) };
  },
  async claimPlaylist(_, ctx) {
    const id = ctx.need();
    const t = today();
    if (!(await redis.get(`ss:playlist:${t}`))) fail('No playlist set for today yet');
    const first = await redis.set(`ss:plclaim:${id}:${t}`, 1, { nx: true, ex: 172800 });
    if (!first) return { already: true, user: view(await getUser(id)) };
    await addExp(id, 20);
    return { gained: 20, user: view(await getUser(id)) };
  },
  async missions(_, ctx) {
    const id = ctx.need();
    const t = today();
    const dates = weekDates();
    const { hours } = await weekDays(id);
    const [ci, pl, hasPl, wk, special] = await Promise.all([
      redis.exists(`ss:checkin:${id}:${t}`), redis.exists(`ss:plclaim:${id}:${t}`), redis.exists(`ss:playlist:${t}`),
      redis.exists(`ss:wk:${id}:${dates[0]}`), redis.get('ss:config:special'),
    ]);
    return {
      checkin: !!ci, playlist: { done: !!pl, available: !!hasPl },
      weekly: { days: hours.filter((h) => h > 0).length, target: 5, claimed: !!wk },
      special: special || null,
    };
  },
  async claimWeekly(_, ctx) {
    const id = ctx.need();
    const { hours } = await weekDays(id);
    if (hours.filter((h) => h > 0).length < 5) fail('Not enough days yet');
    const first = await redis.set(`ss:wk:${id}:${weekDates()[0]}`, 1, { nx: true, ex: 864000 });
    if (!first) return { already: true, user: view(await getUser(id)) };
    await addExp(id, 100);
    return { gained: 100, user: view(await getUser(id)) };
  },
  async submitRecord({ platform, hours, streams, date, evidence }, ctx) {
    const id = ctx.need();
    await limit(`ss:rl:rec:${id}`, 30, 3600);
    hours = Number(hours); streams = Number(streams) || 0;
    if (!PLATFORMS.includes(platform)) fail('Choose a platform');
    if (!(hours > 0 && hours <= 24)) fail('Hours must be between 0 and 24');
    if (!(streams >= 0 && streams <= 100000)) fail('Streams out of range');
    const t = today();
    if (!isDate(date) || date > t || date < addDays(t, -7)) fail('Date must be within the last 7 days');
    if (evidence && !okUrl(evidence)) fail('Evidence must be an https link');
    const rid = crypto.randomUUID();
    const rec = { rid, uid: id, platform, hours, streams, date, evidence: evidence || '', status: 'ss:pending', at: Date.now() };
    await redis.set(`ss:rec:${rid}`, rec);
    await redis.lpush(`ss:records:${id}`, rid);
    await redis.ltrim(`ss:records:${id}`, 0, 99);
    await redis.sadd('ss:pending', rid);
    const dk = `ss:daily:${id}:${date}`;
    await redis.hincrbyfloat(dk, 'hours', hours);
    await redis.expire(dk, 60 * 864e2);
    return { ok: true, record: rec };
  },
  async stats(_, ctx) {
    const id = ctx.need();
    const u = view(await getUser(id));
    const { hours } = await weekDays(id);
    const rids = await redis.lrange(`ss:records:${id}`, 0, 9);
    const recs = rids.length ? (await redis.mget(...rids.map((r) => `ss:rec:${r}`))).filter(Boolean) : [];
    return { totalHours: u.totalHours, totalStreams: u.totalStreams, week: hours, recent: recs };
  },
  async ranking() {
    const top = await redis.zrange('ss:leaderboard', 0, 49, { rev: true, withScores: true });
    const ids = [];
    for (let i = 0; i < top.length; i += 2) ids.push([String(top[i]), Number(top[i + 1])]);
    if (!ids.length) return { items: [] };
    const p = redis.pipeline();
    ids.forEach(([id]) => p.hmget(`ss:user:${id}`, 'username', 'avatar', 'public'));
    const info = await p.exec();
    const items = ids.map(([id, exp], i) => ({ ...(info[i] || {}), exp }))
      .filter((x) => x.username && x.public !== 0 && x.public !== '0')
      .map((x, i) => ({ rank: i + 1, username: String(x.username), avatar: x.avatar, exp: x.exp, level: levelOf(x.exp) }));
    return { items };
  },
  async changePin({ oldPin, newPin }, ctx) {
    const id = ctx.need();
    await limit(`ss:rl:pin:${id}`, 10, 3600);
    const rec = await redis.hget('users', id);
    if (!rec) fail('User not found', 404);
    await checkPin(rec, oldPin);
    if (!/^\d{4}$/.test(String(newPin || ''))) fail('PIN must be 4 digits');
    const salt = crypto.randomBytes(16).toString('hex');
    await redis.hset('users', { [id]: { ...rec, salt, hash: hashPin(newPin, salt), updated: Date.now() } });
    return { ok: true };
  },
  async setPublic({ value }, ctx) {
    const id = ctx.need();
    await redis.hset(`ss:user:${id}`, { public: value ? 1 : 0 });
    return { user: view(await getUser(id)) };
  },

  // ----- admin (admin accounts only) -----
  async a_setPlaylist({ date, url, title }, ctx) {
    ctx.admin();
    if (!isDate(date)) fail('Invalid date');
    if (!okUrl(url)) fail('URL must start with https://');
    const v = { url, title: String(title || 'Daily Stream').slice(0, 80), img: await spCover(url) };
    await redis.set(`ss:playlist:${date}`, v, { ex: 90 * 864e2 });
    return { ok: true, cover: !!v.img };
  },
  async a_setRoom({ url }, ctx) {
    ctx.admin();
    if (url && !okUrl(url)) fail('URL must start with https://');
    if (url) await redis.set('ss:config:room', url); else await redis.del('ss:config:room');
    return { ok: true };
  },
  async a_setSpecial({ text }, ctx) {
    ctx.admin();
    if (text) await redis.set('ss:config:special', String(text).slice(0, 200)); else await redis.del('ss:config:special');
    return { ok: true };
  },
  async a_pending(_, ctx) {
    ctx.admin();
    const rids = (await redis.smembers('ss:pending')).slice(0, 50);
    const recs = rids.length ? (await redis.mget(...rids.map((r) => `ss:rec:${r}`))).filter(Boolean) : [];
    return { items: recs };
  },
  async a_review({ rid, approve }, ctx) {
    ctx.admin();
    const rec = await redis.get(`ss:rec:${rid}`);
    if (!rec || rec.status !== 'ss:pending') fail('Record not pending', 409);
    rec.status = approve ? 'approved' : 'rejected';
    await redis.set(`ss:rec:${rid}`, rec);
    await redis.srem('ss:pending', rid);
    if (approve) {
      await redis.hincrbyfloat(`ss:user:${rec.uid}`, 'totalHours', rec.hours);
      await redis.hincrby(`ss:user:${rec.uid}`, 'totalStreams', rec.streams);
      await addExp(rec.uid, Math.min(100, Math.round(rec.hours * 10)));
    }
    return { ok: true };
  },
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const { action, ...body } = req.body || {};
    const fn = Object.prototype.hasOwnProperty.call(A, action) ? A[action] : null;
    if (!fn) fail('Unknown action', 404);
    const uid = await sessionAcc((req.headers.authorization || '').replace('Bearer ', ''));
    const ctx = {
      ip: String(req.headers['x-forwarded-for'] || 'x').split(',')[0].trim(),
      need: () => uid || fail('Please log in', 401),
      admin: () => (uid && isAdminAcc(uid)) || fail('Admin only', 403),
    };
    return res.status(200).json(await fn(body, ctx));
  } catch (e) {
    if (e.code) return res.status(e.code).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
}
