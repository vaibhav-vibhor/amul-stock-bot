import { afterEach, describe, expect, it, vi } from "vitest";
import { Amul, parseProduct, productUrl, validPincode } from "../src/amul";
import { limitedText, MAX_SUBREQUESTS, Network, retryAfter } from "../src/http";
import { fixtureProduct, Upstream } from "./helpers";

afterEach(() => vi.restoreAllMocks());

describe("regional Amul protocol", () => {
  it("uses exact PIN lookup, guest cookies, signed headers and plain-text preferences", async () => {
    const upstream = new Upstream();
    upstream.products = [fixtureProduct(0, 1), fixtureProduct(1, 0)];
    upstream.install();
    const catalog = await new Amul(new Network()).catalog("500032");
    expect(catalog.region).toBe("telangana");
    expect(catalog.products.map((product) => product.available)).toEqual([1, 0]);
    const lookup = upstream.amul.find((call) => call.url.pathname === "/entity/pincode")!;
    expect(JSON.parse(lookup.url.searchParams.get("filters")!)).toEqual([
      { field: "pincode", value: "500032", operator: "equal" },
    ]);
    const preference = upstream.amul.find((call) => call.url.pathname.endsWith("setPreferences"))!;
    expect(preference.body).toEqual({ data: { store: "telangana" } });
    for (const call of upstream.amul.filter((call) => call.url.pathname.startsWith("/entity/"))) {
      expect(call.headers.get("Cookie")).toMatch(/^fixture_session=\d+$/);
      expect(call.headers.get("frontend")).toBe("1");
      expect(call.headers.get("base_url")).toBe("https://shop.amul.com/en/browse/protein");
      const [timestamp, nonce, signature] = call.headers.get("tid")!.split(":");
      const session = call.headers.get("Cookie")!.split("=")[1]!;
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
        `62fa94df8c13af2e242eba16:${timestamp}:${nonce}:fictional-session-${session}`,
      ));
      expect(signature).toBe([...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
    }
    expect(upstream.amul.filter((call) => call.url.pathname === "/en/browse/protein")).toHaveLength(2);
    expect(upstream.amul.some((call) => [...call.url.searchParams.keys()].some((key) => key.startsWith("fields")))).toBe(false);
  });

  it("paginates without trusting the misleading total", async () => {
    const upstream = new Upstream();
    upstream.products = Array.from({ length: 51 }, (_, index) => fixtureProduct(index, index % 2));
    upstream.install();
    const catalog = await new Amul(new Network()).catalog("500032");
    expect(catalog.products).toHaveLength(51);
    expect(upstream.amul.filter((call) => call.url.pathname === "/entity/ms.products")
      .map((call) => call.url.searchParams.get("start"))).toEqual(["0", "50"]);
  });

  it("requires an empty terminal page when the page size divides the catalog", async () => {
    const upstream = new Upstream();
    upstream.products = Array.from({ length: 50 }, (_, index) => fixtureProduct(index));
    upstream.install();
    expect((await new Amul(new Network()).catalog("500032")).products).toHaveLength(50);
    expect(upstream.amul.filter((call) => call.url.pathname === "/entity/ms.products")).toHaveLength(2);
  });

  it("fails closed on repeated pages instead of looping or truncating", async () => {
    const upstream = new Upstream();
    upstream.products = Array.from({ length: 50 }, (_, index) => fixtureProduct(index));
    upstream.repeatPage = true;
    upstream.install();
    await expect(new Amul(new Network()).catalog("500032")).rejects.toThrow("amul_repeated_page");
  });

  it("fails closed rather than silently truncating more than 200 products", async () => {
    const upstream = new Upstream();
    upstream.products = Array.from({ length: 201 }, (_, index) => fixtureProduct(index));
    upstream.install();
    await expect(new Amul(new Network()).catalog("500032")).rejects.toThrow("amul_catalog_limit");
    expect(upstream.amul.filter((call) => call.url.pathname === "/entity/ms.products")).toHaveLength(5);
  });

  it("rejects an empty catalog rather than reporting a successful stock-out", async () => {
    const upstream = new Upstream();
    upstream.products = [];
    upstream.install();
    await expect(new Amul(new Network()).catalog("500032")).rejects.toThrow("amul_empty_catalog");
  });

  it("refuses a PIN without a unique match and never requests global inventory", async () => {
    const upstream = new Upstream();
    upstream.install();
    await expect(new Amul(new Network()).catalog("999999")).rejects.toThrow("amul_pincode_not_uniquely_serviceable");
    expect(upstream.amul.some((call) => call.url.pathname === "/entity/ms.products")).toBe(false);
  });

  it("refuses a mismatched regional guest session", async () => {
    const upstream = new Upstream();
    upstream.wrongRegion = true;
    upstream.install();
    await expect(new Amul(new Network()).catalog("500032")).rejects.toThrow("amul_region_mismatch");
    expect(upstream.amul.some((call) => call.url.pathname === "/entity/ms.products")).toBe(false);
  });

  it("never evaluates JavaScript in a guest script", async () => {
    const upstream = new Upstream();
    upstream.badGuest = true;
    upstream.install();
    await expect(new Amul(new Network()).catalog("500032")).rejects.toThrow("amul_guest_format_changed");
    expect("untrusted" in globalThis).toBe(false);
  });

  it("does not treat an unrecognized preference response as confirmation", async () => {
    const upstream = new Upstream();
    upstream.preferenceText = "Please log in";
    upstream.install();
    await expect(new Amul(new Network()).catalog("500032")).rejects.toThrow("amul_preferences_unconfirmed");
  });

  it("honors a long Retry-After without an immediate retry", async () => {
    const upstream = new Upstream();
    upstream.failure = { path: "/entity/ms.products", status: 429, retryAfter: "600" };
    upstream.install();
    await expect(new Amul(new Network()).catalog("500032")).rejects.toMatchObject({
      code: "amul_http_429", retryAfterSeconds: 600,
    });
    expect(upstream.amul.filter((call) => call.url.pathname === "/entity/ms.products")).toHaveLength(1);
  });

  it("does not retry or circumvent an access block", async () => {
    const upstream = new Upstream();
    upstream.failure = { path: "/en/browse/protein", status: 403 };
    upstream.install();
    await expect(new Amul(new Network()).catalog("500032")).rejects.toThrow("amul_http_403");
    expect(upstream.amul).toHaveLength(1);
  });
});

describe("availability and bounded input contracts", () => {
  it("trusts effective available=0 even with positive quantity", () => {
    expect(parseProduct(fixtureProduct(0, 0)).available).toBe(0);
  });

  it.each([undefined, null, true, "1", 2, -1])("treats availability %s as UNKNOWN", (available) => {
    expect(parseProduct({ ...fixtureProduct(), available }).available).toBeNull();
  });

  it("rejects malformed identities, foreign categories and arbitrary product links", () => {
    expect(() => parseProduct({ ...fixtureProduct(), alias: "../../admin" })).toThrow();
    expect(() => parseProduct({ ...fixtureProduct(), categories: ["milk"] })).toThrow();
    expect(() => parseProduct({ ...fixtureProduct(), name: "\u0000" })).toThrow();
    expect(() => productUrl("https://evil.example")).toThrow();
    expect(productUrl("amul-test-protein")).toBe("https://shop.amul.com/en/product/amul-test-protein");
  });

  it("accepts only a six-digit nonzero-leading PIN", () => {
    expect(validPincode("500032")).toBe(true);
    for (const pin of ["000000", "50003", "5000320", " 500032", "50003x"]) expect(validPincode(pin)).toBe(false);
  });

  it("parses bounded Retry-After seconds or dates", () => {
    expect(retryAfter("120")).toBe(120);
    expect(retryAfter("Tue, 22 Sep 2026 10:01:00 GMT", Date.parse("2026-09-22T10:00:00Z"))).toBe(60);
    expect(retryAfter("999999999")).toBe(86_400);
    expect(retryAfter("invalid")).toBe(0);
  });

  it("bounds streamed and content-length bodies in bytes", async () => {
    await expect(limitedText(new Response("a".repeat(100)), 10)).rejects.toThrow("response_too_large");
    await expect(limitedText(new Response("x", { headers: { "Content-Length": "100" } }), 10)).rejects.toThrow("response_too_large");
    expect(await limitedText(new Response("ok"), 10)).toBe("ok");
  });

  it("sanitizes network errors and caps external requests", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("sensitive request URL"));
    await expect(new Network().request(new URL("https://shop.amul.com"), {}, "amul", 100))
      .rejects.toThrow("amul_network_or_timeout");
    spy.mockResolvedValue(new Response(""));
    const network = new Network();
    for (let index = 0; index < MAX_SUBREQUESTS; index++) {
      spy.mockResolvedValueOnce(new Response(""));
      await network.request(new URL("https://shop.amul.com"), {}, "amul", 100);
    }
    await expect(network.request(new URL("https://shop.amul.com"), {}, "amul", 100))
      .rejects.toThrow("operation_budget_exhausted");
  });
});
