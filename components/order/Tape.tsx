import type { LogEntry } from "@/lib/voice/session";
import { CheckIcon, CrossIcon } from "./icons";

/** One tool call as a receipt-style line. Also used in the order panel's tape. */
export function TapeLine({ entry, fresh = false }: { entry: LogEntry; fresh?: boolean }) {
  const colon = entry.summary.indexOf(":");
  const verb = colon === -1 ? entry.summary : entry.summary.slice(0, colon);
  const rest = colon === -1 ? "" : entry.summary.slice(colon + 1).trim();
  return (
    <div
      className={`flex items-start gap-2 rounded-sm px-1.5 py-1 font-mono text-xs leading-5 ${fresh ? "land" : ""}`}
    >
      <span
        className={`mt-0.5 inline-flex size-4 shrink-0 items-center justify-center ${entry.ok ? "text-success" : "text-danger"}`}
      >
        {entry.ok ? <CheckIcon className="size-3.5" /> : <CrossIcon className="size-3.5" />}
        <span className="sr-only">{entry.ok ? "Allowed:" : "Refused by the order code:"}</span>
      </span>
      <span className="min-w-0 [overflow-wrap:anywhere]">
        <span className={entry.ok ? "text-fg" : "text-danger"}>{verb}</span>
        {rest && <span className="text-muted">: {rest}</span>}
      </span>
    </div>
  );
}

/** A group plan as the order engine accepted it: the lines, the total, and the checks it passed. */
export function PlanCard({ entry, handWritten }: { entry: LogEntry; handWritten: boolean }) {
  const plan = entry.plan;
  if (!plan) return null;
  return (
    <div className="my-1 rounded-md border border-border bg-bg p-2.5 text-xs">
      <p className="font-medium">
        {handWritten
          ? `Group plan ${plan.planId}: a pre-written stand-in for the planner AI's suggestion, checked and priced by code`
          : `Group plan ${plan.planId}: suggested by a stronger AI model (Claude Opus 5.5), checked and priced by code`}
      </p>
      <ul className="mt-1.5 flex flex-col gap-0.5 font-mono">
        {plan.lines.map((line, index) => (
          <li key={index} className="flex justify-between gap-3">
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {line.quantity} × {line.name}
              {line.details.length > 0 ? `, ${line.details.join(", ")}` : ""}
            </span>
            <span className="shrink-0 tabular-nums">{line.price}</span>
          </li>
        ))}
        <li className="mt-1 flex justify-between gap-3 border-t border-border pt-1 font-semibold">
          <span>Total with tax{plan.budget ? ` (budget ${plan.budget})` : ""}</span>
          <span className="tabular-nums">{plan.total}</span>
        </li>
      </ul>
      <ul className="mt-2 flex flex-col gap-0.5 text-muted">
        {plan.checks.map((check) => (
          <li key={check} className="flex items-start gap-1.5">
            <CheckIcon className="mt-0.5 size-3 shrink-0 text-success" />
            <span>{check}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
