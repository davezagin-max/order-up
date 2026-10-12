import { describe, expect, it } from "vitest";
import { applyTool, emptyOrder, priceCart, type DietNeed, type LineSpec } from "@/lib/order/engine";
import { applyPlan, assignMeals, checkPlan, parseConstraints } from "@/lib/order/plan";

const line = (
  item_id: string,
  choices: Record<string, string> = {},
  extra: { quantity?: number; leave_off?: string[]; add_ons?: string[]; size?: string | null } = {},
) => ({
  item_id,
  size: extra.size ?? null,
  choices: Object.entries(choices).map(([group, option]) => ({ group, option })),
  add_ons: extra.add_ons ?? [],
  leave_off: extra.leave_off ?? [],
  quantity: extra.quantity ?? 1,
});

const sixUnderSixty = {
  party_size: 6,
  budget_dollars: 60,
  dietary_needs: [
    { people: 2, needs: ["vegetarian"] },
    { people: 1, needs: ["gluten_free"] },
  ],
  notes: "",
};

/** Six mains: two vegetarian bowls, tacos on corn, and three others. 55.00 before tax. */
const goodPlan = {
  lines: [
    line("bowl", { protein: "veggies" }, { quantity: 2 }),
    line("tacos", { protein: "chicken", tortilla: "corn" }),
    line("burrito", { protein: "chicken" }),
    line("burrito", { protein: "carnitas" }),
    line("quesadilla", { protein: "chicken" }),
  ],
};

function constraints(input: unknown = sixUnderSixty) {
  const parsed = parseConstraints(input);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.constraints;
}

describe("plan constraints", () => {
  it("expands dietary needs into one entry per person", () => {
    expect(constraints()).toEqual({
      partySize: 6,
      budgetCents: 6000,
      restricted: [["vegetarian"], ["vegetarian"], ["gluten_free"]],
      notes: "",
    });
  });

  it("rejects numbers and needs that make no sense", () => {
    const bad = [
      { ...sixUnderSixty, party_size: 0 },
      { ...sixUnderSixty, party_size: 2.5 },
      { ...sixUnderSixty, party_size: 500 },
      { ...sixUnderSixty, budget_dollars: -5 },
      { ...sixUnderSixty, budget_dollars: Number.POSITIVE_INFINITY },
      { ...sixUnderSixty, dietary_needs: [{ people: 7, needs: ["vegan"] }] },
      { ...sixUnderSixty, dietary_needs: [{ people: 1, needs: ["keto"] }] },
      { ...sixUnderSixty, free: true },
      "six people",
    ];
    for (const input of bad) expect(parseConstraints(input).ok, JSON.stringify(input)).toBe(false);
  });

  it("clips the customer's notes", () => {
    const parsed = constraints({ ...sixUnderSixty, notes: `no   pork\n${"x".repeat(900)}` });
    expect(parsed.notes.startsWith("no pork x")).toBe(true);
    expect(parsed.notes).toHaveLength(200);
  });
});

describe("meal assignment (bipartite matching)", () => {
  const meal = (
    itemId: string,
    choices: Record<string, string>,
    removals: string[] = [],
  ): LineSpec => ({
    itemId,
    size: null,
    choices,
    addOns: [],
    removals,
    quantity: 1,
  });
  const veggieBowl = meal("bowl", { protein: "veggies" }); // vegetarian and gluten-free
  const chickenBowl = meal("bowl", { protein: "chicken" }); // gluten-free only
  const veggieBurrito = meal("burrito", { protein: "veggies" }); // vegetarian only

  it("gives each restricted person a meal of their own", () => {
    const people: DietNeed[][] = [["vegetarian"], ["gluten_free"]];
    // Counting says "one vegetarian meal, one gluten-free meal": true of a single veggie bowl,
    // but one bowl cannot feed two people.
    expect(assignMeals(people, [veggieBowl])).toContain(-1);
    expect(assignMeals(people, [veggieBowl, chickenBowl])).toEqual([0, 1]);
  });

  it("finds an assignment that needs a swap", () => {
    // A greedy pass gives the veggie bowl to the vegetarian and strands the gluten-free person.
    const people: DietNeed[][] = [["vegetarian"], ["gluten_free"]];
    const assigned = assignMeals(people, [veggieBowl, veggieBurrito]);
    expect(assigned).toEqual([1, 0]);
  });

  it("handles a person with two needs", () => {
    const people: DietNeed[][] = [["vegetarian", "gluten_free"], ["vegetarian"]];
    expect(assignMeals(people, [veggieBurrito, veggieBowl])).toEqual([1, 0]);
    expect(assignMeals(people, [veggieBurrito, chickenBowl])).toEqual([-1, 0]);
  });
});

describe("checking a proposed plan", () => {
  it("accepts a plan that feeds everyone within budget and prices it itself", () => {
    const check = checkPlan([], constraints(), goodPlan);
    expect(check).toMatchObject({ ok: true, totalCents: 5500 + 426 });
  });

  it("rejects a plan over budget, by the engine's total with tax", () => {
    const pricey = {
      lines: [...goodPlan.lines, line("chips_guac", {}, { size: "large" })],
    };
    const check = checkPlan([], constraints(), pricey);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.problems.join(" ")).toContain("over the $60.00 budget");
  });

  it("rejects a plan with too few mains, or without a meal for each dietary need", () => {
    const short = { lines: goodPlan.lines.slice(0, 4) };
    const few = checkPlan([], constraints(), short);
    expect(few.ok === false && few.problems.join(" ")).toContain("5 meals for 6 people");

    const noVeg = {
      lines: [
        line("tacos", { protein: "chicken", tortilla: "corn" }, { quantity: 5 }),
        line("bowl", { protein: "veggies" }),
      ],
    };
    const check = checkPlan([], constraints(), noVeg);
    expect(check.ok === false && check.problems).toEqual([
      "1 vegetarian person has no meal of their own that fits.",
    ]);
  });

  it("rejects invalid lines, off-menu items, and anything out of stock", () => {
    const off = checkPlan([], constraints(), {
      lines: [line("lobster_roll"), ...goodPlan.lines],
    });
    expect(off.ok === false && off.problems[0]).toContain("Line 1");
    expect(off.ok === false && off.problems[0]).toContain("not on the menu");

    const missingChoice = checkPlan([], constraints(), {
      lines: [line("burrito", {}, { quantity: 6 })],
    });
    expect(missingChoice.ok === false && missingChoice.problems[0]).toContain("needs a protein");

    const stale = checkPlan(["carnitas"], constraints(), goodPlan);
    expect(stale.ok === false && stale.problems.join(" ")).toContain("carnitas is out of stock");

    expect(checkPlan([], constraints(), { lines: [] }).ok).toBe(false);
    expect(checkPlan([], constraints(), { items: "six burritos" }).ok).toBe(false);
    expect(checkPlan([], constraints(), null).ok).toBe(false);
  });

  it("ignores prices and totals a proposal tries to supply", () => {
    const sneaky = {
      lines: goodPlan.lines.map((entry) => ({ ...entry, price: 0, unit_price: "$0.00" })),
      total: "$1.00",
    };
    const check = checkPlan([], constraints(), sneaky);
    expect(check).toMatchObject({ ok: true, totalCents: 5926 });
  });
});

describe("plan_group_order and add_planned_order", () => {
  it("stores a valid plan, reports engine prices, and adds nothing until it is accepted", () => {
    const planned = applyPlan(emptyOrder(), sixUnderSixty, goodPlan);
    expect(planned.outcome.ok).toBe(true);
    expect(planned.state.lines).toEqual([]);
    expect(planned.outcome.output).toMatchObject({
      plan_id: "P1",
      subtotal: "$55.00",
      tax: "$4.26",
      total: "$59.26",
      budget: "$60.00",
      under_budget_by: "$0.74",
      meals: 6,
    });
    expect(planned.outcome.output.covers).toEqual([
      { need: "vegetarian", meal: "regular veggie burrito bowl" },
      { need: "vegetarian", meal: "regular veggie burrito bowl" },
      { need: "gluten-free", meal: "chicken street tacos on corn tortillas" },
    ]);
    expect(planned.outcome.summary).toBe("planned P1: 6 meals for 6, $59.26 of $60.00");
    expect(planned.outcome.plan?.checks).toEqual([
      "every line is a valid, in-stock menu item",
      "6 meals for 6 people",
      "2 vegetarian meals matched to a person each",
      "1 gluten-free meal matched to a person each",
      "$59.26 with tax is within $60.00",
    ]);

    const added = applyTool(planned.state, "add_planned_order", { plan_id: "P1" }, 1);
    expect(added.outcome.ok).toBe(true);
    expect(added.outcome.summary).toBe("added group plan P1: 6 items");
    expect(added.state.lines.map((entry) => entry.id)).toEqual(["L1", "L2", "L3", "L4", "L5"]);
    expect(priceCart(added.state).totalCents).toBe(5926);
  });

  it("refuses a plan the checker rejects, and says why", () => {
    const refused = applyPlan(emptyOrder(), { ...sixUnderSixty, budget_dollars: 40 }, goodPlan);
    expect(refused.outcome.ok).toBe(false);
    expect(refused.outcome.output.problems).toEqual([
      "The total with tax is $59.26, which is $19.26 over the $40.00 budget.",
    ]);
    expect(refused.state.plans).toEqual({});
  });

  it("refuses when the planner returned nothing, and an unknown or stale plan id", () => {
    expect(applyPlan(emptyOrder(), sixUnderSixty, null).outcome.output.error).toContain(
      "could not produce a plan",
    );
    expect(applyPlan(emptyOrder(), sixUnderSixty, undefined).outcome.ok).toBe(false);

    const planned = applyPlan(emptyOrder(), sixUnderSixty, goodPlan);
    expect(applyTool(planned.state, "add_planned_order", { plan_id: "P7" }, 1).outcome.ok).toBe(
      false,
    );
    expect(
      applyTool(planned.state, "add_planned_order", { plan_id: "constructor" }, 1).outcome.ok,
    ).toBe(false);

    const stale = { ...planned.state, outOfStock: ["carnitas"] };
    const added = applyTool(stale, "add_planned_order", { plan_id: "P1" }, 1);
    expect(added.outcome.output.error).toContain("no longer works: carnitas is out of stock");
    expect(added.state.lines).toEqual([]);
  });
});
