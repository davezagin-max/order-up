import { describe, expect, it } from "vitest";
import {
  INITIAL_VOICE_STATE,
  voiceReducer,
  type VoiceEffect,
  type VoiceEvent,
  type VoiceState,
} from "@/lib/voice/machine";

/** Runs events through the reducer and collects every effect. */
function drive(events: VoiceEvent[], start: VoiceState = INITIAL_VOICE_STATE) {
  let state = start;
  const effects: VoiceEffect[] = [];
  for (const event of events) {
    const next = voiceReducer(state, event);
    state = next.state;
    effects.push(...next.effects);
  }
  return { state, effects };
}

const types = (effects: VoiceEffect[]) => effects.map((effect) => effect.type);

describe("voice state machine", () => {
  it("walks the happy path: idle → listening → thinking → speaking → idle", () => {
    const a = drive([{ type: "MIC" }]);
    expect(a.state.phase).toBe("listening");
    expect(a.effects).toEqual([{ type: "listen" }]);

    const b = drive([{ type: "HEARD", text: "  a burrito please " }], a.state);
    expect(b.state).toMatchObject({ phase: "thinking", turn: 1, error: null });
    expect(b.effects).toEqual([
      { type: "send", turn: 1, text: "a burrito please", interrupted: false },
    ]);

    const c = drive([{ type: "SENTENCE", turn: 1 }], b.state);
    expect(c.state).toMatchObject({ phase: "speaking", pendingSpeech: 1 });

    // The reply finishes streaming while the first sentence is still playing.
    const d = drive(
      [
        { type: "SENTENCE", turn: 1 },
        { type: "REPLY_DONE", turn: 1 },
      ],
      c.state,
    );
    expect(d.state).toMatchObject({ phase: "speaking", pendingSpeech: 2, replyDone: true });

    const e = drive([{ type: "SPOKEN", turn: 1 }], d.state);
    expect(e.state.phase).toBe("speaking");
    const f = drive([{ type: "SPOKEN", turn: 1 }], e.state);
    expect(f.state).toMatchObject({ phase: "idle", pendingSpeech: 0 });
  });

  it("returns to idle when a reply has no spoken text", () => {
    const { state } = drive([
      { type: "SUBMIT", text: "hello" },
      { type: "REPLY_DONE", turn: 1 },
    ]);
    expect(state.phase).toBe("idle");
  });

  it("stays speaking until the reply is done, even if speech catches up with the stream", () => {
    const { state } = drive([
      { type: "SUBMIT", text: "hello" },
      { type: "SENTENCE", turn: 1 },
      { type: "SPOKEN", turn: 1 },
    ]);
    expect(state).toMatchObject({ phase: "speaking", pendingSpeech: 0, replyDone: false });
    expect(drive([{ type: "REPLY_DONE", turn: 1 }], state).state.phase).toBe("idle");
  });

  it("barge-in while speaking stops the voice, aborts the request, and listens", () => {
    const speaking = drive([
      { type: "SUBMIT", text: "a burrito" },
      { type: "SENTENCE", turn: 1 },
    ]).state;
    const cut = drive([{ type: "MIC" }], speaking);
    expect(cut.state).toMatchObject({ phase: "listening", turn: 2, pendingSpeech: 0, cutIn: true });
    expect(types(cut.effects)).toEqual(["abortRequest", "hush", "listen"]);

    // Late events from the abandoned reply are ignored.
    const late = drive(
      [
        { type: "SENTENCE", turn: 1 },
        { type: "SPOKEN", turn: 1 },
        { type: "REPLY_DONE", turn: 1 },
        { type: "FAILED", turn: 1, message: "aborted" },
      ],
      cut.state,
    );
    expect(late.state).toEqual(cut.state);
    expect(late.effects).toEqual([]);

    // The next turn tells the model it was interrupted, once.
    const next = drive([{ type: "HEARD", text: "actually make it chicken" }], cut.state);
    expect(next.effects).toEqual([
      { type: "send", turn: 3, text: "actually make it chicken", interrupted: true },
    ]);
    expect(next.state.cutIn).toBe(false);
  });

  it("barge-in while thinking cancels the request before any audio", () => {
    const thinking = drive([{ type: "SUBMIT", text: "a burrito" }]).state;
    const cut = drive([{ type: "MIC" }], thinking);
    expect(cut.state.phase).toBe("listening");
    expect(types(cut.effects)).toEqual(["abortRequest", "hush", "listen"]);
  });

  it("typing over a reply cancels it and sends the new text as an interruption", () => {
    const speaking = drive([
      { type: "SUBMIT", text: "a burrito" },
      { type: "SENTENCE", turn: 1 },
    ]).state;
    const typed = drive([{ type: "SUBMIT", text: "no wait, tacos" }], speaking);
    expect(typed.state).toMatchObject({ phase: "thinking", turn: 3, cutIn: false });
    expect(typed.effects).toEqual([
      { type: "abortRequest" },
      { type: "hush" },
      { type: "send", turn: 3, text: "no wait, tacos", interrupted: true },
    ]);
  });

  it("typing while listening discards the half-heard speech", () => {
    const { state, effects } = drive([{ type: "MIC" }, { type: "SUBMIT", text: "tacos" }]);
    expect(state.phase).toBe("thinking");
    expect(types(effects)).toEqual(["listen", "abortListening", "send"]);
  });

  it("a second tap or releasing Space while listening finishes the utterance", () => {
    const listening = drive([{ type: "MIC" }]).state;
    expect(drive([{ type: "MIC" }], listening).effects).toEqual([{ type: "finishListening" }]);
    expect(drive([{ type: "MIC_RELEASE" }], listening).effects).toEqual([
      { type: "finishListening" },
    ]);
    expect(drive([{ type: "MIC_RELEASE" }]).effects).toEqual([]);
  });

  it("goes back to idle when nothing was heard or listening failed", () => {
    const listening = drive([{ type: "MIC" }]).state;
    const silence = drive([{ type: "HEARD", text: "   " }], listening);
    expect(silence.state.phase).toBe("idle");
    expect(silence.effects).toEqual([]);

    const denied = drive(
      [{ type: "LISTEN_FAILED", message: "The microphone is blocked." }],
      listening,
    );
    expect(denied.state).toMatchObject({ phase: "idle", error: "The microphone is blocked." });

    // A recognizer result that arrives when nobody is listening is dropped.
    expect(drive([{ type: "HEARD", text: "stray" }]).effects).toEqual([]);
  });

  it("stop cancels whatever is in progress", () => {
    const listening = drive([{ type: "MIC" }]).state;
    expect(drive([{ type: "STOP" }], listening)).toMatchObject({
      state: { phase: "idle" },
      effects: [{ type: "abortListening" }],
    });

    const speaking = drive([
      { type: "SUBMIT", text: "hi" },
      { type: "SENTENCE", turn: 1 },
    ]).state;
    const stopped = drive([{ type: "STOP" }], speaking);
    expect(stopped.state).toMatchObject({ phase: "idle", turn: 2, cutIn: true });
    expect(types(stopped.effects)).toEqual(["abortRequest", "hush"]);

    expect(drive([{ type: "STOP" }]).effects).toEqual([]);
  });

  it("a failed reply hushes, reports the error, and clears it on the next turn", () => {
    const failed = drive([
      { type: "SUBMIT", text: "hi" },
      { type: "SENTENCE", turn: 1 },
      { type: "FAILED", turn: 1, message: "Anthropic rate limit reached." },
    ]);
    expect(failed.state).toMatchObject({ phase: "idle", error: "Anthropic rate limit reached." });
    expect(failed.effects.at(-1)).toEqual({ type: "hush" });
    expect(drive([{ type: "MIC" }], failed.state).state.error).toBeNull();
  });

  it("ignores empty submissions", () => {
    expect(drive([{ type: "SUBMIT", text: "   " }])).toEqual({
      state: INITIAL_VOICE_STATE,
      effects: [],
    });
  });

  it("never leaves a reachable state without a way back to idle", () => {
    const events: VoiceEvent[] = [
      { type: "MIC" },
      { type: "MIC_RELEASE" },
      { type: "HEARD", text: "x" },
      { type: "SUBMIT", text: "y" },
      { type: "SENTENCE", turn: 1 },
      { type: "SPOKEN", turn: 1 },
      { type: "REPLY_DONE", turn: 1 },
    ];
    // Breadth-first over three events deep; STOP must always reach idle.
    let frontier = [INITIAL_VOICE_STATE];
    for (let depth = 0; depth < 3; depth++) {
      frontier = frontier.flatMap((state) =>
        events.map((event) => voiceReducer(state, event).state),
      );
    }
    for (const state of frontier) {
      expect(voiceReducer(state, { type: "STOP" }).state.phase).toBe("idle");
      expect(state.pendingSpeech).toBeGreaterThanOrEqual(0);
    }
  });
});
