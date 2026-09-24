import { json, object, SafeError } from "./errors";
import { Network, retryAfter } from "./http";
import type { Catalog, Product } from "./types";

const ORIGIN = "https://shop.amul.com";
const PAGE = `${ORIGIN}/en/browse/protein`;
const STORE_ID = "62fa94df8c13af2e242eba16";
const PAGE_SIZE = 50;
const MAX_PRODUCTS = 200;
const ALIAS = /^[a-z0-9][a-z0-9-]{0,199}$/;

export function validPincode(pin: string): boolean {
  return /^[1-9]\d{5}$/.test(pin);
}

export function productUrl(alias: string): string {
  if (!ALIAS.test(alias)) throw new SafeError("invalid_product_alias");
  return `${ORIGIN}/en/product/${alias}`;
}

function records(text: string): unknown[] {
  const payload = json(text, "amul_invalid_json");
  if (!object(payload) || !Array.isArray(payload.records)) {
    throw new SafeError("amul_invalid_records");
  }
  return payload.records;
}

export function parseProduct(value: unknown): Product {
  if (
    !object(value) ||
    typeof value.alias !== "string" ||
    !ALIAS.test(value.alias) ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 300 ||
    !Array.isArray(value.categories) ||
    !value.categories.includes("protein")
  ) {
    throw new SafeError("amul_invalid_product");
  }
  const name = value.name.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!name) throw new SafeError("amul_invalid_product");
  return {
    alias: value.alias,
    name,
    // Quantity and projected payloads are NOT equivalent to effective availability.
    available: value.available === 0 || value.available === 1 ? value.available : null,
  };
}

export class Amul {
  private readonly cookies = new Map<string, string>();
  private guest: Record<string, unknown> = {};
  private serverTime = 0;
  private handshakeTime = 0;

  constructor(private readonly network: Network) {}

  private async send(url: URL, options: RequestInit = {}): Promise<string> {
    if (url.origin !== ORIGIN) throw new SafeError("amul_unexpected_origin");
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = new Headers(options.headers);
      headers.set("Accept", "application/json, text/plain, */*");
      if (this.cookies.size) {
        headers.set(
          "Cookie",
          [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "),
        );
      }
      const { response, text } = await this.network.request(
        url,
        { ...options, headers },
        "amul",
        url.pathname === "/entity/ms.products" ? 2_000_000 : 256_000,
      );
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";")[0] ?? "";
        const equals = pair.indexOf("=");
        if (equals > 0) {
          this.cookies.set(pair.slice(0, equals), pair.slice(equals + 1));
        }
      }
      if (response.ok) return text;
      const delay = retryAfter(response.headers.get("retry-after"));
      if (
        attempt === 0 &&
        [429, 502, 503, 504].includes(response.status) &&
        delay <= 2 &&
        this.network.remaining() > (delay + 7) * 1_000
      ) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(250, delay * 1_000)));
        continue;
      }
      throw new SafeError(`amul_http_${response.status}`, delay);
    }
    throw new SafeError("amul_retry_exhausted");
  }

  private async handshake(): Promise<void> {
    const html = await this.send(new URL(PAGE));
    const timestamp = html.match(/serverTimestamp\s*=\s*["'](\d+)["']/);
    const asset = html.match(
      /<script\s+src=["']?(\/user\/info\.js[^\s>"']*)/,
    );
    if (!timestamp?.[1] || !asset?.[1]) {
      throw new SafeError("amul_handshake_missing");
    }
    const url = new URL(asset[1].replaceAll("&amp;", "&"), ORIGIN);
    if (url.origin !== ORIGIN || url.pathname !== "/user/info.js") {
      throw new SafeError("amul_guest_asset_invalid");
    }
    this.serverTime = Number(timestamp[1]);
    this.handshakeTime = Date.now();
    if (!Number.isSafeInteger(this.serverTime)) {
      throw new SafeError("amul_clock_invalid");
    }
    const source = await this.send(url);
    const assignment = source.match(
      /^\s*(?:window\.)?session\s*=\s*(\{[\s\S]*\})\s*;?\s*$/,
    );
    if (!assignment?.[1]) throw new SafeError("amul_guest_format_changed");
    const guest = json(assignment[1], "amul_guest_invalid_json");
    if (
      !object(guest) ||
      typeof guest.tid !== "string" ||
      !guest.tid ||
      guest.tid.length > 1_024
    ) {
      throw new SafeError("amul_guest_invalid");
    }
    this.guest = guest;
  }

  private async api(
    path: string,
    params: Record<string, string> = {},
    data?: Record<string, string>,
  ): Promise<string> {
    const timestamp = String(this.serverTime + Date.now() - this.handshakeTime);
    const nonce = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000);
    const input = `${STORE_ID}:${timestamp}:${nonce}:${String(this.guest.tid)}`;
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    const digest = [...new Uint8Array(bytes)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const url = new URL(path, ORIGIN);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const headers = new Headers({
      frontend: "1",
      base_url: PAGE,
      Referer: PAGE,
      Origin: ORIGIN,
      tid: `${timestamp}:${nonce}:${digest}`,
    });
    const options: RequestInit = { method: data ? "PUT" : "GET", headers };
    if (data) {
      headers.set("Content-Type", "application/json");
      options.body = JSON.stringify({ data });
    }
    return this.send(url, options);
  }

  async bind(pincode: string): Promise<string> {
    if (!validPincode(pincode)) throw new SafeError("invalid_pincode");
    await this.handshake();
    const pins = records(
      await this.api("/entity/pincode", {
        limit: "3",
        filters: JSON.stringify([{ field: "pincode", value: pincode, operator: "equal" }]),
      }),
    );
    const matches = pins.filter(
      (pin): pin is Record<string, unknown> =>
        object(pin) && String(pin.pincode) === pincode,
    );
    const region = matches[0]?.substore;
    if (matches.length !== 1 || typeof region !== "string" || !ALIAS.test(region)) {
      throw new SafeError("amul_pincode_not_uniquely_serviceable");
    }
    // This endpoint returns plain text, not JSON.
    const result = await this.api("/entity/ms.settings/_/setPreferences", {}, { store: region });
    if (result.trim() !== "Updated successfully") {
      throw new SafeError("amul_preferences_unconfirmed");
    }
    await this.handshake();
    if (!object(this.guest.substore) || this.guest.substore.alias !== region) {
      throw new SafeError("amul_region_mismatch");
    }
    return region;
  }

  async catalog(pincode: string, aliases?: string[]): Promise<Catalog> {
    if (aliases && (!aliases.length || aliases.length > MAX_PRODUCTS ||
        aliases.some((alias) => !ALIAS.test(alias)) || new Set(aliases).size !== aliases.length)) {
      throw new SafeError("amul_invalid_alias_filter");
    }
    const requested = aliases ? new Set(aliases) : null;
    const region = await this.bind(pincode);
    const products: Product[] = [];
    const seenAliases = new Set<string>();
    for (let start = 0; start <= MAX_PRODUCTS; start += PAGE_SIZE) {
      // No fields[...] projection: it disables linked-inventory enrichment.
      const page = records(
        await this.api("/entity/ms.products", {
          limit: String(PAGE_SIZE),
          start: String(start),
          filters: JSON.stringify([
            { field: "categories", value: ["protein"], operator: "in" },
            ...(aliases ? [{ field: "alias", value: aliases, operator: "in" }] : []),
          ]),
        }),
      );
      if (page.length > PAGE_SIZE) throw new SafeError("amul_invalid_page");
      for (const value of page) {
        const product = parseProduct(value);
        if (requested && !requested.has(product.alias)) throw new SafeError("amul_filtered_unexpected_product");
        if (seenAliases.has(product.alias)) throw new SafeError("amul_repeated_page");
        seenAliases.add(product.alias);
        products.push(product);
      }
      if (products.length > MAX_PRODUCTS) throw new SafeError("amul_catalog_limit");
      if (page.length < PAGE_SIZE) {
        if (!products.length && !requested) throw new SafeError("amul_empty_catalog");
        return { pincode, region, products, checkedAt: Date.now() };
      }
    }
    throw new SafeError("amul_catalog_limit");
  }
}
