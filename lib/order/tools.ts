/**
 * The tools the conversation model can call, as strict wire schemas.
 *
 * These are the only operations that exist. There is no tool that sets a
 * price, applies a discount, or adds something that is not on the menu, so no
 * amount of persuasion can make the agent do those things.
 *
 * Strict schemas guarantee the shape of every call. They cannot express
 * ranges or lengths, so the engine checks those after parsing.
 */
import { strictTool, type ToolDef } from "../claude";
import { ADD_ON_IDS, GROUP_IDS, ITEM_IDS, OPTION_IDS, REMOVABLE_IDS, SIZES } from "../menu";
import { DIET_NEEDS } from "./engine";

const choices = {
  type: "array",
  description: "One entry for each required choice the customer made, such as the protein.",
  items: {
    type: "object",
    properties: {
      group: { type: "string", enum: GROUP_IDS },
      option: { type: "string", enum: OPTION_IDS },
    },
    required: ["group", "option"],
    additionalProperties: false,
  },
};

const addOnList = (description: string) => ({
  type: "array",
  description,
  items: { type: "string", enum: ADD_ON_IDS },
});

const ingredientList = (description: string) => ({
  type: "array",
  description,
  items: { type: "string", enum: REMOVABLE_IDS },
});

const size = (description: string) => ({
  anyOf: [{ type: "string", enum: [...SIZES] }, { type: "null" }],
  description,
});

export const PLAN_TOOL = "plan_group_order";

export const ORDER_TOOLS: ToolDef[] = [
  strictTool(
    "add_item",
    "Add one menu item to the order. Call it as soon as the customer has given the required choices for that item. If a required choice is missing, ask for it instead of guessing.",
    {
      item_id: { type: "string", enum: ITEM_IDS },
      size: size("The size the customer asked for, or null to use the item's usual size."),
      choices,
      add_ons: addOnList("Paid extras the customer asked for. Empty when there are none."),
      leave_off: ingredientList(
        "Ingredients the customer wants left off. Empty when there are none.",
      ),
      quantity: { type: "integer", description: "How many of this exact item." },
    },
  ),
  strictTool(
    "update_line",
    "Change a line that is already in the order. Pass null or an empty list for anything that stays the same.",
    {
      line_id: { type: "string", description: "The line to change, such as L2." },
      quantity: {
        anyOf: [{ type: "integer" }, { type: "null" }],
        description: "New quantity, or null.",
      },
      size: size("New size, or null to keep it."),
      choices: { ...choices, description: "Only the required choices that change." },
      add_ons_to_add: addOnList("Extras to put on this line."),
      add_ons_to_remove: addOnList("Extras to take off this line."),
      leave_off: ingredientList("Ingredients to start leaving off."),
      put_back: ingredientList("Ingredients that were left off and should be included again."),
    },
  ),
  strictTool("remove_line", "Take a line out of the order.", {
    line_id: { type: "string", description: "The line to remove, such as L2." },
  }),
  strictTool("set_pickup_name", "Record the name the order will be called out under.", {
    name: { type: "string", description: "The customer's first name." },
  }),
  strictTool(
    "review_order",
    "Get the full order and its total so you can read it back. Call it when the customer says they are done, before asking them to confirm.",
    {},
  ),
  strictTool(
    "confirm_order",
    "Place the order. Only works after review_order, once the customer has heard the read-back and said yes in a later turn, and a pickup name is set.",
    {},
  ),
  strictTool(
    PLAN_TOOL,
    "Ask the planner to build an order for a group with a headcount and optional budget or dietary needs. Use it instead of working out a group order yourself. It returns a priced plan and a plan_id; it does not add anything to the order.",
    {
      party_size: { type: "integer", description: "How many people are eating." },
      budget_dollars: {
        anyOf: [{ type: "number" }, { type: "null" }],
        description:
          "The most they want to spend in dollars, tax included, or null if they gave no budget.",
      },
      dietary_needs: {
        type: "array",
        description:
          "One entry for each group of people who share the same needs. Empty when nobody has any.",
        items: {
          type: "object",
          properties: {
            people: { type: "integer", description: "How many people have exactly these needs." },
            needs: { type: "array", items: { type: "string", enum: [...DIET_NEEDS] } },
          },
          required: ["people", "needs"],
          additionalProperties: false,
        },
      },
      notes: {
        type: "string",
        description:
          "Other preferences in a few words, such as 'no pork' or 'include drinks'. Empty if none.",
      },
    },
  ),
  strictTool(
    "add_planned_order",
    "Add every line of a plan from plan_group_order to the order. Call it only after the customer accepts that plan.",
    { plan_id: { type: "string", description: "The plan_id that plan_group_order returned." } },
  ),
];

export const TOOL_NAMES: string[] = ORDER_TOOLS.map((tool) => tool.name);
