"use client";

import { Fragment } from "react";
import { SAMPLES } from "@/lib/samples";
import type { CallSnapshot, Caption } from "@/lib/voice/session";
import {
  ArrowIcon,
  MicIcon,
  PlayIcon,
  ShieldIcon,
  SoundOffIcon,
  SoundOnIcon,
  SpeechIcon,
} from "./icons";
import { PlanCard, TapeLine } from "./Tape";

interface ConversationProps {
  snapshot: CallSnapshot;
  /** The browser has speech synthesis (assumed true until it is known). */
  canSpeak: boolean;
  isLive: boolean;
  onPlay: (sampleId: string) => void;
}

function AgentCaption({ caption }: { caption: Extract<Caption, { role: "agent" }> }) {
  return (
    <div className="max-w-[46rem]">
      <p className="mb-1 text-xs font-medium tracking-wide text-accent uppercase">AI cashier</p>
      <p className="text-xl leading-8 text-balance sm:text-2xl sm:leading-9">
        {caption.sentences.map((sentence) => (
          <span
            key={sentence.id}
            className={
              sentence.status === "speaking"
                ? "text-fg underline decoration-accent decoration-2 underline-offset-[6px]"
                : sentence.status === "queued"
                  ? "text-muted"
                  : sentence.status === "dropped"
                    ? "text-muted line-through decoration-1"
                    : "text-fg"
            }
          >
            {sentence.text}{" "}
          </span>
        ))}
        {caption.pending && <span className="text-muted">{caption.pending}</span>}
      </p>
      {caption.cutOff && <p className="mt-1 text-xs text-muted">Cut off before it finished.</p>}
    </div>
  );
}

function CustomerCaption({ caption }: { caption: Extract<Caption, { role: "customer" }> }) {
  return (
    <div
      className={`ml-auto max-w-[36rem] rounded-xl rounded-br-sm border border-border bg-surface px-4 py-3 ${
        caption.unanswered ? "border-dashed text-muted" : ""
      }`}
    >
      <p className="mb-0.5 flex items-center gap-2 text-xs font-medium tracking-wide text-muted uppercase">
        {caption.scripted
          ? "Customer (sample script)"
          : caption.unanswered
            ? "You (not answered)"
            : "You"}
        {caption.speaking && (
          <span className="inline-flex items-center gap-1 normal-case tracking-normal text-accent">
            <span aria-hidden className="size-1.5 rounded-full bg-accent" />
            speaking
          </span>
        )}
      </p>
      <p className="text-lg leading-7 sm:text-xl">{caption.text}</p>
    </div>
  );
}

function KitchenCaption({
  caption,
  handWritten,
}: {
  caption: Extract<Caption, { role: "kitchen" }>;
  handWritten: boolean;
}) {
  return (
    <div className="rounded-lg border border-dashed border-border px-3 py-2 text-sm">
      <p className="text-xs font-medium tracking-wide text-muted uppercase">Kitchen update</p>
      {caption.effects.map((effect) => (
        <p key={effect.id} className="mt-0.5">
          <span className="font-medium">
            {effect.name.charAt(0).toUpperCase() + effect.name.slice(1)}{" "}
            {effect.inStock ? "is back in stock." : "just ran out."}
          </span>{" "}
          <span className="text-muted">
            {effect.affected.length > 0
              ? `It is in this order (${effect.affected.map((line) => line.name).join(", ")}). `
              : ""}
            {handWritten
              ? "In a live call the app tells the AI cashier, and it has to cope."
              : "The app told the AI cashier, and it has to cope."}
          </span>
        </p>
      ))}
    </div>
  );
}

const STEPS = [
  { icon: MicIcon, text: "You say (or type) what you want" },
  { icon: SpeechIcon, text: "The AI cashier answers out loud and picks items from the menu" },
  { icon: ShieldIcon, text: "Code checks every item and sets every price" },
];

function Welcome({
  canSpeak,
  soundOn,
  isLive,
  onPlay,
}: Omit<ConversationProps, "snapshot"> & { soundOn: boolean }) {
  const [first, ...others] = SAMPLES;
  const audible = canSpeak && soundOn;
  return (
    <div className="flex flex-col gap-5 sm:gap-6 sm:py-1">
      <div className="flex flex-col gap-2">
        <h2 className="text-[1.7rem] leading-9 font-semibold tracking-tight text-balance sm:text-4xl sm:leading-tight">
          Talk to a cafe&apos;s AI cashier.
        </h2>
        <p className="max-w-xl text-lg leading-7 text-balance text-muted sm:text-xl sm:leading-8">
          It answers out loud and fills your cart as you order.
        </p>
      </div>

      <div className="flex flex-col items-start gap-2.5">
        <button
          type="button"
          onClick={() => onPlay(first.id)}
          className="inline-flex items-center gap-2.5 rounded-lg bg-accent px-6 py-3.5 text-lg font-semibold text-accent-fg shadow-[0_0_24px_var(--glow)] hover:opacity-90"
        >
          <PlayIcon className="size-5" />
          Play a sample call
        </button>
        <p className="flex items-start gap-2 text-sm leading-6 text-muted">
          {audible ? (
            <SoundOnIcon className="mt-1 size-4 shrink-0 text-accent" />
          ) : (
            <SoundOffIcon className="mt-1 size-4 shrink-0" />
          )}
          <span>
            {audible
              ? "Plays out loud, so turn your sound up. Every word also appears on screen."
              : canSpeak
                ? "Sound is off, so the call plays as on-screen captions. Turn it on at the top."
                : "This browser cannot speak, so the call plays as on-screen captions."}{" "}
            {isLive ? "Or tap the microphone and order yourself." : "No key or sign-up needed."}
          </span>
        </p>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">
          How it works
        </h3>
        <ol className="grid gap-2 sm:grid-cols-[1fr_auto_1fr_auto_1fr] sm:items-stretch">
          {STEPS.map((step, index) => (
            <Fragment key={step.text}>
              {index > 0 && (
                <li aria-hidden className="hidden items-center text-muted sm:flex">
                  <ArrowIcon className="size-4" />
                </li>
              )}
              <li className="flex items-start gap-2.5 text-sm leading-5">
                <step.icon className="mt-px size-4 shrink-0 text-accent" />
                <span>{step.text}</span>
              </li>
            </Fragment>
          ))}
        </ol>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">
          Two more sample calls
        </h3>
        <ul className="grid gap-2 sm:grid-cols-2">
          {others.map((sample) => (
            <li key={sample.id}>
              <button
                type="button"
                onClick={() => onPlay(sample.id)}
                className="flex h-full w-full items-start gap-3 rounded-lg border border-border px-3.5 py-2.5 text-left hover:border-accent hover:bg-surface"
              >
                <PlayIcon className="mt-1 size-3.5 shrink-0 text-muted" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{sample.title}</span>
                  <span className="mt-0.5 block text-sm text-muted">{sample.shows}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function Conversation({ snapshot, canSpeak, isLive, onPlay }: ConversationProps) {
  const { captions, planning, interim, phase } = snapshot;
  // "vegetarian, vegetarian, gluten-free" reads better as "2 vegetarian, 1 gluten-free".
  const needCounts = new Map<string, number>();
  for (const need of planning?.needs ?? []) needCounts.set(need, (needCounts.get(need) ?? 0) + 1);
  const needs = [...needCounts].map(([need, count]) => `${count} ${need}`);

  if (captions.length === 0 && phase === "idle" && !snapshot.sample) {
    return (
      <Welcome canSpeak={canSpeak} soundOn={snapshot.soundOn} isLive={isLive} onPlay={onPlay} />
    );
  }

  return (
    <div
      role="log"
      aria-label="Conversation captions"
      aria-live="polite"
      className="flex flex-col gap-4"
    >
      {captions.map((caption) => {
        if (caption.role === "customer")
          return <CustomerCaption key={caption.id} caption={caption} />;
        if (caption.role === "agent") return <AgentCaption key={caption.id} caption={caption} />;
        if (caption.role === "kitchen")
          return (
            <KitchenCaption key={caption.id} caption={caption} handWritten={snapshot.handWritten} />
          );
        return (
          // On wide screens the tape sits beside the order. On a phone it is shown here, in place.
          <div key={caption.id} className="lg:hidden">
            <TapeLine entry={caption.entry} />
            <PlanCard entry={caption.entry} handWritten={snapshot.handWritten} />
          </div>
        );
      })}
      {interim && (
        <div className="ml-auto max-w-[36rem] rounded-xl rounded-br-sm border border-dashed border-border px-4 py-3">
          <p className="mb-0.5 text-xs font-medium tracking-wide text-muted uppercase">
            You (listening)
          </p>
          <p className="text-lg leading-7 text-muted sm:text-xl">{interim}</p>
        </div>
      )}
      {planning && (
        <div className="flex items-start gap-3 rounded-lg border border-border bg-surface px-3.5 py-3 text-sm">
          <span
            aria-hidden
            className="mic-spin mt-0.5 size-4 shrink-0 rounded-full border-2 border-border border-t-accent"
          />
          <p>
            <span className="font-medium">
              {snapshot.handWritten
                ? "Planning the group order. In a live call a stronger AI model (Claude Opus 5.5) does this step."
                : "A stronger AI model (Claude Opus 5.5) is planning the group order."}
            </span>{" "}
            <span className="text-muted">
              {planning.people} people
              {planning.budget ? `, ${planning.budget} with tax` : ""}
              {needs.length > 0 ? `, ${needs.join(", ")}` : ""}. Code checks and prices the plan
              before the cashier may offer it.
            </span>
          </p>
        </div>
      )}
    </div>
  );
}
