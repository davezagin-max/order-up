/**
 * Scriptable speech for tests. Nothing here touches a browser API or a timer:
 * the test decides when an utterance starts, ends, or is heard.
 */
import type {
  ListenHandlers,
  ListenResult,
  SpeakOptions,
  SpeakResult,
  SpeechInput,
  SpeechOutput,
  Voice,
} from "./types";

interface Utterance {
  text: string;
  voice: Voice;
  result: SpeakResult | null;
  options: SpeakOptions;
  settle: (result: SpeakResult) => void;
}

export class FakeOutput implements SpeechOutput {
  readonly audible: boolean;
  /** Every utterance ever requested, in order. */
  readonly utterances: Utterance[] = [];
  cancels = 0;

  /**
   * `auto` finishes each utterance on the next microtask, which is what most
   * tests want. Turn it off to hold an utterance open and interrupt it.
   */
  constructor(
    private readonly options: { auto?: boolean; audible?: boolean; fail?: boolean } = {},
  ) {
    this.audible = options.audible ?? true;
  }

  speak(text: string, options: SpeakOptions): Promise<SpeakResult> {
    return new Promise((resolve) => {
      const utterance: Utterance = {
        text,
        voice: options.voice,
        result: null,
        options,
        settle: (result) => {
          if (utterance.result !== null) return;
          utterance.result = result;
          resolve(result);
        },
      };
      this.utterances.push(utterance);
      if (this.options.fail) {
        utterance.settle("failed");
      } else if (this.options.auto ?? true) {
        queueMicrotask(() => {
          if (utterance.result !== null) return;
          options.onStart?.();
          utterance.settle("ended");
        });
      }
    });
  }

  cancel(): void {
    this.cancels += 1;
    this.current?.settle("cancelled");
  }

  /** The utterance in progress, if any. */
  get current(): Utterance | undefined {
    return this.utterances.find((utterance) => utterance.result === null);
  }

  /** Manual mode: the current utterance starts making sound. */
  start(): void {
    this.current?.options.onStart?.();
  }

  /** Manual mode: the current utterance finishes. */
  finish(): void {
    this.current?.settle("ended");
  }

  /** What was spoken to completion, in order. */
  get spoken(): string[] {
    return this.utterances.filter((u) => u.result === "ended").map((u) => u.text);
  }
}

export class FakeInput implements SpeechInput {
  readonly available: boolean;
  starts = 0;
  aborts = 0;
  private handlers: ListenHandlers | null = null;
  private heardSoFar = "";

  constructor(available = true) {
    this.available = available;
  }

  get listening(): boolean {
    return this.handlers !== null;
  }

  start(handlers: ListenHandlers): void {
    this.starts += 1;
    this.handlers = handlers;
    this.heardSoFar = "";
  }

  stop(): void {
    this.done({ text: this.heardSoFar });
  }

  abort(): void {
    this.aborts += 1;
    this.handlers = null;
  }

  /** The recognizer reports words it may still revise. */
  hearInterim(text: string): void {
    this.heardSoFar = text;
    this.handlers?.onInterim(text);
  }

  /** The customer stopped talking and the recognizer settled on this text. */
  hear(text: string): void {
    this.done({ text });
  }

  failWith(error: Extract<ListenResult, { error: unknown }>["error"]): void {
    this.done({ error });
  }

  private done(result: ListenResult): void {
    const handlers = this.handlers;
    this.handlers = null;
    handlers?.onDone(result);
  }
}
