import { z } from "zod";
import fixtures from "@/fixtures/turn.json";
import { streamRoute } from "@/lib/api";
import type { FixtureStore } from "@/lib/demo";
import { runTurn } from "@/lib/order/agent";
import { TurnBodySchema, type TurnData, type TurnEvent } from "@/lib/order/protocol";

/**
 * One customer turn of a call.
 *
 * With no key, a sample-call turn replays its fixture event by event. With a
 * key, the turn runs live: the server rebuilds the conversation and the cart
 * from the transcript in the request, runs the model, and streams text, tool
 * calls, and the cart as they happen. The server keeps nothing between turns.
 */
const Body = TurnBodySchema.extend({
  /** Replay a sample turn with no pacing. Used to skip to the end of a sample call. */
  instant: z.boolean().optional(),
});

export const maxDuration = 60;

export const POST = streamRoute({
  store: "turn",
  fixtures: fixtures as unknown as FixtureStore<TurnData, TurnEvent>,
  schema: Body,
  // A long call carries every earlier assistant turn, thinking blocks included.
  maxBytes: 512 * 1024,
  // A sample call is one request per turn, so this is roughly ten calls a minute.
  rateLimit: { limit: 60, windowMs: 60_000 },
  replaySpeed: (body) => (body.instant ? Number.POSITIVE_INFINITY : 1),
  live: async ({ body, client, emit, signal }) => {
    let turns = body.turns;
    if (body.demoId) {
      const recorder = await import("@/lib/demo-record");
      if (recorder.recordingEnabled()) {
        const { recordedPrefixFromDisk } = await import("@/lib/order/recording");
        turns = await recordedPrefixFromDisk(body.demoId);
      }
    }
    return runTurn({
      client,
      request: { turns, text: body.text, kitchen: body.kitchen, interrupted: body.interrupted },
      emit,
      signal,
    });
  },
});
