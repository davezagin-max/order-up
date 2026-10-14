"use client";

import { CostMeter } from "@/components/kit/CostMeter";
import { formatUsd } from "@/lib/config";
import type { CallSnapshot, TurnTimeline } from "@/lib/voice/session";

const number = new Intl.NumberFormat("en-US");

const STAGES = [
  { key: "speechEnd", label: "You stop talking", detail: "the clock starts" },
  { key: "firstToken", label: "AI starts replying", detail: "its first words arrive" },
  {
    key: "firstSentence",
    label: "First sentence ready",
    detail: "enough to start speaking",
  },
  { key: "audioStart", label: "Voice starts", detail: "the browser speaks it" },
  { key: "done", label: "Reply complete", detail: "every word and cart change is in" },
] as const;

function ms(value: number): string {
  return `${number.format(Math.round(value))} ms`;
}

function LiveStages({ timeline }: { timeline: TurnTimeline }) {
  const marks: Record<(typeof STAGES)[number]["key"], number | null> = {
    speechEnd: 0,
    ...timeline.marks,
  };
  const longest = Math.max(1, ...Object.values(marks).map((value) => value ?? 0));
  return (
    <ol className="flex flex-col gap-1.5">
      {STAGES.map((stage) => {
        const value = marks[stage.key];
        const waiting = value === null;
        const noAudio = stage.key === "audioStart" && waiting && timeline.status !== "running";
        return (
          <li key={stage.key} className="grid grid-cols-[1fr_auto] items-baseline gap-x-3 text-sm">
            <span className={waiting ? "text-muted" : ""}>{stage.label}</span>
            <span className="font-mono text-xs tabular-nums">
              {value !== null
                ? ms(value)
                : noAudio
                  ? "sound off"
                  : timeline.status === "running"
                    ? "…"
                    : "not reached"}
            </span>
            <span aria-hidden className="col-span-2 mt-0.5 h-1 rounded-full bg-raised">
              <span
                className="block h-full rounded-full bg-accent"
                style={{ width: `${value === null ? 0 : Math.max(2, (value / longest) * 100)}%` }}
              />
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function SampleStages({ timeline }: { timeline: TurnTimeline }) {
  return (
    <>
      <ol className="flex flex-col gap-1.5">
        {STAGES.map((stage) => (
          <li key={stage.key} className="flex items-baseline justify-between gap-3 text-sm">
            <span>
              {stage.label} <span className="text-xs text-muted">· {stage.detail}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-3 rounded-md border border-dashed border-border px-2.5 py-2 text-xs leading-5 text-muted">
        {timeline.placeholder ? (
          <>
            No times shown on purpose: this sample is pre-written, so nothing was measured. In a
            live call, each step shows how many milliseconds after you stopped talking it happened.
          </>
        ) : timeline.recorded ? (
          <>
            Recorded{timeline.recordedAt ? ` on ${timeline.recordedAt.slice(0, 10)}` : ""}, timed on
            the server:{" "}
            {timeline.recorded.firstTextMs !== null
              ? `first words after ${ms(timeline.recorded.firstTextMs)}, `
              : ""}
            whole reply in {ms(timeline.recorded.totalMs)}. The other steps are only measured in a
            live call.
          </>
        ) : (
          <>No timing was stored with this reply. Each step is measured in a live call.</>
        )}
      </p>
    </>
  );
}

export function TimelinePanel({ snapshot }: { snapshot: CallSnapshot }) {
  const { timeline, spend } = snapshot;
  return (
    <section
      aria-labelledby="timeline-heading"
      className="rounded-xl border border-border bg-surface p-4"
    >
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 id="timeline-heading" className="text-base font-semibold">
          Response speed
        </h2>
        <p className="text-sm text-muted">
          {!timeline
            ? "Nothing yet"
            : timeline.status === "running"
              ? "In progress"
              : timeline.status === "cancelled"
                ? "Cancelled"
                : timeline.status === "failed"
                  ? "Failed"
                  : timeline.source === "live"
                    ? "Last live reply"
                    : "Last sample reply"}
        </p>
      </div>

      {!timeline ? (
        <p className="text-sm leading-6 text-muted">
          How quickly the AI cashier answers, step by step, and what each reply costs. It fills in
          during a live call with your key.
        </p>
      ) : timeline.source === "live" ? (
        <LiveStages timeline={timeline} />
      ) : (
        <SampleStages timeline={timeline} />
      )}

      {timeline && (timeline.models.length > 0 || timeline.meta) && (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer font-medium text-muted hover:text-fg">
            Tokens and cost, by AI model
          </summary>
          <p className="mt-1.5 leading-5 text-muted">
            Tokens are the small chunks of text an AI model reads and writes; they are what you pay
            for. &ldquo;Reused&rdquo; counts the menu and house rules the model already read on an
            earlier reply (prompt caching), billed at a small fraction of the normal price.
          </p>
          {timeline.models.length > 0 && (
            <table className="mt-2 w-full text-left">
              <caption className="sr-only">Tokens and cost by model for this reply</caption>
              <thead className="text-muted">
                <tr>
                  <th scope="col" className="py-1 font-medium">
                    Model
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    Read
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    Reused
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    Written
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    Cost
                  </th>
                </tr>
              </thead>
              <tbody className="font-mono tabular-nums">
                {timeline.models.map((use) => (
                  <tr key={use.role} className="border-t border-border">
                    <th scope="row" className="py-1 pr-2 font-sans font-normal">
                      {use.role === "planner"
                        ? "Group planner (strong model)"
                        : "Cashier (fast model)"}
                      <span className="block font-mono text-[0.6875rem] text-muted">
                        {use.model}
                      </span>
                    </th>
                    <td className="py-1 text-right">
                      {number.format(
                        use.usage.input_tokens +
                          use.usage.cache_creation_input_tokens +
                          use.usage.cache_read_input_tokens,
                      )}
                    </td>
                    <td className="py-1 text-right">
                      {number.format(use.usage.cache_read_input_tokens)}
                    </td>
                    <td className="py-1 text-right">{number.format(use.usage.output_tokens)}</td>
                    <td className="py-1 text-right">{formatUsd(use.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {timeline.meta && <CostMeter meta={timeline.meta} className="mt-2" />}
        </details>
      )}

      {timeline && timeline.status === "done" && (
        <p
          className={`mt-2 text-xs leading-5 ${timeline.unbackedAmounts.length > 0 ? "font-medium text-danger" : "text-muted"}`}
        >
          {timeline.unbackedAmounts.length > 0
            ? `Price check: the cashier said ${timeline.unbackedAmounts.join(", ")}, which matches no price the code produced. The order itself is unaffected.`
            : "Price check: every dollar amount the cashier said matches a price the code produced."}
        </p>
      )}

      {spend.turns > 0 && (
        <p className="mt-2 font-mono text-xs text-muted">
          This call so far: {spend.turns} live {spend.turns === 1 ? "reply" : "replies"},{" "}
          {formatUsd(spend.costUsd)}
        </p>
      )}
    </section>
  );
}
