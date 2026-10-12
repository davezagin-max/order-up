"use client";

import { CAFE } from "@/lib/menu";
import { SAMPLES } from "@/lib/samples";
import type { CallSnapshot, Caption } from "@/lib/voice/session";
import { PlayIcon } from "./icons";
import { PlanCard, TapeLine } from "./Tape";

interface ConversationProps {
  snapshot: CallSnapshot;
  /** True while the sample calls are hand-written examples rather than recorded runs. */
  placeholder: boolean;
  isLive: boolean;
  onPlay: (sampleId: string) => void;
}

function AgentCaption({ caption }: { caption: Extract<Caption, { role: "agent" }> }) {
  return (
    <div className="max-w-[46rem]">
      <p className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">{CAFE.name}</p>
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
      {caption.cutOff && (
        <p className="mt-1 text-xs text-muted">Cut off: the customer started talking.</p>
      )}
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
          ? "Customer (scripted)"
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

function KitchenCaption({ caption }: { caption: Extract<Caption, { role: "kitchen" }> }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-3 py-2 text-sm">
      <p className="text-xs font-medium tracking-wide text-muted uppercase">Kitchen</p>
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
            The agent was told in a system message the server wrote.
          </span>
        </p>
      ))}
    </div>
  );
}

function Welcome({ placeholder, isLive, onPlay }: Omit<ConversationProps, "snapshot">) {
  const [first, ...others] = SAMPLES;
  return (
    <div className="flex flex-col gap-4 sm:py-1">
      {/* On a phone the button comes straight after the headline, so it is on the first screen. */}
      <h2 className="text-[1.7rem] leading-9 font-semibold tracking-tight text-balance sm:text-4xl sm:leading-tight">
        Order at the counter, out loud.
      </h2>
      <p className="order-2 max-w-xl text-base leading-7 text-muted sm:order-none">
        A voice agent takes your order at {CAFE.name}. It answers out loud, you can interrupt it or
        change your mind, and the cart fills in as you speak. Code owns every item and every price.
      </p>
      <div className="order-1 flex flex-col items-start gap-3 sm:order-none">
        <button
          type="button"
          onClick={() => onPlay(first.id)}
          className="inline-flex items-center gap-2.5 rounded-lg bg-accent px-5 py-3 text-base font-semibold text-accent-fg shadow-[0_0_24px_var(--glow)] hover:opacity-90"
        >
          <PlayIcon className="size-4" />
          Play a sample call
        </button>
        <p className="text-sm leading-6 text-muted">
          {placeholder
            ? "Plays with sound. The agent's side of each sample call is a hand-written example; every price in it comes from the real order engine."
            : "Plays with sound. The sample calls are recorded runs of the real agent."}{" "}
          {isLive ? "Or tap the microphone and order yourself." : "No key needed."}
        </p>
      </div>
      <div className="order-3 sm:order-none">
        <p className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">
          More sample calls
        </p>
        <ul className="grid gap-2 sm:grid-cols-2">
          {others.map((sample) => (
            <li key={sample.id}>
              <button
                type="button"
                onClick={() => onPlay(sample.id)}
                className="flex h-full w-full items-start gap-3 rounded-lg border border-border bg-surface px-3.5 py-2.5 text-left hover:border-accent"
              >
                <PlayIcon className="mt-1 size-3.5 shrink-0 text-accent" />
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

export function Conversation({ snapshot, placeholder, isLive, onPlay }: ConversationProps) {
  const { captions, planning, interim, phase } = snapshot;

  if (captions.length === 0 && phase === "idle" && !snapshot.sample) {
    return <Welcome placeholder={placeholder} isLive={isLive} onPlay={onPlay} />;
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
          return <KitchenCaption key={caption.id} caption={caption} />;
        return (
          // On wide screens the tape sits beside the order. On a phone it is shown here, in place.
          <div key={caption.id} className="lg:hidden">
            <TapeLine entry={caption.entry} />
            <PlanCard entry={caption.entry} />
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
            <span className="font-medium">Claude Opus 5.5 is planning the group order.</span>{" "}
            <span className="text-muted">
              {planning.people} people
              {planning.budget ? `, ${planning.budget} with tax` : ""}
              {planning.needs.length > 0 ? `, ${planning.needs.join(", ")}` : ""}. The order engine
              checks and prices the plan before the agent may offer it.
            </span>
          </p>
        </div>
      )}
    </div>
  );
}
