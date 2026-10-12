/**
 * One call, browser side.
 *
 * `CallSession` owns everything that changes during a call: the transcript,
 * the captions, the live cart, the speaker queue, the in-flight request, and
 * the turn-taking state machine. It is plain TypeScript with its speech and
 * network injected, so the whole thing (barge-in included) runs in tests
 * without a browser. React only subscribes to its snapshot.
 *
 * The transcript in `turns` is the source of truth. The cart and the tool log
 * are derived from it with the same `replay` the server uses.
 */
import type { ApiMeta, ApiResponse, ErrorKind } from "../api";
import type { StreamHandlers } from "../client";
import {
  emptyOrder,
  priceCart,
  type KitchenChange,
  type KitchenEffect,
  type PlanView,
  type PricedCart,
  type Receipt,
} from "../order/engine";
import { CALL_LIMITS, newTurn, replay, type TurnRecord } from "../order/history";
import type { ModelUse, TurnBody, TurnData, TurnEvent } from "../order/protocol";
import { findSample, type SampleCall } from "../samples";
import { SentenceChunker, splitSentences } from "../speech/chunker";
import { Speaker, type SpeakerItem } from "../speech/speaker";
import {
  LISTEN_ERROR_TEXT,
  type SpeakResult,
  type SpeechInput,
  type SpeechOutput,
} from "../speech/types";
import {
  INITIAL_VOICE_STATE,
  voiceReducer,
  type Phase,
  type VoiceEffect,
  type VoiceEvent,
  type VoiceState,
} from "./machine";

// What the UI renders ---------------------------------------------------------

export type SentenceStatus = "queued" | "speaking" | "spoken" | "dropped";

export interface CaptionSentence {
  id: string;
  text: string;
  status: SentenceStatus;
}

export type Caption =
  | {
      id: string;
      role: "customer";
      text: string;
      scripted: boolean;
      speaking: boolean;
      /** The turn failed, so the agent never heard this. */
      unanswered?: boolean;
    }
  | {
      id: string;
      role: "agent";
      sentences: CaptionSentence[];
      /** Streamed text that is not a whole sentence yet. */
      pending: string;
      /** The customer cut this reply off. */
      cutOff: boolean;
    }
  | { id: string; role: "kitchen"; effects: KitchenEffect[] }
  /** A tool call, shown in the conversation where it happened. */
  | { id: string; role: "tool"; entry: LogEntry };

export interface LogEntry {
  id: string;
  name: string;
  ok: boolean;
  summary: string;
  plan?: PlanView;
}

export interface TurnTimeline {
  /** `live` was measured in this browser. `sample` is a replay and shows no browser timings. */
  source: "live" | "sample";
  /** A hand-written sample: nothing was measured, so no numbers are shown at all. */
  placeholder: boolean;
  recordedAt: string | null;
  status: "running" | "done" | "cancelled" | "failed";
  /** Milliseconds after the customer stopped speaking. Null until it happens. */
  marks: {
    firstToken: number | null;
    firstSentence: number | null;
    audioStart: number | null;
    done: number | null;
  };
  /** Whether sound was playing, so "audio started" means something. */
  audible: boolean;
  /** Server clock marks stored with a recorded sample. */
  recorded: TurnData["timing"];
  models: ModelUse[];
  meta: ApiMeta | null;
  unbackedAmounts: string[];
}

export interface CallError {
  kind: ErrorKind | "speech" | "limit";
  message: string;
}

export interface CallSnapshot {
  phase: Phase;
  captions: Caption[];
  /** Words the recognizer has heard so far in this utterance. */
  interim: string;
  cart: PricedCart;
  receipt: Receipt | null;
  log: LogEntry[];
  /** Out of stock right now, including changes the agent has not been told about yet. */
  outOfStock: string[];
  /** Kitchen changes waiting to go out with the next turn. */
  pendingKitchen: KitchenChange[];
  /** Set while the planner model is working on a group order. */
  planning: { people: number; budget: string | null; needs: string[] } | null;
  timeline: TurnTimeline | null;
  /** The sample call being played, if any. */
  sample: { id: string; title: string; turn: number; of: number; skipping: boolean } | null;
  /** Where the conversation on screen came from. */
  origin: "none" | "sample" | "live";
  /** The sample call that just finished playing. */
  finished: string | null;
  /** The sample call the conversation on screen came from, playing or not. */
  sampleId: string | null;
  error: CallError | null;
  soundOn: boolean;
  /** The browser has speech synthesis but it produced no sound. */
  audioFailed: boolean;
  /** Live spend across this call. */
  spend: { costUsd: number; turns: number };
  turnsLeft: number;
}

// Dependencies ----------------------------------------------------------------

export type SendTurn = (
  body: TurnBody & { instant?: boolean },
  apiKey: string | null,
  handlers: StreamHandlers<TurnEvent>,
  signal: AbortSignal,
) => Promise<ApiResponse<TurnData>>;

export interface SessionDeps {
  input: SpeechInput;
  /** The speaking implementation, or null when this browser has none. */
  audible: SpeechOutput | null;
  silent: SpeechOutput;
  send: SendTurn;
  getKey: () => string | null;
  now: () => number;
  /** The beat between turns of a sample call. */
  pause: (ms: number) => Promise<void>;
}

const SAMPLE_GAP_MS = 550;
const EMPTY_CART = priceCart(emptyOrder());

interface Flight {
  /** The voice machine's turn number, or null for a silent fast-forward turn. */
  turnNo: number | null;
  record: TurnRecord;
  controller: AbortController;
  chunker: SentenceChunker;
  captionId: string | null;
  sentenceCount: number;
  startedAt: number;
  demo: boolean;
  instant: boolean;
  /** The server finished the turn and it is in the transcript. */
  committed: boolean;
  /** The first sentence of this turn has started playing. */
  speechStarted: boolean;
  /** Tool calls shown for this turn, so ones that never made the transcript can be taken back. */
  toolIds: string[];
  /** The caption holding the customer's words for this turn. */
  customerCaptionId: string | null;
}

interface SampleRun {
  sample: SampleCall;
  cancelled: boolean;
  demoId: string | null;
}

export class CallSession {
  private voice: VoiceState = INITIAL_VOICE_STATE;
  private turns: TurnRecord[] = [];
  private captions: Caption[] = [];
  private interim = "";
  private cart: PricedCart = EMPTY_CART;
  private receipt: Receipt | null = null;
  private committedLog: LogEntry[] = [];
  private liveLog: LogEntry[] = [];
  private liveCart: PricedCart | null = null;
  private committedOut: string[] = [];
  private pendingKitchen: KitchenChange[] = [];
  private planning: CallSnapshot["planning"] = null;
  private timeline: TurnTimeline | null = null;
  private error: CallError | null = null;
  private origin: CallSnapshot["origin"] = "none";
  private finished: string | null = null;
  private sampleId: string | null = null;
  private soundOn = true;
  private audioFailed = false;
  private spend = { costUsd: 0, turns: 0 };

  private flight: Flight | null = null;
  private run: SampleRun | null = null;
  private sampleView: CallSnapshot["sample"] = null;
  private idleWaiters: (() => void)[] = [];
  private nextId = 1;
  /** Which caption sentence and which turn a queued utterance belongs to. */
  private readonly spoken = new Map<string, { captionId: string; turnNo: number | null }>();

  private readonly speaker: Speaker;
  private readonly listeners = new Set<() => void>();
  private snapshot: CallSnapshot;

  constructor(private readonly deps: SessionDeps) {
    this.speaker = new Speaker(
      () =>
        this.soundOn && this.deps.audible && !this.audioFailed
          ? this.deps.audible
          : this.deps.silent,
      this.deps.silent,
      {
        onStart: (item, audible) => this.onSpeechStart(item, audible),
        onEnd: (item, result) => this.onSpeechEnd(item, result),
        onAudioFailed: () => {
          this.audioFailed = true;
          this.emit();
        },
      },
    );
    this.snapshot = this.build();
  }

  // Store interface -----------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): CallSnapshot => this.snapshot;

  private build(): CallSnapshot {
    const out = new Set(this.committedOut);
    for (const change of this.pendingKitchen) {
      if (change.inStock) out.delete(change.id);
      else out.add(change.id);
    }
    return {
      phase: this.voice.phase,
      captions: this.captions,
      interim: this.interim,
      cart: this.liveCart ?? this.cart,
      receipt: this.receipt,
      log: [...this.committedLog, ...this.liveLog],
      outOfStock: [...out].sort(),
      pendingKitchen: this.pendingKitchen,
      planning: this.planning,
      timeline: this.timeline,
      sample: this.sampleView,
      origin: this.origin,
      finished: this.finished,
      sampleId: this.sampleId,
      error: this.error,
      soundOn: this.soundOn,
      audioFailed: this.audioFailed,
      spend: this.spend,
      turnsLeft: Math.max(0, CALL_LIMITS.maxTurns - this.turns.length),
    };
  }

  private emit(): void {
    this.snapshot = this.build();
    this.listeners.forEach((listener) => listener());
  }

  private id(prefix: string): string {
    return `${prefix}${this.nextId++}`;
  }

  // Visitor actions -----------------------------------------------------------

  /** The microphone was tapped: start listening, finish listening, or barge in. */
  micTap(): void {
    if (!this.readyForLive()) return;
    this.unlockAudio();
    this.dispatch({ type: "MIC" });
  }

  /** Space went down: push to talk. Barges in if the agent is replying. */
  micDown(): void {
    if (this.voice.phase === "listening" || !this.readyForLive()) return;
    this.unlockAudio();
    this.dispatch({ type: "MIC" });
  }

  private unlockAudio(): void {
    if (this.soundOn && !this.audioFailed) this.deps.audible?.unlock?.();
  }

  /** Space came up: the customer is done talking. */
  micUp(): void {
    this.dispatch({ type: "MIC_RELEASE" });
  }

  submitText(text: string): void {
    if (!text.trim() || !this.readyForLive()) return;
    this.unlockAudio();
    this.dispatch({ type: "SUBMIT", text });
  }

  /** Stops whatever is happening: listening, the reply in progress, or a sample call. */
  stop(): void {
    if (this.run) {
      this.run.cancelled = true;
      this.run = null;
      this.sampleView = null;
    }
    this.dispatch({ type: "STOP" });
    // The scripted customer's voice is not part of the state machine, so silence it here too.
    this.hush();
    this.releaseIdle();
    this.emit();
  }

  /** Starts a fresh call, discarding the current one. */
  reset(): void {
    this.clear();
    this.emit();
  }

  setSound(on: boolean): void {
    this.soundOn = on;
    // Turning sound back on is a request to try the browser's voice again.
    if (on) this.audioFailed = false;
    this.emit();
  }

  /** The staff mark something in or out of stock. The agent is told on the next turn. */
  toggleStock(id: string): void {
    if (this.run || !this.deps.getKey()) return;
    // A finished sample call is not a call the visitor can continue; their own starts clean.
    if (this.origin === "sample") this.clear();
    if (this.receipt) return;
    const committedOut = this.committedOut.includes(id);
    const pending = this.pendingKitchen.find((change) => change.id === id);
    const currentlyOut = pending ? !pending.inStock : committedOut;
    const nextInStock = currentlyOut;
    this.pendingKitchen = this.pendingKitchen.filter((change) => change.id !== id);
    // Only keep a change that differs from what the agent already knows.
    if (nextInStock === committedOut) this.pendingKitchen.push({ id, inStock: nextInStock });
    this.emit();
  }

  dispose(): void {
    this.clear();
    this.listeners.clear();
  }

  /** Live actions need a key, and never continue a transcript that came from a sample. */
  private readyForLive(): boolean {
    if (!this.deps.getKey()) return false;
    if (this.run) this.stop();
    if (this.origin === "sample") this.clear();
    if (this.receipt) return false;
    if (this.turns.length >= CALL_LIMITS.maxTurns) {
      this.error = {
        kind: "limit",
        message: `A call is limited to ${CALL_LIMITS.maxTurns} turns. Start a new call to keep going.`,
      };
      this.emit();
      return false;
    }
    return true;
  }

  private clear(): void {
    if (this.run) this.run.cancelled = true;
    this.run = null;
    this.sampleView = null;
    this.flight?.controller.abort();
    this.flight = null;
    this.speaker.cancel();
    this.deps.input.abort();
    this.voice = INITIAL_VOICE_STATE;
    this.turns = [];
    this.captions = [];
    this.interim = "";
    this.cart = EMPTY_CART;
    this.receipt = null;
    this.committedLog = [];
    this.liveLog = [];
    this.liveCart = null;
    this.committedOut = [];
    this.pendingKitchen = [];
    this.planning = null;
    this.timeline = null;
    this.error = null;
    this.origin = "none";
    this.finished = null;
    this.sampleId = null;
    this.spend = { costUsd: 0, turns: 0 };
    this.spoken.clear();
    // One silent utterance turns the voice off for that call only; a new call tries again.
    this.audioFailed = false;
    this.releaseIdle();
  }

  // The state machine and its effects -------------------------------------------

  private dispatch(event: VoiceEvent): void {
    const { state, effects } = voiceReducer(this.voice, event);
    this.voice = state;
    if (state.error && state.error !== this.error?.message) {
      this.error = { kind: "speech", message: state.error };
    }
    for (const effect of effects) this.perform(effect);
    if (state.phase === "idle") this.releaseIdle();
    this.emit();
  }

  private perform(effect: VoiceEffect): void {
    switch (effect.type) {
      case "listen":
        this.error = null;
        this.interim = "";
        // During a sample call the "customer" is scripted, so the microphone stays off.
        if (this.run) return;
        this.deps.input.start({
          onInterim: (text) => {
            this.interim = text;
            this.emit();
          },
          onDone: (result) => {
            this.interim = "";
            if ("error" in result) {
              this.dispatch({ type: "LISTEN_FAILED", message: LISTEN_ERROR_TEXT[result.error] });
            } else {
              this.dispatch({ type: "HEARD", text: result.text });
            }
          },
        });
        return;
      case "finishListening":
        if (!this.run) this.deps.input.stop();
        return;
      case "abortListening":
        this.interim = "";
        if (!this.run) this.deps.input.abort();
        return;
      case "send":
        void this.runTurn({
          turnNo: effect.turn,
          text: effect.text,
          interrupted: effect.interrupted,
          demoId: this.run?.demoId ?? null,
          instant: false,
        });
        return;
      case "abortRequest":
        this.abandonFlight();
        return;
      case "hush":
        this.hush();
        return;
    }
  }

  private whenIdle(): Promise<void> {
    if (this.voice.phase === "idle") return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private releaseIdle(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    waiters.forEach((resolve) => resolve());
  }

  /** Stops the voice at once. Sentences that were not finished are marked as dropped. */
  private hush(): void {
    this.speaker.cancel();
    this.captions = this.captions.map((caption) => {
      if (caption.role === "customer")
        return caption.speaking ? { ...caption, speaking: false } : caption;
      if (caption.role !== "agent") return caption;
      if (!caption.sentences.some((s) => s.status === "queued" || s.status === "speaking")) {
        return caption;
      }
      return {
        ...caption,
        cutOff: true,
        pending: "",
        sentences: caption.sentences.map((sentence) =>
          sentence.status === "queued" || sentence.status === "speaking"
            ? { ...sentence, status: "dropped" as const }
            : sentence,
        ),
      };
    });
  }

  /**
   * Barge-in or Stop while a request is in flight. The fetch is aborted, which
   * the server sees as a cancelled request and stops calling the model. Rounds
   * that had already finished stay in the transcript, because their tool calls
   * really happened; the unfinished part of the reply is gone.
   */
  private abandonFlight(): void {
    const flight = this.flight;
    this.flight = null;
    this.planning = null;
    if (!flight || flight.committed) return;
    flight.controller.abort();
    this.turns.push(flight.record);
    this.liveLog = [];
    this.liveCart = null;
    this.derive();
    this.dropUnstoredTools(flight);
    if (flight.captionId) {
      this.updateAgent(flight.captionId, (caption) => ({ ...caption, cutOff: true, pending: "" }));
    }
    if (this.timeline) this.timeline = { ...this.timeline, status: "cancelled" };
  }

  /** Removes tool lines whose round never reached the transcript, so the screen matches the order. */
  private dropUnstoredTools(flight: Flight): void {
    const stored = new Set(this.committedLog.map((entry) => entry.id));
    const gone = new Set(flight.toolIds.filter((id) => !stored.has(id)).map((id) => `tool-${id}`));
    if (gone.size > 0) this.captions = this.captions.filter((caption) => !gone.has(caption.id));
  }

  // One turn --------------------------------------------------------------------

  private async runTurn(args: {
    turnNo: number | null;
    text: string;
    interrupted: boolean;
    demoId: string | null;
    instant: boolean;
  }): Promise<boolean> {
    const kitchen = this.pendingKitchen;
    this.pendingKitchen = [];
    const flight: Flight = {
      turnNo: args.turnNo,
      record: newTurn(args.text, kitchen, args.interrupted),
      controller: new AbortController(),
      chunker: new SentenceChunker(),
      captionId: null,
      sentenceCount: 0,
      startedAt: this.deps.now(),
      demo: args.demoId !== null,
      instant: args.instant,
      committed: false,
      speechStarted: false,
      toolIds: [],
      customerCaptionId: null,
    };
    this.flight = flight;
    this.error = null;
    this.finished = null;
    this.origin = flight.demo ? "sample" : "live";
    if (!flight.demo) {
      flight.customerCaptionId = this.id("c");
      this.captions = [
        ...this.captions,
        {
          id: flight.customerCaptionId,
          role: "customer",
          text: args.text,
          scripted: false,
          speaking: false,
        },
      ];
    }
    this.timeline = {
      source: flight.demo ? "sample" : "live",
      placeholder: false,
      recordedAt: null,
      status: "running",
      marks: { firstToken: null, firstSentence: null, audioStart: null, done: null },
      audible: false,
      recorded: null,
      models: [],
      meta: null,
      unbackedAmounts: [],
    };
    this.emit();

    const body: TurnBody & { instant?: boolean } = {
      ...(args.demoId ? { demoId: args.demoId } : {}),
      // A sample turn is looked up by its id; only a live turn needs the transcript.
      turns: flight.demo ? [] : this.turns,
      text: args.text,
      kitchen,
      interrupted: args.interrupted,
      ...(args.instant ? { instant: true } : {}),
    };
    const response = await this.deps.send(
      body,
      // Sample calls never spend the visitor's key: they always replay.
      flight.demo ? null : this.deps.getKey(),
      {
        onMeta: (meta) => {
          if (this.flight !== flight || !this.timeline) return;
          this.timeline = {
            ...this.timeline,
            placeholder: meta.placeholder,
            recordedAt: meta.recordedAt,
          };
        },
        onEvent: (event) => this.onEvent(flight, event),
      },
      flight.controller.signal,
    );

    // Abandoned while in flight: `abandonFlight` already dealt with it.
    if (this.flight !== flight) return false;

    if (!response.ok) return this.failTurn(flight, kitchen, response);

    flight.committed = true;
    flight.record.assistant = response.data.assistant;
    flight.record.plans = response.data.plans;
    this.turns.push(flight.record);
    try {
      this.derive();
    } catch {
      // The reply cannot be replayed into an order, so it is not kept.
      this.turns.pop();
      return this.failTurn(flight, kitchen, {
        ok: false,
        error: { kind: "server", message: "The reply could not be applied to the order." },
      });
    }
    this.addSentences(flight, flight.chunker.flush());
    if (flight.captionId)
      this.updateAgent(flight.captionId, (caption) => ({ ...caption, pending: "" }));
    this.liveLog = [];
    this.liveCart = null;
    this.planning = null;
    if (this.timeline) {
      this.timeline = {
        ...this.timeline,
        status: "done",
        placeholder: response.meta.placeholder,
        recordedAt: response.meta.recordedAt,
        marks: { ...this.timeline.marks, done: this.deps.now() - flight.startedAt },
        recorded: flight.demo ? response.data.timing : null,
        models: response.data.models,
        meta: response.meta,
        unbackedAmounts: response.data.unbackedAmounts,
      };
    }
    if (response.meta.mode === "live") this.addSpend(response.meta);
    if (flight.turnNo !== null) this.dispatch({ type: "REPLY_DONE", turn: flight.turnNo });
    else this.emit();
    return true;
  }

  /** A turn that did not complete: it leaves the transcript and the staff's changes go back in the queue. */
  private failTurn(
    flight: Flight,
    kitchen: KitchenChange[],
    response: Extract<ApiResponse<TurnData>, { ok: false }>,
  ): false {
    this.flight = null;
    this.liveLog = [];
    this.liveCart = null;
    this.planning = null;
    // The turn never happened as far as the transcript goes, so the staff's changes go back in the queue.
    this.pendingKitchen = [...kitchen, ...this.pendingKitchen];
    this.dropUnstoredTools(flight);
    this.captions = this.captions.map((caption) =>
      caption.id === flight.customerCaptionId && caption.role === "customer"
        ? { ...caption, unanswered: true }
        : caption,
    );
    this.error = { kind: response.error.kind, message: response.error.message };
    if (flight.captionId) {
      this.updateAgent(flight.captionId, (caption) => ({
        ...caption,
        cutOff: true,
        pending: "",
      }));
    }
    if (this.timeline) {
      this.timeline = { ...this.timeline, status: "failed", meta: response.meta ?? null };
    }
    if (response.meta?.mode === "live") this.addSpend(response.meta);
    if (flight.turnNo !== null) {
      this.dispatch({ type: "FAILED", turn: flight.turnNo, message: response.error.message });
    } else {
      this.emit();
    }
    return false;
  }

  private addSpend(meta: ApiMeta): void {
    this.spend = { costUsd: this.spend.costUsd + meta.costUsd, turns: this.spend.turns + 1 };
  }

  private onEvent(flight: Flight, event: TurnEvent): void {
    if (this.flight !== flight) return;
    switch (event.type) {
      case "kitchen":
        this.captions = [
          ...this.captions,
          { id: this.id("k"), role: "kitchen", effects: event.effects },
        ];
        break;
      case "text": {
        if (this.timeline && this.timeline.marks.firstToken === null) {
          this.timeline = {
            ...this.timeline,
            marks: { ...this.timeline.marks, firstToken: this.deps.now() - flight.startedAt },
          };
        }
        const sentences = flight.chunker.push(event.delta);
        this.ensureAgentCaption(flight);
        this.addSentences(flight, sentences);
        this.updateAgent(flight.captionId!, (caption) => ({
          ...caption,
          pending: flight.chunker.pending.trim(),
        }));
        break;
      }
      case "planning":
        // Say "let me work that out" now, not after the planner comes back.
        this.addSentences(flight, flight.chunker.flush());
        this.planning = { people: event.people, budget: event.budget, needs: event.needs };
        break;
      case "tool": {
        this.addSentences(flight, flight.chunker.flush());
        this.planning = null;
        const entry: LogEntry = {
          id: event.id,
          name: event.name,
          ok: event.ok,
          summary: event.summary,
          ...(event.plan ? { plan: event.plan } : {}),
        };
        this.liveLog = [...this.liveLog, entry];
        this.liveCart = event.cart;
        this.captions = [...this.captions, { id: `tool-${event.id}`, role: "tool", entry }];
        // Whatever the agent says next belongs under this call, in a new caption.
        flight.captionId = null;
        flight.toolIds.push(event.id);
        break;
      }
      case "round":
        // A finished round is kept even if the rest of the turn is cancelled.
        flight.record.assistant.push(event.content);
        Object.assign(flight.record.plans, event.plans);
        this.addSentences(flight, flight.chunker.flush());
        break;
    }
    this.emit();
  }

  private ensureAgentCaption(flight: Flight): void {
    if (flight.captionId) return;
    flight.captionId = this.id("a");
    this.captions = [
      ...this.captions,
      { id: flight.captionId, role: "agent", sentences: [], pending: "", cutOff: false },
    ];
  }

  private updateAgent(
    captionId: string,
    change: (caption: Extract<Caption, { role: "agent" }>) => Extract<Caption, { role: "agent" }>,
  ): void {
    this.captions = this.captions.map((caption) =>
      caption.id === captionId && caption.role === "agent" ? change(caption) : caption,
    );
  }

  /** Hands finished sentences to the speaker, one utterance each. */
  private addSentences(flight: Flight, sentences: string[]): void {
    if (sentences.length === 0) return;
    this.ensureAgentCaption(flight);
    const captionId = flight.captionId!;
    for (const text of sentences) {
      const id = `${captionId}.${flight.sentenceCount++}`;
      const speak = !flight.instant && flight.turnNo !== null;
      this.updateAgent(captionId, (caption) => ({
        ...caption,
        pending: "",
        sentences: [...caption.sentences, { id, text, status: speak ? "queued" : "spoken" }],
      }));
      if (this.timeline && this.timeline.marks.firstSentence === null) {
        this.timeline = {
          ...this.timeline,
          marks: { ...this.timeline.marks, firstSentence: this.deps.now() - flight.startedAt },
        };
      }
      if (!speak) continue;
      this.spoken.set(id, { captionId, turnNo: flight.turnNo });
      this.dispatch({ type: "SENTENCE", turn: flight.turnNo! });
      // The machine drops a sentence from a turn that is no longer current.
      if (this.voice.turn === flight.turnNo) this.speaker.enqueue({ id, text, voice: "agent" });
    }
  }

  private setSentence(id: string, status: SentenceStatus): void {
    const owner = this.spoken.get(id);
    if (!owner) return;
    this.updateAgent(owner.captionId, (caption) => ({
      ...caption,
      sentences: caption.sentences.map((sentence) =>
        sentence.id === id ? { ...sentence, status } : sentence,
      ),
    }));
  }

  private onSpeechStart(item: SpeakerItem, audible: boolean): void {
    const owner = this.spoken.get(item.id);
    if (!owner) return; // A scripted customer line: its caption is already marked as speaking.
    this.setSentence(item.id, "speaking");
    // The first sentence of the current turn to start playing marks "audio started".
    const flight = this.flight;
    if (this.timeline && flight && flight.turnNo === owner.turnNo && !flight.speechStarted) {
      flight.speechStarted = true;
      this.timeline = {
        ...this.timeline,
        audible,
        marks: {
          ...this.timeline.marks,
          audioStart: audible ? this.deps.now() - flight.startedAt : null,
        },
      };
    }
    this.emit();
  }

  private onSpeechEnd(item: SpeakerItem, result: SpeakResult): void {
    const owner = this.spoken.get(item.id);
    if (!owner) return;
    this.setSentence(item.id, result === "cancelled" ? "dropped" : "spoken");
    this.spoken.delete(item.id);
    if (owner.turnNo !== null) this.dispatch({ type: "SPOKEN", turn: owner.turnNo });
    else this.emit();
  }

  /** Recomputes the cart, receipt, tool log, and stock from the transcript. */
  private derive(): void {
    const replayed = replay(this.turns);
    this.cart = priceCart(replayed.state);
    this.receipt = replayed.state.receipt;
    this.committedOut = replayed.state.outOfStock;
    this.committedLog = replayed.log.map(({ id, name, ok, summary, plan }) => ({
      id,
      name,
      ok,
      summary,
      ...(plan ? { plan } : {}),
    }));
  }

  // Sample calls ----------------------------------------------------------------

  /** Plays a sample call turn by turn, with the scripted customer in a second voice. */
  async playSample(id: string): Promise<void> {
    const sample = findSample(id);
    if (!sample) return;
    this.clear();
    this.unlockAudio();
    const run: SampleRun = { sample, cancelled: false, demoId: null };
    this.run = run;
    this.origin = "sample";
    this.sampleId = sample.id;

    for (const [index, turn] of sample.turns.entries()) {
      if (run.cancelled) return;
      this.sampleView = {
        id: sample.id,
        title: sample.title,
        turn: index + 1,
        of: sample.turns.length,
        skipping: false,
      };
      this.pendingKitchen = [...this.pendingKitchen, ...turn.kitchen];
      const captionId = this.id("c");
      this.captions = [
        ...this.captions,
        { id: captionId, role: "customer", text: turn.text, scripted: true, speaking: true },
      ];
      // The agent "listens" while the scripted customer talks.
      this.dispatch({ type: "MIC" });
      for (const [part, sentence] of splitSentences(turn.text).entries()) {
        this.speaker.enqueue({ id: `${captionId}.${part}`, text: sentence, voice: "customer" });
      }
      await this.speaker.whenIdle();
      if (run.cancelled) return;
      this.captions = this.captions.map((caption) =>
        caption.id === captionId && caption.role === "customer"
          ? { ...caption, speaking: false }
          : caption,
      );
      run.demoId = turn.demoId;
      this.dispatch({ type: "HEARD", text: turn.text });
      await this.whenIdle();
      if (run.cancelled) return;
      if (this.error) break;
      if (index < sample.turns.length - 1) await this.deps.pause(SAMPLE_GAP_MS);
    }
    if (run.cancelled) return;
    this.run = null;
    this.sampleView = null;
    this.finished = this.error ? null : sample.id;
    this.emit();
  }

  /** Jumps to the end of the sample call being played: same turns, no speech, no pacing. */
  async skipSample(): Promise<void> {
    const sample = this.run?.sample;
    if (!sample) return;
    this.clear();
    const run: SampleRun = { sample, cancelled: false, demoId: null };
    this.run = run;
    this.origin = "sample";
    this.sampleId = sample.id;

    for (const [index, turn] of sample.turns.entries()) {
      this.sampleView = {
        id: sample.id,
        title: sample.title,
        turn: index + 1,
        of: sample.turns.length,
        skipping: true,
      };
      this.pendingKitchen = [...this.pendingKitchen, ...turn.kitchen];
      this.captions = [
        ...this.captions,
        { id: this.id("c"), role: "customer", text: turn.text, scripted: true, speaking: false },
      ];
      const ok = await this.runTurn({
        turnNo: null,
        text: turn.text,
        interrupted: false,
        demoId: turn.demoId,
        instant: true,
      });
      if (run.cancelled) return;
      if (!ok) break;
      this.flight = null;
    }
    this.run = null;
    this.sampleView = null;
    this.finished = this.error ? null : sample.id;
    this.emit();
  }
}
