/**
 * A stand-in for the Anthropic client that plays a written script.
 *
 * It is used in two places: to build the placeholder fixtures (the sample
 * calls run through the real turn pipeline with this in place of the model),
 * and in tests of the live path. It behaves like a model that follows its
 * instructions: any figure it "says" is read out of the tool results it was
 * sent, never typed into the script.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "../lib/config";
import { splitSentences } from "../lib/speech/chunker";
import type { ScriptRound } from "./sample-replies";

type Params = Record<string, unknown>;

interface ToolResultLike {
  type?: string;
  content?: unknown;
}

/** Every tool result in the request, newest first, parsed. */
function toolResults(params: Params): Record<string, unknown>[] {
  const messages = (params.messages as { role: string; content: unknown }[]) ?? [];
  const results: Record<string, unknown>[] = [];
  for (const message of [...messages].reverse()) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const block of [...(message.content as ToolResultLike[])].reverse()) {
      if (block.type !== "tool_result" || typeof block.content !== "string") continue;
      try {
        results.push(JSON.parse(block.content) as Record<string, unknown>);
      } catch {
        // Not JSON: nothing to read a figure from.
      }
    }
  }
  return results;
}

/** Fills `{total}`-style slots from the tool results, the way a model reads them back. */
export function fillSlots(text: string, params: Params): string {
  const results = toolResults(params);
  const order = results.map((result) => result.order).find(Boolean) as
    | {
        total: string;
        lines: { line_id: string; price: string }[];
        combo_savings?: { saves: string }[];
      }
    | undefined;
  const pick = (key: string) => results.find((result) => result[key] !== undefined)?.[key];
  return text.replace(/\{([a-z_]+)(?::([A-Za-z0-9]+))?\}/g, (slot, name: string, arg?: string) => {
    let value: unknown;
    if (name === "total") value = order?.total;
    else if (name === "savings") value = order?.combo_savings?.[0]?.saves;
    else if (name === "line") value = order?.lines.find((line) => line.line_id === arg)?.price;
    else if (name === "order_number") value = pick("order_number");
    else if (name === "ready") value = pick("ready_in_minutes");
    else if (name === "plan_total") value = results.find((result) => result.plan_id)?.total;
    if (value === undefined || value === null) {
      throw new Error(`Script slot ${slot} has no value in the tool results.`);
    }
    return String(value);
  });
}

const USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

export interface ScriptedClient {
  client: Anthropic;
  /** Every request sent, in order, snapshotted at the time it was made. */
  requests: Params[];
}

/**
 * `idPrefix` makes tool_use ids unique across turns. Conversation requests
 * (the ones with tools) consume one scripted round each; planner requests
 * (structured output) return the proposal of the most recent planning call.
 */
export function scriptedClient(rounds: ScriptRound[], idPrefix: string): ScriptedClient {
  const requests: Params[] = [];
  const queue = [...rounds];
  const proposals: unknown[] = [];
  let lastProposal: unknown;
  let toolCount = 0;

  function respond(params: Params): { message: object; deltas: string[] } {
    requests.push(structuredClone(params));
    const format = (params.output_config as { format?: unknown } | undefined)?.format;
    if (format) {
      // Asked to repair a rejected plan, the scripted planner returns the same plan again.
      if (proposals.length > 0) lastProposal = proposals.shift();
      if (lastProposal === undefined) {
        throw new Error("The script has no plan proposal for this request.");
      }
      const text = JSON.stringify(lastProposal);
      return {
        deltas: [],
        message: {
          model: MODELS.opus,
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          stop_details: null,
          usage: USAGE,
        },
      };
    }
    const round = queue.shift();
    if (!round) throw new Error("The script has no more rounds for this turn.");
    const say = round.say ? fillSlots(round.say, params) : "";
    const sentences = splitSentences(say);
    const deltas = sentences.map((sentence, index) =>
      index < sentences.length - 1 ? `${sentence} ` : sentence,
    );
    if (deltas.join("") !== say) throw new Error(`Script text must use single spaces: "${say}"`);
    const calls = round.calls ?? [];
    for (const call of calls) if (call.proposal !== undefined) proposals.push(call.proposal);
    return {
      deltas,
      message: {
        model: MODELS.haiku,
        content: [
          ...(say ? [{ type: "text", text: say }] : []),
          ...calls.map((call) => ({
            type: "tool_use",
            id: `toolu_${idPrefix}_${++toolCount}`,
            name: call.name,
            input: call.input,
          })),
        ],
        stop_reason: calls.length > 0 ? "tool_use" : "end_turn",
        stop_details: null,
        usage: USAGE,
      },
    };
  }

  const client = {
    beta: {
      messages: {
        create: async (params: Params) => respond(params).message,
        stream: (params: Params) => {
          const listeners: ((delta: string) => void)[] = [];
          return {
            on(event: string, listener: (delta: string) => void) {
              if (event === "text") listeners.push(listener);
              return this;
            },
            async finalMessage() {
              const { message, deltas } = respond(params);
              for (const delta of deltas) listeners.forEach((listener) => listener(delta));
              return message;
            },
          };
        },
      },
    },
  } as unknown as Anthropic;

  return { client, requests };
}
