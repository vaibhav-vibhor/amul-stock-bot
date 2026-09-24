import { Amul, productUrl } from "./amul";
import type { Store } from "./db";
import { errorCode, logFailure, SafeError } from "./errors";
import type { Network } from "./http";
import type { Catalog, Config, Message, Product, StoredProduct } from "./types";

export interface CheckPlan {
  statements: D1PreparedStatement[];
  messages: Message[];
  snapshot: Product[];
  selectedCount: number;
  unknownCount: number;
  checkedAt: number | null;
  error: string | null;
}

export function assertUpstreamReady(config: Config): void {
  if (config.upstream_retry_at > Date.now()) {
    throw new SafeError(
      "amul_retry_after_active",
      Math.ceil((config.upstream_retry_at - Date.now()) / 1_000),
    );
  }
}

export function upstreamFailure(store: Store, error: SafeError): D1PreparedStatement[] {
  logFailure("amul_check", error);
  return [
    store.sql(
      `UPDATE config SET last_attempt_at = ?, last_error = ?,
       upstream_retry_at = MAX(upstream_retry_at, ?) WHERE id = 1`,
      Date.now(),
      errorCode(error),
      error.retryAfterSeconds ? Date.now() + error.retryAfterSeconds * 1_000 : 0,
    ),
  ];
}

const snapshotDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Kolkata",
  day: "2-digit", month: "short", year: "numeric",
  hour: "2-digit", minute: "2-digit", hour12: true,
});

export function html(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function checkedTime(checkedAt: number): string {
  const parts = snapshotDate.formatToParts(checkedAt);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((entry) => entry.type === type)!.value;
  return `${part("day")} ${part("month")} ${part("year")}, ${part("hour")}:${part("minute")} ${part("dayPeriod").toUpperCase()} IST`;
}

export function snapshotMessages(
  pincode: string,
  checkedAt: number,
  products: Pick<Product, "name" | "available">[],
  paused: boolean,
): Message[] {
  const available = products.filter((product) => product.available === 1);
  const unavailable = products.filter((product) => product.available === 0);
  const unknown = products.filter((product) => product.available === null);
  const checked = checkedTime(checkedAt);
  const title = `Stock snapshot \u2014 PIN ${pincode}`;
  const details = `\nChecked: ${checked}${paused ? "\nPaused: this snapshot does not change alert baselines." : ""}${unknown.length ? "\nPartial check: some products are UNKNOWN." : ""}`;
  const none = available.length ? "" : unknown.length
    ? "No selected products are confirmed available."
    : "No selected products are available.";
  const header = `<b>${html(title)}</b>${html(details)}${none ? `\n\n<b>${none}</b>` : ""}`;
  const headerLength = title.length + details.length + (none ? none.length + 2 : 0);
  const footer = "\n\nNot reserved or guaranteed at checkout.";
  const groups = [
    { label: "\u2705 Available", products: available, note: "" },
    { label: "\u274c Out of stock", products: unavailable, note: "" },
    {
      label: "\u26a0\ufe0f Unconfirmed",
      products: unknown,
      note: "\nUNKNOWN: missing or unrecognized availability; previous baselines preserved.",
    },
  ];
  const messages: Message[] = [];
  let text = header;
  let length = headerLength;
  let itemsInMessage = 0;
  for (const group of groups) {
    const prefix = (continued: boolean) => {
      const label = `${group.label} (${group.products.length})${continued ? " (continued)" : ""}`;
      return {
        text: `\n\n<b>${label}</b>${group.note}\n`,
        length: label.length + group.note.length + 3,
      };
    };
    for (const [index, product] of group.products.entries()) {
      const bullet = `\u2022 ${product.name}`;
      let before = index === 0 ? prefix(false) : { text: "\n", length: 1 };
      // Telegram limits text after entity parsing. Count the original UTF-16
      // text, not expanded HTML entities, and never cut a name or entity.
      if (length + before.length + bullet.length + footer.length > 4_096) {
        if (!itemsInMessage) throw new SafeError("snapshot_product_name_too_long");
        messages.push({ text, parse_mode: "HTML" });
        text = `${header}\n(continued)`;
        length = headerLength + "\n(continued)".length;
        itemsInMessage = 0;
        before = prefix(index > 0);
      }
      if (length + before.length + bullet.length + footer.length > 4_096) {
        throw new SafeError("snapshot_product_name_too_long");
      }
      text += before.text + html(bullet);
      length += before.length + bullet.length;
      itemsInMessage++;
    }
  }
  messages.push({ text: text + footer, parse_mode: "HTML" });
  return messages;
}

export async function planCheck(
  store: Store,
  config: Config,
  network: Network,
  includeSnapshot = true,
  knownProducts?: StoredProduct[],
): Promise<CheckPlan> {
  const tracked = (knownProducts ?? await store.products()).filter((product) => product.epoch !== null);
  const invalidatePriorReminder = includeSnapshot ? [
    store.sql("UPDATE outbox SET state = 'cancelled', last_error = 'manual_recheck' WHERE kind = 'alert' AND state = 'pending'"),
  ] : [];
  if (!tracked.length) {
    return {
      statements: invalidatePriorReminder, messages: [{ text: "No products tracked. Use /products to choose some. Nothing is being monitored." }],
      snapshot: [], selectedCount: 0, unknownCount: 0, checkedAt: null, error: null,
    };
  }
  let catalog: Catalog;
  try {
    assertUpstreamReady(config);
    catalog = await new Amul(network).catalog(
      config.pincode, includeSnapshot ? undefined : tracked.map((product) => product.alias),
    );
  } catch (error) {
    if (!(error instanceof SafeError)) throw error;
    return {
      statements: [...invalidatePriorReminder, ...upstreamFailure(store, error)],
      messages: [{
        text: `Check failed for PIN ${config.pincode}: ${error.code}.\nNo stock status was inferred; previous valid baselines are preserved. Try again later or inspect /status.`,
      }],
      snapshot: [], selectedCount: tracked.length, unknownCount: tracked.length, checkedAt: null, error: error.code,
    };
  }
  const products = new Map(catalog.products.map((product) => [product.alias, product]));
  // The selection UI owns the catalog cache. Periodic checks only persist
  // watched observations, avoiding a full catalog rewrite every five minutes.
  const statements = [...invalidatePriorReminder, ...(includeSnapshot ? store.catalogPlan(catalog) : [])];
  const snapshot: Product[] = [];
  let unknown = 0;

  for (const trackedProduct of tracked) {
    const product = products.get(trackedProduct.alias);
    const available = product?.available ?? null;
    snapshot.push({ name: product?.name ?? trackedProduct.name, alias: trackedProduct.alias, available });
    if (available === null) {
      unknown++;
      continue;
    }
    if (config.paused) continue;
    statements.push(
      store.sql(
        `INSERT INTO observations
         (product_id, pincode, watch_epoch, available, checked_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(product_id, pincode, watch_epoch) DO UPDATE SET
           available = excluded.available, checked_at = excluded.checked_at`,
        trackedProduct.id,
        config.pincode,
        trackedProduct.epoch,
        available,
        catalog.checkedAt,
      ),
    );
  }
  statements.push(
    store.sql(
      `UPDATE config SET last_attempt_at = ?, last_error = ?, upstream_retry_at = 0,
       last_success_at = CASE WHEN ? = 0 THEN ? ELSE last_success_at END WHERE id = 1`,
      catalog.checkedAt,
      unknown ? `amul_unknown_availability:${unknown}` : null,
      unknown,
      catalog.checkedAt,
    ),
  );
  if (unknown) logFailure("amul_check", new SafeError(`amul_unknown_availability:${unknown}`));
  return {
    statements,
    messages: includeSnapshot ? snapshotMessages(config.pincode, catalog.checkedAt, snapshot, Boolean(config.paused)) : [],
    snapshot, selectedCount: tracked.length, unknownCount: unknown, checkedAt: catalog.checkedAt, error: null,
  };
}

export function availabilityReminder(pincode: string, checkedAt: number, products: Product[], unknownCount: number): Message {
  const available = products.filter((product) => product.available === 1);
  if (!available.length) throw new SafeError("reminder_without_confirmed_availability");
  const title = `\u2705 Available (${available.length}) \u2014 PIN ${pincode}`;
  const details = `\nChecked: ${checkedTime(checkedAt)}${unknownCount ? `\nPartial check: ${unknownCount} selected product(s) unconfirmed; only confirmed stock is listed.` : ""}`;
  const caveat = "\n\nAvailability snapshot, not a reservation or guaranteed at checkout.";
  let text = `<b>${html(title)}</b>${html(details)}\n\n`;
  let length = title.length + details.length + 2;
  let shown = 0;
  for (const product of available) {
    // The rare oversized report remains ONE reminder, with explicit omission
    // count and /checknow for full details rather than a burst of messages.
    const reserve = caveat.length + "\n\n200 more available products. Use /checknow for the full report.".length;
    if (length + product.name.length + 3 + reserve > 4_096) break;
    text += `${shown ? "\n" : ""}\u2022 <a href="${productUrl(product.alias)}">${html(product.name)}</a>`;
    length += product.name.length + 2 + (shown ? 1 : 0);
    shown++;
  }
  if (!shown) throw new SafeError("reminder_product_name_too_long");
  if (shown < available.length) {
    text += `\n\n${available.length - shown} more available products. Use /checknow for the full report.`;
  }
  return { text: text + caveat, parse_mode: "HTML" };
}
