import type { Delivery, Lease, TelegramMethod } from "./db";
import { errorCode, json, logFailure, object, SafeError } from "./errors";
import { Network, retryAfter } from "./http";
import type { Env, OwnerUpdate } from "./types";

export function validateEnv(env: Env): void {
  if (
    !/^\d{5,16}:[A-Za-z0-9_-]{20,100}$/.test(env.TELEGRAM_BOT_TOKEN ?? "") ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET ?? "") ||
    !/^[1-9]\d{0,15}$/.test(env.TELEGRAM_OWNER_ID ?? "") ||
    !Number.isSafeInteger(Number(env.TELEGRAM_OWNER_ID))
  ) {
    throw new SafeError("secure_runtime_configuration_missing");
  }
}

export async function validWebhookSecret(actual: string | null, expected: string): Promise<boolean> {
  if (actual === null || actual.length > 256) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index]! ^ b[index]!;
  return difference === 0;
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function ownerUpdate(body: unknown, owner: string): OwnerUpdate | null {
  if (!object(body) || !integer(body.update_id)) throw new SafeError("invalid_update");
  if (object(body.callback_query)) {
    const callback = body.callback_query;
    const message = callback.message;
    if (
      !object(callback.from) ||
      !integer(callback.from.id) ||
      String(callback.from.id) !== owner ||
      callback.from.is_bot === true ||
      !object(message) ||
      !object(message.chat) ||
      message.chat.type !== "private" ||
      !integer(message.chat.id) ||
      String(message.chat.id) !== owner
    ) return null;
    if (
      typeof callback.id !== "string" || !callback.id || callback.id.length > 128 ||
      typeof callback.data !== "string" || new TextEncoder().encode(callback.data).length > 64 ||
      !integer(message.message_id)
    ) throw new SafeError("invalid_callback");
    return {
      id: body.update_id,
      callback: { id: callback.id, data: callback.data, messageId: message.message_id },
    };
  }
  const message = body.message;
  if (
    !object(message) ||
    !object(message.from) ||
    !integer(message.from.id) ||
    String(message.from.id) !== owner ||
    message.from.is_bot === true ||
    !object(message.chat) ||
    message.chat.type !== "private" ||
    !integer(message.chat.id) ||
    String(message.chat.id) !== owner
  ) return null;
  if (typeof message.text !== "string" || message.text.length > 4_096) return null;
  return { id: body.update_id, text: message.text };
}

async function send(
  env: Env,
  network: Network,
  method: TelegramMethod,
  payload: string,
): Promise<void> {
  const { response, text } = await network.request(
    new URL(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`),
    { method: "POST", headers: { "Content-Type": "application/json" }, body: payload },
    "telegram",
    64_000,
  );
  const data = json(text, "telegram_invalid_json");
  if (!object(data)) throw new SafeError("telegram_invalid_response");
  if (response.ok && data.ok === true) {
    if (method === "answerCallbackQuery" && data.result === true) return;
    if (
      method !== "answerCallbackQuery" &&
      object(data.result) &&
      integer(data.result.message_id)
    ) return;
    throw new SafeError("telegram_missing_acknowledgement");
  }
  if (
    method === "editMessageText" &&
    data.error_code === 400 &&
    typeof data.description === "string" &&
    data.description.startsWith("Bad Request: message is not modified")
  ) return;
  const code = integer(data.error_code) ? data.error_code : response.status;
  const bodyRetry = object(data.parameters) &&
    typeof data.parameters.retry_after === "number" &&
    Number.isFinite(data.parameters.retry_after)
    ? Math.max(0, Math.min(data.parameters.retry_after, 86_400))
    : 0;
  throw new SafeError(
    `telegram_http_${code}`,
    Math.max(bodyRetry, retryAfter(response.headers.get("retry-after"))),
  );
}

export async function flushOutbox(env: Env, lease: Lease, network: Network): Promise<void> {
  const store = lease.store;
  const now = Date.now();
  await lease.commit([
    store.sql(
      `UPDATE outbox SET state = 'cancelled',
         last_error = CASE WHEN kind != 'callback'
           AND CAST(json_extract(payload, '$.chat_id') AS TEXT) IS NOT ?
           THEN 'owner_binding_changed' ELSE 'obsolete' END
       WHERE state = 'pending' AND (
         (kind != 'callback' AND CAST(json_extract(payload, '$.chat_id') AS TEXT) IS NOT ?) OR
         (expires_at IS NOT NULL AND expires_at <= ?) OR
         (kind = 'reply' AND config_revision IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM config c WHERE c.id = 1 AND c.revision = outbox.config_revision
         )) OR
         (kind = 'alert' AND NOT EXISTS (
           SELECT 1 FROM config c JOIN tracked_products t ON t.product_id = outbox.product_id
           WHERE c.id = 1 AND c.paused = 0 AND c.pincode = outbox.pincode
             AND t.epoch = outbox.watch_epoch
         )))`,
      env.TELEGRAM_OWNER_ID,
      env.TELEGRAM_OWNER_ID,
      now,
    ),
    store.sql(
      `DELETE FROM outbox WHERE id IN (
         SELECT id FROM outbox WHERE state != 'pending' AND created_at < ? LIMIT 100
       )`,
      now - 30 * 86_400_000,
    ),
  ]);
  if ((await store.config()).telegram_retry_at > Date.now()) return;
  const deliveries = await store.sql(
    `SELECT * FROM outbox WHERE state = 'pending' AND next_attempt_at <= ?
     ORDER BY CASE kind WHEN 'callback' THEN 0 WHEN 'reply' THEN 1 ELSE 2 END, id LIMIT 6`,
    now,
  ).all<Delivery>();

  for (const delivery of deliveries.results) {
    if (network.remaining() < 7_000) break;
    // No config mutation can acquire this lease during the bounded external send.
    await lease.assertOwned(15);
    await lease.commit([
      store.sql(
        "UPDATE outbox SET attempts = attempts + 1, next_attempt_at = ? WHERE id = ? AND state = 'pending'",
        Date.now() + 120_000,
        delivery.id,
      ),
    ]);
    try {
      await lease.assertOwned(15);
      await send(env, network, delivery.method, delivery.payload);
    } catch (error) {
      logFailure("telegram_delivery", error);
      const retry = error instanceof SafeError ? error.retryAfterSeconds : 0;
      const backoff = Math.min(3_600, 30 * 2 ** Math.min(delivery.attempts, 7));
      await lease.commit([
        store.sql(
          "UPDATE outbox SET next_attempt_at = ?, last_error = ? WHERE id = ?",
          Date.now() + Math.max(backoff, retry) * 1_000,
          errorCode(error),
          delivery.id,
        ),
        store.sql(
          "UPDATE config SET telegram_retry_at = MAX(telegram_retry_at, ?) WHERE id = 1",
          retry ? Date.now() + retry * 1_000 : 0,
        ),
      ]);
      // Respect Telegram-wide rate limits and avoid repeatedly hitting a broken token/chat.
      break;
    }
    await lease.commit([
      store.sql(
        `UPDATE outbox SET state = 'acknowledged', acknowledged_at = ?, last_error = NULL
         WHERE id = ? AND state = 'pending'`,
        Date.now(),
        delivery.id,
      ),
    ]);
  }
}
