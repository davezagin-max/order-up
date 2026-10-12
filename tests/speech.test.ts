import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeInput, FakeOutput } from "@/lib/speech/fake";
import { NoSpeechInput, SilentOutput, readingTimeMs } from "@/lib/speech/silent";
import { Speaker, type SpeakerItem } from "@/lib/speech/speaker";
import type { ListenResult, SpeakResult } from "@/lib/speech/types";
import { pickVoices, type VoiceInfo } from "@/lib/speech/web";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const item = (id: string, text: string, voice: "agent" | "customer" = "agent"): SpeakerItem => ({
  id,
  text,
  voice,
});

function track() {
  const events: string[] = [];
  return {
    events,
    hooks: {
      onStart: (it: SpeakerItem, audible: boolean) =>
        events.push(`start ${it.id} ${audible ? "audible" : "silent"}`),
      onEnd: (it: SpeakerItem, result: SpeakResult) => events.push(`end ${it.id} ${result}`),
      onAudioFailed: () => events.push("audio failed"),
    },
  };
}

describe("speaker queue", () => {
  it("speaks one sentence at a time, in order, in its speakable form", async () => {
    const output = new FakeOutput({ auto: false });
    const { events, hooks } = track();
    const speaker = new Speaker(() => output, new FakeOutput({ audible: false }), hooks);
    speaker.enqueue(item("a", "That is $8.50."));
    speaker.enqueue(item("b", "Anything else?"));
    expect(speaker.busy).toBe(true);
    expect(output.utterances.map((u) => u.text)).toEqual(["That is 8 dollars and 50 cents."]);

    output.start();
    output.finish();
    await tick();
    expect(output.utterances.map((u) => u.text)).toEqual([
      "That is 8 dollars and 50 cents.",
      "Anything else?",
    ]);
    output.start();
    output.finish();
    await speaker.whenIdle();
    expect(speaker.busy).toBe(false);
    expect(events).toEqual(["start a audible", "end a ended", "start b audible", "end b ended"]);
  });

  it("cancel stops the current sentence at once and forgets the rest", async () => {
    const output = new FakeOutput({ auto: false });
    const { events, hooks } = track();
    const speaker = new Speaker(() => output, new FakeOutput({ audible: false }), hooks);
    speaker.enqueue(item("a", "One."));
    speaker.enqueue(item("b", "Two."));
    speaker.enqueue(item("c", "Three."));
    output.start();
    const idle = speaker.whenIdle();
    speaker.cancel();
    await idle; // waiters are released by the cancel
    await tick();
    expect(output.cancels).toBe(1);
    expect(output.utterances.map((u) => [u.text, u.result])).toEqual([["One.", "cancelled"]]);
    // Nothing is reported for the abandoned sentences: whoever cancelled already knows.
    expect(events).toEqual(["start a audible"]);

    // The queue is usable again straight away.
    speaker.enqueue(item("d", "Four."));
    output.start();
    output.finish();
    await speaker.whenIdle();
    expect(events).toEqual(["start a audible", "start d audible", "end d ended"]);
  });

  it("falls back to the silent output when the audible one makes no sound", async () => {
    const broken = new FakeOutput({ fail: true });
    const silent = new FakeOutput({ audible: false });
    const { events, hooks } = track();
    const speaker = new Speaker(() => broken, silent, hooks);
    speaker.enqueue(item("a", "Hello."));
    await speaker.whenIdle();
    expect(silent.spoken).toEqual(["Hello."]);
    expect(events).toEqual(["audio failed", "start a silent", "end a ended"]);
  });

  it("skips text with nothing to say without touching the output", async () => {
    const output = new FakeOutput();
    const { events, hooks } = track();
    const speaker = new Speaker(() => output, new FakeOutput({ audible: false }), hooks);
    speaker.enqueue(item("a", "🎉"));
    await speaker.whenIdle();
    expect(output.utterances).toEqual([]);
    expect(events).toEqual(["start a silent", "end a ended"]);
  });

  it("asks which output to use for every sentence, so muting takes effect mid-reply", async () => {
    const loud = new FakeOutput();
    const quiet = new FakeOutput({ audible: false });
    let muted = false;
    const speaker = new Speaker(() => (muted ? quiet : loud), quiet);
    speaker.enqueue(item("a", "One."));
    await speaker.whenIdle();
    muted = true;
    speaker.enqueue(item("b", "Two."));
    await speaker.whenIdle();
    expect(loud.spoken).toEqual(["One."]);
    expect(quiet.spoken).toEqual(["Two."]);
  });
});

describe("text-only speech", () => {
  afterEach(() => vi.useRealTimers());

  it("paces captions at reading speed and can be cut off", async () => {
    vi.useFakeTimers();
    const output = new SilentOutput();
    expect(output.audible).toBe(false);
    let started = false;
    const first = output.speak("A regular horchata and chips and salsa.", {
      voice: "agent",
      onStart: () => (started = true),
    });
    expect(started).toBe(true);
    await vi.advanceTimersByTimeAsync(readingTimeMs("A regular horchata and chips and salsa.") - 1);
    let settled: SpeakResult | null = null;
    void first.then((result) => (settled = result));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe("ended");

    const second = output.speak("Anything else?", { voice: "agent" });
    output.cancel();
    expect(await second).toBe("cancelled");
  });

  it("keeps reading time within sensible bounds", () => {
    expect(readingTimeMs("Hi.")).toBe(900);
    expect(readingTimeMs("x".repeat(60))).toBe(60 * 48);
    expect(readingTimeMs("x".repeat(5000))).toBe(6500);
  });

  it("reports that listening is unsupported instead of pretending to listen", () => {
    const input = new NoSpeechInput();
    expect(input.available).toBe(false);
    const results: ListenResult[] = [];
    input.start({ onInterim: () => {}, onDone: (result) => results.push(result) });
    expect(results).toEqual([{ error: "unsupported" }]);
  });
});

describe("fake microphone", () => {
  it("delivers interim words, then what was heard so far when told to stop", () => {
    const input = new FakeInput();
    const heard: string[] = [];
    const done: ListenResult[] = [];
    input.start({ onInterim: (text) => heard.push(text), onDone: (result) => done.push(result) });
    input.hearInterim("two chicken");
    input.hearInterim("two chicken burritos");
    input.stop();
    expect(heard).toEqual(["two chicken", "two chicken burritos"]);
    expect(done).toEqual([{ text: "two chicken burritos" }]);
    expect(input.listening).toBe(false);
  });

  it("delivers nothing after an abort", () => {
    const input = new FakeInput();
    const done: ListenResult[] = [];
    input.start({ onInterim: () => {}, onDone: (result) => done.push(result) });
    input.abort();
    input.hear("too late");
    expect(done).toEqual([]);
  });
});

describe("voice selection", () => {
  const voice = (name: string, lang: string, extra: Partial<VoiceInfo> = {}): VoiceInfo => ({
    name,
    lang,
    localService: true,
    default: false,
    ...extra,
  });

  it("picks an English voice for the agent and a different one for the scripted customer", () => {
    const voices = [
      voice("Thomas", "fr-FR", { default: true }),
      voice("Daniel", "en-GB"),
      voice("Samantha", "en-US"),
      voice("Karen", "en-AU"),
    ];
    expect(pickVoices(voices)).toEqual({ agent: 2, customer: 1 });
  });

  it("prefers American English when no voice is one it knows by name", () => {
    const voices = [
      voice("Voice A", "en-GB"),
      voice("Voice B", "en_US"),
      voice("Voice C", "de-DE"),
    ];
    expect(pickVoices(voices)).toEqual({ agent: 1, customer: 0 });
  });

  it("uses the same voice for both when there is only one, and none when there is no English voice", () => {
    expect(pickVoices([voice("Only", "en-US")])).toEqual({ agent: 0, customer: 0 });
    expect(pickVoices([voice("Anna", "de-DE")])).toEqual({ agent: null, customer: null });
    expect(pickVoices([])).toEqual({ agent: null, customer: null });
  });
});
