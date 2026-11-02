import { Redis } from '@upstash/redis';
import crypto from 'crypto';

const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN });

const SESSION_SECRET = process.env.SESSION_SECRET || '';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

// [minEXP, name] — level = number of thresholds reached (Lv4 = 600–999)
const LEVELS = [[0, 'Newcomer'], [100, 'Listener'], [300, 'Regular'], [600, 'Dedicated Streamer'], [1000, 'Super Streamer'], [1600, 'Elite Streamer'], [2500, 'Legend']];
const PLATFORMS = ['Spotify', 'Apple Music', 'YouTube Music', 'Stationhead', 'Other'];
const AVATARS = ['🐰', '🐱', '🐻', '🦊', '🐼', '🐨', '🐯', '🐸'];

// ---------- helpers ----------
const today = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10); // Thai time UTC+7
const addDays = (d, n) => new Date(new Date(d + 'T00:00:00Z').getTime() + n * 864e5).toISOString().slice(0, 10);
const weekDates = () => {
  const t = today();
  const dow = (new Date(t + 'T00:00:00Z').getUTCDay() + 6) % 7; // Mon=0
  const start = addDays(t, -dow);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
};
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s));
const fail = (msg, code = 400) => { const e = new Error(msg); e.code = code; throw e; };
const levelOf = (exp) => LEVELS.filter((l) => exp >= l[0]).length;

const hashPin = (pin, salt = crypto.randomBytes(8).toString('hex')) =>
  `s$${salt}$${crypto.scryptSync(pin, salt, 32).toString('hex')}`;
const checkPin = (pin, stored) => {
  const [, salt, h] = String(stored).split('$');
  const a = Buffer.from(crypto.scryptSync(pin, salt, 32).toString('hex'));
  const b = Buffer.from(h);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const sign = (id) => {
  const p = `${id}.${Date.now() + 30 * 864e5}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(p).digest('base64url');
  return `${Buffer.from(p).toString('base64url')}.${sig}`;
};
const verify = (token) => {
  try {
    const [b, sig] = String(token).split('.');
    const p = Buffer.from(b, 'base64url').toString();
    const good = crypto.createHmac('sha256', SESSION_SECRET).update(p).digest('base64url');
    if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
    const [id, exp] = p.split('.');
    return Number(exp) > Date.now() ? id : null;
  } catch { return null; }
};
const isAdmin = (s) => {
  if (!ADMIN_SECRET || !s) return false;
  const a = crypto.createHash('sha256').update(String(s)).digest();
  const b = crypto.createHash('sha256').update(ADMIN_SECRET).digest();
  return crypto.timingSafeEqual(a, b);
};
const okUrl = (u) => typeof u === 'string' && /^https:\/\/[^\s]+$/.test(u) && u.length < 500;

async function getUser(id) {
  const u = await redis.hgetall(`user:${id}`);
  if (!u || !u.username) fail('User not found', 404);
  return u;
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
    id: u.id, username: String(u.username), avatar: u.avatar, exp, level, levelName: LEVELS[level - 1][1],
    prevExp: LEVELS[level - 1][0], nextExp: LEVELS[level] ? LEVELS[level][0] : null,
    streak: Number(u.streak) || 0, totalHours: Number(u.totalHours) || 0, totalStreams: Number(u.totalStreams) || 0,
    public: u.public !== 0 && u.public !== '0' && u.public !== false, badges,
  };
}
async function addExp(id, n) {
  const exp = await redis.hincrby(`user:${id}`, 'exp', n);
  await redis.zadd('leaderboard', { score: exp, member: id });
  await redis.hset(`user:${id}`, { level: levelOf(exp) });
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
  dates.forEach((d) => p.hget(`daily:${id}:${d}`, 'hours'));
  const hours = (await p.exec()).map((h) => Number(h) || 0);
  return { dates, hours };
}

// ---------- actions ----------
const A = {
  async register({ username, pin }, ctx) {
    await limit(`rl:reg:${ctx.ip}`, 10, 3600);
    username = String(username || '').trim();
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) fail('Username must be 3–20 letters, numbers or _');
    if (!/^\d{4,8}$/.test(String(pin || ''))) fail('PIN must be 4–8 digits');
    const id = username.toLowerCase();
    const made = await redis.set(`uname:${id}`, 1, { nx: true });
    if (!made) fail('Username already taken', 409);
    await redis.hset(`user:${id}`, {
      id, username, pinHash: hashPin(String(pin)), avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)],
      exp: 0, level: 1, streak: 0, bestStreak: 0, lastCheckin: '', totalHours: 0, totalStreams: 0, public: 1,
    });
    await redis.zadd('leaderboard', { score: 0, member: id });
    return { token: sign(id), user: view(await getUser(id)) };
  },
  async login({ username, pin }, ctx) {
    await limit(`rl:login:${ctx.ip}`, 20, 600);
    const id = String(username || '').trim().toLowerCase();
    const u = await redis.hgetall(`user:${id}`);
    if (!u || !u.pinHash || !checkPin(String(pin || ''), u.pinHash)) fail('Wrong username or PIN', 401);
    return { token: sign(id), user: view(u) };
  },
  async me(_, ctx) {
    const u = await getUser(ctx.need());
    const t = today();
    return { user: view(u), checkedIn: !!(await redis.exists(`checkin:${u.id}:${t}`)), today: t };
  },
  async today() {
    const t = today();
    const [pl, room] = await Promise.all([redis.get(`playlist:${t}`), redis.get('config:room')]);
    return { date: t, playlist: pl || null, room: room || null, guide: (await redis.get('config:guide')) || null };
  },
  async schedule() {
    const t = today();
    const p = redis.pipeline();
    for (let i = 0; i < 7; i++) p.get(`playlist:${addDays(t, i)}`);
    const r = await p.exec();
    return { items: r.map((pl, i) => ({ date: addDays(t, i), title: pl ? pl.title : null })) };
  },
  async checkin(_, ctx) {
    const id = ctx.need();
    const t = today();
    const first = await redis.set(`checkin:${id}:${t}`, 1, { nx: true, ex: 172800 });
    const u = await getUser(id);
    if (!first) return { already: true, user: view(u) };
    const streak = u.lastCheckin === addDays(t, -1) ? (Number(u.streak) || 0) + 1 : 1;
    await redis.hset(`user:${id}`, { streak, bestStreak: Math.max(streak, Number(u.bestStreak) || 0), lastCheckin: t });
    await addExp(id, 10);
    return { gained: 10, user: view(await getUser(id)) };
  },
  async claimPlaylist(_, ctx) {
    const id = ctx.need();
    const t = today();
    if (!(await redis.get(`playlist:${t}`))) fail('No playlist set for today yet');
    const first = await redis.set(`plclaim:${id}:${t}`, 1, { nx: true, ex: 172800 });
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
      redis.exists(`checkin:${id}:${t}`), redis.exists(`plclaim:${id}:${t}`), redis.exists(`playlist:${t}`),
      redis.exists(`wk:${id}:${dates[0]}`), redis.get('config:special'),
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
    const first = await redis.set(`wk:${id}:${weekDates()[0]}`, 1, { nx: true, ex: 864000 });
    if (!first) return { already: true, user: view(await getUser(id)) };
    await addExp(id, 100);
    return { gained: 100, user: view(await getUser(id)) };
  },
  async submitRecord({ platform, hours, streams, date, evidence }, ctx) {
    const id = ctx.need();
    await limit(`rl:rec:${id}`, 30, 3600);
    hours = Number(hours); streams = Number(streams) || 0;
    if (!PLATFORMS.includes(platform)) fail('Choose a platform');
    if (!(hours > 0 && hours <= 24)) fail('Hours must be between 0 and 24');
    if (!(streams >= 0 && streams <= 100000)) fail('Streams out of range');
    const t = today();
    if (!isDate(date) || date > t || date < addDays(t, -7)) fail('Date must be within the last 7 days');
    if (evidence && !okUrl(evidence)) fail('Evidence must be an https link');
    const rid = crypto.randomUUID();
    const rec = { rid, uid: id, platform, hours, streams, date, evidence: evidence || '', status: 'pending', at: Date.now() };
    await redis.set(`rec:${rid}`, rec);
    await redis.lpush(`records:${id}`, rid);
    await redis.ltrim(`records:${id}`, 0, 99);
    await redis.sadd('pending', rid);
    const dk = `daily:${id}:${date}`;
    await redis.hincrbyfloat(dk, 'hours', hours);
    await redis.expire(dk, 60 * 864e2);
    return { ok: true, record: rec };
  },
  async stats(_, ctx) {
    const id = ctx.need();
    const u = view(await getUser(id));
    const { hours } = await weekDays(id);
    const rids = await redis.lrange(`records:${id}`, 0, 9);
    const recs = rids.length ? (await redis.mget(...rids.map((r) => `rec:${r}`))).filter(Boolean) : [];
    return { totalHours: u.totalHours, totalStreams: u.totalStreams, week: hours, recent: recs };
  },
  async ranking() {
    const top = await redis.zrange('leaderboard', 0, 49, { rev: true, withScores: true });
    const ids = [];
    for (let i = 0; i < top.length; i += 2) ids.push([String(top[i]), Number(top[i + 1])]);
    if (!ids.length) return { items: [] };
    const p = redis.pipeline();
    ids.forEach(([id]) => p.hmget(`user:${id}`, 'username', 'avatar', 'public'));
    const info = await p.exec();
    const items = ids.map(([id, exp], i) => ({ ...(info[i] || {}), exp }))
      .filter((x) => x.username && x.public !== 0 && x.public !== '0')
      .map((x, i) => ({ rank: i + 1, username: String(x.username), avatar: x.avatar, exp: x.exp, level: levelOf(x.exp) }));
    return { items };
  },
  async setPublic({ value }, ctx) {
    const id = ctx.need();
    await redis.hset(`user:${id}`, { public: value ? 1 : 0 });
    return { user: view(await getUser(id)) };
  },

  // ----- admin (needs ADMIN_SECRET) -----
  async a_setPlaylist({ date, url, title }, ctx) {
    ctx.admin();
    if (!isDate(date)) fail('Invalid date');
    if (!okUrl(url)) fail('URL must start with https://');
    const v = { url, title: String(title || 'Daily Stream').slice(0, 80) };
    await redis.set(`playlist:${date}`, v, { ex: 90 * 864e2 });
    return { ok: true };
  },
  async a_setRoom({ url }, ctx) {
    ctx.admin();
    if (url && !okUrl(url)) fail('URL must start with https://');
    if (url) await redis.set('config:room', url); else await redis.del('config:room');
    return { ok: true };
  },
  async a_setSpecial({ text }, ctx) {
    ctx.admin();
    if (text) await redis.set('config:special', String(text).slice(0, 200)); else await redis.del('config:special');
    return { ok: true };
  },
  async a_pending(_, ctx) {
    ctx.admin();
    const rids = (await redis.smembers('pending')).slice(0, 50);
    const recs = rids.length ? (await redis.mget(...rids.map((r) => `rec:${r}`))).filter(Boolean) : [];
    return { items: recs };
  },
  async a_review({ rid, approve }, ctx) {
    ctx.admin();
    const rec = await redis.get(`rec:${rid}`);
    if (!rec || rec.status !== 'pending') fail('Record not pending', 409);
    rec.status = approve ? 'approved' : 'rejected';
    await redis.set(`rec:${rid}`, rec);
    await redis.srem('pending', rid);
    if (approve) {
      await redis.hincrbyfloat(`user:${rec.uid}`, 'totalHours', rec.hours);
      await redis.hincrby(`user:${rec.uid}`, 'totalStreams', rec.streams);
      await addExp(rec.uid, Math.min(100, Math.round(rec.hours * 10)));
    }
    return { ok: true };
  },
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!SESSION_SECRET || SESSION_SECRET.length < 16) return res.status(500).json({ error: 'Server not configured' });
  try {
    const { action, ...body } = req.body || {};
    const fn = Object.prototype.hasOwnProperty.call(A, action) ? A[action] : null;
    if (!fn) fail('Unknown action', 404);
    const uid = verify((req.headers.authorization || '').replace('Bearer ', ''));
    const ctx = {
      ip: String(req.headers['x-forwarded-for'] || 'x').split(',')[0].trim(),
      need: () => uid || fail('Please log in', 401),
      admin: () => isAdmin(req.headers['x-admin-secret']) || fail('Admin only', 403),
    };
    return res.status(200).json(await fn(body, ctx));
  } catch (e) {
    if (e.code) return res.status(e.code).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
}
