import { processUpdate } from "./commands";
import { checkBackground } from "./background";
import { Store } from "./db";
import { json, logFailure, SafeError } from "./errors";
import { limitedText, Network } from "./http";
import { deliverCurrentReminder, flushOutbox, ownerUpdate, validateEnv, validWebhookSecret } from "./telegram";
import type { Env } from "./types";

export const MAX_WEBHOOK_BYTES = 128_000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET") {
      return new Response("ok (liveness only)");
    }
    if (path !== "/telegram" || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }
    try {
      validateEnv(env);
      if (!(await validWebhookSecret(
        request.headers.get("X-Telegram-Bot-Api-Secret-Token"),
        env.TELEGRAM_WEBHOOK_SECRET,
      ))) return new Response("Forbidden", { status: 403 });
      const body = await limitedText(new Response(request.body, { headers: request.headers }), MAX_WEBHOOK_BYTES);
      const update = ownerUpdate(json(body, "invalid_update_json"), env.TELEGRAM_OWNER_ID);
      if (!update) return new Response("Ignored");
      const store = new Store(env.DB);
      const lease = await store.acquire();
      if (!lease) return new Response("Busy; retry", { status: 503, headers: { "Retry-After": "5" } });
      try {
        const network = new Network();
        await processUpdate(env, lease, network, update);
        await flushOutbox(env, lease, network, false);
        const config = await store.config();
        const pendingMenu = await store.pendingProductMenu(config.revision);
        if (pendingMenu) {
          // Telegram retries the already-deduplicated update to drain requested
          // overflow chunks even when scheduled polling is disabled.
          const retryAt = Math.max(pendingMenu.next_attempt_at, config.telegram_retry_at);
          return new Response("Menu delivery pending; retry", {
            status: 503,
            headers: { "Retry-After": String(Math.max(5, Math.ceil((retryAt - Date.now()) / 1_000))) },
          });
        }
        return new Response("OK");
      } finally {
        await lease.release();
      }
    } catch (error) {
      logFailure("webhook", error);
      if (error instanceof SafeError) {
        if (error.code === "response_too_large") return new Response("Payload too large", { status: 413 });
        if (["invalid_update_json", "invalid_update", "invalid_callback"].includes(error.code)) {
          return new Response("Invalid update", { status: 400 });
        }
      }
      return new Response("Request could not be processed; retry", { status: 503 });
    }
  },

  async scheduled(controller: Pick<ScheduledController, "scheduledTime" | "cron">, env: Env): Promise<void> {
    try {
      validateEnv(env);
      if (env.MONITORING_ENABLED !== "true") {
        console.log(JSON.stringify({ operation: "background_disabled" }));
        return;
      }
      const store = new Store(env.DB);
      const state = await store.acquireBackground();
      if (!state) throw new SafeError("scheduled_operation_busy");
      const { lease } = state;
      try {
        const network = new Network();
        await checkBackground(controller, env, state, network);
        await deliverCurrentReminder(env, lease, network);
        if (state.pendingReplies) await flushOutbox(env, lease, network, false);
      } finally {
        await lease.release();
      }
    } catch (error) {
      logFailure("scheduled_check", error);
      // Mark this Cron invocation failed in Cloudflare rather than reporting success.
      throw new Error("Scheduled check failed; inspect sanitized application logs.");
    }
  },
} satisfies ExportedHandler<Env>;
