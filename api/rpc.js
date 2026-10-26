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

async function view(me, cfg, u) {
  const td = dayAt(0);
  const [a, b, f] = await Promise.all([r("SCARD", "day:" + td), r("SCARD", "users"), r("LRANGE", "feed", 0, 9)]);
  const fd = (f || []).map(x => JSON.parse(x));
  const us = [...new Set(fd.map(x => x.u))], avs = {};
  if (us.length) { const al = (await r("MGET", ...us.map(x => "av:" + x))) || []; us.forEach((x, i) => { if (al[i]) avs[x] = al[i]; }); }
  const av = (await r("GET", "av:" + u)) || "";
  return { me: { xp: me.xp, log: me.log, checks: me.checks }, stats: { today: a || 0, total: b || 0 }, feed: fd, cfg: { songs: cfg.songs, plats: cfg.plats, sh: cfg.sh || "" }, mail: !!(me.mail && me.mail.ok), av, avs };
}
const mark = async (u, td) => { await r("SADD", "day:" + td, u); await r("EXPIRE", "day:" + td, 172800); };

// ---- Email sets: 2 topics ("" = sign-up emails, "s" = streaming emails). Admin loads a numbered list per topic, users get sets of 5 ----
const MN = 5;
const cleanMail = s => String(s || "").trim().toLowerCase().slice(0, 100);
const tp = b => (b && b.t === "s") ? "s" : "";
const perOf = async p => { const v = await r("GET", p + "mail:per"); return v === null ? 1 : Number(v) || 0; };
const mst = (me, p) => { me.mail = me.mail || { ok: 1, cur: -1, done: [] }; return p ? (me.mail.s = me.mail.s || { cur: -1, done: [] }) : me.mail; };
const mailStat = async p => { const l = (await J(p + "mail:list")) || []; return { total: l.length, sets: Math.ceil(l.length / MN), claimed: Number(await r("GET", p + "mail:claimed")) || 0, per: await perOf(p) }; };
async function pack(p, k, ms, st, list) {
  const e = list.slice(k * MN, k * MN + MN), per = await perOf(p);
  const c = e.map((_, i) => (ms.c && ms.c[i]) ? 1 : 0);
  const all = c.length > 0 && c.every(Boolean);
  return { k, e, c, more: all && (per === 0 || st.done.length + 1 < per) };
}
async function mailSet(p, u, me) {
  const st = mst(me, p);
  const list = (await J(p + "mail:list")) || [], n = Math.ceil(list.length / MN);
  const gen = (await r("GET", p + "mail:gen")) || "0";
  if (st.g !== gen) { st.g = gen; st.cur = -1; st.done = []; }
  const mine = async k => {
    const ms = await J(p + "mset:" + k);
    if (ms) return ms.u === u ? ms : null;
    if ((await r("GET", p + "mres:" + k)) === u) { await r("EXPIRE", p + "mres:" + k, 900); return { u, c: [] }; }
    return null;
  };
  let k = st.cur, ms = k >= 0 && k < n ? await mine(k) : null;
  if (!ms) {
    k = -1;
    const ptr = Number(await r("GET", p + "mail:ptr")) || 0; let np = ptr;
    for (let i = ptr; i < n && i < ptr + 60; i++) {
      if (await J(p + "mset:" + i)) { if (i === np) np = i + 1; continue; }
      if ((await r("SET", p + "mres:" + i, u, "NX", "EX", 900)) === "OK" || (await r("GET", p + "mres:" + i)) === u) { k = i; break; }
    }
    if (np !== ptr) await r("SET", p + "mail:ptr", String(np));
    if (k < 0) { st.cur = -1; return null; }
    ms = { u, c: [] };
  }
  st.cur = k;
  return pack(p, k, ms, st, list);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();
  const b = req.body || {}, out = (o, s = 200) => res.status(s).json(o);
  try {
    const saved = await J("cfg") || {};
    const cfg = { ...DEF, ...saved, xp: { ...DEF.xp, ...(saved.xp || {}) } };

    if (b.a === "admin") {
      if (!process.env.ADMIN_PASSWORD || b.pw !== process.env.ADMIN_PASSWORD) return out({ error: "auth" }, 401);
      const c = b.cfg || {};
      await W("cfg", { ...saved, songs: (c.songs || []).slice(0, 5).map(s => ({ u: String(s.u || "").slice(0, 300), img: String(s.img || "").slice(0, 300) })), plats: (c.plats || []).slice(0, 6).map(x => String(x || "").slice(0, 300)), sh: String(c.sh || "").slice(0, 300) });
      return out({ ok: 1 });
    }

    if (b.a === "mailadmin") {
      if (!process.env.ADMIN_PASSWORD || b.pw !== process.env.ADMIN_PASSWORD) return out({ error: "auth" }, 401);
      const p = tp(b);
      let list = (await J(p + "mail:list")) || [];
      if (typeof b.code === "string" && b.code.trim()) await r("SET", "mail:code", b.code.trim().slice(0, 60));
      if (b.per !== undefined && b.per !== "") await r("SET", p + "mail:per", String(Math.max(0, Math.min(50, Math.floor(Number(b.per)) || 0))));
      if (Array.isArray(b.emails) && b.emails.length) {
        const nw = [...new Set(b.emails.map(cleanMail).filter(x => x.includes("@")))];
        if (b.mode === "replace") {
          const n = Math.ceil(list.length / MN);
          for (let i = 0; i < n; i++) await r("DEL", p + "mset:" + i, p + "mres:" + i);
          await r("SET", p + "mail:ptr", "0"); await r("SET", p + "mail:claimed", "0"); await r("SET", p + "mail:gen", String(Date.now())); list = [];
        }
        const have = new Set(list);
        list = list.concat(nw.filter(x => !have.has(x))).slice(0, 2000);
        await W(p + "mail:list", list);
      }
      return out({ ok: 1, code: (await r("GET", "mail:code")) || "", r: await mailStat(""), s: await mailStat("s") });
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
      return out({ token, user: u, ...(await view(me, cfg, u)) });
    }

    const t = await J("tok:" + b.token);
    if (!t) return out({ error: "auth" }, 401);
    const u = t.u, me = await J("user:" + u), td = dayAt(0);
    if (!me) return out({ error: "auth" }, 401);

    if (b.a === "state") return out(await view(me, cfg, u));

    if (b.a === "setavatar") {
      const im = String(b.img || "");
      if (!im) { await r("DEL", "av:" + u); return out(await view(me, cfg, u)); }
      if (im.length > 30000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(im)) return out({ error: "bad" }, 400);
      await r("SET", "av:" + u, im);
      return out(await view(me, cfg, u));
    }

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
      return out({ gain, ...(await view(me, cfg, u)) });
    }

    if (b.a === "update") {
      const n = Math.floor(Number(b.n)), s = Number(b.s), p = Number(b.p);
      if (!(n >= 1 && n <= 100000) || !(s >= 0 && s < cfg.songs.length) || !(p >= 0 && p < 6)) return out({ error: "bad" }, 400);
      if (me.log.filter(l => l.d === td).length >= cfg.xp.maxUpdates) return out({ error: "limit" });
      me.log.push({ d: td, s, p, n }); me.log = me.log.slice(-300);
      me.xp += cfg.xp.update; await W("user:" + u, me); await mark(u, td);
      await r("LPUSH", "feed", JSON.stringify({ u, l: lvOf(me.xp), s, p, t: Date.now() })); await r("LTRIM", "feed", 0, 19);
      return out(await view(me, cfg, u));
    }
    if (b.a === "mailunlock") {
      const tr = await r("INCR", "mtry:" + u); if (tr === 1) await r("EXPIRE", "mtry:" + u, 900);
      if (tr > 8) return out({ error: "too many attempts, try again later" }, 429);
      const code = await r("GET", "mail:code");
      if (!code || String(b.code || "").trim() !== code) return out({ error: "code" }, 401);
      me.mail = me.mail || { ok: 1, cur: -1, done: [] }; me.mail.ok = 1;
      await W("user:" + u, me);
      return out({ ok: 1 });
    }
    if (String(b.a || "").startsWith("mail")) {
      if (!(me.mail && me.mail.ok)) return out({ error: "locked" }, 403);
      const p = tp(b), st = mst(me, p);
      const list = (await J(p + "mail:list")) || [];

      if (b.a === "mailget") { const s = await mailSet(p, u, me); await W("user:" + u, me); return out(s ? { set: s } : { none: 1 }); }

      if (b.a === "mailcopy") {
        const k = st.cur; if (!(k >= 0)) return out({ error: "lost" });
        let ms = await J(p + "mset:" + k);
        if (ms && ms.u !== u) return out({ error: "lost" });
        if (!ms) {
          if ((await r("GET", p + "mres:" + k)) !== u && (await r("SET", p + "mres:" + k, u, "NX", "EX", 900)) !== "OK") return out({ error: "lost" });
          ms = { u, c: list.slice(k * MN, k * MN + MN).map(() => 0), t: Date.now() };
          await r("INCR", p + "mail:claimed");
        }
        const i = Number(b.i);
        if (i < 0) ms.c = ms.c.map(() => 1); else if (i < ms.c.length) ms.c[i] = 1; else return out({ error: "bad" }, 400);
        await W(p + "mset:" + k, ms); await r("DEL", p + "mres:" + k);
        return out({ set: await pack(p, k, ms, st, list) });
      }

      if (b.a === "mailnext") {
        const ms = st.cur >= 0 ? await J(p + "mset:" + st.cur) : null;
        if (ms && ms.u === u) {
          if (!ms.c.every(Boolean)) return out({ error: "notyet" });
          const per = await perOf(p);
          if (per > 0 && st.done.length + 1 >= per) return out({ error: "limit" });
          st.done.push(st.cur); st.cur = -1;
        }
        const s = await mailSet(p, u, me); await W("user:" + u, me);
        return out(s ? { set: s } : { none: 1 });
      }
    }
    return out({ error: "unknown" }, 400);
  } catch (e) { return out({ error: "server" }, 500); }
};
