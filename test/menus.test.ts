import { describe, expect, it } from "vitest";
import { productMenus } from "../src/menus";
import type { Button, Config, Message, StoredProduct } from "../src/types";
import { proteinNames } from "./catalog";

const config: Config = {
  id: 1, pincode: "500032", revision: 1, paused: 0,
  last_attempt_at: null, last_success_at: null, last_error: null,
  catalog_at: 1, upstream_retry_at: 0, telegram_retry_at: 0,
};

function products(names = proteinNames): StoredProduct[] {
  return names.map((name, index) => ({
    id: index + 1, alias: `amul-test-protein-${index}`, name,
    active: 1, catalog_available: 0, last_seen_at: 1, epoch: null,
  }));
}

function toggles(messages: Message[]): Button[] {
  return messages.flatMap((message) => message.reply_markup!.inline_keyboard)
    .filter((row) => row[0]?.callback_data?.startsWith("pick:"))
    .map((row) => {
      expect(row).toHaveLength(1);
      return row[0]!;
    });
}

function assertBounds(messages: Message[]): void {
  for (const message of messages) {
    expect(message.text.length).toBeGreaterThan(0);
    expect(message.text.length).toBeLessThanOrEqual(4_096);
    expect(new TextDecoder().decode(new TextEncoder().encode(message.text))).toBe(message.text);
    const escapedResponse = JSON.stringify({ ok: true, result: { message_id: 1, ...message } })
      .replace(/[^\x00-\x7f]/g, "\\u0000");
    expect(escapedResponse.length).toBeLessThan(64_000);
    const buttons = message.reply_markup!.inline_keyboard.flat();
    expect(buttons.length).toBeLessThanOrEqual(100);
    for (const button of buttons) {
      expect(button.url).toBeUndefined();
      expect(button.text).not.toMatch(/^(Next|Previous|Open product)$/);
      expect(new TextEncoder().encode(button.callback_data!).length).toBeLessThanOrEqual(64);
    }
  }
}

describe("complete product selection menus", () => {
  it("renders the actual 23-name catalog only once as clickable buttons under a compact header", () => {
    const catalog = products();
    catalog[2]!.epoch = "watch-chocolate";
    catalog[21]!.epoch = "watch-milk";
    const messages = productMenus(config, catalog);
    expect(messages).toHaveLength(1);
    assertBounds(messages);
    const text = messages[0]!.text;
    expect(text).toBe("Protein products for PIN 500032\nSelected: 2/23\nTap a product to select or deselect.");
    const buttons = toggles(messages);
    expect(buttons).toHaveLength(23);
    catalog.forEach((product, index) => {
      expect(text).not.toContain(product.name);
      expect(buttons[index]!.text).toBe(`${product.epoch ? "\u2705" : "\u2610"} ${product.name.slice("Amul ".length)}`);
      expect(buttons.filter((button) => button.text === buttons[index]!.text)).toHaveLength(1);
      expect(buttons[index]!.style).toBe(product.epoch ? "success" : undefined);
    });
    expect(messages[0]!.reply_markup!.inline_keyboard.at(-1)?.map((button) => button.text))
      .toEqual(["Pause", "Status", "Refresh all"]);
  });

  it("preserves full Unicode and literal formatting characters without HTML/Markdown escaping", () => {
    const name = 'Protein <Milk> & "Kesar" / \u{1F95B} \u0932\u0938\u094d\u0938\u0940 _500g_ *pack*';
    const messages = productMenus(config, products([name]));
    assertBounds(messages);
    expect(messages[0]!.text).not.toContain(name);
    expect(toggles(messages)[0]!.text).toBe(`\u2610 ${name}`);
    expect(messages[0]).not.toHaveProperty("parse_mode");
  });

  it.each([
    ["Amul Chocolate Whey Protein Gift Pack, 34 g | Pack of 10 sachets", "Chocolate Whey Protein Gift Pack, 34 g | Pack of 10 sachets"],
    ["amul Kool Milkshake | Kesar, 180 mL | Pack of 30", "Kool Milkshake | Kesar, 180 mL | Pack of 30"],
    [" \tAMUL \t High Protein Milk, 250 mL | Pack of 8", "High Protein Milk, 250 mL | Pack of 8"],
    ["Amul\u00a0\u00a0Protein \u0932\u0938\u094d\u0938\u0940", "Protein \u0932\u0938\u094d\u0938\u0940"],
    ["Amulya Milk Powder, 1 kg", "Amulya Milk Powder, 1 kg"],
    ["Gift pack by Amul, 34 g", "Gift pack by Amul, 34 g"],
    ["Amul-Protein Pack", "Amul-Protein Pack"],
    ["Amul", "Amul"],
    ["Whey Protein, 34 g | Pack of 30", "Whey Protein, 34 g | Pack of 30"],
  ])("removes only the leading standalone brand from %s for display", (canonicalName, displayedName) => {
    const catalog = products([canonicalName]);
    const before = structuredClone(catalog);
    const button = toggles(productMenus(config, catalog))[0]!;
    expect(button.text).toBe(`\u2610 ${displayedName}`);
    expect(button.callback_data).toBe("pick:1:1:1:1:1");
    expect(catalog).toEqual(before);
  });

  it("keeps long names in one keyboard even when a duplicated text list would have overflowed", () => {
    const catalog = products(Array.from({ length: 23 }, (_, index) =>
      `Product ${index} ` + "X".repeat(280),
    ));
    expect(catalog.map((product) => product.name).join("\n").length).toBeGreaterThan(4_096);
    const messages = productMenus(config, catalog);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text.length).toBeLessThan(150);
    expect(toggles(messages).map((button) => button.text)).toEqual(catalog.map((product) => `\u2610 ${product.name}`));
    assertBounds(messages);
  });

  it("splits only oversized keyboards and preserves every product once in order with stable IDs", () => {
    const catalog = products(Array.from({ length: 200 }, (_, index) =>
      `${index} ` + "Long & <full> \u{1F95B} product ".repeat(11),
    ));
    catalog[40]!.epoch = "selected";
    const messages = productMenus(config, catalog);
    expect(messages.length).toBeGreaterThan(1);
    assertBounds(messages);
    const buttons = toggles(messages);
    expect(buttons).toHaveLength(200);
    expect(buttons.map((button) => Number(button.callback_data!.split(":")[2])))
      .toEqual(catalog.map((product) => product.id));
    const text = messages.map((message) => message.text).join("\n");
    for (const [index, product] of catalog.entries()) {
      expect(text).not.toContain(product.name);
      expect(buttons[index]!.text).toBe(`${product.epoch ? "\u2705" : "\u2610"} ${product.name}`);
    }
    expect(messages.every((message) => message.text.includes("Selected in this message:"))).toBe(true);
    expect(messages.every((message) => message.text.includes("/status shows the overall count."))).toBe(true);
    expect(messages.every((message) => !message.text.includes("\nSelected:"))).toBe(true);
  });

  it("splits at the button budget, reserving three controls per keyboard", () => {
    const catalog = products(Array.from({ length: 100 }, (_, index) => `P${index}`));
    const messages = productMenus(config, catalog);
    expect(messages).toHaveLength(2);
    assertBounds(messages);
    expect(toggles([messages[0]!])).toHaveLength(97);
    expect(toggles(messages)).toHaveLength(100);
  });

  it("bounds echoed keyboard bytes for maximum-length Unicode names without shortening any name", () => {
    const catalog = products(Array.from({ length: 97 }, (_, index) => `${index} ` + "\u4e73".repeat(290)));
    const messages = productMenus(config, catalog);
    expect(messages.length).toBeGreaterThan(1);
    expect(toggles(messages).map((button) => button.text)).toEqual(catalog.map((product) => `\u2610 ${product.name}`));
    assertBounds(messages);
  });

  it("keeps range callbacks and boundaries stable when selection counts grow", () => {
    const catalog = products(Array.from({ length: 100 }, (_, index) => `${index} ` + "X".repeat(280)));
    const initial = productMenus(config, catalog);
    catalog.forEach((product) => { product.epoch = `watch-${product.id}`; });
    const selected = productMenus({ ...config, revision: 36 }, catalog);
    expect(selected.map((message) => toggles([message]).map((button) => button.callback_data!.split(":").slice(4))))
      .toEqual(initial.map((message) => toggles([message]).map((button) => button.callback_data!.split(":").slice(4))));
    assertBounds(selected);
    const data = toggles([selected[1]!])[0]!.callback_data!.split(":");
    const updatedChunk = productMenus(config, catalog, { first: Number(data[4]), last: Number(data[5]) });
    expect(toggles(updatedChunk).map((button) => button.text)).toEqual(toggles([selected[1]!]).map((button) => button.text));
    expect(updatedChunk[0]!.text).toContain("Selected in this message:");
  });

  it("keeps nonsequential persistent IDs internal without numbering the visible labels", () => {
    const catalog = products(proteinNames.slice(0, 3));
    catalog[0]!.id = 4;
    catalog[1]!.id = 19;
    catalog[2]!.id = 42;
    const buttons = toggles(productMenus(config, catalog));
    expect(buttons.map((button) => button.text)).toEqual(catalog.map((product) => `\u2610 ${product.name.slice("Amul ".length)}`));
    expect(buttons.map((button) => Number(button.callback_data!.split(":")[2]))).toEqual([4, 19, 42]);
  });

  it("keeps missing tracked products removable and handles an empty chunk without hiding controls", () => {
    const catalog = products(proteinNames.slice(0, 1));
    catalog[0]!.active = 0;
    catalog[0]!.epoch = "watch";
    const menu = productMenus(config, catalog)[0]!;
    expect(menu.text).not.toContain(catalog[0]!.name);
    expect(toggles([menu])[0]).toMatchObject({
      text: `\u2705 ${catalog[0]!.name.slice("Amul ".length)} [UNKNOWN]`,
      style: "success",
      callback_data: "pick:1:1:0:1:1",
    });
    const empty = productMenus({ ...config, paused: 1 }, [], { first: 1, last: 1 });
    expect(empty[0]!.text).toContain("No products remain");
    expect(empty[0]!.reply_markup!.inline_keyboard[0]![0]!.text).toBe("Resume");
    assertBounds(empty);
  });
});
