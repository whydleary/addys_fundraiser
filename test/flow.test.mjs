// End-to-end check of the square flow against a pretend Stripe. Run with: npm test
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import assert from "node:assert/strict";

const APP = "http://127.0.0.1:8798";
const STRIPE_PORT = 8799;
const WEBHOOK_SECRET = "whsec_test";
const sessions = new Map();
const intents = new Map();

// A tiny stand-in for the three Stripe calls the worker makes.
const fakeStripe = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const send = (code, data) => { res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify(data)); };
  const url = new URL(req.url, "http://x");
  const id = url.pathname.split("/")[4];
  if (req.method === "POST" && url.pathname === "/v1/checkout/sessions") {
    const p = new URLSearchParams(body);
    const s = {
      id: "cs_test_" + (sessions.size + 1), status: "open", payment_status: "unpaid",
      client_reference_id: p.get("client_reference_id"), success_url: p.get("success_url"),
      amount: Number(p.get("line_items[0][quantity]")) * Number(p.get("line_items[0][price_data][unit_amount]")),
      metadata: { squares: p.get("metadata[squares]"), name: p.get("metadata[name]") },
    };
    s.url = `http://127.0.0.1:${STRIPE_PORT}/pay/${s.id}`;
    sessions.set(s.id, s);
    return send(200, s);
  }
  if (url.pathname.startsWith("/v1/payment_intents") || url.pathname.startsWith("/charge/")) { // on-page card payments
    const parts = url.pathname.split("/");
    if (req.method === "POST" && parts.length === 3) {
      const p = new URLSearchParams(body);
      const pi = { id: "pi_test_" + (intents.size + 1), status: "requires_payment_method", amount: Number(p.get("amount")),
        metadata: { token: p.get("metadata[token]"), squares: p.get("metadata[squares]"), name: p.get("metadata[name]") } };
      pi.client_secret = pi.id + "_secret";
      intents.set(pi.id, pi);
      return send(200, pi);
    }
    const pi = intents.get(parts[1] === "charge" ? parts[2] : parts[3]);
    if (!pi) return send(404, { error: { message: "No such payment" } });
    if (parts[1] === "charge") pi.status = "succeeded"; // the pretend card form charges the card
    else if (parts[4] === "cancel") {
      if (pi.status === "succeeded") return send(400, { error: { message: "Already paid" } });
      pi.status = "canceled";
    }
    return send(200, pi);
  }
  if (url.pathname.startsWith("/pay/")) { // the pretend payment page: pays, then sends the donor back
    const s = sessions.get(url.pathname.split("/")[2]);
    s.status = "complete"; s.payment_status = "paid";
    res.writeHead(302, { Location: s.success_url }); return res.end();
  }
  const s = sessions.get(id);
  if (!s) return send(404, { error: { message: "No such session" } });
  if (req.method === "POST" && url.pathname.endsWith("/expire")) s.status = "expired";
  send(200, s);
});

const post = async (path, body, headers = {}) => {
  const res = await fetch(APP + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
};
const boardNow = async () => Object.fromEntries((await (await fetch(APP + "/api/board")).json()).squares.map((s) => [s.id, s]));
const signed = (event) => {
  const body = JSON.stringify(event), t = Math.floor(Date.now() / 1000);
  return [body, { "Stripe-Signature": `t=${t},v1=${createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${body}`).digest("hex")}` }];
};

{
  await new Promise((r) => fakeStripe.listen(STRIPE_PORT, r));
}
const vars = { STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_API_BASE: `http://127.0.0.1:${STRIPE_PORT}`, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, ADMIN_KEY: "letmein" };
if (process.argv.includes("--card")) vars.STRIPE_PUBLISHABLE_KEY = "pk_test_fake"; // turns on the on-page card form
const dev = spawn("npx", ["wrangler", "dev", "--port", "8798", "--persist-to", ".wrangler/test-state-" + Date.now(), ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`])], { stdio: "ignore", detached: true });
const stop = () => { try { process.kill(-dev.pid); } catch {} fakeStripe.close(); };
process.on("exit", stop);

for (let i = 0; ; i++) {
  try { if ((await fetch(APP + "/api/board")).ok) break; } catch {}
  if (i > 120) throw new Error("wrangler dev did not start");
  await new Promise((r) => setTimeout(r, 500));
}

if (process.argv.includes("--serve")) {
  console.log("serving on " + APP);
  await new Promise(() => {});
}

let b = await boardNow();
assert.equal(Object.keys(b).length, 37, "37 squares");
assert.ok(Object.values(b).every((s) => s.status === "open"), "all open at the start");

// 1. Pay for two squares, then come back from Stripe.
let r = await post("/api/checkout", { squares: [3, 4], name: "  Nana <b> " });
assert.equal(r.status, 200);
const first = r.data;
assert.equal(sessions.get("cs_test_1").amount, 1000, "two squares cost $10");
b = await boardNow();
assert.equal(b[3].status, "held"); assert.equal(b[3].name, null, "held squares show no name");

// 2. Someone else cannot take a held square.
r = await post("/api/checkout", { squares: [4, 5], name: "Papa" });
assert.equal(r.status, 409); assert.deepEqual(r.data.taken, [4]);
assert.equal((await boardNow())[5].status, "open", "a failed grab holds nothing");

await fetch(first.url, { redirect: "manual" }); // donor pays
r = await post("/api/settle", { token: first.token });
assert.equal(r.data.status, "paid");
b = await boardNow();
assert.equal(b[3].status, "paid"); assert.equal(b[4].name, "Nana b", "name is cleaned up");

// 3. Backing out of checkout frees the squares and closes the Stripe session.
r = await post("/api/checkout", { squares: [10] });
r = await post("/api/settle", { token: r.data.token });
assert.equal(r.data.status, "released");
assert.equal((await boardNow())[10].status, "open");
assert.equal(sessions.get("cs_test_2").status, "expired");

// 4. A donor who pays but never comes back is covered by the webhook.
r = await post("/api/checkout", { squares: [20, 21], name: "Coach" });
const s3 = sessions.get("cs_test_3");
r = await post("/api/stripe-webhook", JSON.stringify({ type: "checkout.session.completed", data: { object: s3 } }), { "Stripe-Signature": "t=1,v1=bad" });
assert.equal(r.status, 400, "unsigned webhooks are refused");
assert.equal((await boardNow())[20].status, "held");
r = await post("/api/stripe-webhook", ...signed({ type: "checkout.session.completed", data: { object: { ...s3, payment_status: "paid" } } }));
assert.equal(r.status, 200);
assert.equal((await boardNow())[21].name, "Coach");

// 5. An expired checkout frees its squares.
r = await post("/api/checkout", { squares: [30] });
await post("/api/stripe-webhook", ...signed({ type: "checkout.session.expired", data: { object: sessions.get("cs_test_4") } }));
assert.equal((await boardNow())[30].status, "open");

// 6. Cash donations need the admin key.
r = await post("/api/admin", { key: "nope", action: "mark", id: 37, name: "Mimi" });
assert.equal(r.status, 401);
r = await post("/api/admin", { key: "letmein", action: "mark", id: 37, name: "Mimi" });
assert.equal(r.status, 200); assert.equal((await boardNow())[37].name, "Mimi");
r = await post("/api/admin", { key: "letmein", action: "clear", id: 37 });
assert.equal((await boardNow())[37].status, "open");

// 8. The board also works under the /addy folder used on learys.com.
r = await fetch(APP + "/addy", { redirect: "manual" });
assert.equal(r.status, 301); assert.ok(r.headers.get("location").endsWith("/addy/"));
assert.ok((await (await fetch(APP + "/addy/")).text()).includes("Fill my dragon"), "page loads under /addy/");
assert.ok((await (await fetch(APP + "/addy/board.js")).text()).startsWith("//"), "assets load under /addy/");
assert.equal((await (await fetch(APP + "/addy/api/board")).json()).squares.length, 37);
r = await post("/addy/api/checkout", { squares: [33] });
assert.ok(new URL(sessions.get("cs_test_5").success_url).pathname === "/addy/", "donors return to /addy/");
assert.equal(new URL(sessions.get("cs_test_1").success_url).pathname, "/", "and to / when they started there");
await post("/addy/api/settle", { token: r.data.token });

// 9. On-page card form: pay without leaving the site.
r = await post("/api/intent", { squares: [24, 25], name: "Mimi" });
assert.equal(r.status, 200); assert.ok(r.data.clientSecret);
assert.equal(intents.get("pi_test_1").amount, 1000);
assert.equal((await post("/api/intent", { squares: [25] })).status, 409, "held while the card is charged");
await fetch(`http://127.0.0.1:${STRIPE_PORT}/charge/pi_test_1`);
assert.equal((await post("/api/settle", { token: r.data.token })).data.status, "paid");
assert.equal((await boardNow())[25].name, "Mimi");

// 10. A declined card frees the squares and closes the payment.
r = await post("/api/intent", { squares: [26] });
assert.equal((await post("/api/settle", { token: r.data.token })).data.status, "released");
assert.equal((await boardNow())[26].status, "open");
assert.equal(intents.get("pi_test_2").status, "canceled");

// 11. A card payment whose donor closes the tab is finished by the webhook.
r = await post("/api/intent", { squares: [27], name: "Joe" });
await post("/api/stripe-webhook", ...signed({ type: "payment_intent.succeeded", data: { object: { ...intents.get("pi_test_3"), status: "succeeded" } } }));
assert.equal((await boardNow())[27].name, "Joe");
r = await post("/api/intent", { squares: [28] });
await post("/api/stripe-webhook", ...signed({ type: "payment_intent.canceled", data: { object: intents.get("pi_test_4") } }));
assert.equal((await boardNow())[28].status, "open");

// 7. Junk input is refused.
for (const squares of [[], [0], [38], ["x"], "3", null]) {
  assert.equal((await post("/api/checkout", { squares })).status, 400);
  assert.equal((await post("/api/intent", { squares })).status, 400);
}

console.log("All checks passed.");
process.exit(0);
