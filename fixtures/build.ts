/**
 * Builds the placeholder fixtures for the sample calls.
 *
 * Each scripted turn runs through the real turn pipeline (`runTurn`) with a
 * scripted client in place of the model. So the events, tool results, carts,
 * totals, and receipts in `fixtures/turn.json` are produced by the same code
 * the live path uses. Only the agent's wording and choice of tool calls are
 * hand-written, and the fixtures are marked `placeholder: true` to say so.
 *
 *   pnpm fixtures     # rewrite the placeholders in fixtures/turn.json
 */
import { ZERO_USAGE } from "../lib/config";
import type { Fixture, FixtureStore } from "../lib/demo";
import { CONVERSATION, runTurn } from "../lib/order/agent";
import type { TurnRecord } from "../lib/order/history";
import type { TurnData, TurnEvent } from "../lib/order/protocol";
import { SAMPLES } from "../lib/samples";
import { REPLIES } from "./sample-replies";
import { scriptedClient } from "./scripted-client";

export type TurnFixture = Fixture<TurnData, TurnEvent>;
export type TurnFixtureStore = FixtureStore<TurnData, TurnEvent>;

/**
 * Replay pacing for hand-written samples, in milliseconds between events.
 * These are not measurements and are never shown as numbers; they only space
 * the events out so a replay reads as a stream.
 */
const PACE: Record<TurnEvent["type"], number> = {
  kitchen: 0,
  text: 160,
  planning: 200,
  tool: 280,
  round: 0,
};
const FIRST_EVENT_MS = 320;
const AFTER_PLANNING_MS = 1500;

function pace(events: TurnEvent[]): { at: number; event: TurnEvent }[] {
  let at = FIRST_EVENT_MS;
  let previous: TurnEvent["type"] | null = null;
  return events.map((event, index) => {
    if (index > 0) at += previous === "planning" ? AFTER_PLANNING_MS : PACE[event.type];
    previous = event.type;
    return { at, event };
  });
}

export async function buildSampleFixtures(): Promise<TurnFixtureStore> {
  const store: TurnFixtureStore = {};
  for (const sample of SAMPLES) {
    const replies = REPLIES[sample.id];
    if (!replies || replies.length !== sample.turns.length) {
      throw new Error(`Sample "${sample.id}" needs one scripted reply per customer turn.`);
    }
    const turns: TurnRecord[] = [];
    for (const [index, turn] of sample.turns.entries()) {
      const { client } = scriptedClient(replies[index], `${sample.id}_${index + 1}`);
      const events: TurnEvent[] = [];
      const result = await runTurn({
        client,
        request: { turns, text: turn.text, kitchen: turn.kitchen, interrupted: false },
        emit: (event) => events.push(event),
        now: () => 0,
      });
      if ("refusal" in result) throw new Error(`Scripted turn ${turn.demoId} was refused.`);
      const refused = events.filter((event) => event.type === "tool" && !event.ok);
      if (refused.length > 0) {
        throw new Error(
          `Scripted turn ${turn.demoId} made a call the engine refused: ${JSON.stringify(refused)}`,
        );
      }
      if (result.data.unbackedAmounts.length > 0) {
        throw new Error(
          `Scripted turn ${turn.demoId} states ${result.data.unbackedAmounts.join(", ")}, which the engine never produced.`,
        );
      }
      store[turn.demoId] = {
        label: `${sample.title}, turn ${index + 1}`,
        placeholder: true,
        recordedAt: null,
        model: CONVERSATION.model,
        usage: ZERO_USAGE,
        costUsd: 0,
        // Nothing was measured and no model ran, so timing and usage stay empty.
        data: { ...result.data, timing: null, models: [] },
        events: pace(events),
      };
      turns.push({
        text: turn.text,
        kitchen: turn.kitchen,
        interrupted: false,
        assistant: result.data.assistant,
        plans: result.data.plans,
      });
    }
  }
  return store;
}

/** The request body of every sample turn, for `fixtures/presets.json`. */
export function buildPresets(): { route: string; body: unknown }[] {
  return SAMPLES.flatMap((sample) =>
    sample.turns.map((turn) => ({
      route: "/api/turn",
      body: {
        demoId: turn.demoId,
        turns: [],
        text: turn.text,
        kitchen: turn.kitchen,
        interrupted: false,
      },
    })),
  );
}
