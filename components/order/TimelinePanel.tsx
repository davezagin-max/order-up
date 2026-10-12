"use client";

import { CostMeter } from "@/components/kit/CostMeter";
import { formatUsd } from "@/lib/config";
import type { CallSnapshot, TurnTimeline } from "@/lib/voice/session";

const number = new Intl.NumberFormat("en-US");

const STAGES = [
  { key: "speechEnd", label: "Speech ended", detail: "the request is sent" },
  { key: "firstToken", label: "First token", detail: "the reply starts streaming" },
  {
    key: "firstSentence",
    label: "First sentence ready",
    detail: "the chunker hands it to the voice",
  },
  { key: "audioStart", label: "Audio started", detail: "the browser begins speaking" },
  { key: "done", label: "Reply complete", detail: "tool calls and text are all in" },
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
      {timeline.placeholder || !timeline.recorded ? (
        <p className="mt-3 rounded-md border border-dashed border-border px-2.5 py-2 text-xs leading-5 text-muted">
          No numbers here on purpose. This sample call is a hand-written example, so nothing was
          measured. On a live turn each stage shows its time in milliseconds after you stop talking.
        </p>
      ) : (
        <p className="mt-3 rounded-md border border-dashed border-border px-2.5 py-2 text-xs leading-5 text-muted">
          Recorded{timeline.recordedAt ? ` on ${timeline.recordedAt.slice(0, 10)}` : ""}, on the
          server&apos;s clock:{" "}
          {timeline.recorded.firstTextMs !== null
            ? `first text after ${ms(timeline.recorded.firstTextMs)}, `
            : ""}
          whole turn in {ms(timeline.recorded.totalMs)}. Browser-side stages are only measured on a
          live turn.
        </p>
      )}
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
          Turn timeline
        </h2>
        <p className="text-sm text-muted">
          {!timeline
            ? "No turn yet"
            : timeline.status === "running"
              ? "In progress"
              : timeline.status === "cancelled"
                ? "Cancelled"
                : timeline.status === "failed"
                  ? "Failed"
                  : timeline.source === "live"
                    ? "Last live turn"
                    : "Last sample turn"}
        </p>
      </div>

      {!timeline ? (
        <p className="text-sm leading-6 text-muted">
          For each live turn this shows when speech ended, when the first token arrived, when the
          first sentence was ready, and when audio started, plus tokens, cache reads, and cost.
        </p>
      ) : timeline.source === "live" ? (
        <LiveStages timeline={timeline} />
      ) : (
        <SampleStages timeline={timeline} />
      )}

      {timeline && timeline.models.length > 0 && (
        <table className="mt-3 w-full text-left text-xs">
          <caption className="sr-only">Tokens and cost by model for this turn</caption>
          <thead className="text-muted">
            <tr>
              <th scope="col" className="py-1 font-medium">
                Model
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                In
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                Cache read
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                Out
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
                  {use.role === "planner" ? "Planner" : "Conversation"}
                  <span className="block font-mono text-[0.6875rem] text-muted">{use.model}</span>
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

      {timeline?.meta && <CostMeter meta={timeline.meta} className="mt-3" />}

      {timeline && timeline.status === "done" && (
        <p
          className={`mt-2 text-xs leading-5 ${timeline.unbackedAmounts.length > 0 ? "font-medium text-danger" : "text-muted"}`}
        >
          {timeline.unbackedAmounts.length > 0
            ? `Price check: the reply said ${timeline.unbackedAmounts.join(", ")}, which no tool result or menu price backs. The order itself is unaffected.`
            : "Price check: every dollar amount in the reply matches a tool result or a menu price."}
        </p>
      )}

      {spend.turns > 0 && (
        <p className="mt-2 font-mono text-xs text-muted">
          This call so far: {spend.turns} live {spend.turns === 1 ? "turn" : "turns"},{" "}
          {formatUsd(spend.costUsd)}
        </p>
      )}
    </section>
  );
}
