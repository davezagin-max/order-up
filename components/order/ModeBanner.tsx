"use client";

import { useKey } from "@/components/kit/KeyProvider";

/**
 * Says plainly what the visitor is looking at, in one calm line. The wording
 * follows the fixtures' own `placeholder` flag, so it flips by itself once
 * real runs are recorded and never calls a hand-written sample a recorded run.
 */
export function ModeBanner({ placeholder }: { placeholder: boolean }) {
  const { isLive, openKeyModal } = useKey();

  return (
    <div
      role="status"
      className="flex items-center justify-center gap-x-2 border-b border-border bg-surface px-4 py-1.5 text-center text-xs leading-5 text-muted sm:text-sm"
    >
      <p>
        {isLive ? (
          <>
            <span
              aria-hidden
              className="mr-1.5 inline-block size-2 rounded-full bg-success align-middle"
            />
            Live: your key runs the AI cashier
            <span className="hidden sm:inline">
              {" "}
              (Claude Haiku 5.5) and the group-order planner (Claude Opus 5.5)
            </span>
            .{" "}
          </>
        ) : placeholder ? (
          <>
            Demo: the AI replies here are pre-written examples.{" "}
            <span className="hidden sm:inline">Add your Anthropic API key to run it live. </span>
          </>
        ) : (
          <>
            Demo: these sample calls are recorded runs of the AI cashier.{" "}
            <span className="hidden sm:inline">Add your Anthropic API key to order yourself. </span>
          </>
        )}
        <button
          type="button"
          onClick={openKeyModal}
          className="whitespace-nowrap text-fg underline underline-offset-2 hover:text-accent"
        >
          {isLive ? "Change key" : "Add key"}
        </button>
      </p>
    </div>
  );
}
