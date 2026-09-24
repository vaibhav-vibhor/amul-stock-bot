import { env } from "cloudflare:workers";
import { applyD1Migrations, createScheduledController, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { CHECK_INTERVAL_MS, MONITOR_CRON } from "../src/background";
import { Store } from "../src/db";
import { availabilityReminder } from "../src/stock";
import { callback, command, configuredFetch, configuredTick, fixtureProduct, seedTracked, tick, Upstream, webhook } from "./helpers";

let now: number;
let store: Store;
let upstream: Upstream;

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  now = Math.floor(Date.now() / CHECK_INTERVAL_MS) * CHECK_INTERVAL_MS + 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  store = new Store(env.DB);
  upstream = new Upstream();
  upstream.install();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

function cycle(): number {
  return Math.floor(now / CHECK_INTERVAL_MS) * CHECK_INTERVAL_MS;
}

async function reminders() {
  return (await store.sql(
    "SELECT scheduled_at, state, payload, attempts, last_error FROM outbox WHERE kind = 'alert' ORDER BY id",
  ).all<{ scheduled_at: number; state: string; payload: string; attempts: number; last_error: string | null }>()).results;
}

describe("actual scheduled entrypoint", () => {
  it("suspends late cron events using the deployment gate without changing the owner's pause or watches", async () => {
    await seedTracked(1);
    upstream.products = [fixtureProduct(0, 1)];
    const before = await store.products();
    const observations = await store.observations();
    await worker.scheduled(createScheduledController({ cron: MONITOR_CRON, scheduledTime: cycle() }), {
      ...env, MONITORING_ENABLED: "false",
    });
    expect(upstream.amul).toEqual([]);
    expect(upstream.telegram).toEqual([]);
    expect(await store.lastBackgroundCycle()).toBeNull();
    expect(await store.products()).toEqual(before);
    expect(await store.observations()).toEqual(observations);
    expect((await store.config()).paused).toBe(0);
  });

  it("reports a disabled deployment honestly in status while manual snapshots still work", async () => {
    await seedTracked(1);
    upstream.products = [fixtureProduct(0, 1)];
    const disabled = { ...env, MONITORING_ENABLED: "false" };
    for (const [id, text] of [[1, "/status"], [2, "/checknow"], [3, "/resume"]] as const) {
      const response = await configuredFetch(new Request("https://bot.example/telegram", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": env.TELEGRAM_WEBHOOK_SECRET },
        body: JSON.stringify(command(id, text)),
      }), disabled);
      expect(response.status).toBe(200);
    }
    expect(upstream.telegram[0]?.payload.text).toContain("BACKGROUND DISABLED IN WORKER CONFIGURATION");
    expect(upstream.telegram[1]?.payload.text).toContain("Stock snapshot");
    expect(upstream.telegram[2]?.payload.text).toContain("background monitoring is disabled");
    expect(await reminders()).toEqual([]);
  });

  it.each([undefined, 0, 1] as const)("reminds on first in-stock check regardless of prior observation %s", async (baseline) => {
    await seedTracked(baseline);
    upstream.products = [fixtureProduct(0, 1)];
    await tick(cycle());
    expect(upstream.telegram).toHaveLength(1);
    expect((await reminders())[0]).toMatchObject({ state: "acknowledged", attempts: 1, scheduled_at: cycle() });
    expect(await store.lastBackgroundCycle()).toMatchObject({ outcome: "available", selected_count: 1, available_count: 1 });
  });

  it("notifies on three adjacent unchanged-available cycles, while repeated copies of a tick do not", async () => {
    await seedTracked(1);
    upstream.products = [fixtureProduct(0, 1)];
    const times = [];
    for (let index = 0; index < 3; index++) {
      times.push(cycle());
      await tick(cycle());
      const requestCount = upstream.amul.length;
      await tick(cycle());
      await tick(cycle() + 1); // Same five-minute slot remains the same durable cycle.
      expect(upstream.amul).toHaveLength(requestCount);
      now += CHECK_INTERVAL_MS;
    }
    expect(upstream.telegram).toHaveLength(3);
    expect((await reminders()).map((reminder) => reminder.scheduled_at)).toEqual(times);
  });

  it("consolidates any available selections into exactly one linked IST reminder", async () => {
    await seedTracked(1, 3);
    upstream.products = [fixtureProduct(0, 0), fixtureProduct(1, 1), fixtureProduct(2, 1)];
    await tick(cycle());
    expect(upstream.telegram).toHaveLength(1);
    const payload = upstream.telegram[0]!.payload;
    expect(payload.parse_mode).toBe("HTML");
    expect(payload.text).toContain("\u2705 Available (2)");
    expect(payload.text).toContain("PIN 500032");
    expect(payload.text).toContain(" IST");
    expect(payload.text).toContain('href="https://shop.amul.com/en/product/amul-test-protein-1"');
    expect(payload.text).toContain("Amul test protein 2");
    expect(payload.text).not.toContain("Amul test protein 0");
    expect(payload.text).toContain("not a reservation");
  });

  it("sends nothing when all out of stock, despite formerly in-stock observations", async () => {
    await seedTracked(1, 3);
    upstream.products = [fixtureProduct(0, 0), fixtureProduct(1, 0), fixtureProduct(2, 0)];
    await tick(cycle());
    expect(upstream.telegram).toEqual([]);
    expect(await reminders()).toEqual([]);
    expect(await store.lastBackgroundCycle()).toMatchObject({ outcome: "unavailable", available_count: 0 });
  });

  it("never infers availability from missing or malformed values, but can list separately confirmed products", async () => {
    await seedTracked(1, 3);
    upstream.products = [fixtureProduct(0, 1), fixtureProduct(1, "1")];
    await tick(cycle());
    expect(upstream.telegram).toHaveLength(1);
    expect(upstream.telegram[0]?.payload.text).toContain("Available (1)");
    expect(upstream.telegram[0]?.payload.text).toContain("2 selected product(s) unconfirmed");
    expect(upstream.telegram[0]?.payload.text).not.toContain("Amul test protein 1");
    expect(upstream.telegram[0]?.payload.text).not.toContain("Amul test protein 2");
    expect(await store.lastBackgroundCycle()).toMatchObject({ outcome: "partial", available_count: 1, unknown_count: 2 });
    expect((await store.observations()).find((observation) => observation.product_id === 2)?.checked_at).toBe(1);
  });

  it.each(["unknown", "network", "region", "empty"] as const)("fails closed for %s without notifying from cached stock", async (failure) => {
    await seedTracked(1);
    if (failure === "unknown") upstream.products = [fixtureProduct(0, null)];
    if (failure === "network") upstream.onInventory = async () => { throw new Error("private fetch detail"); };
    if (failure === "region") upstream.wrongRegion = true;
    if (failure === "empty") upstream.products = [];
    await tick(cycle());
    expect(upstream.telegram).toEqual([]);
    expect((await store.observations())[0]).toMatchObject({ available: 1, checked_at: 1 });
    expect((await store.config()).last_error).not.toBeNull();
    expect((await store.lastBackgroundCycle())?.outcome).toBe(failure === "unknown" || failure === "empty" ? "partial" : "error");
  });

  it("does not use a manual snapshot to suppress, generate or advance periodic reminders", async () => {
    await seedTracked(1);
    upstream.products = [fixtureProduct(0, 1)];
    await webhook(command(1, "/checknow"));
    expect(await reminders()).toEqual([]);
    expect(await store.lastBackgroundCycle()).toBeNull();
    const before = now;
    await tick(cycle());
    const scheduled = await store.lastBackgroundCycle();
    now += 60_000;
    await webhook(command(2, "/checknow"));
    expect(await store.lastBackgroundCycle()).toEqual(scheduled);
    expect(await reminders()).toHaveLength(1);
    now = before + CHECK_INTERVAL_MS;
    await tick(cycle());
    expect(await reminders()).toHaveLength(2);
    expect(upstream.telegram).toHaveLength(4); // Two requested snapshots, two separate cycle reminders.
  });

  it("status distinguishes staging/manual success from observed background execution", async () => {
    await seedTracked(1);
    upstream.products = [fixtureProduct(0, 1)];
    await webhook(command(1, "/checknow"));
    await webhook(command(2, "/status"));
    expect(upstream.telegram.at(-1)?.payload.text).toContain("WAITING FOR FIRST BACKGROUND CHECK");
    await tick(cycle());
    await webhook(command(3, "/status"));
    expect(upstream.telegram.at(-1)?.payload.text).toContain("BACKGROUND CHECK OBSERVED: available");
    expect(upstream.telegram.at(-1)?.payload.text).toContain(new Date(now).toISOString());
    now += 3 * CHECK_INTERVAL_MS;
    await webhook(command(4, "/status"));
    expect(upstream.telegram.at(-1)?.payload.text).toContain("BACKGROUND CHECK OVERDUE");
  });

  it("honors pause and empty selection without Amul calls, and resumes on the next cycle", async () => {
    await tick(cycle());
    expect(await store.lastBackgroundCycle()).toMatchObject({ outcome: "empty" });
    await seedTracked(1);
    await webhook(command(1, "/pause"));
    now += CHECK_INTERVAL_MS;
    await tick(cycle());
    expect(upstream.amul).toEqual([]);
    expect(await store.lastBackgroundCycle()).toMatchObject({ outcome: "paused" });
    await webhook(command(2, "/resume"));
    now += CHECK_INTERVAL_MS;
    upstream.products = [fixtureProduct(0, 1)];
    await tick(cycle());
    expect(await reminders()).toHaveLength(1);
    expect((await store.config()).paused).toBe(0);
  });

  it("cancels pending reminders on selection change and includes new in-stock selections immediately next cycle", async () => {
    await seedTracked(1, 2);
    upstream.products = [fixtureProduct(0, 1), fixtureProduct(1, 1)];
    upstream.telegramResponse = () => Response.json({ ok: false, error_code: 500 }, { status: 500 });
    await tick(cycle());
    upstream.telegramResponse = undefined;
    await webhook(callback(1, "pick:1:1:0:1:2"));
    expect((await reminders())[0]?.state).toBe("cancelled");
    now += CHECK_INTERVAL_MS;
    await tick(cycle());
    const last = upstream.telegram.at(-1)!;
    expect(last.payload.text).toContain("Available (1)");
    expect(last.payload.text).toContain("Amul test protein 1");
    expect(last.payload.text).not.toContain("Amul test protein 0");
    await webhook(callback(2, "pick:2:1:1:1:2"));
    now += CHECK_INTERVAL_MS;
    await tick(cycle());
    expect(upstream.telegram.at(-1)?.payload.text).toContain("Available (2)");
  });

  it("cancels pending old-PIN and old-owner reminders instead of delivering them during recovery", async () => {
    await seedTracked(1);
    upstream.products = [fixtureProduct(0, 1)];
    upstream.telegramResponse = () => Response.json({ ok: false, error_code: 500 }, { status: 500 });
    await tick(cycle());
    upstream.telegramResponse = undefined;
    await webhook(command(1, "/pincode 560001"));
    expect((await reminders())[0]?.state).toBe("cancelled");
    now += CHECK_INTERVAL_MS;
    upstream.telegramResponse = () => Response.json({ ok: false, error_code: 500 }, { status: 500 });
    await tick(cycle());
    upstream.telegramResponse = undefined;
    await store.sql("UPDATE outbox SET next_attempt_at = 0 WHERE state = 'pending'").run();
    await configuredTick(cycle(), {
      ...env, TELEGRAM_OWNER_ID: "987654321",
    });
    expect((await reminders()).every((reminder) => reminder.state === "cancelled")).toBe(true);
    now += CHECK_INTERVAL_MS;
    await configuredTick(cycle(), {
      ...env, TELEGRAM_OWNER_ID: "987654321",
    });
    expect(upstream.telegram.at(-1)?.payload).toMatchObject({ chat_id: "987654321" });
    expect(upstream.telegram.at(-1)?.payload.text).toContain("PIN 560001");
  });

  it("retains same-cycle failed delivery for retry but supersedes historical backlog on a fresh cycle", async () => {
    await seedTracked(1);
    upstream.products = [fixtureProduct(0, 1)];
    upstream.telegramResponse = () => Response.json({ ok: false, error_code: 500 }, { status: 500 });
    await tick(cycle());
    now += 31_000;
    upstream.telegramResponse = undefined;
    const amulRequests = upstream.amul.length;
    await tick(cycle());
    expect(upstream.amul).toHaveLength(amulRequests);
    expect((await reminders())[0]).toMatchObject({ state: "acknowledged", attempts: 2 });
    upstream.telegramResponse = () => Response.json({ ok: false, error_code: 429, parameters: { retry_after: 600 } }, { status: 429 });
    now += CHECK_INTERVAL_MS;
    await tick(cycle());
    now += CHECK_INTERVAL_MS;
    await tick(cycle());
    expect((await reminders()).filter((row) => row.state === "pending")).toHaveLength(1);
    upstream.telegramResponse = undefined;
    now += CHECK_INTERVAL_MS;
    const sends = upstream.telegram.length;
    await tick(cycle());
    expect(upstream.telegram).toHaveLength(sends + 1);
    expect((await reminders()).filter((row) => row.state === "pending")).toEqual([]);
    expect((await reminders()).slice(1, -1).every((row) => row.state === "cancelled")).toBe(true);
  });

  it("a failed or all-out fresh check cancels old queued availability instead of replaying it", async () => {
    await seedTracked(1);
    upstream.products = [fixtureProduct(0, 1)];
    upstream.telegramResponse = () => Response.json({ ok: false, error_code: 500 }, { status: 500 });
    await tick(cycle());
    upstream.telegramResponse = undefined;
    upstream.failure = { path: "/entity/ms.products", status: 403 };
    now += CHECK_INTERVAL_MS;
    const sends = upstream.telegram.length;
    await tick(cycle());
    expect(upstream.telegram).toHaveLength(sends);
    expect((await reminders())[0]?.state).toBe("cancelled");
  });

  it("does not send a queued periodic reminder merely because /checknow or /status is requested", async () => {
    await seedTracked(1);
    upstream.products = [fixtureProduct(0, 1)];
    upstream.telegramResponse = () => Response.json({ ok: false, error_code: 500 }, { status: 500 });
    await tick(cycle());
    upstream.telegramResponse = undefined;
    now += 31_000;
    await webhook(command(1, "/checknow"));
    await webhook(command(2, "/status"));
    expect((await reminders())[0]).toMatchObject({ state: "cancelled", attempts: 1, last_error: "manual_recheck" });
    expect(upstream.telegram).toHaveLength(3);
  });

  it("ignores expired/older ticks and rejects wrong cron without sending stale work", async () => {
    await seedTracked(1);
    upstream.products = [fixtureProduct(0, 1)];
    await tick(cycle() - CHECK_INTERVAL_MS);
    expect(upstream.amul).toEqual([]);
    expect((await store.lastBackgroundCycle())?.outcome).toBe("expired");
    await tick(cycle());
    const requests = upstream.amul.length;
    await tick(cycle() - CHECK_INTERVAL_MS);
    expect(upstream.amul).toHaveLength(requests);
    await expect(worker.scheduled(createScheduledController({ cron: "* * * * *", scheduledTime: cycle() }), env))
      .rejects.toThrow("Scheduled check failed");
    expect(upstream.telegram).toHaveLength(1);
  });

  it("a manual overlap does not consume a scheduled cycle; it can retry under the lease", async () => {
    await seedTracked(1);
    upstream.products = [fixtureProduct(0, 1)];
    const lease = (await store.acquire())!;
    await expect(tick(cycle())).rejects.toThrow("Scheduled check failed");
    expect(await store.lastBackgroundCycle()).toBeNull();
    await lease.release();
    await tick(cycle());
    expect(upstream.telegram).toHaveLength(1);
  });

  it("resumes a cycle interrupted before its fenced result commit without duplicating the reminder", async () => {
    await seedTracked(1);
    upstream.products = [fixtureProduct(0, 1)];
    await store.sql(
      "INSERT INTO background_cycles (scheduled_at, started_at, pincode, config_revision, outcome) VALUES (?, ?, '500032', 1, 'checking')",
      cycle(), now - 1_000,
    ).run();
    await tick(cycle());
    await tick(cycle());
    expect(await reminders()).toHaveLength(1);
    expect(upstream.telegram).toHaveLength(1);
  });

  it("never sends at the end of a cycle or after an upstream check crosses its expiry", async () => {
    await seedTracked(1);
    upstream.products = [fixtureProduct(0, 1)];
    const start = cycle();
    now = start + CHECK_INTERVAL_MS - 10_000;
    await tick(start);
    expect(upstream.telegram).toEqual([]);
    expect((await reminders())[0]?.state).toBe("cancelled");
    now = start + CHECK_INTERVAL_MS + 1_000;
    upstream.onInventory = async () => { now += CHECK_INTERVAL_MS; };
    await tick(cycle());
    expect(upstream.telegram).toEqual([]);
    expect((await store.lastBackgroundCycle())?.outcome).toBe("expired");
  });

  it("migrates populated original-schema configuration, epochs, observations and replies without mutation", async () => {
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(0, 1));
    await seedTracked(1, 2);
    await store.sql("UPDATE config SET pincode = '560001', paused = 1, revision = 8").run();
    await store.sql(
      `INSERT INTO outbox (dedupe_key, kind, method, payload, created_at, next_attempt_at)
       VALUES ('prior-reply', 'reply', 'sendMessage', '{"chat_id":"123456789","text":"prior reply"}', 1, 1)`,
    ).run();
    const config = await store.config();
    const products = await store.products();
    const observations = await store.observations();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    expect(await store.config()).toEqual(config);
    expect(await store.products()).toEqual(products);
    expect(await store.observations()).toEqual(observations);
    expect(await store.lastBackgroundCycle()).toBeNull();
    expect(await store.sql("SELECT state, payload FROM outbox WHERE dedupe_key = 'prior-reply'").first())
      .toEqual({ state: "pending", payload: '{"chat_id":"123456789","text":"prior reply"}' });
  });
});

describe("one reminder output contract", () => {
  it("escapes full linked product names, bounds oversized sets and explicitly reports omitted products", () => {
    const products = Array.from({ length: 200 }, (_, index) => ({
      alias: `amul-test-protein-${index}`,
      name: `${index} <Whey> & \u{1F95B} ${"x".repeat(270)}`,
      available: 1 as const,
    }));
    const message = availabilityReminder("500032", Date.parse("2026-09-24T05:50:53.310Z"), products, 0);
    expect(message.parse_mode).toBe("HTML");
    expect(message.text).toContain("Available (200)");
    expect(message.text).toContain("24 Sep 2026, 11:20 AM IST");
    expect(message.text).toContain("&lt;Whey&gt; &amp;");
    expect(message.text).toContain("more available products. Use /checknow");
    const visible = message.text.replace(/<[^>]*>/g, "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
    expect(visible.length).toBeLessThanOrEqual(4_096);
    expect(message.text).not.toContain("<Whey>");
    expect(message.reply_markup).toBeUndefined();
    expect(() => availabilityReminder("500032", now, [], 0)).toThrow();
  });
});
