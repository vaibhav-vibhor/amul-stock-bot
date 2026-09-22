import { env } from "cloudflare:workers";
import { applyD1Migrations, createScheduledController, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { productPage } from "../src/commands";
import { Store } from "../src/db";
import { splitMessages } from "../src/stock";
import worker from "../src";
import { callback, command, fixtureProduct, seedTracked, tick, Upstream, webhook } from "./helpers";

let upstream: Upstream;
let store: Store;
let logged: unknown[][];

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  store = new Store(env.DB);
  upstream = new Upstream();
  upstream.install();
  logged = [];
  vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => { logged.push(values); });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

async function alerts() {
  return (await store.sql("SELECT * FROM outbox WHERE kind = 'alert' ORDER BY id").all<{
    id: number; state: string; attempts: number; payload: string; next_attempt_at: number;
  }>()).results;
}

function deliveredTexts() {
  return upstream.telegram.filter((call) => call.method !== "answerCallbackQuery").map((call) => String(call.payload.text));
}

describe("durable restock state machine", () => {
  it("starts with no watches, no upstream calls and no automatic messages", async () => {
    await tick();
    expect(await store.products()).toEqual([]);
    expect(upstream.amul).toEqual([]);
    expect(upstream.telegram).toEqual([]);
    expect((await store.config()).last_success_at).toBeNull();
  });

  it.each([0, 1] as const)("silently establishes a first baseline of %s", async (available) => {
    await seedTracked();
    upstream.products = [fixtureProduct(0, available)];
    await tick();
    expect((await store.observations())[0]?.available).toBe(available);
    expect(await alerts()).toEqual([]);
    expect(upstream.telegram).toEqual([]);
    expect((await store.config()).last_success_at).toBeGreaterThan(0);
  });

  it("alerts once per observed restock, persists across invocations and re-arms after stock-out", async () => {
    await seedTracked();
    await tick();
    upstream.products = [fixtureProduct(0, 1)];
    await tick();
    await tick();
    expect(await alerts()).toHaveLength(1);
    expect(upstream.telegram).toHaveLength(1);
    const text = deliveredTexts()[0]!;
    expect(text).toContain("Amul test protein 0");
    expect(text).toContain("PIN: 500032");
    expect(text).toContain("https://shop.amul.com/en/product/amul-test-protein-0");
    expect(text).toContain("not a reservation");
    upstream.products = [fixtureProduct(0, 0)];
    await tick();
    upstream.products = [fixtureProduct(0, 1)];
    await tick();
    expect(upstream.telegram).toHaveLength(2);
    expect((await store.observations())[0]?.transition_seq).toBe(2);
  });

  it("preserves an in-stock baseline through UNKNOWN and cannot invent a restock", async () => {
    await seedTracked(1);
    upstream.products = [{ ...fixtureProduct(), available: undefined }];
    await tick();
    expect((await store.observations())[0]).toMatchObject({ available: 1, checked_at: 1 });
    expect((await store.config()).last_error).toBe("amul_unknown_availability:1");
    upstream.products = [fixtureProduct(0, 1)];
    await tick();
    expect(await alerts()).toHaveLength(0);
  });

  it("preserves missing tracked products as UNKNOWN rather than stock-out", async () => {
    await seedTracked(1);
    upstream.products = [fixtureProduct(1, 0)];
    await tick();
    expect((await store.observations())[0]).toMatchObject({ available: 1, checked_at: 1 });
    expect((await store.config()).last_success_at).toBeNull();
    expect((await store.products()).find((product) => product.id === 1)?.active).toBe(0);
    expect(await alerts()).toEqual([]);
  });

  it("handles valid products in a partial check without overwriting unknown baselines", async () => {
    await seedTracked(0, 2);
    upstream.products = [fixtureProduct(0, 1), fixtureProduct(1, "unknown")];
    await tick();
    const observations = await store.observations();
    expect(observations.find((item) => item.product_id === 1)?.available).toBe(1);
    expect(observations.find((item) => item.product_id === 2)?.checked_at).toBe(1);
    expect((await store.config()).last_success_at).toBeNull();
    expect(await alerts()).toHaveLength(1);
  });

  it("does not commit the first page of a catalog if a later page fails", async () => {
    await seedTracked(0);
    upstream.products = Array.from({ length: 51 }, (_, index) => fixtureProduct(index, 1));
    let pages = 0;
    upstream.onInventory = async () => {
      if (++pages === 2) throw new Error("simulated later-page network failure");
    };
    await tick();
    expect((await store.observations())[0]).toMatchObject({ available: 0, checked_at: 1 });
    expect(await store.products()).toHaveLength(1);
    expect(await alerts()).toEqual([]);
  });

  it("surfaces upstream errors in /checknow and /status while retaining last success", async () => {
    await seedTracked(1);
    await store.sql("UPDATE config SET last_success_at = 1000 WHERE id = 1").run();
    upstream.failure = { path: "/entity/ms.products", status: 403 };
    expect((await webhook(command(1, "/checknow"))).status).toBe(200);
    expect(deliveredTexts()[0]).toContain("Check failed for PIN 500032: amul_http_403");
    expect((await store.observations())[0]?.available).toBe(1);
    expect((await store.config()).last_success_at).toBe(1000);
    await webhook(command(2, "/status"));
    expect(deliveredTexts().at(-1)).toContain("1970-01-01T00:00:01.000Z");
    expect(deliveredTexts().at(-1)).toContain("amul_http_403");
    expect(await alerts()).toEqual([]);
  });

  it("persists an upstream Retry-After across cron and manual attempts", async () => {
    await seedTracked();
    upstream.failure = { path: "/entity/ms.products", status: 429, retryAfter: "1800" };
    await tick();
    const requests = upstream.amul.length;
    await tick();
    await webhook(command(1, "/checknow"));
    expect(upstream.amul).toHaveLength(requests);
    expect((await store.config()).upstream_retry_at).toBeGreaterThan(Date.now() + 1_700_000);
    expect(deliveredTexts().at(-1)).toContain("amul_retry_after_active");
  });
});

describe("persistent delivery and coordination", () => {
  it("retries an unacknowledged send after state advances without creating another alert", async () => {
    await seedTracked(0);
    upstream.products = [fixtureProduct(0, 1)];
    upstream.telegramResponse = () => Response.json({ ok: false, error_code: 500 }, { status: 500 });
    await tick();
    expect((await alerts())[0]).toMatchObject({ state: "pending", attempts: 1 });
    expect((await store.observations())[0]?.available).toBe(1);
    await tick();
    expect(upstream.telegram).toHaveLength(1);
    await store.sql("UPDATE outbox SET next_attempt_at = 0 WHERE state = 'pending'").run();
    upstream.telegramResponse = undefined;
    await tick();
    expect(await alerts()).toHaveLength(1);
    expect((await alerts())[0]).toMatchObject({ state: "acknowledged", attempts: 2 });
    expect(upstream.telegram).toHaveLength(2);
    expect(upstream.telegram[0]?.payload).toEqual(upstream.telegram[1]?.payload);
  });

  it("keeps ambiguous Telegram timeouts pending and logs only a sanitized code", async () => {
    await seedTracked(0);
    upstream.products = [fixtureProduct(0, 1)];
    upstream.telegramResponse = () => { throw new Error("sensitive-raw-token-url"); };
    await tick();
    expect((await alerts())[0]?.state).toBe("pending");
    expect(logged).toContainEqual(['{"operation":"telegram_delivery","error":"telegram_network_or_timeout"}']);
    expect(JSON.stringify(logged)).not.toContain("sensitive-raw-token-url");
  });

  it("honors Telegram Retry-After globally, even for newly queued replies", async () => {
    await seedTracked(0);
    upstream.products = [fixtureProduct(0, 1)];
    upstream.telegramResponse = () => Response.json({
      ok: false, error_code: 429, parameters: { retry_after: 600 },
    }, { status: 429 });
    await tick();
    await webhook(command(1, "/status"));
    expect(upstream.telegram).toHaveLength(1);
    expect((await store.config()).telegram_retry_at).toBeGreaterThan(Date.now() + 590_000);
    expect((await alerts())[0]?.next_attempt_at).toBeGreaterThan(Date.now() + 590_000);
  });

  it("requires a real acknowledgement even when Telegram returns HTTP 200", async () => {
    await seedTracked(0);
    upstream.products = [fixtureProduct(0, 1)];
    upstream.telegramResponse = () => Response.json({ ok: true, result: {} });
    await tick();
    expect((await alerts())[0]).toMatchObject({ state: "pending", attempts: 1 });
    expect(logged).toContainEqual(['{"operation":"telegram_delivery","error":"telegram_missing_acknowledgement"}']);
  });

  it("cancels pending messages for a previous runtime owner binding", async () => {
    await store.enqueue("old-owner", "reply", "sendMessage", {
      chat_id: env.TELEGRAM_OWNER_ID, text: "Private old-owner snapshot",
    }).run();
    await worker.scheduled(createScheduledController(), { ...env, TELEGRAM_OWNER_ID: "987654321" });
    expect(upstream.telegram).toEqual([]);
    expect(await store.sql("SELECT state, last_error FROM outbox WHERE dedupe_key = 'old-owner'").first())
      .toEqual({ state: "cancelled", last_error: "owner_binding_changed" });
  });

  it("expires old callback acknowledgements without blocking a requested reply", async () => {
    await store.enqueue("expired-callback", "callback", "answerCallbackQuery", {
      callback_query_id: "old-fictional-callback", text: "Done",
    }, undefined, Date.now() - 1).run();
    await webhook(command(1, "/status"));
    expect(upstream.telegram).toHaveLength(1);
    expect(upstream.telegram[0]?.method).toBe("sendMessage");
    expect(await store.sql("SELECT state FROM outbox WHERE dedupe_key = 'expired-callback'").first())
      .toEqual({ state: "cancelled" });
  });

  it("cancels an undelivered snapshot after observing another stock-out", async () => {
    await seedTracked(0);
    upstream.products = [fixtureProduct(0, 1)];
    upstream.telegramResponse = () => Response.json({ ok: false, error_code: 500 }, { status: 500 });
    await tick();
    upstream.products = [fixtureProduct(0, 0)];
    await tick();
    expect((await alerts())[0]?.state).toBe("cancelled");
  });

  it("serializes overlapping cron checks", async () => {
    await seedTracked(0);
    upstream.products = [fixtureProduct(0, 1)];
    await Promise.all([tick(), tick()]);
    expect(upstream.amul.filter((call) => call.url.pathname === "/entity/ms.products")).toHaveLength(1);
    expect(upstream.telegram).toHaveLength(1);
    expect(await alerts()).toHaveLength(1);
  });

  it("returns retryable busy without consuming an update while a check owns the lease", async () => {
    const lease = await store.acquire();
    expect(lease).not.toBeNull();
    expect((await webhook(command(1, "/checknow"))).status).toBe(503);
    expect(await store.processed(1)).toBe(false);
    await lease!.release();
    expect((await webhook(command(1, "/checknow"))).status).toBe(200);
    expect(await store.processed(1)).toBe(true);
  });

  it("atomically rolls back observation, outbox and update marker when a D1 batch fails", async () => {
    await seedTracked(0);
    const lease = (await store.acquire())!;
    await expect(lease.commit([
      store.sql("UPDATE observations SET available = 1"),
      store.enqueue("test-rollback", "reply", "sendMessage", { chat_id: env.TELEGRAM_OWNER_ID, text: "not sent" }),
      store.sql("INSERT INTO telegram_updates (update_id, processed_at) VALUES (1, 1)"),
      store.sql("UPDATE config SET paused = 2 WHERE id = 1"),
    ])).rejects.toThrow();
    expect((await store.observations())[0]?.available).toBe(0);
    expect(await store.processed(1)).toBe(false);
    expect((await store.sql("SELECT id FROM outbox").all()).results).toEqual([]);
    await lease.release();
  });

  it("fences stale in-flight checks after lease takeover and a PIN change", async () => {
    await seedTracked(0);
    upstream.products = [fixtureProduct(0, 1)];
    let releaseInventory!: () => void;
    let inventoryStarted!: () => void;
    const started = new Promise<void>((resolve) => { inventoryStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseInventory = resolve; });
    upstream.onInventory = async () => { inventoryStarted(); await release; };
    const oldCheck = tick().then(() => null, (error: unknown) => error);
    await started;
    await store.sql("UPDATE operation_lease SET expires_at = 0 WHERE id = 1").run();
    expect((await webhook(command(10, "/pincode 560001"))).status).toBe(200);
    releaseInventory();
    expect(await oldCheck).toBeInstanceOf(Error);
    expect((await store.config()).pincode).toBe("560001");
    expect(await store.observations()).toEqual([]);
    expect(await alerts()).toEqual([]);
    expect(deliveredTexts().every((text) => !text.includes("Restock observed"))).toBe(true);
  });

  it("fences a stale configuration revision even if the lease token is unchanged", async () => {
    await seedTracked(0);
    const lease = (await store.acquire())!;
    await store.sql("UPDATE config SET revision = revision + 1 WHERE id = 1").run();
    await expect(lease.commit([store.sql("UPDATE observations SET available = 1")], 1)).rejects.toThrow();
    expect((await store.observations())[0]?.available).toBe(0);
    await lease.release();
  });
});

describe("owner-only Telegram controls", () => {
  it("checks the webhook secret before any processing", async () => {
    expect((await webhook(command(1, "/start"), "incorrect")).status).toBe(403);
    expect(await store.processed(1)).toBe(false);
    expect(upstream.telegram).toEqual([]);
  });

  it("ignores other users and all non-private chats, without claiming ownership", async () => {
    expect((await webhook(command(1, "/start", 111111111))).status).toBe(200);
    expect((await webhook(command(2, "/start", Number(env.TELEGRAM_OWNER_ID), "group"))).status).toBe(200);
    expect(await store.processed(1)).toBe(false);
    expect(await store.processed(2)).toBe(false);
    expect(upstream.telegram).toEqual([]);
  });

  it("rejects malformed and oversized authenticated input without changing state", async () => {
    const headers = { "X-Telegram-Bot-Api-Secret-Token": env.TELEGRAM_WEBHOOK_SECRET };
    const malformed = new Request("https://bot.example/telegram", { method: "POST", headers, body: "not-json" });
    expect((await worker.fetch(malformed, env)).status).toBe(400);
    const oversized = new Request("https://bot.example/telegram", { method: "POST", headers, body: "x".repeat(24_001) });
    expect((await worker.fetch(oversized, env)).status).toBe(413);
    expect(upstream.telegram).toEqual([]);
    expect((await store.sql("SELECT update_id FROM telegram_updates").all()).results).toEqual([]);
  });

  it("has no unauthenticated mutation endpoint or missing-secret fallback", async () => {
    expect((await worker.fetch(new Request("https://bot.example/admin"), env)).status).toBe(404);
    const request = new Request("https://bot.example/telegram", { method: "POST", body: "{}" });
    expect((await worker.fetch(request, { ...env, TELEGRAM_OWNER_ID: "" })).status).toBe(503);
    expect(upstream.telegram).toEqual([]);
  });

  it("lists paginated catalog products and bounds every output contract", async () => {
    upstream.products = Array.from({ length: 13 }, (_, index) => ({
      ...fixtureProduct(index), name: `Product ${index} ` + "x".repeat(280),
    }));
    expect((await webhook(command(1, "/products"))).status).toBe(200);
    const first = upstream.telegram[0]!.payload;
    expect(String(first.text)).toContain("page 1/3");
    expect(String(first.text).length).toBeLessThanOrEqual(4_096);
    await webhook(callback(2, "page:1:2"));
    const last = upstream.telegram.at(-1)!;
    expect(last.method).toBe("editMessageText");
    expect(String(last.payload.text)).toContain("page 3/3");
    const page = productPage(await store.config(), await store.products(), 1);
    for (const row of page.reply_markup!.inline_keyboard) {
      for (const button of row) {
        if (button.callback_data) expect(new TextEncoder().encode(button.callback_data).length).toBeLessThanOrEqual(64);
      }
    }
    const chunks = splitMessages("Snapshot", Array.from({ length: 200 }, () => "x".repeat(350)));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((message) => message.text.length <= 4_096)).toBe(true);
    const unicodePage = productPage(await store.config(), (await store.products()).map((product) => ({
      ...product, name: "a" + "\u{1F95B}".repeat(25),
    })), 0);
    const buttonText = unicodePage.reply_markup!.inline_keyboard[0]![0]!.text;
    expect(new TextDecoder().decode(new TextEncoder().encode(buttonText))).toBe(buttonText);
  });

  it("deduplicates webhook retries and callback IDs durably", async () => {
    await webhook(command(1, "/products"));
    const update = callback(2, "track:1:1:0", "same-callback");
    await webhook(update);
    const count = upstream.telegram.length;
    await webhook(update);
    await webhook(callback(3, "track:1:1:0", "same-callback"));
    expect(upstream.telegram).toHaveLength(count);
    expect((await store.products())[0]?.epoch).not.toBeNull();
    expect((await store.config()).revision).toBe(2);
    expect(await store.processed(2)).toBe(true);
    expect(await store.processed(3)).toBe(false);
  });

  it("rejects stale buttons and selections outside the catalog", async () => {
    await webhook(command(1, "/products"));
    await webhook(callback(2, "track:1:999:0"));
    expect((await store.products())[0]?.epoch).toBeNull();
    await webhook(callback(3, "track:1:1:0"));
    await webhook(callback(4, "untrack:1:1:0"));
    expect((await store.products())[0]?.epoch).not.toBeNull();
    expect(deliveredTexts().at(-1)).toContain("button is stale");
  });

  it("untracking/retracking establishes a new silent baseline", async () => {
    await seedTracked(0);
    await webhook(callback(1, "untrack:1:1:0"));
    expect(await store.observations()).toEqual([]);
    await webhook(callback(2, "track:2:1:0"));
    upstream.products = [fixtureProduct(0, 1)];
    await tick();
    expect(await alerts()).toEqual([]);
    expect((await store.observations())[0]?.available).toBe(1);
  });

  it("keeps other products' baselines when one selection changes", async () => {
    await seedTracked(0, 2);
    await webhook(callback(1, "untrack:1:2:0"));
    expect((await store.observations()).map((observation) => observation.product_id)).toEqual([1]);
    upstream.products = [fixtureProduct(0, 1), fixtureProduct(1, 1)];
    await tick();
    expect(await alerts()).toHaveLength(1);
  });

  it("changes PIN only after validation, cancels pending old-PIN output and starts quietly", async () => {
    await seedTracked(0);
    upstream.products = [fixtureProduct(0, 1)];
    upstream.telegramResponse = () => Response.json({ ok: false, error_code: 500 }, { status: 500 });
    await webhook(command(1, "/checknow"));
    upstream.telegramResponse = undefined;
    await webhook(command(2, "/pincode 560001"));
    expect((await store.config()).pincode).toBe("560001");
    expect(await store.observations()).toEqual([]);
    expect((await alerts())[0]?.state).toBe("cancelled");
    const oldReply = await store.sql("SELECT state FROM outbox WHERE dedupe_key = 'update:1:reply:0'").first<{ state: string }>();
    expect(oldReply?.state).toBe("cancelled");
    const before = upstream.telegram.length;
    await tick();
    expect((await store.observations())[0]).toMatchObject({ pincode: "560001", available: 1 });
    expect(upstream.telegram).toHaveLength(before);
  });

  it("does not change PIN or baselines for invalid/unserviceable arguments", async () => {
    await seedTracked(0);
    await webhook(command(1, "/pincode 123"));
    await webhook(command(2, "/pincode 500032 extra"));
    expect(upstream.amul).toEqual([]);
    await webhook(command(3, "/pincode 999999"));
    expect((await store.config()).pincode).toBe("500032");
    expect((await store.observations())[0]?.checked_at).toBe(1);
    expect(deliveredTexts().at(-1)).toContain("PIN not changed");
  });

  it("pauses alerts, allows explicit snapshots, and resumes with silent baselines", async () => {
    await seedTracked(0);
    await webhook(command(1, "/pause"));
    expect(await store.observations()).toEqual([]);
    await tick();
    expect(upstream.amul).toEqual([]);
    upstream.products = [fixtureProduct(0, 1)];
    await webhook(command(2, "/checknow"));
    expect(deliveredTexts().at(-1)).toContain("Paused: this snapshot does not change alert baselines.");
    expect(await store.observations()).toEqual([]);
    await webhook(command(3, "/resume"));
    await tick();
    expect((await store.observations())[0]?.available).toBe(1);
    expect(await alerts()).toEqual([]);
  });

  it("explicit /checknow may show in-stock results without a baseline alert", async () => {
    await seedTracked();
    upstream.products = [fixtureProduct(0, 1)];
    await webhook(command(1, "/checknow"));
    expect(deliveredTexts()).toHaveLength(1);
    expect(deliveredTexts()[0]).toContain("Requested stock snapshot for PIN 500032");
    expect(deliveredTexts()[0]).toContain("Available");
    expect(await alerts()).toEqual([]);
  });
});
