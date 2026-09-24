import { SafeError } from "./errors";
import type { Button, Config, Message, StoredProduct } from "./types";

const TEXT_LIMIT = 4_096;
const PRODUCT_ROWS = 97;
const KEYBOARD_BYTES = 48_000;

export interface ProductRange {
  first: number;
  last: number;
}

function label(product: StoredProduct): string {
  const name = product.name.replace(/^\s*amul\s+(?=\S)/i, "");
  return `${product.epoch ? "\u2705" : "\u2610"} ${name}${product.active ? "" : " [UNKNOWN]"}`;
}

function rowBytes(product: StoredProduct): number {
  // Telegram echoes keyboards in API responses and callbacks. Reserve the
  // longest callback/style and escaped Unicode to stay below our 64 KB reader,
  // with space for controls/metadata and stable chunks when selection changes.
  return JSON.stringify({
    text: label(product),
    callback_data: "x".repeat(64),
    style: "success",
  }).replace(/[^\x00-\x7f]/g, "\\u0000").length + 3;
}

export function productMenus(
  config: Config,
  products: StoredProduct[],
  range?: ProductRange,
): Message[] {
  const visible = range
    ? products.filter((product) => product.id >= range.first && product.id <= range.last)
    : products;
  const first = visible[0]?.id ?? range?.first ?? 0;
  const last = visible.at(-1)?.id ?? range?.last ?? 0;
  const groups: StoredProduct[][] = [];
  let group: StoredProduct[] = [];
  let keyboardBytes = 0;
  for (const product of visible) {
    const bytes = rowBytes(product);
    if (bytes > KEYBOARD_BYTES) throw new SafeError("product_menu_entry_too_long");
    if (group.length && (group.length === PRODUCT_ROWS || keyboardBytes + bytes > KEYBOARD_BYTES)) {
      groups.push(group);
      group = [];
      keyboardBytes = 0;
    }
    group.push(product);
    keyboardBytes += bytes;
  }
  if (group.length || !groups.length) groups.push(group);

  return groups.map((entries) => {
    const firstId = entries[0]?.id ?? first;
    const lastId = entries.at(-1)?.id ?? last;
    const keyboard: Button[][] = entries.map((product) => {
      const selected = product.epoch !== null;
      const data = `pick:${config.revision}:${product.id}:${selected ? 0 : 1}:${firstId}:${lastId}`;
      if (new TextEncoder().encode(data).length > 64) {
        throw new SafeError("product_menu_callback_too_long");
      }
      const button: Button = {
        text: label(product),
        callback_data: data,
      };
      if (selected) button.style = "success";
      return [button];
    });
    keyboard.push([
      { text: config.paused ? "Resume" : "Pause", callback_data: `${config.paused ? "resume" : "pause"}:${config.revision}` },
      { text: "Status", callback_data: "status" },
      { text: "Refresh all", callback_data: "products" },
    ]);
    const count = entries.filter((product) => product.epoch !== null).length;
    const partial = entries.length !== products.length;
    const text = `Protein products for PIN ${config.pincode}${config.paused ? "\nPAUSED" : ""}\n${partial ? "Selected in this message" : "Selected"}: ${count}/${entries.length}${partial ? "\nMore products are in consecutive menus. /status shows the overall count." : ""}\nTap a product to select or deselect.${entries.length ? "" : range
      ? "\nNo products remain in this menu. Refresh all to see the catalog."
      : "\nNo catalog yet. Use /products to load it."}`;
    if (text.length > TEXT_LIMIT) throw new SafeError("product_menu_message_too_long");
    return { text, reply_markup: { inline_keyboard: keyboard } };
  });
}
