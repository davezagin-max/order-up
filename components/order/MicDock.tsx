"use client";

import { useId, useState, type FormEvent } from "react";
import { CALL_LIMITS } from "@/lib/order/history";
import type { SpeechSupport } from "@/lib/speech/web";
import type { CallSession, CallSnapshot } from "@/lib/voice/session";
import { LockIcon, MicIcon, PlayIcon, SendIcon, SkipIcon, StopIcon } from "./icons";

interface MicDockProps {
  session: CallSession;
  snapshot: CallSnapshot;
  support: SpeechSupport | null;
  isLive: boolean;
  onAddKey: () => void;
  onPlay: (sampleId: string) => void;
}

function VoiceBars() {
  return (
    <span aria-hidden className="flex h-7 items-center gap-1">
      {[0, 0.15, 0.3, 0.45].map((delay) => (
        <span
          key={delay}
          className="voice-bar h-full w-1 rounded-full bg-current"
          style={{ animationDelay: `${delay}s` }}
        />
      ))}
    </span>
  );
}

/** What the microphone says about itself, for every state it can be in. */
function micCopy(args: { snapshot: CallSnapshot; isLive: boolean; canListen: boolean }): {
  label: string;
  hint: string;
  more?: string;
} {
  const { snapshot, isLive, canListen } = args;
  const fromSample = snapshot.origin === "sample";
  if (snapshot.sample) {
    const { turn, of } = snapshot.sample;
    const what =
      snapshot.phase === "listening"
        ? "The customer is talking"
        : snapshot.phase === "thinking"
          ? "The agent is working"
          : snapshot.phase === "speaking"
            ? "The agent is answering"
            : "Next turn";
    return { label: `Sample call, turn ${turn} of ${of}`, hint: what };
  }
  if (!isLive) {
    if (snapshot.finished)
      return { label: "Sample call finished", hint: "That was the whole call." };
    return {
      label: "Voice needs a key",
      hint: "Sample calls play without one.",
      more: " Talking and typing use your own Anthropic key.",
    };
  }
  if (snapshot.receipt && !fromSample) {
    return { label: "Order placed", hint: "Start a new call to order again." };
  }
  if (snapshot.phase === "listening") {
    return { label: "Listening", hint: "Tap again, or let go of Space, when you are done." };
  }
  if (snapshot.phase === "thinking") {
    return { label: "Thinking", hint: "Tap to cancel and talk over it." };
  }
  if (snapshot.phase === "speaking") {
    return { label: "Speaking", hint: "Tap or hold Space to interrupt." };
  }
  if (!canListen) {
    return {
      label: "Type your order",
      hint: "This browser has no speech recognition, so the microphone is off. Everything else works.",
    };
  }
  if (fromSample) {
    return {
      label: "Tap to talk",
      hint: "That was a sample.",
      more: " Your own call starts fresh.",
    };
  }
  return { label: "Tap to talk", hint: "Or hold Space.", more: " You can also type below." };
}

export function MicDock({ session, snapshot, support, isLive, onAddKey, onPlay }: MicDockProps) {
  const [draft, setDraft] = useState("");
  const inputId = useId();
  const { phase, sample } = snapshot;
  // A receipt from a sample call does not stop a visitor with a key from starting their own.
  const receipt = snapshot.origin === "live" ? snapshot.receipt : null;
  const canListen = support?.recognition ?? false;
  const busy = phase === "thinking" || phase === "speaking";
  const copy = micCopy({ snapshot, isLive, canListen });
  const locked = !isLive && !sample;
  // During a reply the microphone still works when recognition is missing: it is the interrupt button.
  const micDisabled = Boolean(sample) || Boolean(receipt) || (isLive && !canListen && !busy);
  const typingOff = !isLive || Boolean(sample) || Boolean(receipt) || snapshot.turnsLeft === 0;

  function handleMic() {
    if (locked) onAddKey();
    else if (!canListen && busy) session.stop();
    else session.micTap();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.trim() || typingOff) return;
    session.submitText(draft.trim());
    setDraft("");
  }

  const active = phase !== "idle";
  const replayId = snapshot.finished ?? snapshot.sampleId ?? "quick";
  const micLabel = locked
    ? "Add your Anthropic key to talk"
    : phase === "listening"
      ? "Stop listening and send"
      : busy
        ? "Interrupt the agent"
        : "Start talking";

  return (
    <div className="flex flex-col gap-2.5 sm:gap-3">
      <div className="flex items-center gap-3 sm:gap-4">
        <span className="relative inline-flex shrink-0">
          {phase === "listening" && (
            <span aria-hidden className="mic-ring absolute inset-0 rounded-full bg-accent" />
          )}
          <button
            type="button"
            onClick={handleMic}
            disabled={micDisabled}
            aria-label={micLabel}
            aria-pressed={locked ? undefined : phase === "listening"}
            className={`relative inline-flex size-14 items-center justify-center rounded-full transition-colors sm:size-[4.5rem] ${
              locked
                ? "border-2 border-dashed border-border bg-surface text-muted hover:border-accent hover:text-fg"
                : active
                  ? "bg-accent text-accent-fg shadow-[0_0_32px_var(--glow)]"
                  : "border-2 border-accent bg-surface text-accent shadow-[0_0_20px_var(--glow)] hover:bg-accent hover:text-accent-fg"
            } disabled:cursor-default ${sample ? "" : "disabled:opacity-60"}`}
          >
            {phase === "thinking" ? (
              <span
                aria-hidden
                className="mic-spin size-6 rounded-full border-[3px] border-current border-t-transparent sm:size-7"
              />
            ) : phase === "speaking" ? (
              <VoiceBars />
            ) : (
              <MicIcon className="size-7 sm:size-8" />
            )}
            {locked && (
              <span className="absolute -right-0.5 -bottom-0.5 inline-flex size-6 items-center justify-center rounded-full border border-border bg-bg text-muted">
                <LockIcon className="size-3.5" />
              </span>
            )}
          </button>
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-base leading-6 font-semibold" aria-live="polite">
            {copy.label}
          </p>
          <p className="text-sm leading-5 text-muted">
            {copy.hint}
            {copy.more && <span className="hidden sm:inline">{copy.more}</span>}
          </p>
        </div>
        {locked ? (
          <button
            type="button"
            onClick={onAddKey}
            className="shrink-0 rounded-md border border-border px-3 py-2 text-sm font-medium hover:border-accent"
          >
            Add key
          </button>
        ) : (
          isLive &&
          !sample &&
          busy && (
            <button
              type="button"
              onClick={() => session.stop()}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium hover:border-accent"
            >
              <StopIcon className="size-3.5" />
              Stop
            </button>
          )
        )}
      </div>

      {sample ? (
        // While a sample plays there is nothing to type, so its controls take the text box's place.
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => session.stop()}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-border px-3 py-2.5 text-sm font-medium hover:border-accent"
          >
            <StopIcon className="size-3.5" />
            Stop
          </button>
          <button
            type="button"
            onClick={() => void session.skipSample()}
            disabled={sample.skipping}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-border px-3 py-2.5 text-sm font-medium hover:border-accent disabled:opacity-50"
          >
            <SkipIcon className="size-3.5" />
            Skip to end
          </button>
        </div>
      ) : !isLive && (snapshot.captions.length > 0 || snapshot.finished) ? (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onPlay(replayId)}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2.5 text-sm font-semibold text-accent-fg hover:opacity-90"
          >
            <PlayIcon className="size-3.5" />
            Play it again
          </button>
          <button
            type="button"
            onClick={() => session.reset()}
            className="inline-flex flex-1 items-center justify-center rounded-lg border border-border px-3 py-2.5 text-sm font-medium hover:border-accent"
          >
            Other sample calls
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex gap-2">
          <label htmlFor={inputId} className="sr-only">
            Type what you would say
          </label>
          <input
            id={inputId}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={CALL_LIMITS.maxTextLength}
            disabled={typingOff}
            autoComplete="off"
            placeholder={
              receipt
                ? "This order is placed"
                : isLive
                  ? "Or type it: two chicken burritos and a horchata"
                  : "Typing needs a key too"
            }
            className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3.5 py-2.5 text-base placeholder:text-muted disabled:bg-surface disabled:text-muted"
          />
          <button
            type="submit"
            disabled={typingOff || !draft.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-fg hover:opacity-90 disabled:bg-raised disabled:text-muted"
          >
            Send
            <SendIcon className="size-4" />
          </button>
        </form>
      )}

      <p className="text-xs leading-5 text-muted">
        {support !== null && (
          <span className={support.recognition && support.synthesis ? "hidden sm:inline" : ""}>
            {support.recognition
              ? support.synthesis
                ? snapshot.audioFailed
                  ? "This browser can listen, but its voice is not producing sound, so replies are captions only. "
                  : "This browser can listen and speak. "
                : "This browser can listen but cannot speak, so replies are captions only. "
              : support.synthesis
                ? "This browser can speak but has no speech recognition, so type instead. "
                : "This browser can neither listen nor speak, so type and read the captions. "}
          </span>
        )}
        Your browser does the listening, and in Chrome and Safari it may send audio to the browser
        maker&apos;s speech service. Audio never reaches this app&apos;s server; only the recognized
        text goes to Claude, with your own key.
      </p>
    </div>
  );
}
