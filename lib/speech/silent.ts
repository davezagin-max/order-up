/**
 * The text-only implementations. Used automatically when the browser has no
 * speech recognition or synthesis, and when the visitor turns sound off.
 */
import type { ListenHandlers, SpeakOptions, SpeakResult, SpeechInput, SpeechOutput } from "./types";

/** How long a caption stays "current" when nothing is being spoken, by length. */
export function readingTimeMs(text: string): number {
  return Math.min(6500, Math.max(900, text.length * 48));
}

/** Paces captions at reading speed without making a sound. */
export class SilentOutput implements SpeechOutput {
  readonly audible = false;
  private pending: {
    timer: ReturnType<typeof setTimeout>;
    settle: (result: SpeakResult) => void;
  } | null = null;

  constructor(private readonly pace: (text: string) => number = readingTimeMs) {}

  speak(text: string, options: SpeakOptions): Promise<SpeakResult> {
    this.cancel();
    return new Promise((resolve) => {
      options.onStart?.();
      const timer = setTimeout(() => {
        this.pending = null;
        resolve("ended");
      }, this.pace(text));
      this.pending = { timer, settle: resolve };
    });
  }

  cancel(): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.settle("cancelled");
  }
}

/** A browser without speech recognition: listening is simply not offered. */
export class NoSpeechInput implements SpeechInput {
  readonly available = false;

  start(handlers: ListenHandlers): void {
    handlers.onDone({ error: "unsupported" });
  }

  stop(): void {}

  abort(): void {}
}
