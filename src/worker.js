// Fill My Dragon — tracks which squares are open, held or paid, and takes payment through Stripe Checkout.
import { DurableObject } from "cloudflare:workers";

const TOTAL = 37; // squares on the board; must match public/board.js
const SESSION_SECONDS = 31 * 60; // Stripe's shortest checkout window is 30 minutes
const HOLD_MS = 40 * 60 * 1000; // squares stay held a little longer than the checkout can live
const CARD_HOLD_MS = 10 * 60 * 1000; // on-page card payments only hold squares while the card is charged

// One Board object holds the whole fundraiser. It handles one request at a time,
// so two people can never grab the same square.
export class Board extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS squares (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'open',
      name TEXT, token TEXT, session TEXT, source TEXT,
      held_until INTEGER, paid_at INTEGER)`);
    this.sql.exec("CREATE TABLE IF NOT EXISTS content (key TEXT PRIMARY KEY, value TEXT, data BLOB)");
    if (this.sql.exec("SELECT COUNT(*) AS n FROM squares").one().n < TOTAL) {
      for (let id = 1; id <= TOTAL; id++) this.sql.exec("INSERT OR IGNORE INTO squares (id) VALUES (?)", id);
    }
  }

  expireHolds() {
    this.sql.exec(
      "UPDATE squares SET status='open', name=NULL, token=NULL, session=NULL, held_until=NULL WHERE status='held' AND held_until < ?",
      Date.now()
    );
  }

  list() {
    this.expireHolds();
    return this.sql
      .exec("SELECT id, status, name FROM squares ORDER BY id")
      .toArray()
      .map((r) => ({ id: r.id, status: r.status, name: r.status === "paid" ? r.name : null }));
  }

  hold(ids, name, token, ms = HOLD_MS) {
    this.expireHolds();
    const marks = ids.map(() => "?").join(",");
    const taken = this.sql
      .exec(`SELECT id FROM squares WHERE id IN (${marks}) AND status != 'open'`, ...ids)
      .toArray()
      .map((r) => r.id);
    if (taken.length) return { ok: false, taken };
    this.sql.exec(
      `UPDATE squares SET status='held', name=?, token=?, held_until=? WHERE id IN (${marks})`,
      name, token, Date.now() + ms, ...ids
    );
    return { ok: true };
  }

  attach(token, session) {
    this.sql.exec("UPDATE squares SET session=? WHERE token=? AND status='held'", session, token);
  }

  find(token) {
    const rows = this.sql.exec("SELECT id, status, session FROM squares WHERE token=?", token).toArray();
    if (!rows.length) return null;
    return { ids: rows.map((r) => r.id), session: rows[0].session, paid: rows.every((r) => r.status === "paid") };
  }

  release(token) {
    this.sql.exec(
      "UPDATE squares SET status='open', name=NULL, token=NULL, session=NULL, held_until=NULL WHERE token=? AND status='held'",
      token
    );
  }

  // Marks squares paid. Works from the ids Stripe hands back, so a payment still lands
  // even if the hold was lost. Returns any squares someone else already paid for.
  pay(token, ids, name, session) {
    const conflicts = [];
    for (const id of ids) {
      const row = this.sql.exec("SELECT status, token FROM squares WHERE id=?", id).toArray()[0];
      if (!row) continue;
      if (row.status === "paid" && row.token !== token) { conflicts.push(id); continue; }
      this.sql.exec(
        "UPDATE squares SET status='paid', name=?, token=?, session=?, source='card', held_until=NULL, paid_at=COALESCE(paid_at, ?) WHERE id=?",
        name, token, session, Date.now(), id
      );
    }
    return conflicts;
  }

  // The page's editable words, and the photo for the "about" section.
  getContent() {
    const rows = this.sql.exec("SELECT key, value FROM content").toArray();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  setContent(text) {
    for (const [key, value] of Object.entries(text)) {
      this.sql.exec("INSERT INTO content (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value);
    }
  }

  // The photo row's value is "type|timestamp"; the timestamp lets browsers cache each version forever.
  setPhoto(type, data) {
    if (!data) return void this.sql.exec("DELETE FROM content WHERE key='photo'");
    this.sql.exec(
      "INSERT INTO content (key, value, data) VALUES ('photo', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, data=excluded.data",
      `${type}|${Date.now()}`, data
    );
  }

  getPhoto() {
    const row = this.sql.exec("SELECT value, data FROM content WHERE key='photo'").toArray()[0];
    return row ? { type: row.value.split("|")[0], data: row.data } : null;
  }

  // For cash or check donations, and for fixing mistakes.
  admin(action, id, name) {
    if (action === "mark") {
      this.sql.exec(
        "UPDATE squares SET status='paid', name=?, token=NULL, session=NULL, source='cash', held_until=NULL, paid_at=? WHERE id=?",
        name, Date.now(), id
      );
    } else if (action === "clear") {
      this.sql.exec(
        "UPDATE squares SET status='open', name=NULL, token=NULL, session=NULL, source=NULL, held_until=NULL, paid_at=NULL WHERE id=?",
        id
      );
    } else {
      return false;
    }
    return true;
  }
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const board = (env) => env.BOARD.get(env.BOARD.idFromName("board"));
const priceCents = (env) => Math.max(50, parseInt(env.PRICE_CENTS, 10) || 500);
const cleanName = (value) =>
  String(value ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 24);

// Words on the page that can be changed in admin mode, with their longest allowed length.
const TEXT_LIMITS = { who: 30, headline: 60, lede: 200, aboutTitle: 80, aboutBody: 3000 };
const cleanText = (value, max) =>
  String(value ?? "").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);

async function pageContent(env) {
  const saved = await board(env).getContent();
  return {
    who: saved.who || env.FUNDRAISER_NAME || "Addy",
    headline: saved.headline || "Fill my dragon",
    lede: saved.lede ?? "Choose a square, donate, and help me reach my goal!",
    aboutTitle: saved.aboutTitle ?? "What is this about?",
    aboutBody: saved.aboutBody ?? "",
    photo: saved.photo ? saved.photo.split("|")[1] : "",
  };
}

function cleanIds(value) {
  if (!Array.isArray(value) || !value.length || value.length > TOTAL) return null;
  const ids = [...new Set(value.map(Number))];
  return ids.every((id) => Number.isInteger(id) && id >= 1 && id <= TOTAL) ? ids.sort((a, b) => a - b) : null;
}

async function stripe(env, method, path, params) {
  const res = await fetch((env.STRIPE_API_BASE || "https://api.stripe.com") + path, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params ? new URLSearchParams(params) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Stripe answered ${res.status}`);
  return data;
}

function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Checks Stripe's signature so nobody else can tell us a square was paid for.
async function verifiedEvent(request, secret) {
  const body = await request.text();
  const header = request.headers.get("Stripe-Signature") || "";
  let time = "";
  const signatures = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=");
    if (key === "t") time = value;
    if (key === "v1") signatures.push(value);
  }
  if (!time || !signatures.length || Math.abs(Date.now() / 1000 - Number(time)) > 300) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${time}.${body}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return signatures.some((s) => sameText(s, expected)) ? JSON.parse(body) : null;
}

const squaresOf = (session) => cleanIds(String(session.metadata?.squares || "").split(",")) || [];

async function checkout(request, env, home) {
  if (!env.STRIPE_SECRET_KEY) return json({ error: "Payments are not set up yet." }, 503);
  const input = await request.json().catch(() => ({}));
  const ids = cleanIds(input.squares);
  if (!ids) return json({ error: "Pick at least one square." }, 400);
  const name = cleanName(input.name) || "A friend";
  const token = crypto.randomUUID();
  const stub = board(env);

  const held = await stub.hold(ids, name, token);
  if (!held.ok) return json({ error: "taken", taken: held.taken }, 409);

  const back = new URL(env.RETURN_URL || new URL(request.url).origin + home);
  back.searchParams.set("dragon", token);
  const who = env.FUNDRAISER_NAME || "Addy";
  try {
    const session = await stripe(env, "POST", "/v1/checkout/sessions", {
      mode: "payment",
      submit_type: "donate",
      success_url: back.toString(),
      cancel_url: back.toString(),
      client_reference_id: token,
      expires_at: String(Math.floor(Date.now() / 1000) + SESSION_SECONDS),
      "line_items[0][quantity]": String(ids.length),
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": String(priceCents(env)),
      "line_items[0][price_data][product_data][name]": `${who}'s dragon square`,
      "metadata[squares]": ids.join(","),
      "metadata[name]": name,
    });
    await stub.attach(token, session.id);
    return json({ url: session.url, token });
  } catch (err) {
    await stub.release(token);
    console.error("checkout failed", err.message);
    return json({ error: "Could not open the payment page. Try again in a moment." }, 502);
  }
}

// On-page card form: hold the squares and open a payment for the donor's browser to confirm.
async function intent(request, env) {
  if (!env.STRIPE_SECRET_KEY) return json({ error: "Payments are not set up yet." }, 503);
  const input = await request.json().catch(() => ({}));
  const ids = cleanIds(input.squares);
  if (!ids) return json({ error: "Pick at least one square." }, 400);
  const name = cleanName(input.name) || "A friend";
  const token = crypto.randomUUID();
  const stub = board(env);

  const held = await stub.hold(ids, name, token, CARD_HOLD_MS);
  if (!held.ok) return json({ error: "taken", taken: held.taken }, 409);
  try {
    const payment = await stripe(env, "POST", "/v1/payment_intents", {
      amount: String(ids.length * priceCents(env)),
      currency: "usd",
      // Cards only (Apple Pay and Google Pay count as cards). They settle at once, so a square is never left waiting on a bank.
      "payment_method_types[0]": "card",
      description: `${env.FUNDRAISER_NAME || "Addy"}'s dragon squares ${ids.join(", ")}`,
      "metadata[token]": token,
      "metadata[squares]": ids.join(","),
      "metadata[name]": name,
    });
    await stub.attach(token, payment.id);
    return json({ clientSecret: payment.client_secret, token });
  } catch (err) {
    await stub.release(token);
    console.error("intent failed", err.message);
    return json({ error: "Could not start the payment. Try again in a moment." }, 502);
  }
}

// Same job as settle(), for a payment made in the on-page card form.
async function settleCard(env, stub, token, found) {
  const path = `/v1/payment_intents/${found.session}`;
  let payment = await stripe(env, "GET", path);
  if (!["succeeded", "processing", "requires_capture"].includes(payment.status)) {
    // Not paid: close the payment so it can't be charged later, then free the squares.
    payment = await stripe(env, "POST", `${path}/cancel`).catch(() => stripe(env, "GET", path));
  }
  if (payment.status === "succeeded") {
    const ids = squaresOf(payment);
    await stub.pay(token, ids.length ? ids : found.ids, cleanName(payment.metadata?.name) || "A friend", payment.id);
    return json({ status: "paid", squares: found.ids });
  }
  if (payment.status === "processing" || payment.status === "requires_capture") return json({ status: "pending" });
  await stub.release(token);
  return json({ status: "released" });
}

// Called when a donor comes back from Stripe. Asks Stripe what really happened,
// then either colors the squares in or lets them go.
async function settle(request, env) {
  const { token } = await request.json().catch(() => ({}));
  if (typeof token !== "string" || token.length > 64) return json({ status: "unknown" });
  const stub = board(env);
  const found = await stub.find(token);
  if (!found) return json({ status: "unknown" });
  if (found.paid) return json({ status: "paid", squares: found.ids });
  if (!found.session) { await stub.release(token); return json({ status: "released" }); }
  if (found.session.startsWith("pi_")) return settleCard(env, stub, token, found);

  const session = await stripe(env, "GET", `/v1/checkout/sessions/${found.session}`);
  if (session.payment_status === "paid") {
    const ids = squaresOf(session);
    await stub.pay(token, ids.length ? ids : found.ids, cleanName(session.metadata?.name) || "A friend", session.id);
    return json({ status: "paid", squares: found.ids });
  }
  if (session.status === "complete") return json({ status: "pending" });
  if (session.status === "open") await stripe(env, "POST", `/v1/checkout/sessions/${found.session}/expire`).catch(() => {});
  await stub.release(token);
  return json({ status: "released" });
}

async function webhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: "Webhook secret is not set." }, 503);
  const event = await verifiedEvent(request, env.STRIPE_WEBHOOK_SECRET);
  if (!event) return json({ error: "Bad signature." }, 400);
  const session = event.data?.object || {};
  const token = session.client_reference_id || session.metadata?.token;
  if (!token) return json({ received: true });
  const stub = board(env);
  if (event.type === "payment_intent.succeeded") {
    const conflicts = await stub.pay(token, squaresOf(session), cleanName(session.metadata?.name) || "A friend", session.id);
    if (conflicts.length) console.error("paid for squares that were already taken", { payment: session.id, conflicts });
    return json({ received: true });
  }
  if (event.type === "payment_intent.canceled") {
    await stub.release(token);
    return json({ received: true });
  }
  const paidNow = event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded";
  if (paidNow && session.payment_status === "paid") {
    const conflicts = await stub.pay(token, squaresOf(session), cleanName(session.metadata?.name) || "A friend", session.id);
    if (conflicts.length) console.error("paid for squares that were already taken", { session: session.id, conflicts });
  } else if (event.type === "checkout.session.expired") {
    await stub.release(token);
  }
  return json({ received: true });
}

async function admin(request, env) {
  const input = await request.json().catch(() => ({}));
  if (!env.ADMIN_KEY || typeof input.key !== "string" || !sameText(input.key, env.ADMIN_KEY)) {
    return json({ error: "Wrong admin key." }, 401);
  }
  const stub = board(env);
  if (input.action === "content") {
    const text = {};
    for (const [key, max] of Object.entries(TEXT_LIMITS)) {
      if (typeof input.content?.[key] === "string") text[key] = cleanText(input.content[key], max);
    }
    await stub.setContent(text);
    return json({ ok: true });
  }
  if (input.action === "photo") {
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(input.photo || "");
    if (!match) return json({ error: "That file is not a picture this page can use." }, 400);
    const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
    if (bytes.length > 1500000) return json({ error: "That picture is too large." }, 400);
    await stub.setPhoto(match[1], bytes.buffer);
    return json({ ok: true });
  }
  if (input.action === "photo-remove") {
    await stub.setPhoto("", null);
    return json({ ok: true });
  }
  const ids = cleanIds([input.id]);
  if (!ids) return json({ error: "Unknown square." }, 400);
  const ok = await stub.admin(input.action, ids[0], cleanName(input.name) || "A friend");
  return ok ? json({ ok: true }) : json({ error: "Unknown action." }, 400);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // The board also answers under a folder (BASE_PATH), e.g. learys.com/addy/.
    const base = (env.BASE_PATH || "").replace(/\/+$/, "");
    let pathname = url.pathname;
    let home = "/";
    if (base && pathname === base) return Response.redirect(`${url.origin}${base}/${url.search}`, 301);
    if (base && pathname.startsWith(base + "/")) {
      pathname = pathname.slice(base.length);
      home = base + "/";
    }
    if (!pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(new Request(new URL(pathname + url.search, url.origin), request));
    }
    try {
      if (pathname === "/api/board" && request.method === "GET") {
        return json({
          squares: await board(env).list(),
          priceCents: priceCents(env),
          content: await pageContent(env),
          // Public key. When set, the page shows its own card form instead of sending donors to Stripe.
          stripeKey: env.STRIPE_PUBLISHABLE_KEY || "",
        });
      }
      if (pathname === "/api/photo" && request.method === "GET") {
        const photo = await board(env).getPhoto();
        if (!photo) return json({ error: "No photo." }, 404);
        return new Response(photo.data, {
          headers: { "Content-Type": photo.type, "Cache-Control": "public, max-age=31536000, immutable" },
        });
      }
      if (request.method === "POST") {
        if (pathname === "/api/checkout") return await checkout(request, env, home);
        if (pathname === "/api/intent") return await intent(request, env);
        if (pathname === "/api/settle") return await settle(request, env);
        if (pathname === "/api/stripe-webhook") return await webhook(request, env);
        if (pathname === "/api/admin") return await admin(request, env);
      }
      return json({ error: "Not found." }, 404);
    } catch (err) {
      console.error(pathname, err.stack || err.message);
      return json({ error: "Something went wrong. Try again in a moment." }, 500);
    }
  },
};
