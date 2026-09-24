# Amul protein availability bot

A single-owner Telegram bot for the [Amul protein catalog](https://shop.amul.com/en/browse/protein), using a thin Cloudflare Worker, one **SQLite-backed Durable Object**, native `fetch`/Web Crypto and D1. The initial delivery PIN is **500032**. There are **no selected products** initially.

Deployment is deliberate: cloning this repository does not create resources, configure credentials, register a webhook or enable a monitor by itself. Once the five-minute cron and `MONITORING_ENABLED="true"` are deliberately enabled, **Cloudflare runs independently of your laptop, Copilot session and `/checknow`**. The public database ID is a setup-required placeholder. CI only type-checks, tests and bundles; **GitHub Actions never polls stock or deploys**.

**Execution boundary:** the ordinary Worker routes `/telegram` to one named `PersonalMonitor` object and forwards the five-minute Cron event through its internal `runScheduled` RPC. All authentication, commands, Amul calls, D1 state changes and Telegram delivery execute in that object. D1 remains the sole authoritative user/watch/cycle/outbox database; no user data is copied into DO storage. The DO is created with `new_sqlite_classes`, which is compatible with Workers Free. The front door still has a 10 ms CPU budget; the object's documented default request budget is 30 **seconds**. Those are different invocations and must be measured separately.

There is **one timer only: the persisted Cloudflare five-minute Cron Trigger**. There are no DO alarms, constructor timers, always-on sockets, manual bootstrap endpoints or in-memory polling loops. Object eviction does not lose the schedule or per-cycle idempotency. At idle the object has no pending work and is eligible for hibernation. The `MONITORING_ENABLED` gate is checked in both the front door and the core handler; disabling it plus removing cron blocks late deliveries without changing the owner's pause preference.

## Alert behavior

- Track products using the bot's buttons. **Every five-minute scheduled check with any confirmed-available selected product queues one consolidated availability reminder**, including the first check, newly selected products, and products that remain in stock. No preceding stock-out is required; old observations never suppress a reminder.
- If no selected products are confirmed available, there is no availability message. An empty watch list or persistent `/pause` means no scheduled Amul requests or reminders.
- Missing products, unknown values, malformed responses, blocked access and timeouts are **UNKNOWN/errors**, never proof of availability. Previous valid observations survive. A partial check can remind about its separately confirmed available products, with an explicit unconfirmed count; unknown products are never filled in from cached stock. A failed regional/API check sends nothing, and the last *complete* successful check does not advance.
- `/checknow` is an **optional immediate snapshot**. It neither creates a periodic reminder nor advances the periodic cycle clock. A manual recheck cancels any older undelivered reminder; the next distinct scheduled cycle still sends fresh available results normally.
- Reminders include full product variants, fixed Amul links, PIN, and the actual checked-at time in IST. Stock is **not reserved or guaranteed at checkout**. If an unusually large available set cannot fit one Telegram message, the single reminder includes complete names that fit, the exact remaining count and `/checknow` for the complete snapshot rather than bursting per-product messages.
- `/pause` cancels pending reminders. While paused, `/checknow` remains a read-only snapshot. `/resume` restores reminders on the next scheduled cadence, including currently available products.
- Selection/PIN changes invalidate pending reminders under the old configuration. Changing one watch preserves other observations; changing PIN retains selections but resets PIN-specific observations. The next cycle uses the new settings. Existing observations from earlier restock-only versions do not gate this behavior.

## Telegram commands

| Command | Behavior |
| --- | --- |
| `/start`, `/help` | Usage and five-minute repeated-reminder semantics; never claims ownership |
| `/products` | One interactive catalog: a compact PIN/count header and full-width product buttons, with green/checkmarked selections |
| `/pincode 500032` | Validate an exact six-digit PIN against Amul and verify its regional guest session before saving |
| `/status` | PIN, pause state, watches, actual last scheduled cycle/outcome and last successful background check for current settings, plus upstream/delivery errors; warns if no cycle has run or checks are overdue |
| `/checknow` | Current snapshot with available products first, bold status-group counts, full names and an IST checked-at time; long reports are split safely |
| `/pause`, `/resume` | Pause/resume checks and alerts; also available as buttons |

The current 23-product catalog appears **once**, as one clickable selection keyboard under a compact PIN, selected-count and tap-instruction header. There is no second per-product text/status list, visible numbering, **Open product**, **Next** or **Previous** button. Each product has its own full-width button, with only a leading standalone `Amul` brand prefix removed for display (case-insensitive, including surrounding prefix whitespace). Every remaining product type, flavor, weight and pack-size detail is preserved; embedded `Amul` and names such as `Amulya` are not changed. Canonical catalog/database names, IDs, links, alerts and `/checknow` names remain unchanged. Selected buttons use the native green `success` style plus a checkmark; unselected buttons use an empty checkbox, so color is not required. Telegram clients may still visually shorten long button labels and provide no wrapping control. The catalog is not duplicated in message text to work around that client limitation.

A future keyboard exceeding the conservative 100-button budget (including controls) or the bounded serialized-keyboard size is automatically delivered in consecutive, rate-limited menus, with each product button exactly once. Long names alone do not trigger the old message-text splitting. Each chunk shows **its own** selected count (not a duplicated global total that could become stale); `/status` gives the current overall count. A toggle updates the same menu after its selection is committed. Buttons retain internal stable product IDs, the configuration revision and the ID range of their message. A stale button refreshes that range without applying an old intent; tap again to make the selection. Existing full-catalog menu taps update into this buttons-only layout. Old paginated buttons upgrade safely without changing selections, and no old chat messages are deleted.

Toggles use the cached catalog rather than fetching Amul again. While a large catalog is still arriving, a toggle reports that delivery is in progress and leaves selections unchanged; this prevents a new revision from discarding not-yet-delivered chunks. Products missing from a refreshed catalog remain selected and marked `[UNKNOWN]` on their buttons so they can still be unselected. Refresh `/products` after a PIN change before adding selections. Product links remain in availability reminders; only the selection-menu URL buttons were removed.

`/checknow` groups **Available** products first, followed by **Out of stock** and, when needed, a separate **Unconfirmed / UNKNOWN** warning group. Each group shows its total and lists full product names as bullets; no available products produces a clear none-available message rather than an empty group. Reports display the actual check time in **Asia/Kolkata (IST)**, for example `24 Sep 2026, 11:20 AM IST`; stored UTC timestamps are unchanged. Telegram HTML is safely escaped, and reports split only between complete names, with continuation headings and the checkout/reservation disclaimer once at the very bottom. Unknowns and failed checks never masquerade as fresh cached availability. This formatting does not alter baselines, alert rules, outbox delivery or polling.

Only requests with the configured Telegram webhook secret are processed. Both the sender ID and private chat ID must equal the preconfigured owner ID; groups, channels, inline callbacks and other users cannot administer the bot. No public setup/admin endpoint exists. `GET /health` is **liveness only**, not proof of working credentials, upstream access, delivery or successful polling.

## Local development and verification

Use Node.js LTS 24 (22.12+ supported) and npm:

```powershell
npm ci
npm run check
```

`npm run check` is the same fail-fast gate used by CI: source/test typechecks, setup-helper syntax check, **all** tests, then the existing dry-run bundle. It disables Wrangler telemetry/disk logging and the banner's registry-update lookup for its child processes, needs no Cloudflare/Telegram credentials, and never deploys. A failed stage prevents later stages from running.

`npm test` runs both `test:workers` (Vitest in the local Workers runtime with a real SQLite-backed DO and local D1) and `test:node` (Node's built-in test runner for the setup helper and gate/hook). External Amul/Telegram HTTP is **mocked**. Coverage includes the complete empty-state owner journey using emitted selection callbacks and real public webhook/DO dispatch, five-minute recurring reminders, pause/resume, configuration/owner changes, retries/fencing, eviction/restart and migration preservation. Checked-in Wrangler JSONC is parsed with Wrangler's own parser and checked against the source cadence/binding contracts; ignored live/auth config is not used.

Node helper tests exercise the real masked-readline prompt using in-memory terminal streams, explicit confirmation, private ownership challenges, refusal to overwrite another webhook, TTY enforcement, cancellation and sanitized errors. They use fictional credentials and write no credentials. Gate tests simulate failed stages and invoke the optional hook with a temporary fake `npm`, without installing a hook or changing Git configuration.

`test/fixtures/amul-regional-response.ts` is a compact reconstruction from the sanitized public regional feasibility report of **2026-09-22**. It retains representative names, aliases, numeric availability/quantities/prices and the distinct catalog/linked-product-ID relationship; both IDs are replaced with fictional fixture labels. No guest identifiers, cookies, headers, images or descriptions are retained. It is **not current stock** or a complete upstream schema capture. Offline fixtures cannot detect future API drift; runtime response validation and a deliberately refreshed public fixture remain necessary when the storefront changes.

`npm run build` is only `wrangler deploy --dry-run`. It does not deploy. The tests' fake credentials are not usable tokens. For a manually configured local development instance, copy `.dev.vars.example` to `.dev.vars`, populate it privately, apply migrations with `--local`, then use `npm run dev`. Local development does not receive Telegram webhooks without a deliberately configured public tunnel; do not register one inadvertently.

### Optional pre-push check (explicit opt-in)

The repository includes `.githooks/pre-push`, which only runs `npm run check`. Nothing installs or enables it automatically. For one push from the repository root, with Node/npm on `PATH`:

```powershell
git -c core.hooksPath=.githooks push
```

This override applies only to that command and needs no installation/removal; omit it on future commands to stop opting in. **Do not use this override if you already rely on a different pre-push hook**: Git selects one hook directory, so run `npm run check` manually followed by your normal push instead. No existing hook files are overwritten. The shell hook is checked in executable for Git's POSIX hook runner, including Git for Windows.

In a linked worktree, `git config --local core.hooksPath ...` can change the primary checkout and sibling worktrees because the local configuration is shared. Do not use it for this optional setup, and do not enable worktree-config extensions merely to install a check. No global/shared/worktree Git configuration is changed by the per-command example. Hooks are a local convenience and can be bypassed; CI remains the authoritative gate.

## Manual setup (not performed by this implementation)

Use a **new, dedicated Telegram bot**, not the token or owner binding of another bot. Keep the Cloudflare account on Workers Free. One SQLite-backed Durable Object namespace is required; no paid upgrade, queues, KV namespace, browser rendering, or extra Worker is needed. Never substitute a key-value-backed DO class: that is not the Free-compatible storage backend.

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

This creates configuration, product catalog, watches, per-PIN/watch observations, a fenced operation lease, update deduplication and delivery tables. The additive `0002_background_cycles.sql` migration adds durable scheduled-cycle history and an outbox cycle reference without altering existing settings, epochs, observations or messages. All meaningful runtime state lives in D1, not in Git or memory-only maps. Back up populated D1 before migrating; never reset production to upgrade it. The separate Wrangler class migration `v1-personal-monitor` creates **only** the SQLite-backed `PersonalMonitor` namespace on first deployment; leave it and its `MONITOR` binding intact on subsequent deployments.

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

**This step deploys the Worker and its configured cron.** For a staged rollout, keep `vars.MONITORING_ENABLED` as `"false"` and change `triggers.crons` to `[]` in `wrangler.local.jsonc`. The intended schedule, once actual CPU/delivery validation succeeds, is:

```json
"triggers": { "crons": ["*/5 * * * *"] }
```

Schedules are UTC. This implementation expects exactly `*/5 * * * *`; its five-minute idempotency/freshness window is defined beside that cron in `src/background.ts`. Activation requires both that cron and `vars.MONITORING_ENABLED: "true"`. To suspend monitoring, deploy with the gate `"false"` and `crons: []`; the gate rejects late scheduled events while Cloudflare trigger changes propagate, without modifying the owner's pause flag or selections. Change both code/window and configuration if deliberately implementing another cadence. `/pause` is separate and persistent: when the deployment gate is enabled, scheduled invocations record a paused outcome without fetching or sending. `/resume` cannot override a disabled deployment gate.

When you are ready:

```powershell
npx wrangler deploy --config wrangler.local.jsonc
npm run telegram:setup -- webhook
```

The webhook helper takes the dedicated token, deployed HTTPS URL ending in `/telegram`, and the **same webhook secret** through prompts. It refuses to replace a different existing webhook. After explicit `REGISTER` confirmation it calls `setWebhook` with `max_connections: 1`, accepts only messages/callback queries, discards pending setup/discovery updates, and verifies the configured URL. It does **not** prove secret/owner correctness or send a message.

From the owner's private chat use `/start`, `/products`, select products, and inspect `/status`. `/checknow` is optional and does not start monitoring. Once the five-minute cron is enabled, selected available products generate recurring messages even with the laptop off. With no selections, cron records an empty cycle but makes no Amul requests and sends no availability messages. Confirm the actual scheduled cycles and CPU before treating the monitor as healthy.

## Persistence, races and delivery guarantees

One atomic D1 lease serializes checks, command mutations and outbox delivery. It lasts 120 seconds; each invocation has a 45-second network budget, six-second Amul/ten-second Telegram request timeouts and a 32-external-request cap. A database CHECK constraint fences each atomic D1 batch against both lease ownership and (for checks/commands) its starting configuration revision. An expired/replaced lease cannot commit stale observations, selections or alerts. Sends check lease headroom and finish within the bounded request window; configuration changes use the same lease. Busy webhooks return 503 and can be retried without consuming the update ID.

`background_cycles.scheduled_at` is a unique five-minute slot derived from Cloudflare's scheduled timestamp, not from a manual request or observation. Its fenced result batch commits observations, outcome and at most one `reminder:<slot>` outbox row together. Duplicate/retried copies of a completed tick do not recheck or create another reminder; a checking record interrupted before commit can resume after lease recovery. Distinct adjacent slots independently notify even for identical stock. Older/out-of-order/expired ticks cannot revive historical work. A busy overlapping scheduled invocation is surfaced as a failed invocation rather than consuming a tick or pretending a check succeeded; that tick can retry, and the next scheduled cycle remains independent.

All pending historical reminders are superseded when a newer background check starts, even if that newer check fails. A reminder expires at the end of its original five-minute slot and is not sent without request-time headroom. Config revision, PIN, owner and pause are checked under the same lease before delivery; removal/reselection/PIN change or a newer manual recheck invalidates pending old work. Legacy per-product restock alerts are cancelled rather than replayed after upgrade. `/checknow` and other webhooks deliver requested replies, not periodic reminders. Manual results never consume a background slot.

Every send is recorded before HTTP and acknowledged only after a valid Telegram response. Transport failures remain pending/visible and are retryable within the same fresh cycle; backoff and a persistent Telegram-wide Retry-After cooldown prevent hammering. The next scheduled cycle replaces stale pending reminders with its freshly observed results instead of replaying an outage backlog in a burst. Requested command replies retain their durable retry strategy (bounded exponential backoff up to one hour, or server Retry-After up to one day). At most six ordinary deliveries are attempted per invocation. Overflowing product menus can drain up to 24 paced chunks within the same request/lease bounds; pending menu work prompts a retryable webhook 503 so it can continue without a stock cron. Completed/cancelled messages and unreferenced background history are pruned after 30 days; compact Telegram update/callback deduplication markers persist.

**Telegram does not offer a sendMessage idempotency key.** If it accepts a message but its acknowledgement is lost (timeout, Worker termination or D1 acknowledgement failure), a same-cycle retry can duplicate that message. D1 cannot eliminate this narrow ambiguity; this is not an exactly-once promise. Acknowledged reminders are never retried within their cycle, but a new five-minute cycle intentionally sends another reminder if stock is still available. Delivery errors remain visible in logs/outbox; fix invalid credentials/chat rather than resetting state.

Only sanitized operation/error codes are logged, never tokens, guest cookies/session identifiers, raw exceptions, API URLs, upstream bodies or raw Telegram updates. `amul_http_403`, handshake/schema errors, regional mismatches and UNKNOWN counts require upstream investigation; they must not be "fixed" by falling back to global stock, evaluating guest JavaScript, projecting fewer inventory fields or defeating access challenges.

## Amul protocol and feasibility boundary

Each check obtains a fresh anonymous guest session from the public protein page, safely parses the guest JSON (no `eval`), signs normal storefront headers with Web Crypto, resolves one **exact PIN** using `/entity/pincode`, and sets that anonymous session's regional preferences. It refreshes the session and verifies the selected substore before requesting full regional product pages.

Use effective numeric `available` (`0`/`1`), **not positive `inventory_quantity`**. A verified probe found positive quantities on unavailable items. Do **not** add `fields[...]` projections: a reduced response changed 12 answers by omitting fields needed for linked-inventory enrichment. Background checks request the selected aliases with a tested `alias in [...]` filter, retaining **every response field** needed for enrichment; manual catalog/snapshot requests still use the full category. A read-only regional comparison verified identical effective availability for all three watched aliases with full versus filtered responses. Unexpected aliases fail closed; zero matches in a filtered response mean the watches are missing/UNKNOWN, not out of stock. Pagination ignores the endpoint's unreliable `total`, checks for repeated pages, and fails closed above 200 products instead of quietly truncating. An unfiltered catalog must be nonempty; malformed identities fail the check.

A sanitized feasibility probe on **2026-09-22** succeeded on actual Cloudflare Workers Playground: PIN 500032 mapped to `telangana`, and 23 listings (13 available, 10 unavailable) took roughly 1.2-1.3 seconds wall time. That is dated feasibility evidence, **not current inventory**, production monitoring, Telegram/D1 validation, or proof of free-tier CPU compliance.

## Free-tier limits and operational expectations

At a five-minute interval there are 288 scheduled invocations/day. A current 23-item catalog normally needs seven Amul requests per successful check; longer catalogs paginate in 50-item pages. No network waits count toward CPU time, but parsing, hashing, orchestration and application work do.

Cloudflare Workers Free currently allows 100,000 requests/day, **10 ms CPU per ordinary Worker HTTP/Cron invocation**, 50 external subrequests/invocation and 128 MB memory. SQLite-backed DOs are available on Free with **30 seconds default CPU per DO request**, 100,000 DO requests/**day**, 13,000 GB-s active duration/**day**, and 128 MB allocated memory. Active duration includes awaited I/O; idle hibernation-eligible objects are not charged duration. The DO SQL allowance is 5 million rows read/day, 100,000 written/day and 5 GB total; this implementation adds no application DO storage writes. D1 remains independently subject to its Free row/storage quotas. Exceeding a Free allowance fails operations, not an authorization to upgrade.

At 288 scheduled cycles/day this design uses approximately 288 ordinary Cron invocations plus 288 DO RPC requests, before manual traffic/retries. A bounded 45-second network window per cycle would use about **1,659 GB-s/day** at 0.128 GB, plus database/runtime time and manual requests; even a conservative 120-second active interval per cycle is about **4,424 GB-s/day**. Use measured active wall duration to verify the actual workload, not CPU time as a duration proxy. There are no persistent connections or timers keeping the object active between cycles. Confirm current [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

**Actual CPU must be verified per runtime for the deployed version.** The earlier all-in-one ordinary Worker measured 18-32 ms on real scheduled calls and failed its 10 ms gate; that is a failed baseline, not DO evidence. Measure the thin ordinary dispatcher against 10 ms and the actual `PersonalMonitor` DO invocation against its documented 30,000 ms limit. Trace execution model/object identity/RPC metadata must distinguish them; never treat aggregate Worker CPU, startup duration, a successful response or wall time as proof. Scheduled checks retain full-field alias filtering and batched D1 operations. If either runtime exceeds its limit, disable `MONITORING_ENABLED` and cron, preserve state, and retest rather than upgrading automatically.

**Verified live example (2026-09-24, Workers Free):** two distinct five-minute slots on the same SQLite-DO build produced the following sanitized runtime measurements. Each had three selected products, one confirmed available, no unknowns, and one durable Telegram acknowledgement; unchanged availability correctly produced another reminder in the next slot.

| Scheduled slot (UTC) | Ordinary Cron CPU | `PersonalMonitor` DO CPU | DO active wall time | Reminder acknowledged (UTC) |
| --- | --- | --- | --- | --- |
| 09:15 | 1 ms | 25 ms | 12.235 s | 09:16:02.567 |
| 09:20 | 1 ms | 22 ms | 12.573 s | 09:21:01.237 |

Trace metadata identified the ordinary events as `stateless` scheduled invocations and the object events as `durableObject`, entrypoint `PersonalMonitor`, RPC `runScheduled`, with object IDs present. The object namespace was independently verified `use_sqlite=true`; no paid upgrade was made. Applying the longer measured active duration to 288 cycles projects about **463.5 GB-s/day** (3.57% of the 13,000 GB-s/day DO allowance), before manual traffic/retries. This is measured evidence for that build and workload, not a permanent performance guarantee. The approximately one-minute start delay also illustrates why five-minute polling is not an instantaneous stock feed.

This is five-minute polling, not a continuous real-time stock feed. Cron propagation/scheduling delays, quota exhaustion, busy leases, upstream blocks and Telegram rate limits can delay or skip a cycle. Brief availability between checks can be missed. **Repeated in-stock reminders are intentional**, one consolidated message per successful available cycle; no stock message is sent for fully unavailable or unconfirmed-only results. `/status` exposes actual background timestamps/outcomes and overdue checks rather than inferring activity from `paused=false`.
