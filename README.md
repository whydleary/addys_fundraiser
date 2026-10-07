# Addy's Fill My Dragon fundraiser

A clickable version of the paper "Fill my dragon" sheet. Donors pick squares in the word DRAGON, pay $5 each through Stripe, and the squares (and the dragon) color in.

It runs as one Cloudflare Worker: the page lives in `public/`, the square tracking and payment code in `src/worker.js`. No database to set up; the board is stored in a Durable Object that creates itself on first use.

## Setup

1. **Cloudflare**: in Workers & Pages, connect a Worker to this repo. The Worker's name must match `name` in `wrangler.jsonc` (`addys-fundraiser`). The default deploy command, `npx wrangler deploy`, is right.
2. **Stripe key**: in the Worker's Settings → Variables and Secrets, add a secret `STRIPE_SECRET_KEY` with your Stripe secret key. Start with a test key (`sk_test_...`) and pay with card `4242 4242 4242 4242`.
3. **Stripe webhook**: in Stripe, add a webhook endpoint at `https://YOUR-WORKER-URL/api/stripe-webhook` for the events `checkout.session.completed` and `checkout.session.expired`. Add its signing secret to the Worker as `STRIPE_WEBHOOK_SECRET`. This covers donors who pay but close the tab before coming back.
4. **Admin key**: add a secret `ADMIN_KEY` (any password you choose). It lets you mark cash donations.

Text and price are in the `vars` block of `wrangler.jsonc`: the name, the line saying what the money is for, and the price per square.

## Cash donations

Open `https://YOUR-WORKER-URL/?admin`, enter the admin key, tap a square, type the donor's name, and choose "Mark as paid". "Clear this square" undoes a mistake.

## Address

The board answers at the Worker's own address and at `learys.com/addy/`. The second one comes from the `routes` and `BASE_PATH` settings in `wrangler.jsonc`; it needs `learys.com` to be in the same Cloudflare account as the Worker.

## Embedding it in another site

To show the board inside a page on another site (Squarespace, for example), paste this into a Code block (needs a plan that allows JavaScript in code blocks), then set `RETURN_URL` in `wrangler.jsonc` to that page's address so donors land back on it after paying:

```html
<iframe id="dragon" src="https://YOUR-WORKER-URL/" title="Fill my dragon fundraiser" style="width:100%;height:1500px;border:0"></iframe>
<script>
  addEventListener('message', function (e) {
    if (e.origin === 'https://YOUR-WORKER-URL' && e.data && e.data.dragonHeight) {
      document.getElementById('dragon').style.height = e.data.dragonHeight + 'px';
    }
  });
</script>
```

## Working on it

```
npm install
npm test        # runs the whole pick → pay → color-in flow against a pretend Stripe
npm run dev     # local copy at http://localhost:8787 (put STRIPE_SECRET_KEY etc. in .dev.vars)
```

To start a new fundraiser with a clean board, clear each square in admin mode.
