import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../src/db";
import { snapshotMessages } from "../src/stock";
import type { Message, Product } from "../src/types";
import { callback, command, fixtureProduct, seedTracked, Upstream, webhook } from "./helpers";

const checkedAt = Date.parse("2026-09-24T05:50:53.310Z");
const disclaimer = "Not reserved or guaranteed at checkout.";
const sample: Pick<Product, "name" | "available">[] = [
  { name: "Amul Chocolate Whey Protein Gift Pack, 34 g | Pack of 10 sachets", available: 1 },
  { name: "Amul Chocolate Whey Protein, 34 g | Pack of 30 sachets", available: 0 },
  { name: "Amul Chocolate Whey Protein, 34 g | Pack of 60 sachets", available: 0 },
];

function rendered(text: string): string {
  return text.replace(/<\/?b>/g, "").replace(/&amp;|&lt;|&gt;/g, (entity) =>
    entity === "&amp;" ? "&" : entity === "&lt;" ? "<" : ">",
  );
}

function names(messages: Message[]): string[] {
  return messages.flatMap((message) => rendered(message.text).split("\n"))
    .filter((line) => line.startsWith("\u2022 ")).map((line) => line.slice(2));
}

function assertMessages(messages: Message[]): void {
  for (const message of messages) {
    expect(message.parse_mode).toBe("HTML");
    expect(message.reply_markup).toBeUndefined();
    expect(rendered(message.text).length).toBeLessThanOrEqual(4_096);
    expect(new TextDecoder().decode(new TextEncoder().encode(message.text))).toBe(message.text);
    expect(message.text.match(/<b>/g)?.length).toBe(message.text.match(/<\/b>/g)?.length);
    expect(message.text.replace(/<\/?b>/g, "")).not.toMatch(/[<>]/);
    expect(message.text.replace(/&amp;|&lt;|&gt;/g, "")).not.toContain("&");
    expect(message.text).not.toContain("<a ");
  }
  expect(messages.map((message) => message.text).join("\n").split(disclaimer)).toHaveLength(2);
  expect(messages.at(-1)?.text.endsWith(disclaimer)).toBe(true);
}

describe("readable stock snapshots", () => {
  it("renders the exact three-product report with bold 1/2 groups and the actual IST time", () => {
    const messages = snapshotMessages("500032", checkedAt, sample, false);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe(
      "<b>Stock snapshot \u2014 PIN 500032</b>\n" +
      "Checked: 24 Sep 2026, 11:20 AM IST\n\n" +
      "<b>\u2705 Available (1)</b>\n" +
      "\u2022 Amul Chocolate Whey Protein Gift Pack, 34 g | Pack of 10 sachets\n\n" +
      "<b>\u274c Out of stock (2)</b>\n" +
      "\u2022 Amul Chocolate Whey Protein, 34 g | Pack of 30 sachets\n" +
      "\u2022 Amul Chocolate Whey Protein, 34 g | Pack of 60 sachets\n\n" +
      disclaimer,
    );
    expect(names(messages)).toEqual(sample.map((product) => product.name));
    assertMessages(messages);
  });

  it("puts available products first while preserving product order within each group", () => {
    const input = [sample[2]!, sample[0]!, { name: "Other available pack", available: 1 as const }, sample[1]!];
    const messages = snapshotMessages("500032", checkedAt, input, false);
    expect(names(messages)).toEqual([sample[0]!.name, "Other available pack", sample[2]!.name, sample[1]!.name]);
    expect(messages[0]?.text).toContain("<b>\u2705 Available (2)</b>");
    expect(messages[0]?.text).toContain("<b>\u274c Out of stock (2)</b>");
    expect(input[0]).toBe(sample[2]);
    assertMessages(messages);
  });

  it("omits empty out-of-stock and unknown groups when every selected product is available", () => {
    const messages = snapshotMessages("500032", checkedAt, sample.map((product) => ({ ...product, available: 1 })), false);
    expect(messages[0]?.text).toContain("<b>\u2705 Available (3)</b>");
    expect(messages[0]?.text).not.toContain("Out of stock");
    expect(messages[0]?.text).not.toContain("Unconfirmed");
    expect(messages[0]?.text).not.toContain("No selected");
    assertMessages(messages);
  });

  it("states none available instead of creating an empty available group", () => {
    const messages = snapshotMessages("500032", checkedAt, sample.map((product) => ({ ...product, available: 0 })), false);
    expect(messages[0]?.text).toContain("<b>No selected products are available.</b>");
    expect(messages[0]?.text).toContain("<b>\u274c Out of stock (3)</b>");
    expect(messages[0]?.text).not.toContain("\u2705 Available");
    expect(messages[0]?.text).not.toContain("Unconfirmed");
    assertMessages(messages);
  });

  it("separates unknowns without counting or presenting them as stock-outs", () => {
    const messages = snapshotMessages("500032", checkedAt, [
      { ...sample[2]!, available: null }, sample[1]!, sample[0]!,
    ], false);
    const text = messages[0]!.text;
    expect(text).toContain("<b>\u2705 Available (1)</b>");
    expect(text).toContain("<b>\u274c Out of stock (1)</b>");
    expect(text).toContain("<b>\u26a0\ufe0f Unconfirmed (1)</b>");
    expect(text).toContain("Partial check: some products are UNKNOWN.");
    expect(text).toContain("previous baselines preserved");
    expect(names(messages)).toEqual(sample.map((product) => product.name));
    expect(text.indexOf("Available (1)")).toBeLessThan(text.indexOf("Out of stock (1)"));
    expect(text.indexOf("Out of stock (1)")).toBeLessThan(text.indexOf("Unconfirmed (1)"));
    assertMessages(messages);
  });

  it.each([true, false])("says nothing is confirmed available when unknowns remain (all unknown: %s)", (allUnknown) => {
    const messages = snapshotMessages("500032", checkedAt, [
      { ...sample[0]!, available: null },
      { ...sample[1]!, available: allUnknown ? null : 0 },
    ], false);
    const text = messages[0]!.text;
    expect(text).toContain("No selected products are confirmed available.");
    expect(text).not.toContain("No selected products are available.");
    expect(text).not.toContain("\u2705 Available");
    expect(text).toContain(`Unconfirmed (${allUnknown ? 2 : 1})`);
    expect(text.includes("Out of stock (1)")).toBe(!allUnknown);
    assertMessages(messages);
  });

  it.each([
    ["2026-09-24T18:40:00Z", "25 Sep 2026, 12:10 AM IST"],
    ["2026-09-24T06:30:00Z", "24 Sep 2026, 12:00 PM IST"],
    ["2026-12-31T20:15:00Z", "01 Jan 2027, 01:45 AM IST"],
  ])("handles IST day/year and AM/PM transitions for %s", (utc, expected) => {
    const timestamp = Date.parse(utc);
    const messages = snapshotMessages("500032", timestamp, sample, false);
    expect(messages[0]?.text).toContain(`Checked: ${expected}`);
    expect(new Date(timestamp).toISOString()).toBe(new Date(utc).toISOString());
  });

  it("escapes literal HTML/entity-like names and preserves Unicode pack/flavor text", () => {
    const name = 'Protein <b>milk</b> & "&lt;Kesar&gt;" / \u{1F95B} \u0932\u0938\u094d\u0938\u0940 _500g_ *pack*';
    const messages = snapshotMessages("500032", checkedAt, [{ name, available: 1 }], false);
    expect(messages[0]?.text).toContain('Protein &lt;b&gt;milk&lt;/b&gt; &amp; "&amp;lt;Kesar&amp;gt;"');
    expect(messages[0]?.text).not.toContain("<b>milk</b>");
    expect(names(messages)).toEqual([name]);
    assertMessages(messages);
  });

  it("splits large reports between complete names, preserving group totals and one final disclaimer", () => {
    const input = Array.from({ length: 200 }, (_, index) => ({
      name: `Pack ${index}: ${'<&> \u{1F95B} '.repeat(35)}`,
      available: index % 3 === 0 ? 0 as const : index % 3 === 1 ? null : 1 as const,
    }));
    const messages = snapshotMessages("500032", checkedAt, input, true);
    expect(messages.length).toBeGreaterThan(1);
    assertMessages(messages);
    expect(names(messages)).toEqual([
      ...input.filter((product) => product.available === 1),
      ...input.filter((product) => product.available === 0),
      ...input.filter((product) => product.available === null),
    ].map((product) => product.name));
    expect(messages.every((message) => message.text.includes("Paused: this snapshot does not change alert baselines."))).toBe(true);
    expect(messages.slice(1).every((message) => message.text.includes("(continued)"))).toBe(true);
    const text = messages.map((message) => message.text).join("\n");
    expect(text).toContain("Available (66) (continued)");
    expect(text).toContain("Out of stock (67) (continued)");
    expect(text).toContain("Unconfirmed (67) (continued)");
    expect(messages.some((message) => message.text.length > 4_096)).toBe(true);
    for (const message of messages) {
      const withoutIntro = rendered(message.text).split("\n\n").slice(1).join("\n\n");
      expect(withoutIntro).toMatch(/^(?:\u2705 Available|\u274c Out of stock|\u26a0\ufe0f Unconfirmed) \(\d+\)/);
    }
  });

  it("keeps a 4096-character parsed report intact and moves the next full product to a new message", () => {
    const base = rendered(snapshotMessages("500032", checkedAt, [
      { name: "", available: 1 }, { name: "", available: 1 },
    ], false)[0]!.text).length;
    const first = "A".repeat(1_900);
    const second = "B".repeat(4_096 - base - first.length);
    const fitting = snapshotMessages("500032", checkedAt, [
      { name: first, available: 1 }, { name: second, available: 1 },
    ], false);
    expect(fitting).toHaveLength(1);
    expect(rendered(fitting[0]!.text)).toHaveLength(4_096);
    assertMessages(fitting);
    const overflow = snapshotMessages("500032", checkedAt, [
      { name: first, available: 1 }, { name: second + "B", available: 1 },
    ], false);
    expect(overflow).toHaveLength(2);
    expect(names(overflow)).toEqual([first, second + "B"]);
    expect(overflow[1]?.text).toContain("<b>\u2705 Available (2) (continued)</b>");
    assertMessages(overflow);
  });
});

describe("snapshot sender and state preservation", () => {
  let store: Store;
  let upstream: Upstream;

  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    store = new Store(env.DB);
    upstream = new Upstream();
    upstream.install();
    vi.spyOn(Date, "now").mockReturnValue(checkedAt);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await reset();
  });

  async function seedSample(): Promise<void> {
    await seedTracked(undefined, 3);
    for (const [index, product] of sample.entries()) {
      await store.sql("UPDATE products SET name = ? WHERE id = ?", product.name, index + 1).run();
    }
    upstream.products = sample.map((product, index) => ({ ...fixtureProduct(index, product.available), name: product.name }));
  }

  it.each(["command", "button"])("sends the actual HTML report through the durable outbox from a %s", async (source) => {
    await seedSample();
    const before = (await store.products()).map((product) => ({ id: product.id, epoch: product.epoch }));
    const update = source === "command" ? command(1, "/checknow") : callback(1, "check");
    expect((await webhook(update)).status).toBe(200);
    const replies = upstream.telegram.filter((call) => call.method === "sendMessage");
    expect(replies).toHaveLength(1);
    expect(replies[0]?.payload).toMatchObject({
      ...snapshotMessages("500032", checkedAt, sample, false)[0],
      chat_id: env.TELEGRAM_OWNER_ID,
      parse_mode: "HTML",
    });
    expect(replies[0]?.payload.reply_markup).toBeUndefined();
    expect((await store.sql("SELECT id FROM outbox WHERE kind = 'alert'").all()).results).toEqual([]);
    const observations = await store.observations();
    expect(observations.map((observation) => observation.available)).toEqual([1, 0, 0]);
    expect(observations.every((observation) => observation.checked_at === checkedAt)).toBe(true);
    expect((await store.config()).last_success_at).toBe(checkedAt);
    expect((await store.products()).map((product) => ({ id: product.id, epoch: product.epoch }))).toEqual(before);
    const deliveries = upstream.telegram.length;
    await webhook(update);
    expect(upstream.telegram).toHaveLength(deliveries);
  });

  it("never reports previously available cached products as fresh success when now missing or unknown", async () => {
    await seedSample();
    await webhook(command(1, "/checknow"));
    const previous = await store.observations();
    // Keep one known out-of-stock product; another is malformed and the
    // previously available gift pack has disappeared from the fresh catalog.
    upstream.products = [
      { ...fixtureProduct(1, 0), name: sample[1]!.name },
      { ...fixtureProduct(2, "unknown"), name: sample[2]!.name },
    ];
    await webhook(command(2, "/checknow"));
    const text = String(upstream.telegram.at(-1)?.payload.text);
    expect(text).toContain("No selected products are confirmed available.");
    expect(text).toContain("<b>\u274c Out of stock (1)</b>");
    expect(text).toContain("<b>\u26a0\ufe0f Unconfirmed (2)</b>");
    expect(text).not.toContain("\u2705 Available");
    expect(text.indexOf(sample[0]!.name)).toBeGreaterThan(text.indexOf("Unconfirmed (2)"));
    expect((await store.observations()).find((observation) => observation.product_id === 1)).toEqual(previous[0]);
    expect((await store.config()).last_error).toBe("amul_unknown_availability:2");
  });

  it("keeps upstream failures explicit with no success groups or cached availability", async () => {
    await seedSample();
    await webhook(command(1, "/checknow"));
    const baseline = await store.observations();
    upstream.failure = { path: "/entity/ms.products", status: 403 };
    await webhook(command(2, "/checknow"));
    const reply = upstream.telegram.at(-1)!.payload;
    expect(reply.text).toContain("Check failed for PIN 500032: amul_http_403");
    expect(reply.text).toContain("previous valid baselines are preserved");
    expect(reply.text).not.toContain("Available");
    expect(reply.text).not.toContain("Out of stock");
    expect(reply.parse_mode).toBeUndefined();
    expect(await store.observations()).toEqual(baseline);
    expect((await store.config()).last_success_at).toBe(checkedAt);
  });

  it("retains the paused read-only warning without changing baselines or the pause flag", async () => {
    await seedSample();
    await webhook(command(1, "/checknow"));
    const baseline = await store.observations();
    await store.sql("UPDATE config SET paused = 1 WHERE id = 1").run();
    upstream.products = sample.map((product, index) => ({ ...fixtureProduct(index, 1), name: product.name }));
    await webhook(command(2, "/checknow"));
    const text = String(upstream.telegram.at(-1)?.payload.text);
    expect(text).toContain("Paused: this snapshot does not change alert baselines.");
    expect(text).toContain("<b>\u2705 Available (3)</b>");
    expect(await store.observations()).toEqual(baseline);
    expect((await store.config()).paused).toBe(1);
  });

  it("does not turn the no-selection response into an empty successful stock report", async () => {
    await webhook(command(1, "/checknow"));
    expect(upstream.telegram[0]?.payload.text).toContain("No products tracked.");
    expect(upstream.telegram[0]?.payload.parse_mode).toBeUndefined();
    expect(upstream.amul).toEqual([]);
    expect((await store.config()).last_success_at).toBeNull();
  });
});
