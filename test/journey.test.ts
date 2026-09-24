import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CHECK_INTERVAL_MS } from "../src/background";
import { Store } from "../src/db";
import type { Button } from "../src/types";
import { callback, command, fixtureProduct, tick, Upstream, webhook } from "./helpers";
import type { TelegramCall } from "./helpers";

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

it("takes an empty owner through emitted selection buttons, recurring reminders, pause/resume and deselection", async () => {
  const store = new Store(env.DB);
  const upstream = new Upstream();
  upstream.products = [fixtureProduct(0, 1), fixtureProduct(1, 1), fixtureProduct(2, 0)];
  upstream.install();
  let now = Math.floor(Date.now() / CHECK_INTERVAL_MS) * CHECK_INTERVAL_MS + 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(console, "log").mockImplementation(() => {});
  expect(await store.products()).toEqual([]);
  expect(await store.observations()).toEqual([]);
  expect((await store.config()).paused).toBe(0);
  let updateId = 0;
  const send = (text: string) => webhook(command(++updateId, text));
  const buttons = (call: TelegramCall) =>
    (call.payload.reply_markup as { inline_keyboard: Button[][] }).inline_keyboard.flat();
  const tap = async (button: Button) => {
    expect(button.callback_data).toBeTypeOf("string");
    expect((await webhook(callback(++updateId, button.callback_data!))).status).toBe(200);
  };

  expect((await send("/start")).status).toBe(200);
  expect(upstream.telegram.at(-1)?.payload.text).toContain("/products");
  expect((await send("/products")).status).toBe(200);
  const menu = upstream.telegram.at(-1)!;
  expect(buttons(menu).filter((button) => button.callback_data?.startsWith("pick:"))).toHaveLength(3);
  await tap(buttons(menu).find((button) => button.text.includes("test protein 0"))!);
  await tap(buttons(upstream.telegram.at(-1)!).find((button) => button.text.includes("test protein 1"))!);
  expect((await store.products()).filter((product) => product.epoch)).toHaveLength(2);
  expect(upstream.telegram.at(-1)?.payload.text).toContain("Selected: 2/3");

  const expectReminder = async () => {
    const previous = upstream.telegram.length;
    await tick(now);
    const deliveries = upstream.telegram.slice(previous);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      method: "sendMessage",
      payload: { chat_id: env.TELEGRAM_OWNER_ID, parse_mode: "HTML" },
    });
    const text = String(deliveries[0]!.payload.text);
    expect(text).toContain("Available (2)");
    expect(text).toContain("Amul test protein 0");
    expect(text).toContain("Amul test protein 1");
    expect(text).not.toContain("Amul test protein 2");
  };
  await expectReminder();
  now += CHECK_INTERVAL_MS;
  await expectReminder();

  await send("/status");
  await tap(buttons(upstream.telegram.at(-1)!).find((button) => button.text === "Pause")!);
  const deliveryCount = upstream.telegram.length;
  const amulRequests = upstream.amul.length;
  now += CHECK_INTERVAL_MS;
  await tick(now);
  expect(upstream.telegram).toHaveLength(deliveryCount);
  expect(upstream.amul).toHaveLength(amulRequests);
  expect((await store.config()).paused).toBe(1);

  await send("/status");
  await tap(buttons(upstream.telegram.at(-1)!).find((button) => button.text === "Resume")!);
  now += CHECK_INTERVAL_MS;
  await expectReminder();
  await send("/products");
  await tap(buttons(upstream.telegram.at(-1)!).find((button) => button.text.includes("test protein 1"))!);
  const afterDeselect = upstream.telegram.length;
  now += CHECK_INTERVAL_MS;
  await tick(now);
  expect(upstream.telegram.slice(afterDeselect)).toHaveLength(1);
  expect(upstream.telegram.at(-1)?.payload.text).toContain("Available (1)");
  expect(upstream.telegram.at(-1)?.payload.text).not.toContain("Amul test protein 1");
  expect((await store.products()).filter((product) => product.epoch).map((product) => product.alias))
    .toEqual(["amul-test-protein-0"]);
});
