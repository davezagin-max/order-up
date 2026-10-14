import { describe, expect, it } from "vitest";
import { describeStep, latestStepThisTurn, narrate } from "@/components/order/narration";
import type { CallSnapshot, Caption, LogEntry } from "@/lib/voice/session";

const entry = (summary: string, ok = true): LogEntry => ({
  id: summary,
  name: "tool",
  ok,
  summary,
});
const customer: Caption = {
  id: "c1",
  role: "customer",
  text: "Hi",
  scripted: true,
  speaking: false,
};
const tool = (summary: string, ok = true): Caption => ({
  id: `t-${summary}`,
  role: "tool",
  entry: entry(summary, ok),
});
const agent: Caption = { id: "a1", role: "agent", sentences: [], pending: "", cutOff: false };

function snapshot(over: Partial<CallSnapshot>): CallSnapshot {
  return { phase: "idle", captions: [], planning: null, soundOn: true, ...over } as CallSnapshot;
}

describe("sample-call narration", () => {
  it("only reports a tool call made since the customer last spoke", () => {
    expect(latestStepThisTurn([tool("added: chips and salsa"), customer])).toBeNull();
    expect(latestStepThisTurn([customer, tool("pickup name: Dave"), agent])?.summary).toBe(
      "pickup name: Dave",
    );
    expect(
      latestStepThisTurn([customer, tool("added: chips and salsa"), tool("pickup name: Dave")])
        ?.summary,
    ).toBe("pickup name: Dave");
  });

  it("describes each engine summary in plain words", () => {
    expect(describeStep(entry("added: large carnitas burrito, no onions, +guacamole"))).toBe(
      "Code checked the item, priced it, and added it to the cart.",
    );
    expect(describeStep(entry("added group plan P1: 6 items"))).toBe(
      "Code added the planned meals to the cart.",
    );
    expect(describeStep(entry("changed: carnitas quesadilla → steak quesadilla"))).toBe(
      "Code checked the change and updated the cart.",
    );
    expect(describeStep(entry("read back the order"))).toBe(
      "Code pulled up the order so the cashier can read it back.",
    );
    expect(describeStep(entry("planned P1: 6 meals for 6, $59.26 of $60.00"))).toBe(
      "Code checked the plan against the budget and diets.",
    );
    expect(describeStep(entry("confirmed: order 534 for Dave, $20.74"))).toBe(
      "Code placed the order and printed the receipt.",
    );
    expect(describeStep(entry("refused: lobster roll is not on the menu", false))).toBe(
      "Code refused that request, so nothing changed.",
    );
  });

  it("follows the call phase by phase", () => {
    expect(narrate(snapshot({ phase: "listening", captions: [customer] }))).toBe(
      "The customer is ordering…",
    );
    expect(narrate(snapshot({ phase: "thinking", captions: [customer] }))).toBe(
      "The AI cashier is deciding what to do…",
    );
    expect(
      narrate(
        snapshot({ phase: "speaking", captions: [customer, tool("added: chips and salsa")] }),
      ),
    ).toBe(
      "Code checked the item, priced it, and added it to the cart. The AI cashier is answering out loud.",
    );
    expect(narrate(snapshot({ phase: "speaking", captions: [customer], soundOn: false }))).toBe(
      "The AI cashier is answering (sound is off).",
    );
    expect(
      narrate(
        snapshot({ phase: "thinking", planning: { people: 6, budget: "$60.00", needs: [] } }),
      ),
    ).toBe("A stronger AI model is planning the group order…");
  });
});
