/**
 * Every fixture must be something the real pipeline could have produced.
 *
 * These checks hold for hand-written placeholders and for real recordings
 * alike: each sample call is replayed through the order engine, and what the
 * fixture stores (tool outcomes, carts, receipts, kitchen effects) must be
 * exactly what the engine computes. Assertions about the scripted wording
 * apply only to fixtures that are still placeholders.
 */
import { describe, expect, it } from "vitest";
import presets from "@/fixtures/presets.json";
import { buildPresets, buildSampleFixtures, type TurnFixtureStore } from "@/fixtures/build";
import stored from "@/fixtures/turn.json";
import { priceCart } from "@/lib/order/engine";
import { unbackedAmounts } from "@/lib/order/guard";
import { replay, textOf, TurnSchema, type TurnRecord } from "@/lib/order/history";
import { TurnBodySchema } from "@/lib/order/protocol";
import { recordedPrefix } from "@/lib/order/recording";
import { SAMPLES } from "@/lib/samples";

const store = stored as unknown as TurnFixtureStore;

describe("fixture store", () => {
  it("has exactly one fixture for every sample turn", () => {
    const expected = SAMPLES.flatMap((sample) => sample.turns.map((turn) => turn.demoId)).sort();
    expect(Object.keys(store).sort()).toEqual(expected);
  });

  it("marks each fixture honestly: a placeholder has no date, usage, cost, or timing", () => {
    for (const [key, fixture] of Object.entries(store)) {
      if (fixture.placeholder) {
        expect(fixture.recordedAt, key).toBeNull();
        expect(fixture.costUsd, key).toBe(0);
        expect(Object.values(fixture.usage), key).toEqual([0, 0, 0, 0]);
        expect(fixture.data.timing, key).toBeNull();
        expect(fixture.data.models, key).toEqual([]);
      } else {
        expect(typeof fixture.recordedAt, key).toBe("string");
        expect(fixture.data.timing, key).not.toBeNull();
        expect(fixture.data.models.length, key).toBeGreaterThan(0);
      }
    }
  });

  it("lists every sample turn in presets.json so `pnpm record` can replace them", () => {
    expect(presets).toEqual(buildPresets());
    for (const preset of presets) {
      expect(preset.route).toBe("/api/turn");
      expect(TurnBodySchema.safeParse(preset.body).success).toBe(true);
    }
  });
});

describe.each(SAMPLES)("sample call: $title", (sample) => {
  it("replays through the order engine to exactly what the fixtures store", () => {
    const turns: TurnRecord[] = [];
    for (const [index, scripted] of sample.turns.entries()) {
      const fixture = store[scripted.demoId];
      const record: TurnRecord = {
        text: scripted.text,
        kitchen: scripted.kitchen,
        interrupted: false,
        assistant: fixture.data.assistant,
        plans: fixture.data.plans,
      };
      expect(TurnSchema.safeParse(record).success, scripted.demoId).toBe(true);
      turns.push(record);
      const replayed = replay(turns);
      const events = (fixture.events ?? []).map((entry) => entry.event);

      // The final cart and receipt are the engine's.
      expect(fixture.data.cart, scripted.demoId).toEqual(priceCart(replayed.state));
      expect(fixture.data.receipt, scripted.demoId).toEqual(replayed.state.receipt);

      // Every tool event matches the engine's outcome for that call, in order.
      const tools = events.filter((event) => event.type === "tool");
      const log = replayed.log.filter((entry) => entry.turn === index);
      expect(
        tools.map(({ id, name, ok, summary, plan }) => ({
          turn: index,
          id,
          name,
          ok,
          summary,
          ...(plan ? { plan } : {}),
        })),
      ).toEqual(log);
      expect(tools.at(-1)?.cart ?? fixture.data.cart, scripted.demoId).toEqual(fixture.data.cart);

      // Kitchen events are the effects the engine derived from the scripted change.
      const kitchen = events.filter((event) => event.type === "kitchen");
      const effects = replayed.kitchen.find((entry) => entry.turn === index)?.effects;
      expect(kitchen.map((event) => event.effects)).toEqual(effects ? [effects] : []);

      // The streamed text is the text of the stored assistant turns; round events are those turns.
      const streamed = events
        .filter((event) => event.type === "text")
        .map((event) => event.delta)
        .join("");
      expect(streamed, scripted.demoId).toBe(fixture.data.assistant.map(textOf).join(""));
      const rounds = events.filter((event) => event.type === "round");
      expect(rounds.map((event) => event.content)).toEqual(fixture.data.assistant);
      expect(Object.assign({}, ...rounds.map((event) => event.plans))).toEqual(fixture.data.plans);

      // The price check stored with the turn is the one the guard computes.
      const reply = fixture.data.assistant.map(textOf).filter(Boolean).join(" ");
      expect(fixture.data.unbackedAmounts, scripted.demoId).toEqual(
        unbackedAmounts(reply, replayed.steps),
      );

      // Events are in time order.
      const times = (fixture.events ?? []).map((entry) => entry.at);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    }
  });

  it("while it is a placeholder, matches the script and ends with a confirmed order", async () => {
    const built = await buildSampleFixtures();
    const last = sample.turns[sample.turns.length - 1].demoId;
    for (const scripted of sample.turns) {
      const fixture = store[scripted.demoId];
      if (!fixture.placeholder) continue;
      // Hand-written samples are generated from the script; run `pnpm fixtures` after editing it.
      expect(fixture, scripted.demoId).toEqual(built[scripted.demoId]);
      expect(fixture.data.unbackedAmounts, scripted.demoId).toEqual([]);
      if (scripted.demoId === last) expect(fixture.data.receipt?.confirmed).toBe(true);
    }
  });
});

describe("recording a sample call turn by turn", () => {
  const [first, second] = SAMPLES[0].turns;

  it("refuses to continue from a turn that is still hand-written", () => {
    const placeholders = { [first.demoId]: { ...store[first.demoId], placeholder: true } };
    expect(() => recordedPrefix(placeholders, second.demoId)).toThrow(/in order/);
    expect(() => recordedPrefix({}, second.demoId)).toThrow(/in order/);
    expect(() => recordedPrefix({}, "nope-1")).toThrow(/not a sample-call turn/);
  });

  it("builds the earlier turns from fixtures that have been recorded", () => {
    const recorded = { [first.demoId]: { ...store[first.demoId], placeholder: false } };
    expect(recordedPrefix(recorded, first.demoId)).toEqual([]);
    expect(recordedPrefix(recorded, second.demoId)).toEqual([
      {
        text: first.text,
        kitchen: first.kitchen,
        interrupted: false,
        assistant: store[first.demoId].data.assistant,
        plans: store[first.demoId].data.plans,
      },
    ]);
  });
});
