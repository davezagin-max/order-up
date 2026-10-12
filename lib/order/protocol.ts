/**
 * The wire contract between the browser and `/api/turn`: the request body, the
 * events streamed during a turn, and the final result. The browser imports
 * only the types; the request schemas are used by the route.
 */
import { z } from "zod";
import type { Usage } from "../config";
import type { KitchenEffect, PlanView, PricedCart, Receipt } from "./engine";
import { CALL_LIMITS, type Block, type TurnRecord } from "./history";

const KitchenChangeSchema = z.strictObject({ id: z.string().max(40), inStock: z.boolean() });

/**
 * One stored turn as the browser sends it back. Strict: there is no field for
 * a tool result, a cart, or a price, so the browser has nowhere to put one.
 */
export const TurnSchema = z.strictObject({
  text: z.string().max(CALL_LIMITS.maxTextLength),
  kitchen: z.array(KitchenChangeSchema).max(CALL_LIMITS.maxKitchenChanges),
  interrupted: z.boolean(),
  assistant: z
    .array(z.array(z.record(z.string(), z.unknown())).max(CALL_LIMITS.maxBlocksPerRound))
    .max(CALL_LIMITS.maxRounds),
  plans: z.record(z.string().max(128), z.unknown()),
}) satisfies z.ZodType<TurnRecord>;

export const TurnBodySchema = z.strictObject({
  /** Present on a sample-call turn: the fixture to replay. */
  demoId: z.string().max(64).optional(),
  /** Every earlier turn of this call, as the browser holds it. */
  turns: z.array(TurnSchema).max(CALL_LIMITS.maxTurns - 1),
  /** What the customer just said. */
  text: z.string().min(1).max(CALL_LIMITS.maxTextLength),
  /** Kitchen changes since the last turn: ids and a flag, never wording. */
  kitchen: TurnSchema.shape.kitchen,
  interrupted: z.boolean(),
});
export type TurnBody = z.infer<typeof TurnBodySchema>;

export type TurnEvent =
  /** Kitchen changes that took effect this turn. The server told the model in a system message. */
  | { type: "kitchen"; effects: KitchenEffect[] }
  /** Streamed reply text. */
  | { type: "text"; delta: string }
  /** The planning tool was called and Opus is working on it. */
  | { type: "planning"; people: number; budget: string | null; needs: string[] }
  /** A tool call went through the engine. `cart` is the order afterwards. */
  | {
      type: "tool";
      id: string;
      name: string;
      ok: boolean;
      summary: string;
      cart: PricedCart;
      plan?: PlanView;
    }
  /**
   * One model round is complete and its tool calls are applied. The browser
   * stores it, so a turn cut off later still keeps what already happened.
   */
  | { type: "round"; content: Block[]; plans: Record<string, unknown> };

export interface ModelUse {
  role: "conversation" | "planner";
  model: string;
  calls: number;
  usage: Usage;
  costUsd: number;
}

export interface TurnData {
  /** This turn's assistant rounds, exactly as the model returned them. */
  assistant: Block[][];
  plans: Record<string, unknown>;
  cart: PricedCart;
  receipt: Receipt | null;
  /**
   * Server clock marks for a live run, in milliseconds from the start of the
   * request. Null in hand-written samples: nothing was measured.
   */
  timing: { firstTextMs: number | null; totalMs: number } | null;
  models: ModelUse[];
  /** Dollar amounts in the reply that no tool result, menu price, or customer line backs. */
  unbackedAmounts: string[];
}
