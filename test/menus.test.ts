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
  it("renders the actual 23-name catalog exactly once in one menu without links or paging", () => {
    const catalog = products();
    catalog[2]!.epoch = "watch-chocolate";
    catalog[21]!.epoch = "watch-milk";
    const messages = productMenus(config, catalog);
    expect(messages).toHaveLength(1);
    assertBounds(messages);
    const text = messages[0]!.text;
    expect(text).toContain("Selected: 2/23");
    expect(text).toContain("\u2705 Selected | \u2610 Not selected");
    const buttons = toggles(messages);
    expect(buttons).toHaveLength(23);
    catalog.forEach((product, index) => {
      expect(text.split("\n").filter((entry) =>
        entry === `${product.epoch ? "\u2705" : "\u2610"} ${product.id}. ${product.name}`,
      )).toHaveLength(1);
      expect(text).toContain(`${product.id}. ${product.name}`);
      expect(buttons[index]!.text).toBe(`${product.epoch ? "\u2705" : "\u2610"} ${product.id}. ${product.name}`);
      expect(buttons[index]!.style).toBe(product.epoch ? "success" : undefined);
    });
    expect(messages[0]!.reply_markup!.inline_keyboard.at(-1)?.map((button) => button.text))
      .toEqual(["Pause", "Status", "Refresh all"]);
  });

  it("preserves full Unicode and literal formatting characters without HTML/Markdown escaping", () => {
    const name = 'Protein <Milk> & "Kesar" / \u{1F95B} \u0932\u0938\u094d\u0938\u0940 _500g_ *pack*';
    const messages = productMenus(config, products([name]));
    assertBounds(messages);
    expect(messages[0]!.text).toContain(name);
    expect(toggles(messages)[0]!.text).toBe(`\u2610 1. ${name}`);
    expect(messages[0]).not.toHaveProperty("parse_mode");
  });

  it("splits only overflowing full text into consecutive chunks and preserves order and stable IDs", () => {
    const catalog = products(Array.from({ length: 200 }, (_, index) =>
      `${index} ` + "Long & <full> \u{1F95B} product ".repeat(11),
    ));
    catalog[40]!.epoch = "selected";
    const messages = productMenus(config, catalog);
    expect(messages.length).toBeGreaterThan(6);
    assertBounds(messages);
    const buttons = toggles(messages);
    expect(buttons).toHaveLength(200);
    expect(buttons.map((button) => Number(button.callback_data!.split(":")[2])))
      .toEqual(catalog.map((product) => product.id));
    const text = messages.map((message) => message.text).join("\n");
    for (const product of catalog) {
      expect(text.split("\n").filter((entry) =>
        entry === `${product.epoch ? "\u2705" : "\u2610"} ${product.id}. ${product.name}`,
      )).toHaveLength(1);
    }
    expect(messages.every((message) => message.text.includes("Selected in this message:"))).toBe(true);
    expect(messages.every((message) => message.text.includes("/status shows the current overall count."))).toBe(true);
    expect(messages.every((message) => !message.text.includes("\nSelected:"))).toBe(true);
  });

  it("splits at the button budget even when tiny names fit in the text limit", () => {
    const catalog = products(Array.from({ length: 100 }, (_, index) => `P${index}`));
    const messages = productMenus(config, catalog);
    expect(messages).toHaveLength(2);
    assertBounds(messages);
    expect(toggles([messages[0]!])).toHaveLength(97);
    expect(toggles(messages)).toHaveLength(100);
  });

  it("keeps range callbacks and boundaries stable when selection counts grow", () => {
    const catalog = products(Array.from({ length: 35 }, (_, index) => `${index} ` + "X".repeat(280)));
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

  it("uses nonsequential persistent IDs without renumbering or changing the input order", () => {
    const catalog = products(proteinNames.slice(0, 3));
    catalog[0]!.id = 4;
    catalog[1]!.id = 19;
    catalog[2]!.id = 42;
    expect(toggles(productMenus(config, catalog)).map((button) => button.text))
      .toEqual(catalog.map((product) => `\u2610 ${product.id}. ${product.name}`));
  });

  it("keeps missing tracked products removable and handles an empty chunk without hiding controls", () => {
    const catalog = products(proteinNames.slice(0, 1));
    catalog[0]!.active = 0;
    catalog[0]!.epoch = "watch";
    const menu = productMenus(config, catalog)[0]!;
    expect(menu.text).toContain("UNKNOWN");
    expect(toggles([menu])[0]).toMatchObject({ style: "success", callback_data: "pick:1:1:0:1:1" });
    const empty = productMenus({ ...config, paused: 1 }, [], { first: 1, last: 1 });
    expect(empty[0]!.text).toContain("No products remain");
    expect(empty[0]!.reply_markup!.inline_keyboard[0]![0]!.text).toBe("Resume");
    assertBounds(empty);
  });
});
