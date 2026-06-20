import { describe, expect, it } from "vitest";
import { createHttpEngineTransport, EngineAbortedError, pollUntilDone } from "../src/index.js";

/**
 * The supersession AbortSignal must reach the HTTP client, not just the poll
 * loop (§15.3 mandatory checkpoint): an in-flight request aborts on a newer push.
 */
describe("HTTP transport threads the supersession signal into fetch", () => {
  it("aborts the in-flight poll request when the signal fires", async () => {
    const controller = new AbortController();
    let sawAbortedFetch = false;

    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal | undefined;
      // Simulate a slow request that's cancelled by the supersession signal.
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          sawAbortedFetch = true;
          reject(new DOMException("aborted", "AbortError"));
        });
        controller.abort(); // newer push arrives while this request is in flight
      });
    }) as unknown as typeof fetch;

    const transport = createHttpEngineTransport({ baseUrl: "https://engine.test", fetchImpl });

    // pollUntilDone checks the signal at the boundary; even if a request is mid
    // flight, the combined signal aborts the fetch.
    await expect(
      pollUntilDone(transport, "job_1", {
        depth: "deep",
        signal: controller.signal,
        now: () => 0,
        sleep: async () => {},
      }),
    ).rejects.toBeInstanceOf(EngineAbortedError);

    expect(sawAbortedFetch).toBe(true);
  });
});
