/**
 * The browser's built-in Web Speech APIs, behind the app's own interfaces.
 * This is the only file that touches `speechSynthesis` or `SpeechRecognition`.
 *
 * Recognition is done by the browser. In Chrome and Safari it may send audio
 * to the browser vendor's speech service. Audio never reaches this app.
 */
import type {
  ListenError,
  ListenHandlers,
  SpeakOptions,
  SpeakResult,
  SpeechInput,
  SpeechOutput,
  Voice,
} from "./types";

// Recognition types are not in TypeScript's DOM library, so the parts used here are declared.
interface RecognitionAlternative {
  transcript: string;
}
interface RecognitionResult {
  isFinal: boolean;
  0: RecognitionAlternative;
}
interface RecognitionEvent {
  resultIndex: number;
  results: { length: number; [index: number]: RecognitionResult };
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

export interface SpeechSupport {
  recognition: boolean;
  synthesis: boolean;
}

/** What this browser can do, checked at runtime. */
export function detectSpeech(): SpeechSupport {
  return {
    recognition: recognitionCtor() !== null,
    synthesis:
      typeof window !== "undefined" &&
      "speechSynthesis" in window &&
      typeof window.SpeechSynthesisUtterance === "function",
  };
}

const ERROR_KIND: Record<string, ListenError> = {
  "not-allowed": "denied",
  "service-not-allowed": "denied",
  "audio-capture": "no-microphone",
  network: "network",
  "language-not-supported": "unsupported",
};

export class WebSpeechInput implements SpeechInput {
  readonly available = recognitionCtor() !== null;
  private active: Recognition | null = null;

  start(handlers: ListenHandlers): void {
    const Ctor = recognitionCtor();
    if (!Ctor) {
      handlers.onDone({ error: "unsupported" });
      return;
    }
    this.abort();
    const recognition = new Ctor();
    recognition.lang = "en-US";
    recognition.continuous = false; // One utterance: it ends by itself when the speaker stops.
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    let finalText = "";
    let interim = "";
    let error: ListenError | null = null;
    let finished = false;

    recognition.onresult = (event) => {
      interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interim += result[0].transcript;
      }
      handlers.onInterim(`${finalText}${interim}`.trim());
    };
    recognition.onerror = (event) => {
      // "no-speech" and "aborted" are not failures: the turn just has no text.
      if (event.error === "no-speech" || event.error === "aborted") return;
      error = ERROR_KIND[event.error] ?? "failed";
    };
    recognition.onend = () => {
      if (finished) return;
      finished = true;
      if (this.active === recognition) this.active = null;
      // If the speaker was cut off by `stop`, the interim words are the best we have.
      handlers.onDone(error ? { error } : { text: (finalText || interim).trim() });
    };

    this.active = recognition;
    try {
      recognition.start();
    } catch {
      this.active = null;
      finished = true;
      handlers.onDone({ error: "failed" });
    }
  }

  stop(): void {
    try {
      this.active?.stop();
    } catch {
      // Already stopped.
    }
  }

  abort(): void {
    const recognition = this.active;
    this.active = null;
    if (!recognition) return;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    try {
      recognition.abort();
    } catch {
      // Already stopped.
    }
  }
}

export interface VoiceInfo {
  name: string;
  lang: string;
  localService: boolean;
  default: boolean;
}

const AGENT_NAMES = [/samantha/i, /google us english/i, /aria/i, /jenny/i, /ava/i, /zira/i];
const CUSTOMER_NAMES = [/daniel/i, /google uk english male/i, /guy/i, /alex/i, /david/i, /aaron/i];

function rank(voice: VoiceInfo, preferred: RegExp[]): number {
  const named = preferred.findIndex((pattern) => pattern.test(voice.name));
  return (
    (named === -1 ? 0 : 100 - named) +
    (voice.lang.replace("_", "-").toLowerCase() === "en-us" ? 10 : 0) +
    (voice.localService ? 3 : 0) +
    (voice.default ? 1 : 0)
  );
}

/**
 * Picks an English voice for the agent and a different one for the scripted
 * customer. Returns indexes into `voices`, or null where there is no English voice.
 */
export function pickVoices(voices: readonly VoiceInfo[]): {
  agent: number | null;
  customer: number | null;
} {
  const english = voices
    .map((voice, index) => ({ voice, index }))
    .filter(({ voice }) => /^en([-_]|$)/i.test(voice.lang));
  if (english.length === 0) return { agent: null, customer: null };
  const best = (preferred: RegExp[], skip: number | null) =>
    english
      .filter(({ index }) => index !== skip)
      .sort((a, b) => rank(b.voice, preferred) - rank(a.voice, preferred) || a.index - b.index)[0]
      ?.index ?? null;
  const agent = best(AGENT_NAMES, null);
  return { agent, customer: best(CUSTOMER_NAMES, agent) ?? agent };
}

/** If no start event arrives in this long, the engine is treated as silent. */
const START_TIMEOUT_MS = 4000;

function maxDurationMs(text: string): number {
  return 4000 + text.length * 110;
}

export class WebSpeechOutput implements SpeechOutput {
  readonly audible = true;
  private current: { settle: (result: SpeakResult) => void } | null = null;
  // Chrome can drop an utterance's events if it is garbage collected mid-speech.
  private readonly keepAlive = new Set<SpeechSynthesisUtterance>();
  private unlocked = false;

  speak(text: string, options: SpeakOptions): Promise<SpeakResult> {
    return new Promise((resolve) => {
      const synth = window.speechSynthesis;
      const utterance = new SpeechSynthesisUtterance(text);
      this.applyVoice(utterance, options.voice);

      let started = false;
      let settled = false;
      let endTimer: ReturnType<typeof setTimeout> | undefined;
      const begun = Date.now();

      const settle = (result: SpeakResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(startTimer);
        clearTimeout(endTimer);
        this.keepAlive.delete(utterance);
        if (this.current?.settle === settle) this.current = null;
        resolve(result);
      };
      const markStarted = () => {
        if (started || settled) return;
        started = true;
        clearTimeout(startTimer);
        options.onStart?.();
        // Some engines never fire `end`. Do not let one stuck utterance stall the call.
        endTimer = setTimeout(() => settle("ended"), maxDurationMs(text));
      };
      const startTimer = setTimeout(() => {
        // Some engines speak without firing `start`.
        if (synth.speaking) markStarted();
        else {
          synth.cancel();
          settle("failed");
        }
      }, START_TIMEOUT_MS);

      utterance.onstart = markStarted;
      utterance.onend = () => {
        // An `end` with no `start` that arrives instantly means nothing was spoken.
        settle(started || Date.now() - begun > 250 ? "ended" : "failed");
      };
      utterance.onerror = (event) => {
        settle(
          event.error === "canceled" || event.error === "interrupted" ? "cancelled" : "failed",
        );
      };

      this.current = { settle };
      this.keepAlive.add(utterance);
      synth.resume(); // Chrome's queue can be left paused by an earlier cancel.
      synth.speak(utterance);
    });
  }

  cancel(): void {
    const current = this.current;
    this.current = null;
    window.speechSynthesis.cancel();
    current?.settle("cancelled");
  }

  unlock(): void {
    if (this.unlocked) return;
    this.unlocked = true;
    try {
      // A silent utterance inside the gesture marks speech as user-initiated.
      const primer = new SpeechSynthesisUtterance(" ");
      primer.volume = 0;
      window.speechSynthesis.speak(primer);
    } catch {
      // Speech will be attempted anyway; a failure there falls back to captions.
    }
  }

  private applyVoice(utterance: SpeechSynthesisUtterance, voice: Voice): void {
    const voices = window.speechSynthesis.getVoices();
    const picked = pickVoices(voices);
    const index = voice === "agent" ? picked.agent : picked.customer;
    utterance.lang = "en-US";
    if (index !== null) {
      utterance.voice = voices[index];
      utterance.lang = voices[index].lang;
    }
    utterance.rate = voice === "agent" ? 1.05 : 1;
    // With only one English voice, the customer is the same voice pitched down.
    utterance.pitch = voice === "customer" && picked.customer === picked.agent ? 0.75 : 1;
  }
}
