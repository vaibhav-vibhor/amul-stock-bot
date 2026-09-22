# Amul protein restock bot

A single-owner Telegram bot for the [Amul protein catalog](https://shop.amul.com/en/browse/protein), using Cloudflare Workers, native `fetch`/Web Crypto and D1. The initial delivery PIN is **500032**. There are **no selected products** initially.

**Implementation, not a live service:** this repository does not create resources, configure credentials, deploy, register a webhook or enable a running monitor by itself. The database ID in `wrangler.jsonc` is deliberately a setup-required placeholder. The CI workflow only type-checks, tests and bundles; **GitHub Actions never polls stock or deploys**.

## Alert behavior

- Track products using the bot's buttons. Their first successful observation is a **silent baseline**, including products already available. A new delivery PIN, retracking a product, or resuming also starts silently.
- Only an **observed out-of-stock -> available** transition queues a restock alert. Remaining in stock causes no repeated alerts. Another valid stock-out re-arms that product.
- Missing products, unknown availability values, malformed responses, blocked access and timeouts are **UNKNOWN/errors**, never inferred stock-outs. Previous valid baselines survive. Valid products in a partially successful check can still update; the last *complete* successful check does not advance.
- `/checknow` explicitly requests a stock snapshot and can show already-available products. When not paused it also participates in normal transition detection; a newly observed restock can therefore produce both the requested snapshot and a restock alert.
- Alerts include the product name, fixed Amul link, PIN and observation time. Stock is **not reserved or guaranteed at checkout**. This bot never purchases, modifies a cart, uses an Amul login/OTP or bypasses access blocks.
- `/pause` cancels pending restock alerts and resets baselines. While paused, `/checknow` is a read-only snapshot. `/resume` starts fresh silent baselines, rather than reporting restocks from the paused interval.
- Changing one watch preserves other products' baselines. Changing PIN retains selections but resets all observations and cancels old-PIN output. Untracking cancels that product's pending alerts.

## Telegram commands

| Command | Behavior |
| --- | --- |
| `/start`, `/help` | Usage and quiet-baseline semantics; never claims ownership |
| `/products` | Refresh the PIN-specific catalog; five products per page with Track/Untrack, links and navigation |
| `/pincode 500032` | Validate an exact six-digit PIN against Amul and verify its regional guest session before saving |
| `/status` | PIN, pause state, watch count, last complete successful check/attempt, upstream errors and pending delivery errors |
| `/checknow` | Current snapshot of selected products; long responses are split safely |
| `/pause`, `/resume` | Pause/resume checks and alerts; also available as buttons |

Buttons carry a configuration revision. Stale buttons refresh the view instead of changing a selection. Products that disappear remain visible as tracked/UNKNOWN so they can still be untracked. Refresh `/products` after a PIN change before adding selections.

Only requests with the configured Telegram webhook secret are processed. Both the sender ID and private chat ID must equal the preconfigured owner ID; groups, channels, inline callbacks and other users cannot administer the bot. No public setup/admin endpoint exists. `GET /health` is **liveness only**, not proof of working credentials, upstream access, delivery or successful polling.

## Local development and verification

Use Node.js LTS 24 (22.12+ supported) and npm:

```powershell
npm ci
npm run typecheck
node --check scripts\telegram-setup.mjs
npm test
npm run build
```

`npm test` executes in the local Workers runtime with a real local D1 binding, the production migration, synthetic non-secret fixtures and **mocked Amul/Telegram fetches**. It covers regional request signing/cookies/preferences, pagination, quantity-vs-availability, silent baselines, restocks/re-arming, unknown/error preservation, PIN/watch changes, owner validation, stale callbacks, deduplication, outbox retry/rate limits, overlapping work, stale leases and transactional rollback. No real messages or Cloudflare resources are needed.

`npm run build` is only `wrangler deploy --dry-run`. It does not deploy. The tests' fake credentials are not usable tokens. For a manually configured local development instance, copy `.dev.vars.example` to `.dev.vars`, populate it privately, apply migrations with `--local`, then use `npm run dev`. Local development does not receive Telegram webhooks without a deliberately configured public tunnel; do not register one inadvertently.

## Manual setup (not performed by this implementation)

Use a **new, dedicated Telegram bot**, not the token or owner binding of another bot. Keep the Cloudflare account on the Workers Free plan if that is your intention. No paid services, queues, KV, browser rendering or Durable Objects are required.

### 1. Cloudflare authorization and D1

Authenticate interactively and verify the intended account:

```powershell
npx wrangler login
npx wrangler whoami
Copy-Item wrangler.jsonc wrangler.local.jsonc
npx wrangler d1 create amul-stock-bot --config wrangler.local.jsonc
```

Replace `SETUP_REQUIRED_REPLACE_WITH_YOUR_D1_DATABASE_ID` in the ignored `wrangler.local.jsonc` with the actual returned database UUID. If you have multiple accounts, select the correct one and set `account_id` in that local configuration. A Cloudflare **account ID is not authorization**. Browser OAuth or a suitably scoped account API token is still necessary. Do not put an API token in shell arguments, source code or the public configuration.

Apply the migration to the chosen database:

```powershell
npx wrangler d1 migrations apply amul-stock-bot --remote --config wrangler.local.jsonc
```

This creates configuration, product catalog, watches, per-PIN/watch observations, a fenced operation lease, update deduplication and delivery tables. All meaningful runtime state lives in D1, not in Git, memory-only maps or a local filesystem. Back up D1 before changing a populated schema; do not rerun an ad hoc reset against production.

### 2. Dedicated Telegram bot and verified owner

Create a bot using Telegram's official **@BotFather** and keep its token in a password manager. Discover your owner ID without a third-party ID bot:

```powershell
npm run telegram:setup -- discover
```

The helper:

1. Accepts the token only through a **masked interactive prompt**, confirms the bot username and refuses discovery if that bot already has a webhook.
2. Shows a random, short-lived challenge for **you** to send in the bot's private chat, then reads it using `getUpdates`.
3. Requires you to confirm the matching numeric user ID. It does not bind the Worker, save the token or send messages.

No first `/start` visitor can claim this bot. Challenges expire after five minutes. Discovery is for a new dedicated bot with little/no pending history. If the challenge is not in its first 100 pending updates, do not guess an ID or repurpose an existing bot.

Generate a separate 32-256 character random webhook secret in your password manager, using letters, digits, `_` or `-`. Supply all three runtime secrets through Wrangler's interactive secret prompts:

```powershell
npx wrangler secret put TELEGRAM_BOT_TOKEN --config wrangler.local.jsonc
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET --config wrangler.local.jsonc
npx wrangler secret put TELEGRAM_OWNER_ID --config wrangler.local.jsonc
```

The owner value must be the verified numeric **user/private-chat ID**, not a username or group ID. Secret configuration may create a draft Worker if one does not yet exist. Never put secret values on the command line, in URLs in instructions, in screenshots or in Git. `.dev.vars`, `.env`, local Wrangler state and the local setup configuration are ignored. Never log raw Telegram API request URLs: the token is part of the API path.

### 3. Deliberate deployment and webhook registration

**This step activates the Worker and its configured cron.** For a staged rollout, change `triggers.crons` to `[]` in `wrangler.local.jsonc` first and deploy without a scheduled poller. The suggested/default schedule is:

```json
"triggers": { "crons": ["*/5 * * * *"] }
```

Edit that cron to choose a different interval; schedules are UTC. To enable, disable or change it, update the local config and deliberately redeploy. `/pause` is a separate persistent application control: cron invocations still occur but do not fetch inventory or send restock alerts.

When you are ready:

```powershell
npx wrangler deploy --config wrangler.local.jsonc
npm run telegram:setup -- webhook
```

The webhook helper takes the dedicated token, deployed HTTPS URL ending in `/telegram`, and the **same webhook secret** through prompts. It refuses to replace a different existing webhook. After explicit `REGISTER` confirmation it calls `setWebhook` with `max_connections: 1`, accepts only messages/callback queries, discards pending setup/discovery updates, and verifies the configured URL. It does **not** prove secret/owner correctness or send a message.

From the verified owner's private chat, deliberately use `/start`, `/products`, select products, and `/checknow`; inspect `/status`. These are real Telegram interactions and are intentionally left to the operator. With no selected products, cron performs no Amul requests and no automatic stock messages. Only enable the scheduled poller when satisfied.

## Persistence, races and delivery guarantees

One atomic D1 lease serializes checks, command mutations and outbox delivery. It lasts 120 seconds; each invocation has a 45-second network budget, six-second per-request timeout and a 32-external-request cap. A database CHECK constraint fences each atomic D1 batch against both lease ownership and (for checks/commands) its starting configuration revision. An expired/replaced lease cannot commit stale observations, selections or alerts. Sends check lease headroom and finish within the bounded request window; configuration changes use the same lease. Busy webhooks return 503 and can be retried without consuming the update ID.

Observation advancement, new alert insertion, command side effects and update deduplication are committed together where applicable. A refreshable catalog cache is independently idempotent. Unique update IDs/callback IDs and unique `(PIN, watch epoch, restock sequence)` alert keys suppress ordinary duplicates. Untracking/retracking uses a fresh epoch. Old-PIN/configuration replies and invalidated alerts are cancelled; an alert also becomes obsolete if another stock-out is observed before delivery. Pending messages bound to a different runtime owner ID are cancelled rather than sent to the former owner.

Every send is recorded before the HTTP request and acknowledged only after a valid Telegram response. Failed or ambiguous sends remain pending, with bounded exponential backoff (up to one hour, or a longer server Retry-After up to one day). A durable Telegram-wide cooldown honors rate limits even across new commands. At most six deliveries are attempted per invocation, with callbacks and requested replies before stock alerts. Pending sends can be retried on later cron invocations or owner requests, even when monitoring is paused/no products are selected. Expired callback acknowledgements are cancelled. Completed/cancelled output is pruned after 30 days; compact update/callback deduplication markers persist.

**Telegram does not offer a sendMessage idempotency key.** If it accepts a message but the acknowledgement is lost (timeout, Worker termination or D1 acknowledgement failure), retrying can send a duplicate. This narrow ambiguity cannot be eliminated with D1 alone; this implementation favors not silently losing the alert. Normal acknowledged sends are not repeated. A prolonged Telegram outage/invalid token leaves visible pending errors; fix the credentials/chat rather than resetting state blindly.

Only sanitized operation/error codes are logged, never tokens, guest cookies/session identifiers, raw exceptions, API URLs, upstream bodies or raw Telegram updates. `amul_http_403`, handshake/schema errors, regional mismatches and UNKNOWN counts require upstream investigation; they must not be "fixed" by falling back to global stock, evaluating guest JavaScript, projecting fewer inventory fields or defeating access challenges.

## Amul protocol and feasibility boundary

Each check obtains a fresh anonymous guest session from the public protein page, safely parses the guest JSON (no `eval`), signs normal storefront headers with Web Crypto, resolves one **exact PIN** using `/entity/pincode`, and sets that anonymous session's regional preferences. It refreshes the session and verifies the selected substore before requesting full regional product pages.

Use effective numeric `available` (`0`/`1`), **not positive `inventory_quantity`**. A verified probe found positive quantities on unavailable items. Do **not** add `fields[...]` projections: a reduced response changed 12 answers by omitting fields needed for linked-inventory enrichment. Pagination ignores the endpoint's unreliable `total`, checks for repeated pages, and fails closed above 200 products instead of quietly truncating. The catalog must be nonempty; malformed identities fail the check.

A sanitized feasibility probe on **2026-09-22** succeeded on actual Cloudflare Workers Playground: PIN 500032 mapped to `telangana`, and 23 listings (13 available, 10 unavailable) took roughly 1.2-1.3 seconds wall time. That is dated feasibility evidence, **not current inventory**, production monitoring, Telegram/D1 validation, or proof of free-tier CPU compliance.

## Free-tier limits and operational expectations

At a five-minute interval there are 288 scheduled invocations/day. A current 23-item catalog normally needs seven Amul requests per successful check; longer catalogs paginate in 50-item pages. No network waits count toward CPU time, but parsing, hashing, orchestration and application work do.

Cloudflare Workers Free currently allows 100,000 requests/day, **10 ms CPU/invocation**, 50 external subrequests/invocation and 128 MB memory. D1 Free currently includes 5 million rows read/day, 100,000 rows written/day and 5 GB total storage. This personal workload is designed to fit, but more products, frequent manual checks, catalog index writes or Telegram backlog increase usage. These are provider quotas, not guarantees made by this repository; confirm current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) before deployment.

**Actual CPU verification remains pending.** A small bundle and fast wall-clock probe do not prove a 10 ms budget. After deliberate deployment, inspect real invocation CPU/error metrics over representative cron, catalog, callback and burst-restock paths. If the free CPU budget is exceeded, pause and profile/optimize or explicitly approve a different plan; do not claim it works reliably on Free without that measurement.

Polling normally detects a durable restock within one configured interval plus request/delivery latency. Cron scheduling delays, quota exhaustion, upstream blocks, timeouts and retry backoff can increase latency; more than six queued messages can take additional invocations to drain. Brief restocks between checks may be missed entirely. No hourly heartbeat or repeated in-stock notification is sent.
