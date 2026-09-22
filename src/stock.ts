import { Amul, productUrl } from "./amul";
import type { Store } from "./db";
import { errorCode, logFailure, SafeError } from "./errors";
import type { Network } from "./http";
import type { Catalog, Config, Env, Message } from "./types";

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

export function splitMessages(header: string, lines: string[]): Message[] {
  const messages: Message[] = [];
  let text = header;
  for (const line of lines) {
    if (text.length + line.length + 2 > 3_900) {
      messages.push({ text });
      text = `${header} (continued)`;
    }
    text += `\n\n${line}`;
  }
  messages.push({ text });
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
  const lines: string[] = [];
  let unknown = 0;

  for (const trackedProduct of tracked) {
    const product = products.get(trackedProduct.alias);
    const available = product?.available ?? null;
    lines.push(
      `${trackedProduct.name}\n${available === null ? "UNKNOWN (missing or unrecognized availability; baseline preserved)" : available === 1 ? "Available" : "Out of stock"}`,
    );
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
  const header = `Requested stock snapshot for PIN ${config.pincode}\n${new Date(catalog.checkedAt).toISOString()}${config.paused ? "\nPaused: this snapshot does not change alert baselines." : ""}${unknown ? "\nPARTIAL CHECK: some products are UNKNOWN." : ""}\nNot reserved or guaranteed at checkout.`;
  return { statements, messages: splitMessages(header, lines) };
}
