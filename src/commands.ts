import { Amul, validPincode } from "./amul";
import type { Lease, Store } from "./db";
import { SafeError } from "./errors";
import type { Network } from "./http";
import { productMenus } from "./menus";
import type { ProductRange } from "./menus";
import { assertUpstreamReady, planCheck, upstreamFailure } from "./stock";
import type { Config, Env, Message, OwnerUpdate, StoredProduct } from "./types";

const HELP = `Amul protein restock bot (private owner only)

/products - all products; tap full-name buttons to select/unselect
/pincode 500032 - validate and change the delivery PIN
/status - configuration, last successful check and errors
/checknow - request a current stock snapshot
/pause - stop checks/alerts and discard pending restock alerts
/resume - resume with new silent baselines
/help - these instructions

Initially nothing is tracked. The first valid observation after tracking, changing PIN or resuming is silent, even if in stock. An observed out-of-stock -> available transition sends one alert, then re-arms only after another observed stock-out. Errors are UNKNOWN, never stock-outs.

Availability is a snapshot, not a reservation. Short restocks between polls may be missed.`;

function time(value: number | null): string {
  return value === null ? "never (awaiting a complete successful check)" : new Date(value).toISOString();
}

async function status(store: Store, config: Config): Promise<Message> {
  const products = await store.products();
  const pending = await store.sql(
    "SELECT COUNT(*) AS count FROM outbox WHERE state = 'pending'",
  ).first<{ count: number }>();
  const deliveryError = await store.sql(
    "SELECT last_error FROM outbox WHERE state = 'pending' AND last_error IS NOT NULL ORDER BY id DESC LIMIT 1",
  ).first<{ last_error: string }>();
  return {
    text: `Amul bot: ${config.paused ? "PAUSED" : "ready"}\nPIN: ${config.pincode}\nTracked products: ${products.filter((product) => product.epoch).length}\nLast successful complete check: ${time(config.last_success_at)}\nLast check attempt: ${time(config.last_attempt_at)}\nLast check error: ${config.last_error ?? "none"}\nUpstream retry not before: ${config.upstream_retry_at > Date.now() ? time(config.upstream_retry_at) : "not throttled"}\nPending deliveries: ${pending?.count ?? 0}\nDelivery error: ${deliveryError?.last_error ?? "none"}\nSchedule: configured Cloudflare cron (five minutes by default).\nNo selected products means no scheduled inventory requests or alerts.`,
    reply_markup: {
      inline_keyboard: [[
        { text: "Products", callback_data: "products" },
        { text: "Check now", callback_data: "check" },
        { text: config.paused ? "Resume" : "Pause", callback_data: `${config.paused ? "resume" : "pause"}:${config.revision}` },
      ]],
    },
  };
}

function resetBaselines(store: Store): D1PreparedStatement[] {
  return [
    store.sql("DELETE FROM observations"),
    store.sql("UPDATE outbox SET state = 'cancelled', last_error = 'configuration_changed' WHERE kind = 'alert' AND state = 'pending'"),
  ];
}

function queueReplies(
  store: Store,
  env: Env,
  update: OwnerUpdate,
  messages: Message[],
  callbackNotice: string,
  revision: number,
  menuReply: boolean,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  if (update.callback) {
    statements.push(
      store.enqueue(
        `update:${update.id}:callback`,
        "callback",
        "answerCallbackQuery",
        { callback_query_id: update.callback.id, text: callbackNotice.slice(0, 180) },
        undefined,
        Date.now() + 60_000,
      ),
    );
  }
  messages.forEach((message, index) => {
    const edit = update.callback && index === 0 && message.reply_markup;
    if (edit) {
      statements.push(store.sql(
        `UPDATE outbox SET state = 'cancelled', last_error = 'newer_view'
         WHERE state = 'pending' AND method = 'editMessageText'
           AND json_extract(payload, '$.message_id') = ?`,
        update.callback!.messageId,
      ));
    }
    statements.push(
      store.enqueue(
        `update:${update.id}:${menuReply ? "menu" : "reply"}:${index}`,
        "reply",
        edit ? "editMessageText" : "sendMessage",
        {
          chat_id: env.TELEGRAM_OWNER_ID,
          ...(edit ? { message_id: update.callback?.messageId } : {}),
          ...message,
          link_preview_options: { is_disabled: true },
        },
        undefined,
        undefined,
        revision,
      ),
    );
  });
  statements.push(
    store.sql(
      "INSERT INTO telegram_updates (update_id, callback_id, processed_at) VALUES (?, ?, ?)",
      update.id,
      update.callback?.id ?? null,
      Date.now(),
    ),
  );
  return statements;
}

export async function processUpdate(
  env: Env,
  lease: Lease,
  network: Network,
  update: OwnerUpdate,
): Promise<void> {
  const store = lease.store;
  if (await store.processed(update.id, update.callback?.id)) return;
  const initial = await store.config();
  let config = initial;
  let messages: Message[] = [];
  let statements: D1PreparedStatement[] = [];
  let callbackNotice = "Done";
  let action = "";
  let argument = "";
  let menuRange: ProductRange | undefined;
  let productId = 0;
  let callbackRevision: number | undefined;
  let menuReply = false;

  function showProducts(products: StoredProduct[], range?: ProductRange): void {
    messages = productMenus(config, products, range);
    menuReply = true;
  }

  if (update.callback) {
    const data = update.callback.data;
    if (["products", "status", "check"].includes(data)) {
      action = data === "check" ? "checknow" : data;
    } else {
      const legacy = /^(?:page:\d{1,10}:\d{1,3}|(?:track|untrack):\d{1,10}:\d{1,10}:\d{1,3})$/.test(data);
      const selection = data.match(/^pick:(\d{1,10}):(\d{1,10}):([01]):(\d{1,10}):(\d{1,10})$/);
      const pause = data.match(/^(pause|resume):(\d{1,10})$/);
      if (legacy) {
        action = "legacyMenu";
      } else if (selection) {
        callbackRevision = Number(selection[1]);
        productId = Number(selection[2]);
        menuRange = { first: Number(selection[4]), last: Number(selection[5]) };
        action = menuRange.first > 0 && menuRange.first <= productId && productId <= menuRange.last
          ? selection[3] === "1" ? "track" : "untrack"
          : "invalid";
        if (action === "invalid") {
          menuRange = undefined;
          callbackRevision = undefined;
        }
      } else if (pause) {
        action = pause[1]!; callbackRevision = Number(pause[2]);
      } else {
        action = "invalid";
      }
    }
  } else {
    const command = update.text?.trim().match(/^\/([a-z]+)(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/s);
    action = command?.[1] ?? "help";
    argument = command?.[2]?.trim() ?? "";
    if (argument && action !== "pincode") action = "invalid";
  }

  if (callbackRevision !== undefined && callbackRevision !== config.revision) {
    callbackNotice = "This button is stale. Refreshed without changing selections; tap again to choose.";
    showProducts(await store.products(), menuRange);
  } else if (action === "help" || action === "start") {
    messages = [{ text: HELP }];
  } else if (action === "status") {
    messages = [await status(store, config)];
  } else if (action === "products") {
    try {
      assertUpstreamReady(config);
      const catalog = await new Amul(network).catalog(config.pincode);
      // Catalog cache is idempotent; command effects/deduplication remain one later batch.
      await lease.commit(store.catalogPlan(catalog), config.revision);
      config = await store.config();
      showProducts(await store.products());
    } catch (error) {
      if (!(error instanceof SafeError)) throw error;
      statements.push(...upstreamFailure(store, error));
      messages = [{ text: `Catalog refresh failed: ${error.code}. No selections changed. Previous baselines are preserved; use /status and retry later.` }];
      callbackNotice = "Catalog unavailable; no selections changed.";
    }
  } else if (action === "legacyMenu") {
    callbackNotice = "Menu upgraded. Selections unchanged; use the new full-name buttons.";
    showProducts(await store.products());
  } else if (action === "track" || action === "untrack") {
    const products = await store.products();
    const product = products.find((item) => item.id === productId);
    const pendingMenu = await store.pendingProductMenu(config.revision);
    if (pendingMenu) {
      callbackNotice = "The catalog is still arriving. Selection unchanged; tap again shortly.";
    } else if (!product || (action === "track" && !product.active)) {
      callbackNotice = "Product is not in the current catalog. Refresh /products.";
    } else if ((action === "track") === Boolean(product.epoch)) {
      callbackNotice = "Selection already matches; nothing changed.";
    } else {
      const epoch = action === "track" ? crypto.randomUUID() : null;
      statements.push(
        action === "track"
          ? store.sql("INSERT INTO tracked_products (product_id, epoch) VALUES (?, ?)", product.id, epoch)
          : store.sql("DELETE FROM tracked_products WHERE product_id = ?", product.id),
        store.sql("DELETE FROM observations WHERE product_id = ?", product.id),
        store.sql(
          "UPDATE outbox SET state = 'cancelled', last_error = 'selection_changed' WHERE kind = 'alert' AND state = 'pending' AND product_id = ?",
          product.id,
        ),
        store.sql("UPDATE config SET revision = revision + 1, last_success_at = NULL, last_error = NULL WHERE id = 1"),
      );
      product.epoch = epoch;
      config = { ...config, revision: config.revision + 1 };
      callbackNotice = action === "track" ? "Tracked. First valid observation will be silent." : "Untracked. Pending alerts for this product cancelled.";
    }
    if (!pendingMenu) {
      showProducts(products.filter((product) => product.active || product.epoch), menuRange);
    }
  } else if (action === "pause" || action === "resume") {
    const paused = action === "pause" ? 1 : 0;
    if (config.paused !== paused) {
      statements.push(
        ...resetBaselines(store),
        store.sql(
          "UPDATE config SET paused = ?, revision = revision + 1, last_success_at = NULL, last_attempt_at = NULL, last_error = NULL WHERE id = 1",
          paused,
        ),
      );
      config = { ...config, paused, revision: config.revision + 1 };
    }
    callbackNotice = paused
      ? "Paused. Pending restock alerts cancelled."
      : "Resumed. First valid observations will be silent.";
    messages = [{ text: callbackNotice }];
  } else if (action === "pincode") {
    if (!validPincode(argument)) {
      messages = [{ text: "Use /pincode followed by exactly six digits (first digit 1-9), for example /pincode 500032. Nothing changed." }];
    } else if (argument === config.pincode) {
      messages = [{ text: `PIN is already ${argument}. Baselines unchanged.` }];
    } else {
      try {
        assertUpstreamReady(config);
        await new Amul(network).bind(argument);
        statements.push(
          ...resetBaselines(store),
          store.sql(
            `UPDATE config SET pincode = ?, revision = revision + 1, last_success_at = NULL,
             last_attempt_at = NULL, last_error = NULL, catalog_at = NULL, upstream_retry_at = 0 WHERE id = 1`,
            argument,
          ),
          store.sql("UPDATE products SET active = 0, catalog_available = NULL"),
        );
        config = { ...config, pincode: argument, revision: config.revision + 1 };
        messages = [{ text: `Delivery PIN changed to ${argument}. Existing selections are retained, but their first valid observations for this PIN will be silent. Pending old-PIN alerts were cancelled. Use /products to refresh the regional catalog.` }];
      } catch (error) {
        if (!(error instanceof SafeError)) throw error;
        statements.push(...upstreamFailure(store, error));
        messages = [{ text: `PIN not changed: ${error.code}. Still using ${config.pincode}; no region fallback was used.` }];
      }
    }
  } else if (action === "checknow") {
    const plan = await planCheck(store, config, env, network);
    statements.push(...plan.statements);
    messages = plan.messages;
  } else {
    messages = [{ text: "Unknown command or invalid arguments/button. Use /help. Nothing changed." }];
    callbackNotice = "Invalid command; nothing changed.";
  }
  statements.push(...queueReplies(store, env, update, messages, callbackNotice, config.revision, menuReply));
  await lease.commit(statements, initial.revision);
}
