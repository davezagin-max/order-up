/**
 * The order engine. Pure, deterministic, and the only thing that knows a price.
 *
 * The model asks for changes through tool calls; this file decides whether
 * each one is valid and what the order costs afterwards. Every function takes
 * a state and returns a new one, so the same calls always produce the same
 * cart, the same tool results, and the same totals. The server relies on that
 * to rebuild the whole conversation from the browser's transcript each turn.
 *
 * Isomorphic on purpose: the browser runs it too, to draw the cart.
 */
import { z } from "zod";
import {
  ADD_ONS,
  ALLERGENS,
  CAFE,
  COMBOS,
  COMPONENTS,
  GROUPS,
  ITEMS,
  basePrice,
  componentName,
  findItem,
  isAddOn,
  isComponent,
  isGroup,
  isSize,
  isStockable,
  leadName,
  sizesOf,
  stockName,
  type Allergen,
  type GroupId,
  type MenuItem,
  type SizeId,
} from "../menu";
import { formatCents, taxOn } from "../money";

export const LIMITS = {
  maxLines: 20,
  maxQuantity: 20,
  maxUnits: 60,
  maxNameLength: 24,
} as const;

// State -------------------------------------------------------------------

/** What a line is, without its id. Also the shape of a planned line. */
export interface LineSpec {
  itemId: string;
  size: SizeId | null;
  /** Required choices, in the item's own group order. */
  choices: Record<string, string>;
  addOns: string[];
  removals: string[];
  quantity: number;
}

export interface Line extends LineSpec {
  id: string;
}

export interface StoredPlan {
  specs: LineSpec[];
}

export interface OrderState {
  lines: Line[];
  nextLine: number;
  pickupName: string | null;
  /** Sorted ids of items, options, and add-ons the kitchen has run out of. */
  outOfStock: string[];
  plans: Record<string, StoredPlan>;
  nextPlan: number;
  /** Bumped on every change to the lines. A read-back is only good for one version. */
  version: number;
  /** The last read-back: which version of the cart, and in which customer turn. */
  review: { version: number; turn: number } | null;
  receipt: Receipt | null;
}

export function emptyOrder(): OrderState {
  return {
    lines: [],
    nextLine: 1,
    pickupName: null,
    outOfStock: [],
    plans: {},
    nextPlan: 1,
    version: 0,
    review: null,
    receipt: null,
  };
}

// Pricing -----------------------------------------------------------------

export interface PricedLine {
  id: string;
  itemId: string;
  /** "large carnitas burrito" */
  name: string;
  quantity: number;
  /** "no onions", "+guacamole" */
  details: string[];
  unitCents: number;
  totalCents: number;
  /** Why the kitchen cannot make this line right now, or null. */
  issue: string | null;
}

export interface AppliedCombo {
  id: string;
  name: string;
  count: number;
  savingsCents: number;
}

export interface PricedCart {
  lines: PricedLine[];
  itemCount: number;
  subtotalCents: number;
  combos: AppliedCombo[];
  savingsCents: number;
  taxCents: number;
  totalCents: number;
  pickupName: string | null;
  confirmed: boolean;
}

export interface Receipt extends PricedCart {
  orderNumber: string;
  readyInMinutes: number;
}

function item(spec: LineSpec): MenuItem {
  const found = findItem(spec.itemId);
  if (!found) throw new Error(`Line refers to an unknown item: ${spec.itemId}`);
  return found;
}

function optionPrice(group: string, option: string): number {
  if (!isGroup(group)) return 0;
  return GROUPS[group].options.find((entry) => entry.id === option)?.priceCents ?? 0;
}

/** Price of one unit of a line: size price, plus option upcharges, plus add-ons. */
export function unitCents(spec: LineSpec): number {
  let cents = basePrice(item(spec), spec.size);
  for (const [group, option] of Object.entries(spec.choices)) cents += optionPrice(group, option);
  for (const addOn of spec.addOns) if (isAddOn(addOn)) cents += ADD_ONS[addOn].priceCents;
  return cents;
}

const CONNECTOR: Partial<Record<GroupId, string>> = { tortilla: "on" };

/** "large carnitas burrito", "grilled chicken street tacos on corn tortillas". */
export function lineName(spec: LineSpec): string {
  const menuItem = item(spec);
  const lead = menuItem.lead ? spec.choices[menuItem.lead] : undefined;
  const head = [
    sizesOf(menuItem).length > 0 ? (spec.size ?? menuItem.defaultSize) : null,
    lead ? leadName(lead) : null,
    menuItem.name.toLowerCase(),
  ]
    .filter(Boolean)
    .join(" ");
  const rest = menuItem.choices
    .filter((group) => group !== menuItem.lead && spec.choices[group])
    .map((group) => `${CONNECTOR[group] ?? "with"} ${componentName(spec.choices[group])}`);
  return [head, ...rest].join(" ");
}

export function lineDetails(spec: LineSpec): string[] {
  return [
    ...spec.removals.map((id) => `no ${componentName(id)}`),
    ...spec.addOns.map((id) => `+${componentName(id)}`),
  ];
}

/** "2 × large carnitas burrito, no onions, +guacamole" */
export function lineSummary(spec: LineSpec): string {
  const quantity = spec.quantity > 1 ? `${spec.quantity} × ` : "";
  return [`${quantity}${lineName(spec)}`, ...lineDetails(spec)].join(", ");
}

/** Everything in a line the kitchen could be out of: the item, its options, its add-ons. */
function stockIdsOf(spec: LineSpec): string[] {
  return [spec.itemId, ...Object.values(spec.choices), ...spec.addOns];
}

function stockIssue(spec: LineSpec, outOfStock: readonly string[]): string | null {
  const missing = stockIdsOf(spec).filter((id) => outOfStock.includes(id));
  if (missing.length === 0) return null;
  return `${missing.map(stockName).join(" and ")} ${missing.length > 1 ? "are" : "is"} out of stock`;
}

function comboCounts(lines: readonly LineSpec[]): AppliedCombo[] {
  const units = new Map<string, number>();
  for (const line of lines) units.set(line.itemId, (units.get(line.itemId) ?? 0) + line.quantity);
  const applied: AppliedCombo[] = [];
  for (const combo of COMBOS) {
    // Slots are disjoint, so the number of complete combos is the scarcest slot.
    const count = Math.min(
      ...combo.slots.map((slot) => slot.reduce((sum, id) => sum + (units.get(id) ?? 0), 0)),
    );
    if (count > 0) {
      applied.push({
        id: combo.id,
        name: combo.name,
        count,
        savingsCents: count * combo.savingsCents,
      });
    }
  }
  return applied;
}

function priceSpecs(
  lines: readonly (LineSpec & { id?: string })[],
  outOfStock: readonly string[],
): Omit<PricedCart, "pickupName" | "confirmed"> {
  const priced = lines.map((line, index): PricedLine => {
    const unit = unitCents(line);
    return {
      id: line.id ?? `P${index + 1}`,
      itemId: line.itemId,
      name: lineName(line),
      quantity: line.quantity,
      details: lineDetails(line),
      unitCents: unit,
      totalCents: unit * line.quantity,
      issue: stockIssue(line, outOfStock),
    };
  });
  const subtotalCents = priced.reduce((sum, line) => sum + line.totalCents, 0);
  const combos = comboCounts(lines);
  const savingsCents = combos.reduce((sum, combo) => sum + combo.savingsCents, 0);
  const taxCents = taxOn(subtotalCents - savingsCents, CAFE.taxBasisPoints);
  return {
    lines: priced,
    itemCount: priced.reduce((sum, line) => sum + line.quantity, 0),
    subtotalCents,
    combos,
    savingsCents,
    taxCents,
    totalCents: subtotalCents - savingsCents + taxCents,
  };
}

/** The cart with every price computed. The only source of money figures in the app. */
export function priceCart(state: OrderState): PricedCart {
  return {
    ...priceSpecs(state.lines, state.outOfStock),
    pickupName: state.pickupName,
    confirmed: state.receipt !== null,
  };
}

/** Prices a list of lines that is not in the cart yet (a proposed group plan). */
export function pricePlan(specs: readonly LineSpec[], outOfStock: readonly string[]) {
  return priceSpecs(specs, outOfStock);
}

// Dietary facts -------------------------------------------------------------

export const DIET_NEEDS = ["vegetarian", "vegan", "gluten_free", "dairy_free", "nut_free"] as const;
export type DietNeed = (typeof DIET_NEEDS)[number];

export interface Traits {
  allergens: Allergen[];
  meat: boolean;
}

/** What is actually in a line: the base, the default ingredients not left off, the choices, the add-ons. */
export function traitsOf(spec: LineSpec): Traits {
  const menuItem = item(spec);
  const parts = [
    ...menuItem.removable.filter((id) => !spec.removals.includes(id)),
    ...Object.values(spec.choices),
    ...spec.addOns,
  ].filter(isComponent);
  const allergens = new Set<Allergen>(menuItem.base.allergens);
  let meat = menuItem.base.meat === true;
  for (const part of parts) {
    const component: { allergens: readonly Allergen[]; meat?: true } = COMPONENTS[part];
    component.allergens.forEach((allergen) => allergens.add(allergen));
    if (component.meat) meat = true;
  }
  return { allergens: ALLERGENS.filter((allergen) => allergens.has(allergen)), meat };
}

export function meetsNeed(traits: Traits, need: DietNeed): boolean {
  const has = (allergen: Allergen) => traits.allergens.includes(allergen);
  switch (need) {
    case "vegetarian":
      return !traits.meat;
    case "vegan":
      return !traits.meat && !has("dairy") && !has("egg");
    case "gluten_free":
      return !has("gluten");
    case "dairy_free":
      return !has("dairy");
    case "nut_free":
      return !has("tree_nuts");
  }
}

// Tool inputs ---------------------------------------------------------------

const ChoiceInput = z.strictObject({ group: z.string().max(40), option: z.string().max(40) });
const Ids = z.array(z.string().max(40)).max(16);

/** Strict objects: an extra field such as `price` fails validation instead of being ignored. */
export const TOOL_INPUTS = {
  add_item: z.strictObject({
    item_id: z.string().max(40),
    size: z.string().max(20).nullable(),
    choices: z.array(ChoiceInput).max(8),
    add_ons: Ids,
    leave_off: Ids,
    quantity: z.number(),
  }),
  update_line: z.strictObject({
    line_id: z.string().max(12),
    quantity: z.number().nullable(),
    size: z.string().max(20).nullable(),
    choices: z.array(ChoiceInput).max(8),
    add_ons_to_add: Ids,
    add_ons_to_remove: Ids,
    leave_off: Ids,
    put_back: Ids,
  }),
  remove_line: z.strictObject({ line_id: z.string().max(12) }),
  set_pickup_name: z.strictObject({ name: z.string().max(200) }),
  review_order: z.strictObject({}),
  confirm_order: z.strictObject({}),
  add_planned_order: z.strictObject({ plan_id: z.string().max(12) }),
} as const;

export type AddItemInput = z.infer<typeof TOOL_INPUTS.add_item>;

type Resolved = { ok: true; spec: LineSpec } | { ok: false; error: string };

const fail = (error: string): Resolved => ({ ok: false, error });

function listOptions(group: GroupId, outOfStock: readonly string[]): string {
  return GROUPS[group].options
    .filter((option) => !outOfStock.includes(option.id))
    .map(
      (option) =>
        `${option.id} (${componentName(option.id)}${option.priceCents ? `, +${formatCents(option.priceCents)}` : ""})`,
    )
    .join(", ");
}

function checkQuantity(quantity: number): string | null {
  if (!Number.isInteger(quantity) || quantity < 1) {
    return "Quantity must be a whole number of at least 1. To take a line off, use remove_line.";
  }
  if (quantity > LIMITS.maxQuantity) {
    return `One line can hold at most ${LIMITS.maxQuantity}. For a bigger order, suggest calling the cafe.`;
  }
  return null;
}

/**
 * Turns a requested configuration into a valid line, or says exactly what is
 * wrong with it. Used for new items, for edits, and for every line of a plan.
 */
export function resolveSpec(
  input: {
    item_id: string;
    size: string | null;
    choices: { group: string; option: string }[];
    add_ons: string[];
    leave_off: string[];
    quantity: number;
  },
  outOfStock: readonly string[],
): Resolved {
  const menuItem = findItem(input.item_id);
  if (!menuItem) {
    return fail(
      `"${input.item_id.slice(0, 40)}" is not on the menu. Only items in the menu can be ordered.`,
    );
  }
  if (outOfStock.includes(menuItem.id)) {
    return fail(`${menuItem.name} is out of stock right now. Offer something else.`);
  }

  const offered = sizesOf(menuItem);
  let size: SizeId | null = null;
  if (offered.length === 0) {
    if (input.size !== null && input.size !== "regular") {
      return fail(`${menuItem.name} comes in one size. Pass size as null.`);
    }
  } else if (input.size === null) {
    size = menuItem.defaultSize ?? offered[0];
  } else if (isSize(input.size) && offered.includes(input.size)) {
    size = input.size;
  } else {
    return fail(`${menuItem.name} comes in ${offered.join(", ")}. Ask which one.`);
  }

  const chosen = new Map<string, string>();
  for (const { group, option } of input.choices) {
    if (!isGroup(group) || !(menuItem.choices as readonly string[]).includes(group)) {
      return fail(`${menuItem.name} has no "${group.slice(0, 40)}" choice.`);
    }
    if (chosen.has(group)) return fail(`The ${GROUPS[group].name} choice is listed twice.`);
    if (!GROUPS[group].options.some((entry) => entry.id === option)) {
      return fail(
        `"${option.slice(0, 40)}" is not a ${GROUPS[group].name} option. Options: ${listOptions(group, outOfStock)}.`,
      );
    }
    if (outOfStock.includes(option)) {
      return fail(
        `${stockName(option)} is out of stock. In stock: ${listOptions(group, outOfStock)}.`,
      );
    }
    chosen.set(group, option);
  }
  const missing = menuItem.choices.filter((group) => !chosen.has(group));
  if (missing.length > 0) {
    return fail(
      `${menuItem.name} needs a ${missing.map((group) => GROUPS[group].name).join(" and a ")}. Ask the customer. ` +
        missing
          .map((group) => `${GROUPS[group].name} options: ${listOptions(group, outOfStock)}.`)
          .join(" "),
    );
  }

  const addOns = new Set<string>();
  for (const addOn of input.add_ons) {
    if (!(menuItem.addOns as readonly string[]).includes(addOn)) {
      const allowed = menuItem.addOns.length
        ? `Add-ons for it: ${menuItem.addOns.join(", ")}.`
        : "It has no add-ons.";
      return fail(`"${addOn.slice(0, 40)}" cannot be added to ${menuItem.name}. ${allowed}`);
    }
    if (addOns.has(addOn)) {
      return fail(`${componentName(addOn)} is listed twice. Each add-on goes on an item once.`);
    }
    if (outOfStock.includes(addOn)) return fail(`${stockName(addOn)} is out of stock.`);
    addOns.add(addOn);
  }

  const removals = new Set<string>();
  for (const removal of input.leave_off) {
    if (!(menuItem.removable as readonly string[]).includes(removal)) {
      const allowed = menuItem.removable.length
        ? `It can be made without: ${menuItem.removable.join(", ")}.`
        : "Nothing can be left off it.";
      return fail(`"${removal.slice(0, 40)}" cannot be left off ${menuItem.name}. ${allowed}`);
    }
    removals.add(removal);
  }

  const quantityProblem = checkQuantity(input.quantity);
  if (quantityProblem) return fail(quantityProblem);

  return {
    ok: true,
    spec: {
      itemId: menuItem.id,
      size,
      // Menu order, not the order the model listed them in, so equal lines are equal.
      choices: Object.fromEntries(menuItem.choices.map((group) => [group, chosen.get(group)!])),
      addOns: menuItem.addOns.filter((id) => addOns.has(id)),
      removals: menuItem.removable.filter((id) => removals.has(id)),
      quantity: input.quantity,
    },
  };
}

// What the model sees ----------------------------------------------------------

/** The order as the model reads it: money is already formatted, so there is nothing to add up. */
export function orderForModel(cart: PricedCart) {
  return {
    lines: cart.lines.map((line) => ({
      line_id: line.id,
      quantity: line.quantity,
      item: line.name,
      details: line.details.join(", "),
      price: formatCents(line.totalCents),
      ...(line.issue ? { problem: line.issue } : {}),
    })),
    subtotal: formatCents(cart.subtotalCents),
    ...(cart.combos.length
      ? {
          combo_savings: cart.combos.map((combo) => ({
            combo: combo.count > 1 ? `${combo.count} × ${combo.name}` : combo.name,
            saves: formatCents(combo.savingsCents),
          })),
        }
      : {}),
    tax: formatCents(cart.taxCents),
    total: formatCents(cart.totalCents),
    pickup_name: cart.pickupName,
  };
}

/** A proposed group plan after it has been checked and priced, for the tool log. */
export interface PlanView {
  planId: string;
  lines: { quantity: number; name: string; details: string[]; price: string }[];
  total: string;
  budget: string | null;
  /** The deterministic checks the plan passed, in words. */
  checks: string[];
}

export interface ToolOutcome {
  ok: boolean;
  /** Returned to the model as the tool result, serialized as JSON. */
  output: Record<string, unknown>;
  /** One receipt-style line for the tool log: "added: large carnitas burrito, no onions". */
  summary: string;
  /** Only for a successful plan: what to show in the tool log. Never sent to the model. */
  plan?: PlanView;
}

export interface Applied {
  state: OrderState;
  outcome: ToolOutcome;
}

function refuse(state: OrderState, error: string): Applied {
  return {
    state,
    outcome: { ok: false, output: { ok: false, error }, summary: `refused: ${error}` },
  };
}

function done(state: OrderState, summary: string, extra: Record<string, unknown> = {}): Applied {
  return {
    state,
    outcome: {
      ok: true,
      output: { ok: true, ...extra, order: orderForModel(priceCart(state)) },
      summary,
    },
  };
}

function units(lines: readonly LineSpec[]): number {
  return lines.reduce((sum, line) => sum + line.quantity, 0);
}

function withLines(state: OrderState, lines: Line[], nextLine = state.nextLine): OrderState {
  return { ...state, lines, nextLine, version: state.version + 1 };
}

// Operations ----------------------------------------------------------------

function addItem(state: OrderState, input: AddItemInput): Applied {
  const resolved = resolveSpec(input, state.outOfStock);
  if (!resolved.ok) return refuse(state, resolved.error);
  if (state.lines.length >= LIMITS.maxLines) {
    return refuse(state, `An order holds at most ${LIMITS.maxLines} lines.`);
  }
  if (units(state.lines) + resolved.spec.quantity > LIMITS.maxUnits) {
    return refuse(
      state,
      `An order holds at most ${LIMITS.maxUnits} items. Suggest calling the cafe.`,
    );
  }
  const line: Line = { id: `L${state.nextLine}`, ...resolved.spec };
  const next = withLines(state, [...state.lines, line], state.nextLine + 1);
  return done(next, `added: ${lineSummary(line)}`, { line_id: line.id });
}

function updateLine(state: OrderState, input: z.infer<typeof TOOL_INPUTS.update_line>): Applied {
  const current = state.lines.find((line) => line.id === input.line_id);
  if (!current) {
    return refuse(state, `There is no line ${input.line_id.slice(0, 12)} in the order.`);
  }
  const overlap = input.leave_off.filter((id) => input.put_back.includes(id));
  if (overlap.length > 0) {
    return refuse(state, `${componentName(overlap[0])} is in both leave_off and put_back.`);
  }
  // Rebuild the full configuration with the edits applied, then validate it like a new line.
  const choices = new Map(Object.entries(current.choices));
  const edited = new Set<string>();
  for (const { group, option } of input.choices) {
    if (edited.has(group))
      return refuse(state, `The ${group.slice(0, 40)} choice is listed twice.`);
    edited.add(group);
    choices.set(group, option);
  }
  const notOnLine = input.add_ons_to_remove.find((id) => !current.addOns.includes(id));
  if (notOnLine) {
    return refuse(
      state,
      `Line ${current.id} has no ${componentName(notOnLine).slice(0, 40)} to take off.`,
    );
  }
  const alreadyOn = input.add_ons_to_add.find((id) => current.addOns.includes(id));
  if (alreadyOn) {
    return refuse(state, `Line ${current.id} already has ${componentName(alreadyOn)}.`);
  }
  const resolved = resolveSpec(
    {
      item_id: current.itemId,
      // An item with one size keeps null. Otherwise a null edit keeps the current size.
      size: input.size ?? current.size,
      choices: [...choices].map(([group, option]) => ({ group, option })),
      add_ons: [
        ...current.addOns.filter((id) => !input.add_ons_to_remove.includes(id)),
        ...input.add_ons_to_add,
      ],
      leave_off: [
        ...current.removals.filter((id) => !input.put_back.includes(id)),
        ...input.leave_off,
      ],
      quantity: input.quantity ?? current.quantity,
    },
    state.outOfStock,
  );
  if (!resolved.ok) return refuse(state, resolved.error);
  const others = units(state.lines) - current.quantity;
  if (others + resolved.spec.quantity > LIMITS.maxUnits) {
    return refuse(
      state,
      `An order holds at most ${LIMITS.maxUnits} items. Suggest calling the cafe.`,
    );
  }
  const updated: Line = { id: current.id, ...resolved.spec };
  if (JSON.stringify(updated) === JSON.stringify(current)) {
    return refuse(state, `Line ${current.id} is already like that. Nothing changed.`);
  }
  const next = withLines(
    state,
    state.lines.map((line) => (line.id === current.id ? updated : line)),
  );
  return done(next, `changed: ${lineSummary(current)} → ${lineSummary(updated)}`, {
    line_id: updated.id,
  });
}

function removeLine(state: OrderState, input: z.infer<typeof TOOL_INPUTS.remove_line>): Applied {
  const current = state.lines.find((line) => line.id === input.line_id);
  if (!current) {
    return refuse(state, `There is no line ${input.line_id.slice(0, 12)} in the order.`);
  }
  const next = withLines(
    state,
    state.lines.filter((line) => line.id !== current.id),
  );
  return done(next, `removed: ${lineSummary(current)}`);
}

/** Letters, spaces, hyphens, apostrophes, and periods only. The name is echoed to the model and printed on the receipt. */
export function cleanPickupName(raw: string): string | null {
  const cleaned = raw
    .normalize("NFKC")
    .replace(/[^\p{L}\p{M} .'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LIMITS.maxNameLength)
    .trim();
  return /\p{L}/u.test(cleaned) ? cleaned : null;
}

function setPickupName(
  state: OrderState,
  input: z.infer<typeof TOOL_INPUTS.set_pickup_name>,
): Applied {
  const name = cleanPickupName(input.name);
  if (!name) return refuse(state, "That is not a usable pickup name. Ask for a first name.");
  return done({ ...state, pickupName: name }, `pickup name: ${name}`);
}

function blockingIssues(state: OrderState): string[] {
  return priceCart(state)
    .lines.filter((line) => line.issue)
    .map((line) => `line ${line.id} (${line.name}): ${line.issue}`);
}

function reviewOrder(state: OrderState, turn: number): Applied {
  if (state.lines.length === 0)
    return refuse(state, "The order is empty. There is nothing to read back.");
  const issues = blockingIssues(state);
  if (issues.length > 0) {
    return refuse(
      state,
      `Fix these before reading the order back: ${issues.join("; ")}. Change or remove those lines.`,
    );
  }
  const next = { ...state, review: { version: state.version, turn } };
  return done(next, "read back the order", {
    next_step:
      "Read every line and the total to the customer, then ask if it is right. Call confirm_order only after they say yes, in a later turn.",
  });
}

function orderNumber(state: OrderState): string {
  // FNV-1a over the order's content: the same order always gets the same number.
  let hash = 0x811c9dc5;
  for (const char of JSON.stringify([state.lines, state.pickupName])) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return String(100 + (hash % 900));
}

function readyInMinutes(state: OrderState): number {
  const meals = state.lines.reduce((sum, line) => sum + (item(line).meal ? line.quantity : 0), 0);
  const others = units(state.lines) - meals;
  return Math.min(30, 5 + 2 * meals + Math.ceil(others / 3));
}

function confirmOrder(state: OrderState, turn: number): Applied {
  if (state.lines.length === 0) return refuse(state, "The order is empty. Nothing to confirm.");
  const issues = blockingIssues(state);
  if (issues.length > 0) {
    return refuse(
      state,
      `Cannot confirm: ${issues.join("; ")}. Change or remove those lines first.`,
    );
  }
  if (!state.pickupName) {
    return refuse(state, "There is no pickup name yet. Ask for one and call set_pickup_name.");
  }
  if (!state.review || state.review.version !== state.version) {
    return refuse(
      state,
      "The order has not been read back since it last changed. Call review_order, read it to the customer, and wait for a yes.",
    );
  }
  if (turn <= state.review.turn) {
    return refuse(
      state,
      "The customer has not answered the read-back yet. Read the order to them and wait for their yes.",
    );
  }
  const cart = priceCart(state);
  const receipt: Receipt = {
    ...cart,
    confirmed: true,
    orderNumber: orderNumber(state),
    readyInMinutes: readyInMinutes(state),
  };
  const next = { ...state, receipt };
  return {
    state: next,
    outcome: {
      ok: true,
      output: {
        ok: true,
        order_number: receipt.orderNumber,
        ready_in_minutes: receipt.readyInMinutes,
        order: orderForModel(priceCart(next)),
        note: "This is a demo. No payment is taken and no food is made.",
      },
      summary: `confirmed: order ${receipt.orderNumber} for ${receipt.pickupName}, ${formatCents(receipt.totalCents)}`,
    },
  };
}

function addPlannedOrder(
  state: OrderState,
  input: z.infer<typeof TOOL_INPUTS.add_planned_order>,
): Applied {
  const plan = Object.prototype.hasOwnProperty.call(state.plans, input.plan_id)
    ? state.plans[input.plan_id]
    : null;
  if (!plan) return refuse(state, `There is no plan ${input.plan_id.slice(0, 12)}.`);
  const stale = plan.specs
    .map((spec) => stockIssue(spec, state.outOfStock))
    .find((issue) => issue !== null);
  if (stale) {
    return refuse(state, `That plan no longer works: ${stale}. Call plan_group_order again.`);
  }
  if (state.lines.length + plan.specs.length > LIMITS.maxLines) {
    return refuse(state, `An order holds at most ${LIMITS.maxLines} lines.`);
  }
  if (units(state.lines) + units(plan.specs) > LIMITS.maxUnits) {
    return refuse(state, `An order holds at most ${LIMITS.maxUnits} items.`);
  }
  const added = plan.specs.map((spec, index): Line => ({
    id: `L${state.nextLine + index}`,
    ...spec,
  }));
  const next = withLines(state, [...state.lines, ...added], state.nextLine + added.length);
  return done(next, `added group plan ${input.plan_id}: ${units(added)} items`, {
    line_ids: added.map((line) => line.id),
  });
}

/** Stores a validated plan under the next plan id. Called by the planner, never by the model directly. */
export function storePlan(
  state: OrderState,
  specs: LineSpec[],
): { state: OrderState; planId: string } {
  const planId = `P${state.nextPlan}`;
  return {
    state: {
      ...state,
      plans: { ...state.plans, [planId]: { specs } },
      nextPlan: state.nextPlan + 1,
    },
    planId,
  };
}

export const ENGINE_TOOLS = Object.keys(TOOL_INPUTS) as (keyof typeof TOOL_INPUTS)[];

/**
 * Applies one tool call. Unknown tools, malformed inputs, and anything the
 * menu does not allow come back as a refusal with the state untouched. There
 * is no operation here that sets a price, so nothing a caller sends can.
 *
 * `turn` is the index of the customer turn the call happened in.
 */
export function applyTool(state: OrderState, name: string, input: unknown, turn: number): Applied {
  if (!Object.prototype.hasOwnProperty.call(TOOL_INPUTS, name)) {
    return refuse(state, `There is no "${name.slice(0, 40)}" operation.`);
  }
  const tool = name as keyof typeof TOOL_INPUTS;
  const parsed = TOOL_INPUTS[tool].safeParse(input);
  if (!parsed.success) {
    return refuse(state, `The ${tool} call had fields the register does not accept.`);
  }
  if (state.receipt) {
    return refuse(state, "This order is already confirmed. It cannot be changed in this call.");
  }
  switch (tool) {
    case "add_item":
      return addItem(state, parsed.data as AddItemInput);
    case "update_line":
      return updateLine(state, parsed.data as z.infer<typeof TOOL_INPUTS.update_line>);
    case "remove_line":
      return removeLine(state, parsed.data as z.infer<typeof TOOL_INPUTS.remove_line>);
    case "set_pickup_name":
      return setPickupName(state, parsed.data as z.infer<typeof TOOL_INPUTS.set_pickup_name>);
    case "review_order":
      return reviewOrder(state, turn);
    case "confirm_order":
      return confirmOrder(state, turn);
    case "add_planned_order":
      return addPlannedOrder(state, parsed.data as z.infer<typeof TOOL_INPUTS.add_planned_order>);
  }
}

// Kitchen ---------------------------------------------------------------------

export interface KitchenChange {
  id: string;
  inStock: boolean;
}

export interface KitchenEffect {
  id: string;
  name: string;
  inStock: boolean;
  /** Cart lines the change affects, as "L2 (large carnitas burrito)". */
  affected: { lineId: string; name: string }[];
  /** In-stock alternatives the agent can offer, by name. */
  alternatives: string[];
}

function alternativesFor(id: string, outOfStock: readonly string[]): string[] {
  const menuItem = findItem(id);
  if (menuItem) {
    return ITEMS.filter(
      (other) =>
        other.category === menuItem.category &&
        other.meal === menuItem.meal &&
        other.id !== id &&
        !outOfStock.includes(other.id),
    )
      .slice(0, 5)
      .map((other) => other.name);
  }
  const groups = (Object.keys(GROUPS) as GroupId[]).filter((group) =>
    GROUPS[group].options.some((option) => option.id === id),
  );
  return [
    ...new Set(
      groups.flatMap((group) =>
        GROUPS[group].options
          .filter((option) => option.id !== id && !outOfStock.includes(option.id))
          .map((option) => componentName(option.id)),
      ),
    ),
  ];
}

/**
 * Applies kitchen changes. Unknown ids and changes that change nothing are
 * dropped, so the browser cannot make the server announce something untrue.
 */
export function applyKitchen(
  state: OrderState,
  changes: readonly KitchenChange[],
): { state: OrderState; effects: KitchenEffect[] } {
  const out = new Set(state.outOfStock);
  const effective: KitchenChange[] = [];
  for (const change of changes) {
    if (!isStockable(change.id)) continue;
    if (change.inStock === !out.has(change.id)) continue;
    if (change.inStock) out.delete(change.id);
    else out.add(change.id);
    effective.push(change);
  }
  const outOfStock = [...out].sort();
  const next = effective.length ? { ...state, outOfStock } : state;
  const effects = effective.map((change): KitchenEffect => ({
    id: change.id,
    name: stockName(change.id),
    inStock: change.inStock,
    affected: change.inStock
      ? []
      : next.lines
          .filter((line) => stockIdsOf(line).includes(change.id))
          .map((line) => ({ lineId: line.id, name: lineName(line) })),
    alternatives: change.inStock ? [] : alternativesFor(change.id, outOfStock),
  }));
  return { state: next, effects };
}
