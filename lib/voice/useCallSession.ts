"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { getKey } from "@/components/kit/key-store";
import { streamApi } from "@/lib/client";
import type { TurnData, TurnEvent } from "@/lib/order/protocol";
import { NoSpeechInput, SilentOutput } from "@/lib/speech/silent";
import {
  WebSpeechInput,
  WebSpeechOutput,
  detectSpeech,
  type SpeechSupport,
} from "@/lib/speech/web";
import { CallSession, type CallSnapshot } from "./session";

function createSession(): CallSession {
  const support = detectSpeech();
  return new CallSession({
    // Text-only implementations are used automatically where the browser has no speech.
    input: support.recognition ? new WebSpeechInput() : new NoSpeechInput(),
    audible: support.synthesis ? new WebSpeechOutput() : null,
    silent: new SilentOutput(),
    send: (body, apiKey, handlers, signal) =>
      streamApi<TurnData, TurnEvent>("/api/turn", body, apiKey, handlers, signal),
    getKey,
    now: () => performance.now(),
    pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
}

let cachedSupport: SpeechSupport | null = null;
const subscribeNever = () => () => {};
const clientSupport = () => (cachedSupport ??= detectSpeech());
const serverSupport = () => null;

/** What this browser can do. Null on the server and during hydration, so markup matches. */
export function useSpeechSupport(): SpeechSupport | null {
  return useSyncExternalStore(subscribeNever, clientSupport, serverSupport);
}

export function useCallSession(): { session: CallSession; snapshot: CallSnapshot } {
  const [session] = useState(createSession);
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  // Leaving the page stops the voice, the microphone, and any request in flight.
  useEffect(() => () => session.reset(), [session]);
  return { session, snapshot };
}
