const crypto = require("crypto");
const U = process.env.UPSTASH_REDIS_REST_URL, TK = process.env.UPSTASH_REDIS_REST_TOKEN;
const r = async (...c) => { const x = await fetch(U, { method: "POST", headers: { Authorization: "Bearer " + TK }, body: JSON.stringify(c) }); return (await x.json()).result; };
const J = async k => { const v = await r("GET", k); return v ? JSON.parse(v) : null; };
const W = (k, v, ex) => ex ? r("SET", k, JSON.stringify(v), "EX", ex) : r("SET", k, JSON.stringify(v));
const dayAt = o => { const p = new Date(Date.now() + 7 * 36e5 - o * 864e5); return p.getUTCFullYear() + "-" + (p.getUTCMonth() + 1) + "-" + p.getUTCDate(); };
const hash = (p, u) => crypto.createHash("sha256").update(u + ":" + p + ":" + (process.env.PIN_SALT || "molo2")).digest("hex");
const LV = [0, 100, 300, 600, 1000, 1600, 2400, 3500, 5000, 7000];
const lvOf = x => LV.reduce((a, v, i) => x >= v ? i : a, 0);
const SP = ["4irSoWVMefjnL4ZjmmM25t", "1GiP26gz7ODqQ8dxweTPo7", "5HaYRuf3zAfCb8RSO9LLea", "14sD1EmQ20kSJY3P0M82MY"];
const DEF = { songs: SP.map(i => ({ u: "https://open.spotify.com/track/" + i, img: "" })), plats: ["", "", "", "", "", ""], xp: { checkin: 10, update: 20, streak: 5, maxUpdates: 3 } };

async function view(me, cfg) {
  const td = dayAt(0);
  const [a, b, f] = await Promise.all([r("SCARD", "day:" + td), r("SCARD", "users"), r("LRANGE", "feed", 0, 9)]);
  return { me: { xp: me.xp, log: me.log, checks: me.checks }, stats: { today: a || 0, total: b || 0 }, feed: (f || []).map(x => JSON.parse(x)), cfg: { songs: cfg.songs, plats: cfg.plats } };
}
const mark = async (u, td) => { await r("SADD", "day:" + td, u); await r("EXPIRE", "day:" + td, 172800); };

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();
  const b = req.body || {}, out = (o, s = 200) => res.status(s).json(o);
  try {
    const saved = await J("cfg") || {};
    const cfg = { ...DEF, ...saved, xp: { ...DEF.xp, ...(saved.xp || {}) } };

    if (b.a === "admin") {
      if (!process.env.ADMIN_PASSWORD || b.pw !== process.env.ADMIN_PASSWORD) return out({ error: "auth" }, 401);
      const c = b.cfg || {};
      await W("cfg", { ...saved, songs: (c.songs || []).slice(0, 5).map(s => ({ u: String(s.u || "").slice(0, 300), img: String(s.img || "").slice(0, 300) })), plats: (c.plats || []).slice(0, 6).map(x => String(x || "").slice(0, 300)) });
      return out({ ok: 1 });
    }

    if (b.a === "login") {
      const u = String(b.user || "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 15), pin = String(b.pin || "");
      if (!u) return out({ error: "user" });
      const tries = await r("INCR", "try:" + u); if (tries === 1) await r("EXPIRE", "try:" + u, 900);
      if (tries > 10) return out({ error: "too many attempts, try again later" }, 429);
      let me = await J("user:" + u);
      if (!me) { me = { xp: 0, log: [], checks: [], pin: /^\d{4}$/.test(pin) ? hash(pin, u) : "" }; await W("user:" + u, me); await r("SADD", "users", u); }
      else if (me.pin && me.pin !== hash(pin, u)) return out({ error: "pin" }, 401);
      const token = crypto.randomBytes(24).toString("hex");
      await W("tok:" + token, { u }, 60 * 60 * 24 * 60);
      return out({ token, user: u, ...(await view(me, cfg)) });
    }

    const t = await J("tok:" + b.token);
    if (!t) return out({ error: "auth" }, 401);
    const u = t.u, me = await J("user:" + u), td = dayAt(0);
    if (!me) return out({ error: "auth" }, 401);

    if (b.a === "state") return out(await view(me, cfg));

    if (b.a === "setpin") {
      if (!/^\d{4}$/.test(String(b.pin))) return out({ error: "pin" }, 400);
      me.pin = hash(String(b.pin), u); await W("user:" + u, me); return out({ ok: 1 });
    }

    if (b.a === "checkin") {
      if (me.checks.includes(td)) return out({ error: "done" });
      me.checks.push(td); me.checks = me.checks.slice(-120);
      let st = 0; while (me.checks.includes(dayAt(st))) st++;
      const gain = cfg.xp.checkin + Math.min(st - 1, 5) * cfg.xp.streak;
      me.xp += gain; await W("user:" + u, me); await mark(u, td);
      return out({ gain, ...(await view(me, cfg)) });
    }

    if (b.a === "update") {
      const n = Math.floor(Number(b.n)), s = Number(b.s), p = Number(b.p);
      if (!(n >= 1 && n <= 100000) || !(s >= 0 && s < cfg.songs.length) || !(p >= 0 && p < 6)) return out({ error: "bad" }, 400);
      if (me.log.filter(l => l.d === td).length >= cfg.xp.maxUpdates) return out({ error: "limit" });
      me.log.push({ d: td, s, p, n }); me.log = me.log.slice(-300);
      me.xp += cfg.xp.update; await W("user:" + u, me); await mark(u, td);
      await r("LPUSH", "feed", JSON.stringify({ u, l: lvOf(me.xp), s, p, t: Date.now() })); await r("LTRIM", "feed", 0, 19);
      return out(await view(me, cfg));
    }
    return out({ error: "unknown" }, 400);
  } catch (e) { return out({ error: "server" }, 500); }
};
