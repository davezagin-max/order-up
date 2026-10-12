/**
 * A queue of sentences to speak, one at a time, that can be cut off at once.
 *
 * The reply arrives sentence by sentence, usually faster than it can be
 * spoken. Each sentence is its own short utterance, which is what makes
 * barge-in instant (cancel drops the current one and the whole queue) and
 * sidesteps browsers that cut off or stall on long utterances.
 */
import { speakable } from "./speakable";
import type { SpeakResult, SpeechOutput, Voice } from "./types";

export interface SpeakerItem {
  id: string;
  text: string;
  voice: Voice;
}

export interface SpeakerHooks {
  /** The item began: sound started, or with no audio its caption turn began. */
  onStart?(item: SpeakerItem, audible: boolean): void;
  onEnd?(item: SpeakerItem, result: SpeakResult): void;
  /** The audible engine produced no sound. Captions carry on without it. */
  onAudioFailed?(): void;
}

export class Speaker {
  private queue: SpeakerItem[] = [];
  private running = false;
  /** Bumped by `cancel`, so a loop that was mid-utterance knows it is stale. */
  private generation = 0;
  private active: SpeechOutput | null = null;
  private waiters: (() => void)[] = [];

  /**
   * `pick` chooses the output for the next sentence (sound on, or captions
   * only). `silent` is the fallback when the audible one fails to start.
   */
  constructor(
    private readonly pick: () => SpeechOutput,
    private readonly silent: SpeechOutput,
    private readonly hooks: SpeakerHooks = {},
  ) {}

  get busy(): boolean {
    return this.running;
  }

  enqueue(item: SpeakerItem): void {
    this.queue.push(item);
    if (!this.running) void this.run();
  }

  /** Stops the current utterance and forgets everything queued. */
  cancel(): void {
    this.generation += 1;
    this.queue = [];
    this.running = false;
    const active = this.active;
    this.active = null;
    active?.cancel();
    this.release();
  }

  /** Resolves once nothing is being spoken and nothing is queued. */
  whenIdle(): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((resolve) => resolve());
  }

  private async run(): Promise<void> {
    this.running = true;
    const generation = this.generation;
    const stale = () => generation !== this.generation;

    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      const text = speakable(item.text);
      let result: SpeakResult = "ended";
      if (text) {
        result = await this.speakWith(this.pick(), item, text, stale);
        if (stale()) return;
        if (result === "failed") {
          this.hooks.onAudioFailed?.();
          result = await this.speakWith(this.silent, item, text, stale);
          if (stale()) return;
        }
      } else {
        this.hooks.onStart?.(item, false);
      }
      this.hooks.onEnd?.(item, result);
      if (stale()) return;
    }
    this.running = false;
    this.active = null;
    this.release();
  }

  private speakWith(
    output: SpeechOutput,
    item: SpeakerItem,
    text: string,
    stale: () => boolean,
  ): Promise<SpeakResult> {
    this.active = output;
    return output.speak(text, {
      voice: item.voice,
      onStart: () => {
        if (!stale()) this.hooks.onStart?.(item, output.audible);
      },
    });
  }
}
