import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { streamRoute } from "@/lib/api";
import { ZERO_USAGE } from "@/lib/config";

const schema = z.object({
  demoId: z.string().optional(),
  topic: z.string(),
  instant: z.boolean().optional(),
});
const key = { "x-anthropic-key": "sk-ant-test-0123456789abcdef" };

const post = (
  body: unknown,
  init: { headers?: Record<string, string>; signal?: AbortSignal } = {},
) =>
  new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "application/json", ...init.headers },
    body: JSON.stringify(body),
    signal: init.signal,
  });

describe("streamRoute cancellation", () => {
  it("aborts the live handler's signal when the visitor stops reading the response", async () => {
    let aborted = false;
    let finished = false;
    const route = streamRoute({
      store: "x",
      fixtures: {},
      schema,
      live: async ({ emit, signal }) => {
        emit({ step: 1 });
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          });
        });
        finished = true;
        return { data: { answer: "late" }, model: "none", usage: ZERO_USAGE, costUsd: 0 };
      },
    });
    const response = await route(post({ topic: "a" }, { headers: key }));
    const reader = response.body!.getReader();
    await reader.read(); // the meta frame
    expect(aborted).toBe(false);
    await reader.cancel(); // barge-in: the browser aborts the fetch
    await vi.waitFor(() => expect(finished).toBe(true));
    expect(aborted).toBe(true);
  });

  it("aborts the live handler's signal when the request itself is aborted", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | null = null;
    const route = streamRoute({
      store: "x",
      fixtures: {},
      schema,
      live: async ({ signal }) => {
        seen = signal;
        return { data: {}, model: "none", usage: ZERO_USAGE, costUsd: 0 };
      },
    });
    const response = await route(post({ topic: "a" }, { headers: key, signal: controller.signal }));
    await response.text();
    expect(seen!.aborted).toBe(false);
    controller.abort();
    expect(seen!.aborted).toBe(true);
  });

  it("lets a request choose its own replay speed, down to no pacing at all", async () => {
    const fixtures = {
      slow: {
        label: "slow",
        placeholder: true,
        recordedAt: null,
        model: "none",
        usage: ZERO_USAGE,
        costUsd: 0,
        data: {},
        events: [
          { at: 0, event: { step: 1 } },
          { at: 60_000, event: { step: 2 } },
        ],
      },
    };
    const route = streamRoute({
      store: "x",
      fixtures,
      schema,
      live: vi.fn(),
      replaySpeed: (body) => (body.instant ? Number.POSITIVE_INFINITY : 1),
    });
    const started = Date.now();
    const text = await (await route(post({ demoId: "slow", topic: "a", instant: true }))).text();
    expect(text.match(/"type":"event"/g)).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
