/**
 * Speech sits behind two small interfaces. The app talks to these and never
 * to the browser's speech APIs directly, so the same call logic runs with real
 * speech (`web.ts`), with none (`silent.ts`), and in tests (`fake.ts`).
 */

export type Voice = "agent" | "customer";

/** How an utterance finished. `failed` means the engine never produced sound. */
export type SpeakResult = "ended" | "cancelled" | "failed";

export interface SpeakOptions {
  voice: Voice;
  /** Called when sound actually starts (or, with no audio, when the caption turn begins). */
  onStart?: () => void;
}

export interface SpeechOutput {
  /** True when this implementation produces sound. */
  readonly audible: boolean;
  /** Speaks one utterance. Resolves when it ends or is cut off. Never rejects. */
  speak(text: string, options: SpeakOptions): Promise<SpeakResult>;
  /** Stops at once. An utterance in progress resolves as `cancelled`. */
  cancel(): void;
}

export type ListenError = "denied" | "no-microphone" | "network" | "unsupported" | "failed";

export type ListenResult = { text: string } | { error: ListenError };

export interface ListenHandlers {
  /** Words heard so far, including ones the recognizer may still revise. */
  onInterim(text: string): void;
  /** Called exactly once per `start`: the final text ("" if nothing was heard) or an error. */
  onDone(result: ListenResult): void;
}

export interface SpeechInput {
  /** False when this browser has no speech recognition. The text box still works. */
  readonly available: boolean;
  start(handlers: ListenHandlers): void;
  /** Stop listening and deliver what was heard so far. */
  stop(): void;
  /** Stop listening and throw away what was heard. `onDone` is not called. */
  abort(): void;
}

export const LISTEN_ERROR_TEXT: Record<ListenError, string> = {
  denied:
    "The microphone is blocked for this page. Allow it in the browser's site settings, or type instead.",
  "no-microphone": "No microphone was found. You can type instead.",
  network: "The browser could not reach its speech service. You can type instead.",
  unsupported: "This browser has no speech recognition. You can type instead.",
  failed: "Speech recognition stopped unexpectedly. Try again, or type instead.",
};
