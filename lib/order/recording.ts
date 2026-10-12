/**
 * Support for `pnpm record`. Node-only; loaded lazily by the route and only
 * when the dev server runs with RECORD_FIXTURES=1.
 *
 * A sample call is a chain of turns, and each turn's request must carry the
 * turns before it exactly as the model returned them. The preset list cannot
 * know those in advance, so while recording the route takes the earlier turns
 * from the fixtures that were recorded moments ago.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PipelineError } from "../claude";
import type { FixtureStore } from "../demo";
import { locateDemo } from "../samples";
import type { TurnRecord } from "./history";
import type { TurnData } from "./protocol";

/** The turns before `demoId` in its sample call, rebuilt from recorded fixtures. */
export function recordedPrefix(store: FixtureStore<TurnData>, demoId: string): TurnRecord[] {
  const located = locateDemo(demoId);
  if (!located) throw new PipelineError(`"${demoId}" is not a sample-call turn.`, 400);
  return located.sample.turns.slice(0, located.index).map((turn) => {
    const fixture = Object.prototype.hasOwnProperty.call(store, turn.demoId)
      ? store[turn.demoId]
      : null;
    if (!fixture || fixture.placeholder) {
      // A hand-written turn has no real model output to continue from.
      throw new PipelineError(
        `Record ${turn.demoId} before ${demoId}: sample calls are recorded in order.`,
        409,
      );
    }
    return {
      text: turn.text,
      kitchen: turn.kitchen,
      interrupted: false,
      assistant: fixture.data.assistant,
      plans: fixture.data.plans,
    };
  });
}

export async function recordedPrefixFromDisk(demoId: string): Promise<TurnRecord[]> {
  const file = path.join(process.cwd(), "fixtures", "turn.json");
  const store = JSON.parse(await readFile(file, "utf8")) as FixtureStore<TurnData>;
  return recordedPrefix(store, demoId);
}
