import { env } from "cloudflare:workers";
import { createScheduledController } from "cloudflare:test";
import { vi } from "vitest";
import worker from "../src";
import { Store } from "../src/db";
import type { Availability } from "../src/types";

export function fixtureProduct(index = 0, available: unknown = 0) {
  return {
    _id: `fictional-public-product-${index}`,
    alias: `amul-test-protein-${index}`,
    name: `Amul test protein ${index}`,
    available,
    inventory_quantity: 8,
    categories: ["protein"],
    linked_product_id: `fictional-linked-product-${index}`,
  };
}

export interface TelegramCall {
  method: string;
  payload: Record<string, unknown>;
}

export class Upstream {
  products: unknown[] = [fixtureProduct()];
  telegram: TelegramCall[] = [];
  amul: { url: URL; headers: Headers; body: unknown }[] = [];
  failure: { path: string; status: number; retryAfter?: string; body?: string } | undefined;
  wrongRegion = false;
  repeatPage = false;
  badGuest = false;
  preferenceText = "Updated successfully";
  onInventory: (() => Promise<void>) | undefined;
  telegramResponse: ((call: TelegramCall) => Response | Promise<Response>) | undefined;
  private regions = new Map<string, string>();
  private nextSession = 0;

  install() {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, options) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === "https://api.telegram.org") {
        const call: TelegramCall = {
          method: url.pathname.split("/").at(-1)!,
          payload: JSON.parse(String(options?.body)) as Record<string, unknown>,
        };
        this.telegram.push(call);
        if (this.telegramResponse) return this.telegramResponse(call);
        return Response.json({
          ok: true,
          result: call.method === "answerCallbackQuery" ? true : {
            message_id: call.method === "editMessageText" ? call.payload.message_id : this.telegram.length,
          },
        });
      }
      if (url.origin !== "https://shop.amul.com") throw new Error("Unexpected test fetch target");
      const headers = new Headers(options?.headers);
      const body = options?.body ? JSON.parse(String(options.body)) as unknown : null;
      this.amul.push({ url, headers, body });
      if (this.failure?.path === url.pathname) {
        return new Response(this.failure.body ?? "Test upstream error", {
          status: this.failure.status,
          headers: this.failure.retryAfter ? { "Retry-After": this.failure.retryAfter } : {},
        });
      }
      let session = headers.get("Cookie")?.match(/fixture_session=(\d+)/)?.[1];
      if (!session) {
        session = String(++this.nextSession);
        this.regions.set(session, "default-must-not-be-used");
      }
      if (url.pathname === "/en/browse/protein") {
        return new Response(
          `<script>serverTimestamp = "${Date.now()}";</script><script src="/user/info.js?fixture=1"></script>`,
          { headers: { "Set-Cookie": `fixture_session=${session}; Secure; HttpOnly` } },
        );
      }
      if (url.pathname === "/user/info.js") {
        return new Response(this.badGuest
          ? 'session = {"tid":"fixture"}; globalThis.untrusted = true;'
          : `session = ${JSON.stringify({
            tid: `fictional-session-${session}`,
            substore: { alias: this.wrongRegion ? "wrong-region" : this.regions.get(session) },
          })};`);
      }
      if (url.pathname === "/entity/pincode") {
        const filters = JSON.parse(url.searchParams.get("filters")!) as { value: string }[];
        const pin = filters[0]!.value;
        const region = pin === "500032" ? "telangana" : pin === "560001" ? "karnataka" : null;
        return Response.json({
          records: region ? [{ pincode: pin, substore: region }] : [],
        });
      }
      if (url.pathname === "/entity/ms.settings/_/setPreferences") {
        const preferences = body as { data: { store: string } };
        this.regions.set(session, preferences.data.store);
        return new Response(this.preferenceText);
      }
      if (url.pathname === "/entity/ms.products") {
        if (this.onInventory) await this.onInventory();
        if ([...url.searchParams.keys()].some((key) => key.startsWith("fields"))) {
          throw new Error("Inventory projection is forbidden");
        }
        const start = this.repeatPage ? 0 : Number(url.searchParams.get("start"));
        const limit = Number(url.searchParams.get("limit"));
        return Response.json({ total: 3, records: this.products.slice(start, start + limit) });
      }
      throw new Error("Unexpected Amul test endpoint");
    });
  }
}

export async function seedTracked(available?: Availability, count = 1): Promise<void> {
  const store = new Store(env.DB);
  for (let index = 0; index < count; index++) {
    const product = fixtureProduct(index);
    await store.sql(
      "INSERT INTO products (id, alias, name, active, catalog_available, last_seen_at) VALUES (?, ?, ?, 1, 0, 1)",
      index + 1, product.alias, product.name,
    ).run();
    await store.sql(
      "INSERT INTO tracked_products (product_id, epoch) VALUES (?, ?)",
      index + 1, `fictional-watch-${index}`,
    ).run();
    if (available !== undefined) {
      await store.sql(
        "INSERT INTO observations (product_id, pincode, watch_epoch, available, checked_at) VALUES (?, '500032', ?, ?, 1)",
        index + 1, `fictional-watch-${index}`, available,
      ).run();
    }
  }
}

export function command(id: number, text: string, owner = Number(env.TELEGRAM_OWNER_ID), chatType = "private") {
  return {
    update_id: id,
    message: { message_id: id, text, from: { id: owner }, chat: { id: owner, type: chatType } },
  };
}

export function callback(id: number, data: string, callbackId = `fictional-callback-${id}`, messageId = 100) {
  return {
    update_id: id,
    callback_query: {
      id: callbackId,
      from: { id: Number(env.TELEGRAM_OWNER_ID) },
      data,
      message: { message_id: messageId, chat: { id: Number(env.TELEGRAM_OWNER_ID), type: "private" } },
    },
  };
}

export async function webhook(update: unknown, secret = env.TELEGRAM_WEBHOOK_SECRET) {
  return worker.fetch(new Request("https://bot.example/telegram", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify(update),
  }), env);
}

export async function tick(): Promise<void> {
  await worker.scheduled(createScheduledController({ cron: "*/5 * * * *" }), env);
}
