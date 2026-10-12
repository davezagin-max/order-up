/**
 * Group-order planning, the deterministic half.
 *
 * Claude Opus 5.5 proposes a list of lines for "six people under sixty
 * dollars, two vegetarians, one gluten-free". This file decides whether the
 * proposal is real: every line must be a valid, in-stock menu configuration,
 * the engine prices it, the total must fit the budget, and every person with
 * a dietary need must have a meal of their own that meets it.
 */
import * as z from "zod/mini";
import { findItem } from "../menu";
import { dollarsToCents, formatCents } from "../money";
import {
  DIET_NEEDS,
  lineSummary,
  meetsNeed,
  orderForModel,
  pricePlan,
  resolveSpec,
  storePlan,
  traitsOf,
  type Applied,
  type DietNeed,
  type LineSpec,
  type OrderState,
  type PlanView,
} from "./engine";

export const PLAN_LIMITS = { maxParty: 12, maxLines: 16, maxNotes: 200 } as const;

/** What the conversation model sends when it calls `plan_group_order`. */
export const PlanInput = z.strictObject({
  party_size: z.number(),
  budget_dollars: z.nullable(z.number()),
  dietary_needs: z
    .array(
      z.strictObject({
        people: z.number(),
        needs: z.array(z.string().check(z.maxLength(20))).check(z.maxLength(5)),
      }),
    )
    .check(z.maxLength(8)),
  notes: z.string().check(z.maxLength(1000)),
});

export interface PlanConstraints {
  partySize: number;
  budgetCents: number | null;
  /** One entry per person who has dietary needs. Everyone else eats anything. */
  restricted: DietNeed[][];
  notes: string;
}

export type ParsedConstraints =
  { ok: true; constraints: PlanConstraints } | { ok: false; error: string };

export function parseConstraints(input: unknown): ParsedConstraints {
  const parsed = PlanInput.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "The plan_group_order call had fields the planner does not accept.",
    };
  }
  const { party_size, budget_dollars, dietary_needs, notes } = parsed.data;
  if (!Number.isInteger(party_size) || party_size < 1 || party_size > PLAN_LIMITS.maxParty) {
    return {
      ok: false,
      error: `The planner handles 1 to ${PLAN_LIMITS.maxParty} people. For a bigger group, suggest calling the cafe.`,
    };
  }
  let budgetCents: number | null = null;
  if (budget_dollars !== null) {
    budgetCents = dollarsToCents(budget_dollars);
    if (budgetCents === null)
      return { ok: false, error: "The budget must be a positive dollar amount." };
  }
  const restricted: DietNeed[][] = [];
  for (const group of dietary_needs) {
    if (!Number.isInteger(group.people) || group.people < 1) {
      return { ok: false, error: "Each dietary need must cover at least one person." };
    }
    const unknown = group.needs.find((need) => !(DIET_NEEDS as readonly string[]).includes(need));
    if (unknown !== undefined) {
      return {
        ok: false,
        error: `"${unknown}" is not a dietary need the menu tracks. Tracked: ${DIET_NEEDS.join(", ")}.`,
      };
    }
    const needs = DIET_NEEDS.filter((need) => group.needs.includes(need));
    if (needs.length === 0) continue;
    for (let person = 0; person < group.people; person++) restricted.push(needs);
  }
  if (restricted.length > party_size) {
    return {
      ok: false,
      error: "More people have dietary needs than are in the party. Check the numbers.",
    };
  }
  return {
    ok: true,
    constraints: {
      partySize: party_size,
      budgetCents,
      restricted,
      notes: notes.replace(/\s+/g, " ").trim().slice(0, PLAN_LIMITS.maxNotes),
    },
  };
}

/**
 * The structured output Opus returns. Kept free of length and range limits,
 * which the structured-output schema does not support; `checkPlan` enforces them.
 */
export const PlanProposal = z.object({
  lines: z.array(
    z.object({
      item_id: z.string(),
      size: z.nullable(z.string()),
      choices: z.array(z.object({ group: z.string(), option: z.string() })),
      add_ons: z.array(z.string()),
      leave_off: z.array(z.string()),
      quantity: z.number(),
    }),
  ),
});
export type PlanProposal = z.infer<typeof PlanProposal>;

/**
 * Can every restricted person get their own meal? A meal that is both
 * vegetarian and gluten-free can feed the vegetarian or the gluten-free
 * person, not both, so counting is not enough. This is bipartite matching
 * (Kuhn's augmenting paths) between people and meal units.
 * Returns the index of each person's meal, or -1 for a person left without one.
 */
export function assignMeals(restricted: DietNeed[][], meals: LineSpec[]): number[] {
  const traits = meals.map(traitsOf);
  const fits = restricted.map((needs) =>
    traits.map((meal) => needs.every((need) => meetsNeed(meal, need))),
  );
  const eater = new Array<number>(meals.length).fill(-1);

  const place = (person: number, seen: boolean[]): boolean => {
    for (let meal = 0; meal < meals.length; meal++) {
      if (!fits[person][meal] || seen[meal]) continue;
      seen[meal] = true;
      if (eater[meal] === -1 || place(eater[meal], seen)) {
        eater[meal] = person;
        return true;
      }
    }
    return false;
  };

  // People with the fewest options go first. The number of people fed is the same in any order.
  const order = restricted
    .map((_, person) => person)
    .sort((a, b) => fits[a].filter(Boolean).length - fits[b].filter(Boolean).length || a - b);
  for (const person of order) place(person, new Array<boolean>(meals.length).fill(false));

  const mealOf = new Array<number>(restricted.length).fill(-1);
  eater.forEach((person, meal) => {
    if (person !== -1) mealOf[person] = meal;
  });
  return mealOf;
}

const NEED_LABEL: Record<DietNeed, string> = {
  vegetarian: "vegetarian",
  vegan: "vegan",
  gluten_free: "gluten-free",
  dairy_free: "dairy-free",
  nut_free: "nut-free",
};

export function describeNeeds(needs: DietNeed[]): string {
  return needs.map((need) => NEED_LABEL[need]).join(" and ");
}

export type PlanCheck =
  { ok: true; specs: LineSpec[]; totalCents: number } | { ok: false; problems: string[] };

/** Validates and prices a proposal against the menu, the stock, and the customer's constraints. */
export function checkPlan(
  outOfStock: readonly string[],
  constraints: PlanConstraints,
  proposal: unknown,
): PlanCheck {
  const parsed = PlanProposal.safeParse(proposal);
  if (!parsed.success) return { ok: false, problems: ["The plan was not in the expected shape."] };
  if (parsed.data.lines.length === 0) return { ok: false, problems: ["The plan has no lines."] };
  if (parsed.data.lines.length > PLAN_LIMITS.maxLines) {
    return { ok: false, problems: [`A plan can have at most ${PLAN_LIMITS.maxLines} lines.`] };
  }

  const problems: string[] = [];
  const specs: LineSpec[] = [];
  parsed.data.lines.forEach((line, index) => {
    const resolved = resolveSpec(line, outOfStock);
    if (resolved.ok) specs.push(resolved.spec);
    else problems.push(`Line ${index + 1}: ${resolved.error}`);
  });
  if (problems.length > 0) return { ok: false, problems };

  const meals = specs.flatMap((spec) =>
    findItem(spec.itemId)?.meal ? new Array<LineSpec>(spec.quantity).fill(spec) : [],
  );
  if (meals.length < constraints.partySize) {
    problems.push(
      `The plan has ${meals.length} meal${meals.length === 1 ? "" : "s"} for ${constraints.partySize} people. Everyone needs a main dish of their own.`,
    );
  }
  const mealOf = assignMeals(constraints.restricted, meals);
  const unfed = constraints.restricted.filter((_, person) => mealOf[person] === -1);
  if (unfed.length > 0) {
    const counts = new Map<string, number>();
    for (const needs of unfed) {
      const label = describeNeeds(needs);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    for (const [label, count] of counts) {
      problems.push(
        `${count} ${label} ${count === 1 ? "person has" : "people have"} no meal of their own that fits.`,
      );
    }
  }
  const { totalCents } = pricePlan(specs, outOfStock);
  if (constraints.budgetCents !== null && totalCents > constraints.budgetCents) {
    problems.push(
      `The total with tax is ${formatCents(totalCents)}, which is ${formatCents(totalCents - constraints.budgetCents)} over the ${formatCents(constraints.budgetCents)} budget.`,
    );
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, specs, totalCents };
}

/**
 * The `plan_group_order` tool as the engine sees it. `proposal` is whatever
 * the planner returned (or what the browser sent back on a later turn); it is
 * validated and priced here every time, so it is never trusted as given.
 */
export function applyPlan(state: OrderState, input: unknown, proposal: unknown): Applied {
  const refuse = (error: string, extra: Record<string, unknown> = {}): Applied => ({
    state,
    outcome: {
      ok: false,
      output: { ok: false, error, ...extra },
      summary: `plan refused: ${error}`,
    },
  });
  if (state.receipt) return refuse("This order is already confirmed.");
  const parsed = parseConstraints(input);
  if (!parsed.ok) return refuse(parsed.error);
  if (proposal === null || proposal === undefined) {
    return refuse(
      "The planner could not produce a plan. Help the customer build the order item by item.",
    );
  }
  const check = checkPlan(state.outOfStock, parsed.constraints, proposal);
  if (!check.ok) {
    return refuse(
      "No plan that fits was found. Tell the customer, and ask whether to raise the budget or change the group's needs.",
      { problems: check.problems },
    );
  }
  const { constraints } = parsed;
  const stored = storePlan(state, check.specs);
  const priced = pricePlan(check.specs, state.outOfStock);
  const mealSpecs = check.specs.flatMap((spec) =>
    findItem(spec.itemId)?.meal ? new Array<LineSpec>(spec.quantity).fill(spec) : [],
  );
  const mealOf = assignMeals(constraints.restricted, mealSpecs);
  const plan = orderForModel({ ...priced, pickupName: null, confirmed: false });
  const needCounts = new Map<string, number>();
  for (const needs of constraints.restricted) {
    const label = describeNeeds(needs);
    needCounts.set(label, (needCounts.get(label) ?? 0) + 1);
  }
  const view: PlanView = {
    planId: stored.planId,
    lines: priced.lines.map((line) => ({
      quantity: line.quantity,
      name: line.name,
      details: line.details,
      price: formatCents(line.totalCents),
    })),
    total: formatCents(check.totalCents),
    budget: constraints.budgetCents !== null ? formatCents(constraints.budgetCents) : null,
    checks: [
      "every line is a valid, in-stock menu item",
      `${mealSpecs.length} meals for ${constraints.partySize} people`,
      ...[...needCounts].map(
        ([label, count]) =>
          `${count} ${label} ${count === 1 ? "meal" : "meals"} matched to a person each`,
      ),
      ...(constraints.budgetCents !== null
        ? [
            `${formatCents(check.totalCents)} with tax is within ${formatCents(constraints.budgetCents)}`,
          ]
        : []),
    ],
  };
  return {
    state: stored.state,
    outcome: {
      ok: true,
      plan: view,
      output: {
        ok: true,
        plan_id: stored.planId,
        lines: plan.lines.map(({ quantity, item, details, price }) => ({
          quantity,
          item,
          details,
          price,
        })),
        subtotal: plan.subtotal,
        ...(plan.combo_savings ? { combo_savings: plan.combo_savings } : {}),
        tax: plan.tax,
        total: plan.total,
        ...(constraints.budgetCents !== null
          ? {
              budget: formatCents(constraints.budgetCents),
              under_budget_by: formatCents(constraints.budgetCents - check.totalCents),
            }
          : {}),
        meals: mealSpecs.length,
        covers: constraints.restricted.map((needs, person) => ({
          need: describeNeeds(needs),
          meal: lineSummary({ ...mealSpecs[mealOf[person]], quantity: 1 }),
        })),
        next_step:
          "Nothing is in the order yet. Describe this plan briefly with its total and ask if they want it. If yes, call add_planned_order with this plan_id.",
      },
      summary: `planned ${stored.planId}: ${mealSpecs.length} meals for ${constraints.partySize}, ${formatCents(check.totalCents)}${
        constraints.budgetCents !== null ? ` of ${formatCents(constraints.budgetCents)}` : ""
      }`,
    },
  };
}
