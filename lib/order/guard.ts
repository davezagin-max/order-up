/**
 * A check you can watch: did the reply state a dollar amount the register
 * never produced?
 *
 * The system prompt tells the model to quote money only from tool results or
 * the menu. This finds every amount in a reply and compares it with every
 * amount the model was actually given. It runs after the fact (the sentence
 * may already have been spoken), so it flags rather than blocks.
 */
import { ADD_ONS, COMBOS, GROUPS, ITEMS, CAFE } from "../menu";
import { formatCents } from "../money";
import type { Step } from "./history";

const SYMBOL_AMOUNT = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?!\d)/g;
const WORD_AMOUNT =
  /\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))? dollars?(?: and (\d{1,2}) cents?)?/gi;
const CENTS_ONLY = /\b(\d{1,2}) cents?\b/gi;

function toCents(whole: string, fraction: string | undefined): number {
  return Number(whole.replaceAll(",", "")) * 100 + (fraction ? Number(fraction.padEnd(2, "0")) : 0);
}

/** Every dollar amount written in `text`, in cents. Understands "$8.50", "$8", "8 dollars and 50 cents", "75 cents". */
export function amountsIn(text: string): number[] {
  const found: number[] = [];
  let rest = text;
  for (const match of text.matchAll(SYMBOL_AMOUNT)) found.push(toCents(match[1], match[2]));
  rest = rest.replace(SYMBOL_AMOUNT, " ");
  for (const match of rest.matchAll(WORD_AMOUNT)) {
    found.push(toCents(match[1], match[2]) + (match[3] ? Number(match[3]) : 0));
  }
  rest = rest.replace(WORD_AMOUNT, " ");
  for (const match of rest.matchAll(CENTS_ONLY)) found.push(Number(match[1]));
  return found;
}

/** Every price printed on the menu: sizes, upcharges, add-ons, combo savings. */
export function menuAmounts(): Set<number> {
  const amounts = new Set<number>();
  for (const item of ITEMS) {
    if (typeof item.price === "number") amounts.add(item.price);
    else Object.values(item.price).forEach((cents) => amounts.add(cents));
  }
  for (const group of Object.values(GROUPS)) {
    for (const option of group.options) if (option.priceCents) amounts.add(option.priceCents);
  }
  Object.values(ADD_ONS).forEach((addOn) => amounts.add(addOn.priceCents));
  COMBOS.forEach((combo) => amounts.add(combo.savingsCents));
  return amounts;
}

/** Every amount the model has been shown so far: the menu, tool results, and the customer's own words. */
export function backedAmounts(steps: readonly Step[]): Set<number> {
  const amounts = menuAmounts();
  for (const step of steps) {
    if (step.kind !== "user") continue;
    for (const result of step.results)
      amountsIn(result.content).forEach((cents) => amounts.add(cents));
    for (const text of step.texts) amountsIn(text).forEach((cents) => amounts.add(cents));
  }
  return amounts;
}

/** Amounts in `reply` that nothing backs, formatted, without repeats. */
export function unbackedAmounts(reply: string, steps: readonly Step[]): string[] {
  const backed = backedAmounts(steps);
  return [...new Set(amountsIn(reply).filter((cents) => !backed.has(cents)))].map(formatCents);
}

/** The tax rate as the menu states it, for callers that describe the check. */
export const TAX_PERCENT = (CAFE.taxBasisPoints / 100).toFixed(2);
