/**
 * The cart is a pure function of the conversation.
 *
 * The server keeps no session. The browser holds the transcript: what the
 * customer said, what the kitchen changed, and each assistant turn exactly as
 * the model returned it. `replay` walks that transcript and runs every tool
 * call through the order engine again. That rebuilds the cart and regenerates
 * every tool result from scratch, so:
 *
 *   - tool results from the browser are never used (it does not even send them),
 *   - a tampered transcript can only produce calls the engine validates, and
 *   - the rebuilt history is identical every turn, which keeps the prompt
 *     cache warm and the model's thinking blocks valid.
 *
 * Isomorphic: the browser calls `replay` to draw the cart from the same data.
 */
import { z } from "zod";
import {
  applyKitchen,
  applyTool,
  emptyOrder,
  type Applied,
  type KitchenChange,
  type KitchenEffect,
  type OrderState,
  type ToolOutcome,
} from "./engine";
import { applyPlan } from "./plan";

export const CALL_LIMITS = {
  /** Customer turns in one call, including the one being answered. */
  maxTurns: 30,
  /** Model rounds in one turn (a round is one model response). */
  maxRounds: 6,
  maxTextLength: 500,
  maxBlocksPerRound: 24,
  maxKitchenChanges: 40,
} as const;

/** A content block exactly as the API returned it. Opaque apart from its `type`. */
export type Block = Record<string, unknown>;

export interface TurnRecord {
  /** What the customer said or typed. */
  text: string;
  /** What the staff changed in the kitchen since the previous turn. Data only, never wording. */
  kitchen: KitchenChange[];
  /** True when the customer cut the previous reply off by starting to talk. */
  interrupted: boolean;
  /** One entry per model round, unmodified. A cancelled turn keeps only the rounds that finished. */
  assistant: Block[][];
  /** The planner's proposals, by tool_use id. Re-validated and re-priced on every replay. */
  plans: Record<string, unknown>;
}

const KitchenChangeSchema = z.strictObject({ id: z.string().max(40), inStock: z.boolean() });

export const TurnSchema = z.strictObject({
  text: z.string().max(CALL_LIMITS.maxTextLength),
  kitchen: z.array(KitchenChangeSchema).max(CALL_LIMITS.maxKitchenChanges),
  interrupted: z.boolean(),
  assistant: z
    .array(z.array(z.record(z.string(), z.unknown())).max(CALL_LIMITS.maxBlocksPerRound))
    .max(CALL_LIMITS.maxRounds),
  plans: z.record(z.string().max(128), z.unknown()),
});

export interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

/** Thrown when a transcript is not something this app could have produced. */
export class TranscriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptError";
  }
}

const BLOCK_TYPES = new Set(["text", "thinking", "redacted_thinking", "tool_use"]);
const TOOL_USE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The tool calls in one round, after checking the round only holds block types the model emits. */
export function toolUsesOf(round: Block[]): ToolUse[] {
  if (round.length === 0) throw new TranscriptError("An assistant turn was empty.");
  const uses: ToolUse[] = [];
  for (const block of round) {
    if (typeof block.type !== "string" || !BLOCK_TYPES.has(block.type)) {
      throw new TranscriptError("An assistant turn held a block type this app never stores.");
    }
    if (block.type === "text" && typeof block.text !== "string") {
      throw new TranscriptError("A text block had no text.");
    }
    if (block.type !== "tool_use") continue;
    if (typeof block.id !== "string" || !TOOL_USE_ID.test(block.id)) {
      throw new TranscriptError("A tool call had no usable id.");
    }
    if (typeof block.name !== "string") throw new TranscriptError("A tool call had no name.");
    if (uses.some((use) => use.id === block.id)) {
      throw new TranscriptError("Two tool calls in one turn shared an id.");
    }
    uses.push({ id: block.id, name: block.name, input: block.input });
  }
  return uses;
}

export function textOf(round: Block[]): string {
  return round
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

export const PLAN_TOOL_NAME = "plan_group_order";

/** One tool call through the engine. `proposal` is only read for the planning tool. */
export function applyCall(
  state: OrderState,
  call: ToolUse,
  turn: number,
  proposal: unknown,
): Applied {
  if (call.name === PLAN_TOOL_NAME) return applyPlan(state, call.input, proposal);
  return applyTool(state, call.name, call.input, turn);
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: true;
}

export function toolResult(call: ToolUse, outcome: ToolOutcome): ToolResultBlock {
  return {
    type: "tool_result",
    tool_use_id: call.id,
    content: JSON.stringify(outcome.output),
    ...(outcome.ok ? {} : { is_error: true as const }),
  };
}

// Notes the server writes ------------------------------------------------------

export const INTERRUPT_NOTE =
  "The customer started talking before your last reply finished, so they may not have heard all of it. Any tool calls you made still took effect. Do not repeat yourself at length; answer what they just said.";

function listNames(names: string[]): string {
  return names.length <= 1
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The wording of a kitchen update. Written here, from the menu and the cart,
 * so the browser can only ever say "this id went out of stock", never
 * supply text that lands in a system message.
 */
export function kitchenNote(effects: KitchenEffect[]): string {
  const lines = effects.map((effect) => {
    if (effect.inStock) return `${effect.name} is available again.`;
    if (effect.affected.length === 0) {
      return `${effect.name} just ran out. Nothing in the order uses it. Do not offer it.`;
    }
    const where = listNames(effect.affected.map((line) => `line ${line.lineId} (${line.name})`));
    const instead = effect.alternatives.length
      ? ` In stock instead: ${listNames(effect.alternatives)}.`
      : "";
    return `${effect.name} just ran out. It is in the order on ${where}. Tell the customer now, offer something that is in stock, and change or remove ${effect.affected.length > 1 ? "those lines" : "that line"}.${instead}`;
  });
  return `Kitchen update from the staff. ${lines.join(" ")}`;
}

// Replay ---------------------------------------------------------------------

/** One message of the rebuilt conversation, before it is put in API form. */
export type Step =
  | {
      kind: "user";
      /** Results of the tool calls in the assistant step just before this one. */
      results: ToolResultBlock[];
      /** Customer utterances, oldest first. More than one only after an interruption. */
      texts: string[];
      /** Server-written notes that follow this message as one system message. */
      notes: string[];
    }
  | { kind: "assistant"; content: Block[] };

export interface ToolLogEntry {
  /** Index of the customer turn the call was made in. */
  turn: number;
  id: string;
  name: string;
  ok: boolean;
  summary: string;
}

export interface Replayed {
  steps: Step[];
  state: OrderState;
  log: ToolLogEntry[];
  /** Kitchen changes that took effect, by turn index. */
  kitchen: { turn: number; effects: KitchenEffect[] }[];
  /** True when the last turn ended with a complete reply (no rounds left hanging). */
  settled: boolean;
}

/**
 * Rebuilds everything from a transcript. The same transcript always yields the
 * same steps, byte for byte, and extending a transcript only appends to them
 * (apart from an interrupted turn, whose trailing user message absorbs the
 * customer's next words).
 */
export function replay(turns: readonly TurnRecord[]): Replayed {
  if (turns.length > CALL_LIMITS.maxTurns) {
    throw new TranscriptError(`A call is limited to ${CALL_LIMITS.maxTurns} turns.`);
  }
  let state = emptyOrder();
  const steps: Step[] = [];
  const log: ToolLogEntry[] = [];
  const kitchen: Replayed["kitchen"] = [];
  // The user message being assembled. It stays open across an interrupted turn.
  let open: Extract<Step, { kind: "user" }> | null = null;
  let settled = true;

  const close = () => {
    if (open) steps.push(open);
    open = null;
  };

  turns.forEach((turn, index) => {
    const applied = applyKitchen(state, turn.kitchen);
    state = applied.state;
    if (applied.effects.length) kitchen.push({ turn: index, effects: applied.effects });

    open ??= { kind: "user", results: [], texts: [], notes: [] };
    open.texts.push(turn.text);
    if (turn.interrupted && index > 0) open.notes.push(INTERRUPT_NOTE);
    if (applied.effects.length) open.notes.push(kitchenNote(applied.effects));
    settled = false;

    turn.assistant.forEach((round, roundIndex) => {
      const uses = toolUsesOf(round);
      close();
      steps.push({ kind: "assistant", content: round });
      if (uses.length === 0) {
        if (roundIndex !== turn.assistant.length - 1) {
          throw new TranscriptError("A turn continued after its final reply.");
        }
        settled = true;
        return;
      }
      const results = uses.map((use) => {
        const proposal = Object.prototype.hasOwnProperty.call(turn.plans, use.id)
          ? turn.plans[use.id]
          : undefined;
        const result = applyCall(state, use, index, proposal);
        state = result.state;
        log.push({
          turn: index,
          id: use.id,
          name: use.name,
          ok: result.outcome.ok,
          summary: result.outcome.summary,
        });
        return toolResult(use, result.outcome);
      });
      open = { kind: "user", results, texts: [], notes: [] };
    });
  });
  close();
  return { steps, state, log, kitchen, settled };
}

/** A new turn, before the model has answered it. */
export function newTurn(text: string, kitchen: KitchenChange[], interrupted: boolean): TurnRecord {
  return { text, kitchen, interrupted, assistant: [], plans: {} };
}
