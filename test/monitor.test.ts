import { env } from "cloudflare:workers";
import {
  applyD1Migrations, createScheduledController, evictDurableObject,
  listDurableObjectIds, reset, runDurableObjectAlarm, runInDurableObject,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src";
import { CHECK_INTERVAL_MS, MONITOR_CRON } from "../src/background";
import { Store } from "../src/db";
import { MONITOR_NAME } from "../src/monitor";
import { command, configuredTick, fixtureProduct, seedTracked, tick, Upstream, webhook } from "./helpers";

let store: Store;
let upstream: Upstream;
let now: number;

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  store = new Store(env.DB);
  upstream = new Upstream();
  upstream.install();
  now = Math.floor(Date.now() / CHECK_INTERVAL_MS) * CHECK_INTERVAL_MS + 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("Free SQLite Durable Object execution boundary", () => {
  it("routes manual catalog/snapshot and cron work through one named SQLite object, with D1 as the only user store", async () => {
    await seedTracked(1);
    upstream.products = [fixtureProduct(0, 1)];
    await webhook(command(1, "/products"));
    await webhook(command(2, "/checknow"));
    await tick(now);
    const ids = await listDurableObjectIds(env.MONITOR);
    expect(ids.map(String)).toEqual([env.MONITOR.idFromName(MONITOR_NAME).toString()]);
    const stub = env.MONITOR.getByName(MONITOR_NAME);
    const state = await runInDurableObject(stub, async (_instance, ctx) => ({
      sqlite: ctx.storage.sql.exec<{ value: number }>("SELECT 1 AS value").one().value,
      userKeys: [...(await ctx.storage.list()).keys()],
      alarm: await ctx.storage.getAlarm(),
    }));
    expect(state).toEqual({ sqlite: 1, userKeys: [], alarm: null });
    expect(await runDurableObjectAlarm(stub)).toBe(false);
    expect((await store.lastBackgroundCycle())?.outcome).toBe("available");
    expect(upstream.telegram).toHaveLength(3);
  });

  it("keeps the front door free of D1, inventory and Telegram work", async () => {
    await seedTracked(1);
    upstream.products = [fixtureProduct(0, 1)];
    const frontDb = new Proxy(env.DB, {
      get() { throw new Error("The public dispatcher must not access D1"); },
    });
    const request = new Request("https://bot.example/telegram", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": env.TELEGRAM_WEBHOOK_SECRET },
      body: JSON.stringify(command(1, "/checknow")),
    });
    const response = await worker.fetch(request, { ...env, DB: frontDb });
    expect(await response.text()).toBe("OK");
    await worker.scheduled(createScheduledController({ cron: MONITOR_CRON, scheduledTime: now }), { ...env, DB: frontDb });
    expect(upstream.telegram).toHaveLength(2);
  });

  it("preserves scheduled tick dedup and new-cycle reminders across object eviction/restart", async () => {
    await seedTracked(1);
    upstream.products = [fixtureProduct(0, 1)];
    const stub = env.MONITOR.getByName(MONITOR_NAME);
    await tick(now);
    const first = await store.lastBackgroundCycle();
    await evictDurableObject(stub);
    await tick(now);
    expect(await store.lastBackgroundCycle()).toEqual(first);
    expect(upstream.telegram).toHaveLength(1);
    await evictDurableObject(stub);
    now += CHECK_INTERVAL_MS;
    await tick(now);
    expect(upstream.telegram).toHaveLength(2);
    expect((await store.lastBackgroundCycle())?.scheduled_at).toBe(first!.scheduled_at + CHECK_INTERVAL_MS);
    expect(await runInDurableObject(stub, (_instance, ctx) => ctx.storage.getAlarm())).toBeNull();
  });

  it("persists a failed same-cycle send in D1 and retries after object restart without another observation", async () => {
    await seedTracked(1);
    upstream.products = [fixtureProduct(0, 1)];
    upstream.telegramResponse = () => Response.json({ ok: false, error_code: 500 }, { status: 500 });
    await tick(now);
    const before = upstream.amul.length;
    await evictDurableObject(env.MONITOR.getByName(MONITOR_NAME));
    now += 31_000;
    upstream.telegramResponse = undefined;
    await tick(now);
    expect(upstream.amul).toHaveLength(before);
    expect(upstream.telegram).toHaveLength(2);
    expect(await store.sql("SELECT state, attempts FROM outbox WHERE kind = 'alert'").first())
      .toEqual({ state: "acknowledged", attempts: 2 });
  });

  it("preserves webhook dedup and selections across eviction without rearming a timer from manual traffic", async () => {
    await seedTracked(1);
    const message = command(1, "/status");
    await webhook(message);
    await evictDurableObject(env.MONITOR.getByName(MONITOR_NAME));
    await webhook(message);
    expect(upstream.telegram).toHaveLength(1);
    expect((await store.products())[0]?.epoch).toBe("fictional-watch-0");
    expect(await store.lastBackgroundCycle()).toBeNull();
    expect(await runDurableObjectAlarm(env.MONITOR.getByName(MONITOR_NAME))).toBe(false);
  });

  it("has no public bootstrap, alarm, RPC or manual-cron endpoint", async () => {
    const frontEnv = { ...env, MONITOR: new Proxy(env.MONITOR, {
      get() { throw new Error("Public non-webhook paths must not access the object"); },
    }) };
    for (const path of ["/admin", "/runScheduled", "/alarm", "/__scheduled", "/bootstrap"]) {
      const response = await worker.fetch(new Request(`https://bot.example${path}`, { method: "POST", body: "{}" }), frontEnv);
      expect(response.status).toBe(404);
      await response.text();
    }
    const response = await worker.fetch(new Request("https://bot.example/health"), frontEnv);
    expect(await response.text()).toBe("ok (liveness only)");
    expect(upstream.amul).toEqual([]);
    expect(upstream.telegram).toEqual([]);
  });

  it("checks authorization inside the object instead of trusting the dispatcher", async () => {
    const stub = env.MONITOR.getByName(MONITOR_NAME);
    const response = await stub.fetch("https://bot.example/telegram", { method: "POST", body: "{}" });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Forbidden");
    expect(await store.lastBackgroundCycle()).toBeNull();
    expect(upstream.telegram).toEqual([]);
  });

  it("disabling monitoring blocks late dispatches and direct in-object execution without changing owner pause", async () => {
    await seedTracked(1);
    const before = await store.products();
    const disabled = { ...env, MONITORING_ENABLED: "false" };
    await worker.scheduled(createScheduledController({ cron: MONITOR_CRON, scheduledTime: now }), {
      ...disabled, MONITOR: new Proxy(env.MONITOR, {
        get() { throw new Error("Disabled dispatcher must not access the object"); },
      }),
    });
    await configuredTick(now, disabled);
    expect(await store.lastBackgroundCycle()).toBeNull();
    expect(upstream.amul).toEqual([]);
    expect(upstream.telegram).toEqual([]);
    expect(await store.products()).toEqual(before);
    expect((await store.config()).paused).toBe(0);
    expect(await runDurableObjectAlarm(env.MONITOR.getByName(MONITOR_NAME))).toBe(false);
  });

  it("does not convert a failing DO check into a successful cron dispatch", async () => {
    await seedTracked(1);
    const lease = (await store.acquire())!;
    const result = await env.MONITOR.getByName(MONITOR_NAME).runScheduled(now, MONITOR_CRON);
    expect(result).toEqual({ ok: false, error: "scheduled_check_failed" });
    await expect(tick(now)).rejects.toThrow("Scheduled check failed");
    expect(await store.lastBackgroundCycle()).toBeNull();
    await lease.release();
    upstream.products = [fixtureProduct(0, 1)];
    await tick(now);
    expect(upstream.telegram).toHaveLength(1);
  });
});
