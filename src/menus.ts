import { SafeError } from "./errors";
import type { Button, Config, Message, StoredProduct } from "./types";

const TEXT_LIMIT = 4_096;
const PRODUCT_ROWS = 97;
const FOOTER = "\n\nTap to select/unselect. New selections start with a silent baseline.\nMatch the numbers above if your app clips a long button label.";

export interface ProductRange {
  first: number;
  last: number;
}

function line(product: StoredProduct): string {
  return `${product.epoch ? "\u2705" : "\u2610"} ${product.id}. ${product.name}${product.active ? "" : "\nNot in the latest catalog: UNKNOWN. You can still unselect it."}`;
}

function heading(
  config: Config,
  first: number,
  last: number,
  count: number,
  size: number,
  partial: boolean,
): string {
  return `Protein products for PIN ${config.pincode}\n${config.paused ? "PAUSED" : "Choose products to track"}\n${partial ? "Selected in this message" : "Selected"}: ${count}/${size}\n\u2705 Selected | \u2610 Not selected${partial ? `\nProduct IDs ${first}-${last}. /status shows the current overall count.\nAll products are sent in consecutive messages; no paging.` : ""}\nCatalog: ${config.catalog_at === null ? "not loaded" : new Date(config.catalog_at).toISOString()}\n\n`;
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
  const partial = visible.length !== products.length;
  const lines = visible.map(line);
  const groups: StoredProduct[][] = [];
  // Size against the largest possible selected count. Selection markers have
  // equal UTF-16 length, so a toggle cannot shift an existing chunk boundary.
  const fullLength = heading(config, first, last, visible.length, visible.length, partial).length +
    lines.join("\n\n").length + FOOTER.length;
  if (visible.length <= PRODUCT_ROWS && fullLength <= TEXT_LIMIT) {
    groups.push(visible);
  } else {
    let group: StoredProduct[] = [];
    let bodyLength = 0;
    for (const product of visible) {
      const length = line(product).length;
      const nextBodyLength = bodyLength + (group.length ? 2 : 0) + length;
      const prefix = heading(config, group[0]?.id ?? product.id, product.id, group.length + 1, group.length + 1, true);
      if (group.length && (group.length === PRODUCT_ROWS || prefix.length + nextBodyLength + FOOTER.length > TEXT_LIMIT)) {
        groups.push(group);
        group = [];
        bodyLength = 0;
      }
      if (heading(config, product.id, product.id, 1, 1, true).length + length + FOOTER.length > TEXT_LIMIT) {
        throw new SafeError("product_menu_entry_too_long");
      }
      bodyLength += (group.length ? 2 : 0) + length;
      group.push(product);
    }
    if (group.length) groups.push(group);
  }

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
        text: `${selected ? "\u2705" : "\u2610"} ${product.id}. ${product.name}`,
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
    const text = heading(config, firstId, lastId, count, entries.length, entries.length !== products.length) +
      (entries.map(line).join("\n\n") || (range
        ? "No products remain in this message. Refresh all to see the catalog."
        : "No catalog yet. Use /products to load it.")) +
      FOOTER;
    if (text.length > TEXT_LIMIT) throw new SafeError("product_menu_message_too_long");
    return { text, reply_markup: { inline_keyboard: keyboard } };
  });
}
