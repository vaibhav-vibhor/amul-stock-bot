import { SafeError } from "./errors";

export const REQUEST_TIMEOUT_MS = 6_000;
export const OPERATION_TIMEOUT_MS = 45_000;
export const MAX_SUBREQUESTS = 32;

export function retryAfter(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const seconds = /^\d+$/.test(value)
    ? Number(value)
    : Math.ceil((Date.parse(value) - now) / 1_000);
  return Number.isFinite(seconds) ? Math.max(0, Math.min(seconds, 86_400)) : 0;
}

export async function limitedText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maximumBytes) {
    await response.body?.cancel();
    throw new SafeError("response_too_large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new SafeError("response_too_large");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export class Network {
  private requests = 0;
  readonly deadline = Date.now() + OPERATION_TIMEOUT_MS;

  remaining(): number {
    return this.deadline - Date.now();
  }

  remainingRequests(): number {
    return MAX_SUBREQUESTS - this.requests;
  }

  async pause(milliseconds: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async request(
    url: URL,
    options: RequestInit,
    service: "amul" | "telegram",
    maximumBytes: number,
  ): Promise<{ response: Response; text: string }> {
    if (++this.requests > MAX_SUBREQUESTS || this.remaining() < 500) {
      throw new SafeError("operation_budget_exhausted");
    }
    try {
      const response = await fetch(url, {
        ...options,
        redirect: "manual",
        signal: AbortSignal.timeout(
          Math.min(REQUEST_TIMEOUT_MS, this.remaining()),
        ),
      });
      const text = await limitedText(response, maximumBytes);
      return { response, text };
    } catch (error) {
      if (error instanceof SafeError) throw error;
      throw new SafeError(`${service}_network_or_timeout`);
    }
  }
}
