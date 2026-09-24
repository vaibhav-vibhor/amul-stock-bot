import { Amul, productUrl } from "./amul";
import type { Store } from "./db";
import { errorCode, logFailure, SafeError } from "./errors";
import type { Network } from "./http";
import type { Catalog, Config, Env, Message, Product } from "./types";

export interface CheckPlan {
  statements: D1PreparedStatement[];
  messages: Message[];
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

function html(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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
  const parts = snapshotDate.formatToParts(checkedAt);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((entry) => entry.type === type)!.value;
  const checked = `${part("day")} ${part("month")} ${part("year")}, ${part("hour")}:${part("minute")} ${part("dayPeriod").toUpperCase()} IST`;
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
  env: Env,
  network: Network,
): Promise<CheckPlan> {
  const tracked = (await store.products()).filter((product) => product.epoch !== null);
  if (!tracked.length) {
    return { statements: [], messages: [{ text: "No products tracked. Use /products to choose some. Nothing is being monitored." }] };
  }
  let catalog: Catalog;
  try {
    assertUpstreamReady(config);
    catalog = await new Amul(network).catalog(config.pincode);
  } catch (error) {
    if (!(error instanceof SafeError)) throw error;
    return {
      statements: upstreamFailure(store, error),
      messages: [{
        text: `Check failed for PIN ${config.pincode}: ${error.code}.\nNo stock status was inferred; previous valid baselines are preserved. Try again later or inspect /status.`,
      }],
    };
  }
  const products = new Map(catalog.products.map((product) => [product.alias, product]));
  const observations = new Map(
    (await store.observations())
      .filter((observation) => observation.pincode === config.pincode)
      .map((observation) => [observation.product_id, observation]),
  );
  const statements = store.catalogPlan(catalog);
  const snapshot: Pick<Product, "name" | "available">[] = [];
  let unknown = 0;

  for (const trackedProduct of tracked) {
    const product = products.get(trackedProduct.alias);
    const available = product?.available ?? null;
    snapshot.push({ name: trackedProduct.name, available });
    if (available === null) {
      unknown++;
      continue;
    }
    if (config.paused) continue;
    const previous = observations.get(trackedProduct.id);
    const baseline = previous?.watch_epoch === trackedProduct.epoch ? previous : undefined;
    const restock = baseline?.available === 0 && available === 1;
    const sequence = (baseline?.transition_seq ?? 0) + (restock ? 1 : 0);
    statements.push(
      store.sql(
        `INSERT INTO observations
         (product_id, pincode, watch_epoch, available, checked_at, transition_seq)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(product_id, pincode, watch_epoch) DO UPDATE SET
           available = excluded.available, checked_at = excluded.checked_at,
           transition_seq = excluded.transition_seq`,
        trackedProduct.id,
        config.pincode,
        trackedProduct.epoch,
        available,
        catalog.checkedAt,
        sequence,
      ),
    );
    if (available === 0) {
      statements.push(
        store.sql(
          `UPDATE outbox SET state = 'cancelled', last_error = 'stock_out_again'
           WHERE kind = 'alert' AND state = 'pending' AND product_id = ?
             AND pincode = ? AND watch_epoch = ?`,
          trackedProduct.id,
          config.pincode,
          trackedProduct.epoch,
        ),
      );
    }
    if (restock && trackedProduct.epoch !== null) {
      statements.push(
        store.enqueue(
          `stock:${config.pincode}:${trackedProduct.epoch}:${sequence}`,
          "alert",
          "sendMessage",
          {
            chat_id: env.TELEGRAM_OWNER_ID,
            text: `Restock observed\n${product?.name ?? trackedProduct.name}\nPIN: ${config.pincode}\n${productUrl(trackedProduct.alias)}\nObserved: ${new Date(catalog.checkedAt).toISOString()}\n\nStock snapshot only, not a reservation or a guarantee of availability at checkout.`,
            link_preview_options: { is_disabled: true },
          },
          { pincode: config.pincode, productId: trackedProduct.id, epoch: trackedProduct.epoch },
        ),
      );
    }
  }
  statements.push(
    store.sql(
      `UPDATE config SET last_attempt_at = ?, last_error = ?,
       last_success_at = CASE WHEN ? = 0 THEN ? ELSE last_success_at END WHERE id = 1`,
      catalog.checkedAt,
      unknown ? `amul_unknown_availability:${unknown}` : null,
      unknown,
      catalog.checkedAt,
    ),
  );
  if (unknown) logFailure("amul_check", new SafeError(`amul_unknown_availability:${unknown}`));
  return { statements, messages: snapshotMessages(config.pincode, catalog.checkedAt, snapshot, Boolean(config.paused)) };
}
