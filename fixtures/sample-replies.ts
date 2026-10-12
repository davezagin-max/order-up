/**
 * The agent's side of the three sample calls, written by hand: what it says
 * and which tools it calls, round by round. These stand in until `pnpm record`
 * replaces them with real model runs.
 *
 * Nothing the engine computes is typed here. Tool results, carts, totals, the
 * order number, and the ready time are filled in by `build.ts`, which runs
 * these calls through the real order engine. Figures in the spoken text use
 * `{total}`-style slots that the builder fills from the engine's own output.
 */

export interface ScriptCall {
  name: string;
  input: unknown;
  /** For `plan_group_order`: the proposal the planner model would return. */
  proposal?: unknown;
}

export interface ScriptRound {
  /** What the agent says in this round. Slots: {total} {savings} {line:L2} {order_number} {ready} {plan_total}. */
  say?: string;
  calls?: ScriptCall[];
}

const add = (
  item_id: string,
  choices: Record<string, string> = {},
  extra: { size?: string; add_ons?: string[]; leave_off?: string[]; quantity?: number } = {},
): ScriptCall => ({
  name: "add_item",
  input: {
    item_id,
    size: extra.size ?? null,
    choices: Object.entries(choices).map(([group, option]) => ({ group, option })),
    add_ons: extra.add_ons ?? [],
    leave_off: extra.leave_off ?? [],
    quantity: extra.quantity ?? 1,
  },
});

const update = (
  line_id: string,
  change: {
    quantity?: number;
    size?: string;
    choices?: Record<string, string>;
    add_ons_to_add?: string[];
    add_ons_to_remove?: string[];
    leave_off?: string[];
    put_back?: string[];
  },
): ScriptCall => ({
  name: "update_line",
  input: {
    line_id,
    quantity: change.quantity ?? null,
    size: change.size ?? null,
    choices: Object.entries(change.choices ?? {}).map(([group, option]) => ({ group, option })),
    add_ons_to_add: change.add_ons_to_add ?? [],
    add_ons_to_remove: change.add_ons_to_remove ?? [],
    leave_off: change.leave_off ?? [],
    put_back: change.put_back ?? [],
  },
});

const planLine = (item_id: string, choices: Record<string, string>, quantity = 1) => ({
  item_id,
  size: null,
  choices: Object.entries(choices).map(([group, option]) => ({ group, option })),
  add_ons: [],
  leave_off: [],
  quantity,
});

/** One list of rounds per customer turn, in the order of `SAMPLES[...].turns`. */
export const REPLIES: Record<string, ScriptRound[][]> = {
  quick: [
    [
      {
        calls: [add("burrito", { protein: "carnitas" }, { size: "large", add_ons: ["guac"], leave_off: ["onions"] })],
      },
      { say: "One large carnitas burrito, no onions, with guacamole. Anything to drink?" },
    ],
    [
      { calls: [add("agua_fresca", { agua_flavor: "horchata" }), add("chips_salsa")] },
      {
        say: "A regular horchata and chips and salsa. Good news: with the burrito, that makes a Counter Combo, so the register took {savings} off. Anything else?",
      },
    ],
    [
      { calls: [{ name: "set_pickup_name", input: { name: "Dave" } }, { name: "review_order", input: {} }] },
      {
        say: "Okay, Dave. I have one large carnitas burrito with no onions and guacamole, a regular horchata, and chips and salsa. With the combo and tax, your total is {total}. Does that sound right?",
      },
    ],
    [
      { calls: [{ name: "confirm_order", input: {} }] },
      {
        say: "You're all set. That's order number {order_number}, and it'll be ready in about {ready} minutes. Thanks, Dave!",
      },
    ],
  ],

  changes: [
    [
      { say: "Sure.", calls: [add("burrito", { protein: "chicken" }, { quantity: 2 })] },
      { say: "Two chicken burritos are in. What would you like in the quesadilla?" },
    ],
    [
      {
        calls: [
          add("quesadilla", { protein: "carnitas" }),
          update("L1", { quantity: 1 }),
          add("bowl", { protein: "steak" }),
        ],
      },
      {
        say: "Done. That's one chicken burrito, a carnitas quesadilla, and a steak bowl. Anything else?",
      },
    ],
    [
      { calls: [add("cold_brew", {}, { size: "large" })] },
      {
        say: "Large cold brew, added. One thing, though. The kitchen just ran out of carnitas, so I can't make that quesadilla. Would chicken or steak work instead?",
      },
    ],
    [
      { calls: [update("L2", { choices: { protein: "steak" } })] },
      { say: "Steak quesadilla it is. That one comes to {line:L2}. Anything else?" },
    ],
    [
      {
        calls: [
          update("L1", { leave_off: ["onions"] }),
          { name: "set_pickup_name", input: { name: "Priya" } },
          { name: "review_order", input: {} },
        ],
      },
      {
        say: "Okay, Priya. One chicken burrito with no onions, a steak quesadilla, a steak bowl, and a large cold brew. Your total with tax is {total}. Is that right?",
      },
    ],
    [
      { calls: [{ name: "confirm_order", input: {} }] },
      { say: "Order {order_number} is in. It'll be ready in about {ready} minutes. Thanks, Priya!" },
    ],
  ],

  group: [
    [
      {
        say: "We don't have lobster rolls, and I can't give anything away or change a price. I can ring up anything on the menu, though. What would you like?",
      },
    ],
    [
      { calls: [add("burrito", { protein: "carnitas" })] },
      {
        say: "I've added a regular carnitas burrito at {line:L1}. There's no discount I can apply. The register sets every price.",
      },
    ],
    [
      {
        say: "No problem. Let me work that out.",
        calls: [
          { name: "remove_line", input: { line_id: "L1" } },
          {
            name: "plan_group_order",
            input: {
              party_size: 6,
              budget_dollars: 60,
              dietary_needs: [
                { people: 2, needs: ["vegetarian"] },
                { people: 1, needs: ["gluten_free"] },
              ],
              notes: "",
            },
            proposal: {
              lines: [
                planLine("bowl", { protein: "veggies" }, 2),
                planLine("tacos", { protein: "chicken", tortilla: "corn" }),
                planLine("burrito", { protein: "chicken" }),
                planLine("burrito", { protein: "carnitas" }),
                planLine("quesadilla", { protein: "chicken" }),
              ],
            },
          },
        ],
      },
      {
        say: "Here's a plan for six. Two veggie bowls for the vegetarians, chicken tacos on corn tortillas for the gluten-free person, a chicken burrito, a carnitas burrito, and a chicken quesadilla. It comes to {plan_total} with tax, just under your budget. Want me to add it?",
      },
    ],
    [
      {
        calls: [
          { name: "add_planned_order", input: { plan_id: "P1" } },
          { name: "set_pickup_name", input: { name: "Sam" } },
          { name: "review_order", input: {} },
        ],
      },
      {
        say: "All six are in, Sam. Two veggie bowls, chicken tacos on corn, a chicken burrito, a carnitas burrito, and a chicken quesadilla. Your total is {total}. Shall I place it?",
      },
    ],
    [
      { calls: [{ name: "confirm_order", input: {} }] },
      { say: "Done. That's order {order_number}, ready in about {ready} minutes. Thanks, Sam!" },
    ],
  ],
};
