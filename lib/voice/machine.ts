/**
 * Turn-taking as a pure reducer.
 *
 *   idle → listening → thinking → speaking → idle
 *
 * plus the edges that make it feel like a conversation: barge-in (speaking or
 * thinking → listening), typing over a reply, stop, and errors. The reducer
 * returns the next state and a list of effects as plain data; the session
 * carries them out. Nothing here touches a microphone, a speaker, or the
 * network, which is why every path can be unit tested.
 */

export type Phase = "idle" | "listening" | "thinking" | "speaking";

export interface VoiceState {
  phase: Phase;
  /** Identifies the turn in flight. Events that carry an older number are ignored. */
  turn: number;
  /** The whole reply has arrived, though some of it may still be waiting to be spoken. */
  replyDone: boolean;
  /** Sentences handed to the speaker that have not finished. */
  pendingSpeech: number;
  /** The customer cut the last reply off. The next turn tells the model so. */
  cutIn: boolean;
  error: string | null;
}

export const INITIAL_VOICE_STATE: VoiceState = {
  phase: "idle",
  turn: 0,
  replyDone: false,
  pendingSpeech: 0,
  cutIn: false,
  error: null,
};

export type VoiceEvent =
  /** The microphone was tapped, or Space was pressed. */
  | { type: "MIC" }
  /** Space was released: the customer is done talking. */
  | { type: "MIC_RELEASE" }
  /** The recognizer settled on what was said. */
  | { type: "HEARD"; text: string }
  | { type: "LISTEN_FAILED"; message: string }
  /** Text was typed and sent. */
  | { type: "SUBMIT"; text: string }
  /** A sentence of the reply was queued for speech. */
  | { type: "SENTENCE"; turn: number }
  /** A queued sentence finished playing. */
  | { type: "SPOKEN"; turn: number }
  /** The reply stream ended normally. */
  | { type: "REPLY_DONE"; turn: number }
  | { type: "FAILED"; turn: number; message: string }
  | { type: "STOP" };

export type VoiceEffect =
  | { type: "listen" }
  /** Stop listening and deliver what was heard. */
  | { type: "finishListening" }
  /** Stop listening and discard it. */
  | { type: "abortListening" }
  | { type: "send"; turn: number; text: string; interrupted: boolean }
  /** Abort the in-flight request so no further model calls are made for it. */
  | { type: "abortRequest" }
  /** Stop speaking at once and drop queued sentences. */
  | { type: "hush" };

export interface Transition {
  state: VoiceState;
  effects: VoiceEffect[];
}

const stay = (state: VoiceState): Transition => ({ state, effects: [] });

function replying(state: VoiceState): boolean {
  return state.phase === "thinking" || state.phase === "speaking";
}

function send(state: VoiceState, text: string, before: VoiceEffect[]): Transition {
  const turn = state.turn + 1;
  return {
    state: {
      phase: "thinking",
      turn,
      replyDone: false,
      pendingSpeech: 0,
      cutIn: false,
      error: null,
    },
    effects: [...before, { type: "send", turn, text, interrupted: state.cutIn }],
  };
}

/** Everything that cancels a reply in progress does it the same way. */
function cutOff(state: VoiceState): { state: VoiceState; effects: VoiceEffect[] } {
  return {
    // A new turn number makes every late event from the old reply a no-op.
    state: { ...state, turn: state.turn + 1, replyDone: false, pendingSpeech: 0, cutIn: true },
    effects: [{ type: "abortRequest" }, { type: "hush" }],
  };
}

export function voiceReducer(state: VoiceState, event: VoiceEvent): Transition {
  switch (event.type) {
    case "MIC": {
      if (state.phase === "idle") {
        return {
          state: { ...state, phase: "listening", error: null },
          effects: [{ type: "listen" }],
        };
      }
      if (state.phase === "listening") return { state, effects: [{ type: "finishListening" }] };
      // Barge-in: the customer starts talking over the reply.
      const cut = cutOff(state);
      return {
        state: { ...cut.state, phase: "listening", error: null },
        effects: [...cut.effects, { type: "listen" }],
      };
    }

    case "MIC_RELEASE":
      return state.phase === "listening"
        ? { state, effects: [{ type: "finishListening" }] }
        : stay(state);

    case "HEARD": {
      if (state.phase !== "listening") return stay(state);
      const text = event.text.trim();
      if (!text) return stay({ ...state, phase: "idle" });
      return send(state, text, []);
    }

    case "LISTEN_FAILED":
      return state.phase === "listening"
        ? stay({ ...state, phase: "idle", error: event.message })
        : stay(state);

    case "SUBMIT": {
      const text = event.text.trim();
      if (!text) return stay(state);
      if (state.phase === "listening") return send(state, text, [{ type: "abortListening" }]);
      if (replying(state)) {
        const cut = cutOff(state);
        return send(cut.state, text, cut.effects);
      }
      return send(state, text, []);
    }

    case "SENTENCE":
      if (event.turn !== state.turn || !replying(state)) return stay(state);
      return stay({ ...state, phase: "speaking", pendingSpeech: state.pendingSpeech + 1 });

    case "SPOKEN": {
      if (event.turn !== state.turn || !replying(state)) return stay(state);
      const pendingSpeech = Math.max(0, state.pendingSpeech - 1);
      if (pendingSpeech === 0 && state.replyDone)
        return stay({ ...state, phase: "idle", pendingSpeech });
      return stay({ ...state, pendingSpeech });
    }

    case "REPLY_DONE":
      if (event.turn !== state.turn || !replying(state)) return stay(state);
      if (state.pendingSpeech === 0) return stay({ ...state, phase: "idle", replyDone: true });
      return stay({ ...state, replyDone: true });

    case "FAILED":
      if (event.turn !== state.turn || !replying(state)) return stay(state);
      return {
        state: {
          ...state,
          phase: "idle",
          replyDone: false,
          pendingSpeech: 0,
          error: event.message,
        },
        effects: [{ type: "hush" }],
      };

    case "STOP": {
      if (state.phase === "idle") return stay(state);
      if (state.phase === "listening") {
        return { state: { ...state, phase: "idle" }, effects: [{ type: "abortListening" }] };
      }
      const cut = cutOff(state);
      return { state: { ...cut.state, phase: "idle" }, effects: cut.effects };
    }
  }
}
