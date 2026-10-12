/**
 * The call session with fake speech and a controllable network: turn-taking,
 * barge-in, cancellation, the kitchen panel, and failure handling, all
 * without a browser.
 */
import { describe, expect, it } from "vitest";
import type { ScriptRound } from "@/fixtures/sample-replies";
import { scriptedClient } from "@/fixtures/scripted-client";
import type { ApiMeta, ApiResponse } from "@/lib/api";
import type { StreamHandlers } from "@/lib/client";
import { ZERO_USAGE } from "@/lib/config";
import { runTurn } from "@/lib/order/agent";
import { CALL_LIMITS } from "@/lib/order/history";
import type { TurnBody, TurnData, TurnEvent } from "@/lib/order/protocol";
import { FakeInput, FakeOutput } from "@/lib/speech/fake";
import { LISTEN_ERROR_TEXT } from "@/lib/speech/types";
import { CallSession, type SendTurn } from "@/lib/voice/session";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle(times = 6) {
  for (let i = 0; i < times; i++) await tick();
}

const liveMeta: ApiMeta = {
  mode: "live",
  placeholder: false,
  recordedAt: null,
  model: "claude-haiku-5-5",
  usage: { ...ZERO_USAGE, input_tokens: 1200, output_tokens: 40, cache_read_input_tokens: 1100 },
  costUsd: 0.0001,
};

const burrito = {
  name: "add_item",
  input: {
    item_id: "burrito",
    size: null,
    choices: [{ group: "protein", option: "carnitas" }],
    add_ons: [],
    leave_off: [],
    quantity: 1,
  },
};

/** A stand-in for the route: runs the real turn pipeline against scripted model output. */
function pipelineSend(script: ScriptRound[][]) {
  const bodies: (TurnBody & { instant?: boolean })[] = [];
  const keys: (string | null)[] = [];
  const send: SendTurn = async (body, apiKey, handlers, signal) => {
    bodies.push(structuredClone(body));
    keys.push(apiKey);
    const rounds = script.shift();
    if (!rounds) return { ok: false, error: { kind: "server", message: "script exhausted" } };
    handlers.onMeta?.({ mode: "live", placeholder: false, recordedAt: null });
    const result = await runTurn({
      client: scriptedClient(rounds, `s${bodies.length}`).client,
      request: body,
      emit: handlers.onEvent,
      signal,
    });
    if (!("data" in result)) return { ok: false, error: { kind: "refusal", message: "declined" } };
    return { ok: true, data: result.data, meta: liveMeta };
  };
  return { send, bodies, keys };
}

/** A network the test drives by hand: events and the final response are released explicitly. */
function manualSend() {
  const calls: {
    body: TurnBody & { instant?: boolean };
    handlers: StreamHandlers<TurnEvent>;
    signal: AbortSignal;
    finish: (response: ApiResponse<TurnData>) => void;
  }[] = [];
  const send: SendTurn = (body, _key, handlers, signal) =>
    new Promise((resolve) => {
      calls.push({ body: structuredClone(body), handlers, signal, finish: resolve });
      // Like fetch: an aborted request settles as a network error.
      signal.addEventListener("abort", () =>
        resolve({
          ok: false,
          error: { kind: "server", message: "Network error. Check your connection." },
        }),
      );
    });
  return { send, calls };
}

function makeSession(
  send: SendTurn,
  options: { key?: string | null; auto?: boolean; audible?: boolean } = {},
) {
  const input = new FakeInput();
  const output = new FakeOutput({ auto: options.auto ?? true, audible: options.audible ?? true });
  const silent = new FakeOutput({ auto: true, audible: false });
  let clock = 0;
  const key = options.key === undefined ? "sk-ant-test-0123456789abcdef" : options.key;
  const session = new CallSession({
    input,
    audible: output,
    silent,
    send,
    getKey: () => key,
    now: () => (clock += 10),
    pause: () => Promise.resolve(),
  });
  return { session, input, output, silent };
}

const cartAfterBurrito = {
  lines: [
    {
      id: "L1",
      itemId: "burrito",
      name: "regular carnitas burrito",
      quantity: 1,
      details: [],
      unitCents: 950,
      totalCents: 950,
      issue: null,
    },
  ],
  itemCount: 1,
  subtotalCents: 950,
  combos: [],
  savingsCents: 0,
  taxCents: 74,
  totalCents: 1024,
  pickupName: null,
  confirmed: false,
};

const addRound = [{ type: "tool_use", id: "t1", name: "add_item", input: burrito.input }];

describe("a spoken turn", () => {
  it("listens, sends what was heard, speaks the reply sentence by sentence, and returns to idle", async () => {
    const { send, bodies, keys } = pipelineSend([
      [{ calls: [burrito] }, { say: "One carnitas burrito at {line:L1}. Anything else?" }],
    ]);
    const { session, input, output } = makeSession(send);

    session.micTap();
    expect(session.getSnapshot().phase).toBe("listening");
    expect(input.listening).toBe(true);
    input.hearInterim("a carnitas");
    expect(session.getSnapshot().interim).toBe("a carnitas");
    input.hear("a carnitas burrito please");
    expect(session.getSnapshot().phase).toBe("thinking");
    await settle();

    const snapshot = session.getSnapshot();
    expect(snapshot.phase).toBe("idle");
    expect(bodies[0]).toEqual({
      turns: [],
      text: "a carnitas burrito please",
      kitchen: [],
      interrupted: false,
    });
    expect(keys[0]).toBe("sk-ant-test-0123456789abcdef");
    expect(snapshot.cart.totalCents).toBe(1024);
    expect(snapshot.log).toEqual([
      { id: "toolu_s1_1", name: "add_item", ok: true, summary: "added: regular carnitas burrito" },
    ]);
    expect(snapshot.captions.map((caption) => caption.role)).toEqual(["customer", "agent"]);
    const agent = snapshot.captions[1];
    expect(agent.role === "agent" && agent.sentences.map((s) => [s.text, s.status])).toEqual([
      ["One carnitas burrito at $9.50.", "spoken"],
      ["Anything else?", "spoken"],
    ]);
    // Captions keep the original text; the voice gets the speakable form.
    expect(output.spoken).toEqual([
      "One carnitas burrito at 9 dollars and 50 cents.",
      "Anything else?",
    ]);
    expect(snapshot.origin).toBe("live");
    expect(snapshot.spend).toEqual({ costUsd: 0.0001, turns: 1 });
  });

  it("measures the turn timeline in order, and only claims an audio start when sound played", async () => {
    const script = (): ScriptRound[][] => [[{ say: "Hello there. What can I get you?" }]];
    const audible = makeSession(pipelineSend(script()).send);
    audible.session.submitText("hi");
    await settle();
    const timeline = audible.session.getSnapshot().timeline!;
    expect(timeline).toMatchObject({
      source: "live",
      placeholder: false,
      status: "done",
      audible: true,
    });
    const { firstToken, firstSentence, audioStart, done } = timeline.marks;
    expect(firstToken).toBeGreaterThan(0);
    expect(firstSentence).toBeGreaterThanOrEqual(firstToken!);
    expect(audioStart).toBeGreaterThanOrEqual(firstSentence!);
    expect(done).toBeGreaterThanOrEqual(firstSentence!);
    expect(timeline.meta?.usage.cache_read_input_tokens).toBe(1100);

    const muted = makeSession(pipelineSend(script()).send);
    muted.session.setSound(false);
    muted.session.submitText("hi");
    await settle();
    expect(muted.session.getSnapshot().timeline?.marks.audioStart).toBeNull();
    expect(muted.session.getSnapshot().timeline?.audible).toBe(false);
    expect(muted.output.utterances).toHaveLength(0);
    expect(muted.silent.spoken).toEqual(["Hello there.", "What can I get you?"]);
  });

  it("falls back to captions when the browser's speech engine makes no sound", async () => {
    const input = new FakeInput();
    const broken = new FakeOutput({ fail: true });
    const silent = new FakeOutput({ audible: false });
    const session = new CallSession({
      input,
      audible: broken,
      silent,
      send: pipelineSend([[{ say: "Hello. Welcome in." }]]).send,
      getKey: () => "sk-ant-test-0123456789abcdef",
      now: () => 0,
      pause: () => Promise.resolve(),
    });
    session.submitText("hi");
    await settle();
    expect(session.getSnapshot().audioFailed).toBe(true);
    expect(session.getSnapshot().phase).toBe("idle");
    expect(broken.utterances).toHaveLength(1); // tried once, then stopped trying
    expect(silent.spoken).toEqual(["Hello.", "Welcome in."]);
  });

  it("does nothing when nothing was heard, and explains a blocked microphone", async () => {
    const { send, bodies } = pipelineSend([]);
    const { session, input } = makeSession(send);
    session.micTap();
    input.hear("   ");
    expect(session.getSnapshot().phase).toBe("idle");
    expect(bodies).toHaveLength(0);

    session.micTap();
    input.failWith("denied");
    expect(session.getSnapshot()).toMatchObject({
      phase: "idle",
      error: { kind: "speech", message: LISTEN_ERROR_TEXT.denied },
    });
  });

  it("push-to-talk: Space down listens, Space up sends", async () => {
    const { send, bodies } = pipelineSend([[{ say: "Sure." }]]);
    const { session, input } = makeSession(send);
    session.micDown();
    session.micDown(); // key repeat must not toggle it off
    expect(input.starts).toBe(1);
    input.hearInterim("a horchata");
    session.micUp();
    await settle();
    expect(bodies[0].text).toBe("a horchata");
  });
});

describe("barge-in and cancellation", () => {
  it("stops the voice at once when the customer cuts in on a finished reply", async () => {
    const { send, bodies } = pipelineSend([
      [
        { calls: [burrito] },
        { say: "One carnitas burrito. It comes with rice and beans. Anything else?" },
      ],
      [{ say: "Two it is." }],
    ]);
    const { session, input, output } = makeSession(send, { auto: false });
    session.submitText("a carnitas burrito");
    await settle();
    output.start();
    expect(session.getSnapshot().phase).toBe("speaking");
    expect(output.current?.text).toBe("One carnitas burrito.");

    session.micTap(); // barge-in
    const cut = session.getSnapshot();
    expect(cut.phase).toBe("listening");
    expect(output.cancels).toBeGreaterThanOrEqual(1);
    expect(output.current).toBeUndefined();
    expect(input.listening).toBe(true);
    const agent = cut.captions[1];
    expect(agent.role === "agent" && agent.cutOff).toBe(true);
    expect(agent.role === "agent" && agent.sentences.map((s) => s.status)).toEqual([
      "dropped",
      "dropped",
      "dropped",
    ]);
    // The reply had fully arrived, so the turn and its tool call are in the transcript.
    expect(cut.cart.totalCents).toBe(1024);

    input.hear("actually make it two");
    await settle();
    expect(bodies[1].interrupted).toBe(true);
    expect(bodies[1].turns).toHaveLength(1);
    expect(bodies[1].turns[0].assistant).toHaveLength(2);
  });

  it("aborts the in-flight request, keeps the round that finished, and drops the rest", async () => {
    const { send, calls } = manualSend();
    const { session, input } = makeSession(send);
    session.submitText("a carnitas burrito");
    const [first] = calls;
    first.handlers.onEvent({
      type: "tool",
      id: "t1",
      name: "add_item",
      ok: true,
      summary: "added: regular carnitas burrito",
      cart: cartAfterBurrito,
    });
    expect(session.getSnapshot().cart.totalCents).toBe(1024); // the cart moves as the call lands
    first.handlers.onEvent({ type: "round", content: addRound, plans: {} });
    first.handlers.onEvent({ type: "text", delta: "One carnitas burrito. Would you" });
    expect(session.getSnapshot().phase).toBe("speaking");

    session.micTap(); // the customer starts talking over the reply
    expect(first.signal.aborted).toBe(true);
    const cut = session.getSnapshot();
    expect(cut.phase).toBe("listening");
    expect(cut.cart.totalCents).toBe(1024);
    expect(cut.log).toEqual([
      { id: "t1", name: "add_item", ok: true, summary: "added: regular carnitas burrito" },
    ]);
    expect(cut.timeline?.status).toBe("cancelled");

    // Late frames from the cancelled request change nothing.
    first.handlers.onEvent({ type: "text", delta: " like a drink?" });
    await settle();
    expect(session.getSnapshot().captions).toEqual(cut.captions);

    input.hear("and a water");
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toMatchObject({ text: "and a water", interrupted: true });
    expect(calls[1].body.turns).toEqual([
      {
        text: "a carnitas burrito",
        kitchen: [],
        interrupted: false,
        assistant: [addRound],
        plans: {},
      },
    ]);
  });

  it("rolls the cart back when the turn is cancelled before its round was stored", async () => {
    const { send, calls } = manualSend();
    const { session } = makeSession(send);
    session.submitText("a carnitas burrito");
    calls[0].handlers.onEvent({
      type: "tool",
      id: "t1",
      name: "add_item",
      ok: true,
      summary: "added: regular carnitas burrito",
      cart: cartAfterBurrito,
    });
    expect(session.getSnapshot().cart.itemCount).toBe(1);
    session.stop();
    const stopped = session.getSnapshot();
    expect(calls[0].signal.aborted).toBe(true);
    expect(stopped.phase).toBe("idle");
    // The cart is whatever the transcript says, and the transcript has no finished round.
    expect(stopped.cart.itemCount).toBe(0);
    expect(stopped.log).toEqual([]);

    session.submitText("never mind, tacos");
    expect(calls[1].body.interrupted).toBe(true);
    expect(calls[1].body.turns).toEqual([
      { text: "a carnitas burrito", kitchen: [], interrupted: false, assistant: [], plans: {} },
    ]);
  });

  it("typing over a reply cancels it and sends the new text", async () => {
    const { send, calls } = manualSend();
    const { session, output } = makeSession(send, { auto: false });
    session.submitText("a burrito");
    calls[0].handlers.onEvent({ type: "text", delta: "Sure. Which protein would you like? " });
    session.submitText("carnitas");
    expect(calls[0].signal.aborted).toBe(true);
    expect(output.cancels).toBeGreaterThanOrEqual(1);
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toMatchObject({ text: "carnitas", interrupted: true });
    expect(session.getSnapshot().phase).toBe("thinking");
  });
});

describe("failures", () => {
  it("drops a failed turn from the transcript and gives the kitchen changes back", async () => {
    const { send, calls } = manualSend();
    const { session } = makeSession(send);
    session.toggleStock("carnitas");
    session.submitText("a burrito");
    expect(calls[0].body.kitchen).toEqual([{ id: "carnitas", inStock: false }]);
    calls[0].finish({
      ok: false,
      error: { kind: "rate_limit", message: "Anthropic rate limit reached. Try again shortly." },
    });
    await settle();
    const failed = session.getSnapshot();
    expect(failed.phase).toBe("idle");
    expect(failed.error).toEqual({
      kind: "rate_limit",
      message: "Anthropic rate limit reached. Try again shortly.",
    });
    expect(failed.pendingKitchen).toEqual([{ id: "carnitas", inStock: false }]);
    expect(failed.timeline?.status).toBe("failed");

    session.submitText("a burrito");
    expect(calls[1].body.turns).toEqual([]);
    expect(calls[1].body.kitchen).toEqual([{ id: "carnitas", inStock: false }]);
    expect(session.getSnapshot().error).toBeNull();
  });

  it("shows a refusal as its own kind of error and keeps the call usable", async () => {
    const { send, calls } = manualSend();
    const { session } = makeSession(send);
    session.submitText("something the model declines");
    calls[0].finish({
      ok: false,
      error: { kind: "refusal", message: "Claude declined this request. Try rephrasing it." },
      meta: liveMeta,
    });
    await settle();
    expect(session.getSnapshot().error?.kind).toBe("refusal");
    expect(session.getSnapshot().spend.turns).toBe(1); // a refused call still cost tokens
    session.submitText("a burrito");
    expect(calls).toHaveLength(2);
  });

  it("stops at the turn limit", async () => {
    const script = Array.from({ length: CALL_LIMITS.maxTurns + 1 }, (): ScriptRound[] => [
      { say: "Okay." },
    ]);
    const { send, bodies } = pipelineSend(script);
    const { session } = makeSession(send);
    for (let i = 0; i < CALL_LIMITS.maxTurns + 1; i++) {
      session.submitText(`turn ${i + 1}`);
      await settle(3);
    }
    expect(bodies).toHaveLength(CALL_LIMITS.maxTurns);
    expect(session.getSnapshot().error?.kind).toBe("limit");
    expect(session.getSnapshot().turnsLeft).toBe(0);
  });
});

describe("demo mode and the kitchen panel", () => {
  it("does not send free speech, typing, or kitchen changes without a key", () => {
    const { send, calls } = manualSend();
    const { session, input } = makeSession(send, { key: null });
    session.submitText("a burrito");
    session.micTap();
    session.micDown();
    session.toggleStock("carnitas");
    expect(calls).toHaveLength(0);
    expect(input.starts).toBe(0); // the microphone is never asked for
    expect(session.getSnapshot()).toMatchObject({
      phase: "idle",
      outOfStock: [],
      pendingKitchen: [],
    });
  });

  it("queues kitchen changes for the next turn and nets out a change that is undone", async () => {
    const { send, bodies } = pipelineSend([
      [{ calls: [burrito] }, { say: "Done." }],
      [{ say: "We are out of carnitas. Chicken?" }],
    ]);
    const { session } = makeSession(send);
    session.submitText("a carnitas burrito");
    await settle();

    session.toggleStock("carnitas");
    session.toggleStock("churros");
    session.toggleStock("churros"); // changed their mind before the agent was told
    expect(session.getSnapshot().outOfStock).toEqual(["carnitas"]);
    expect(session.getSnapshot().pendingKitchen).toEqual([{ id: "carnitas", inStock: false }]);

    session.submitText("and a water");
    await settle();
    expect(bodies[1].kitchen).toEqual([{ id: "carnitas", inStock: false }]);
    const after = session.getSnapshot();
    expect(after.pendingKitchen).toEqual([]);
    expect(after.outOfStock).toEqual(["carnitas"]);
    expect(after.cart.lines[0].issue).toBe("carnitas is out of stock");
    expect(after.captions.map((caption) => caption.role)).toEqual([
      "customer",
      "agent",
      "customer",
      "kitchen",
      "agent",
    ]);

    session.toggleStock("carnitas"); // back in stock
    expect(session.getSnapshot().outOfStock).toEqual([]);
    expect(session.getSnapshot().pendingKitchen).toEqual([{ id: "carnitas", inStock: true }]);
  });

  it("starts a clean call on reset", async () => {
    const { send } = pipelineSend([[{ calls: [burrito] }, { say: "Done." }]]);
    const { session } = makeSession(send);
    session.submitText("a carnitas burrito");
    await settle();
    session.reset();
    expect(session.getSnapshot()).toMatchObject({
      phase: "idle",
      captions: [],
      log: [],
      origin: "none",
      timeline: null,
      turnsLeft: CALL_LIMITS.maxTurns,
    });
    expect(session.getSnapshot().cart.lines).toEqual([]);
  });
});
