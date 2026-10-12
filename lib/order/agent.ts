/**
 * One customer turn, server side. Server-only: it talks to Claude.
 *
 * Two speeds, one conversation:
 *   - The conversation runs on Claude Haiku 5.5 at low effort, because a voice
 *     agent lives or dies on time to first audio. The whole call stays on that
 *     one model, append-only.
 *   - A group order is a planning problem, so the `plan_group_order` handler
 *     makes a separate, stateless request to Claude Opus 5.5 with structured
 *     output. Its answer comes back to Haiku as an ordinary tool result, so
 *     no thinking block ever crosses from one model to the other.
 *
 * Every tool call goes through the order engine. Cancellation is real: the
 * abort signal reaches every model call and no call starts after an abort.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { ZodType } from "zod";
import type { LiveResult } from "../api";
import { PipelineError, callClaude, untrusted, withSystemNote, type Msg } from "../claude";
import { MODELS, ZERO_USAGE, addUsage, type Effort, type Usage } from "../config";
import { stockName } from "../menu";
import { formatCents } from "../money";
import { priceCart, type KitchenChange, type OrderState } from "./engine";
import { unbackedAmounts } from "./guard";
import {
  CALL_LIMITS,
  PLAN_TOOL_NAME,
  TranscriptError,
  applyCall,
  newTurn,
  replay,
  textOf,
  toolResult,
  toolUsesOf,
  type Block,
  type Step,
  type ToolResultBlock,
  type TurnRecord,
} from "./history";
import {
  PlanProposal,
  checkPlan,
  describeNeeds,
  parseConstraints,
  type PlanConstraints,
} from "./plan";
import { PLANNER_PROMPT, SYSTEM_PROMPT } from "./prompt";
import type { ModelUse, TurnData, TurnEvent } from "./protocol";
import { ORDER_TOOLS } from "./tools";

/** Turn-taking: the fast model at low effort. Change here after measuring. */
export const CONVERSATION = {
  model: MODELS.haiku,
  effort: "low" as Effort,
  maxTokens: 4000,
} as const;

/** The one hard problem: the strong model, once per attempt, stateless. */
export const PLANNER = {
  model: MODELS.opus,
  effort: "medium" as Effort,
  maxTokens: 12_000,
  /** One proposal, plus one repair if the checker rejects it. */
  attempts: 2,
} as const;

/** Thrown when the visitor has gone (barge-in, Stop, closed tab) and work should stop. */
export class CallAborted extends Error {
  constructor() {
    super("The turn was cancelled.");
    this.name = "CallAborted";
  }
}

/** Puts replayed steps in API form. Customer words are wrapped as untrusted data; notes become system messages. */
export function toMessages(steps: readonly Step[]): Msg[] {
  let messages: Msg[] = [];
  for (const step of steps) {
    if (step.kind === "assistant") {
      messages.push({ role: "assistant", content: step.content as unknown as Msg["content"] });
      continue;
    }
    messages.push({
      role: "user",
      content: [
        ...step.results,
        ...step.texts.map((text) => ({ type: "text" as const, text: untrusted("customer", text) })),
      ],
    });
    if (step.notes.length > 0) messages = withSystemNote(messages, step.notes.join("\n\n"));
  }
  return messages;
}

class Meter {
  private readonly uses = new Map<ModelUse["role"], ModelUse>();

  add(role: ModelUse["role"], result: { model: string; usage: Usage; costUsd: number }): void {
    const current = this.uses.get(role);
    this.uses.set(role, {
      role,
      model: result.model,
      calls: (current?.calls ?? 0) + 1,
      usage: addUsage(current?.usage ?? ZERO_USAGE, result.usage),
      costUsd: (current?.costUsd ?? 0) + result.costUsd,
    });
  }

  get models(): ModelUse[] {
    return [...this.uses.values()];
  }

  get total(): { model: string; usage: Usage; costUsd: number } {
    const models = this.models;
    return {
      model: models.map((use) => use.model).join(" + ") || CONVERSATION.model,
      usage: models.reduce((sum, use) => addUsage(sum, use.usage), ZERO_USAGE),
      costUsd: models.reduce((sum, use) => sum + use.costUsd, 0),
    };
  }
}

function plannerRequest(
  constraints: PlanConstraints,
  outOfStock: readonly string[],
  problems: string[],
): string {
  const facts = {
    party_size: constraints.partySize,
    budget_with_tax:
      constraints.budgetCents === null ? "none given" : formatCents(constraints.budgetCents),
    people_with_dietary_needs: constraints.restricted.map(describeNeeds),
    out_of_stock: outOfStock.map(stockName),
  };
  return [
    `Plan an order for this group:\n${JSON.stringify(facts, null, 2)}`,
    untrusted("notes", constraints.notes || "(none)"),
    problems.length > 0
      ? `Your previous plan was rejected by the checker:\n${problems.map((problem) => `- ${problem}`).join("\n")}\nReturn a corrected plan.`
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Asks Opus for a plan. Returns its proposal, valid or not (the engine checks
 * it again and words the refusal), or null when the model declined or
 * returned nothing usable.
 */
export async function proposePlan(args: {
  client: Anthropic;
  constraints: PlanConstraints;
  outOfStock: readonly string[];
  signal?: AbortSignal;
  meter?: { add: Meter["add"] };
}): Promise<unknown | null> {
  let proposal: unknown | null = null;
  let problems: string[] = [];
  for (let attempt = 1; attempt <= PLANNER.attempts; attempt++) {
    if (args.signal?.aborted) throw new CallAborted();
    const result = await callClaude({
      client: args.client,
      model: PLANNER.model,
      effort: PLANNER.effort,
      maxTokens: PLANNER.maxTokens,
      system: PLANNER_PROMPT,
      cacheSystem: true,
      // Declared with zod/mini so the browser bundle stays small; the helper only needs
      // `safeParse` and a JSON Schema, which both builds of zod provide.
      schema: PlanProposal as unknown as ZodType<PlanProposal>,
      // Stateless on purpose: each attempt is a fresh single-message request.
      messages: [
        { role: "user", content: plannerRequest(args.constraints, args.outOfStock, problems) },
      ],
      signal: args.signal,
    });
    args.meter?.add("planner", result);
    if (result.refusal) return proposal;
    if (!result.parsed) {
      problems = ["The plan was not valid structured output."];
      continue;
    }
    proposal = result.parsed;
    const check = checkPlan(args.outOfStock, args.constraints, proposal);
    if (check.ok) return proposal;
    problems = check.problems;
  }
  return proposal;
}

export interface TurnRequest {
  turns: TurnRecord[];
  text: string;
  kitchen: KitchenChange[];
  interrupted: boolean;
}

export async function runTurn(args: {
  client: Anthropic;
  request: TurnRequest;
  emit: (event: TurnEvent) => void;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<LiveResult<TurnData>> {
  const { client, request, emit, signal } = args;
  const now = args.now ?? Date.now;
  const started = now();
  const meter = new Meter();

  const current = newTurn(request.text, request.kitchen, request.interrupted);
  const turns = [...request.turns, current];
  const index = turns.length - 1;

  let replayed;
  try {
    replayed = replay(turns);
  } catch (error) {
    if (error instanceof TranscriptError) throw new PipelineError(error.message, 400);
    throw error;
  }
  if (replayed.state.receipt) {
    throw new PipelineError("This order is already confirmed. Start a new call.", 409);
  }

  const kitchen = replayed.kitchen.find((entry) => entry.turn === index);
  if (kitchen) emit({ type: "kitchen", effects: kitchen.effects });

  let state: OrderState = replayed.state;
  let messages = toMessages(replayed.steps);
  let firstTextMs: number | null = null;
  let reply = "";

  for (let round = 1; round <= CALL_LIMITS.maxRounds; round++) {
    // Barge-in and Stop abort the request. Never start another model call for an abandoned turn.
    if (signal?.aborted) throw new CallAborted();

    const result = await callClaude({
      client,
      model: CONVERSATION.model,
      effort: CONVERSATION.effort,
      maxTokens: CONVERSATION.maxTokens,
      system: SYSTEM_PROMPT,
      cacheSystem: true,
      tools: ORDER_TOOLS,
      messages,
      signal,
      onText: (delta) => {
        firstTextMs ??= now() - started;
        emit({ type: "text", delta });
      },
    });
    meter.add("conversation", result);

    // Haiku has no server-side refusal fallback, so a refusal is just a result to report.
    if (result.refusal) return { refusal: result.refusal, ...meter.total };
    if (result.stopReason !== "end_turn" && result.stopReason !== "tool_use") {
      throw new PipelineError("The reply was cut off before it finished. Try again.");
    }

    const content = result.messages[result.messages.length - 1].content as unknown as Block[];
    let uses;
    try {
      uses = toolUsesOf(content);
    } catch (error) {
      // The browser could not send this turn back next time, so do not hand it over at all.
      if (error instanceof TranscriptError) {
        throw new PipelineError("The model returned a reply this app cannot store. Try again.");
      }
      throw error;
    }
    current.assistant.push(content);
    reply += `${reply ? " " : ""}${textOf(content)}`;

    if (uses.length === 0) {
      emit({ type: "round", content, plans: {} });
      break;
    }

    const plans: Record<string, unknown> = {};
    const results: ToolResultBlock[] = [];
    for (const use of uses) {
      if (use.name === PLAN_TOOL_NAME) {
        const parsed = parseConstraints(use.input);
        if (parsed.ok && !state.receipt) {
          emit({
            type: "planning",
            people: parsed.constraints.partySize,
            budget:
              parsed.constraints.budgetCents === null
                ? null
                : formatCents(parsed.constraints.budgetCents),
            needs: parsed.constraints.restricted.map(describeNeeds),
          });
          plans[use.id] = await proposePlan({
            client,
            constraints: parsed.constraints,
            outOfStock: state.outOfStock,
            signal,
            meter,
          });
        }
      }
      const applied = applyCall(state, use, index, plans[use.id]);
      state = applied.state;
      emit({
        type: "tool",
        id: use.id,
        name: use.name,
        ok: applied.outcome.ok,
        summary: applied.outcome.summary,
        cart: priceCart(state),
        ...(applied.outcome.plan ? { plan: applied.outcome.plan } : {}),
      });
      results.push(toolResult(use, applied.outcome));
    }
    Object.assign(current.plans, plans);
    emit({ type: "round", content, plans });
    // At the round limit the tool results are still applied, so the history stays valid;
    // the turn simply ends without a closing sentence.
    messages = [...result.messages, { role: "user", content: results }];
  }

  // What the browser will rebuild from this transcript must be exactly what was computed here.
  const final = replay(turns);
  if (JSON.stringify(final.state) !== JSON.stringify(state)) {
    throw new Error("Replayed order state diverged from the live state.");
  }

  return {
    data: {
      assistant: current.assistant,
      plans: current.plans,
      cart: priceCart(state),
      receipt: state.receipt,
      timing: { firstTextMs, totalMs: now() - started },
      models: meter.models,
      unbackedAmounts: unbackedAmounts(reply, final.steps),
    },
    ...meter.total,
  };
}
