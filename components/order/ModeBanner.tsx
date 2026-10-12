"use client";

import { useKey } from "@/components/kit/KeyProvider";

/**
 * Says plainly what the visitor is looking at. The wording follows the
 * fixtures' own `placeholder` flag, so it flips by itself once real runs are
 * recorded and never calls a hand-written sample a recorded run.
 */
export function ModeBanner({ placeholder }: { placeholder: boolean }) {
  const { isLive, openKeyModal } = useKey();

  if (isLive) {
    return (
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-border bg-surface px-4 py-2 text-sm">
        <span className="inline-flex items-center gap-2">
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-success" />
          <span>
            Live. Your key runs Claude Haiku 5.5 for the conversation
            <span className="hidden sm:inline"> and Claude Opus 5.5 for group plans</span>.
          </span>
        </span>
        <button type="button" onClick={openKeyModal} className="underline underline-offset-2">
          Change key
        </button>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="flex items-center justify-between gap-x-3 gap-y-1 border-b border-border bg-surface px-4 py-2 text-sm sm:justify-center"
    >
      <span>
        {placeholder
          ? "Demo mode. The sample calls are hand-written examples until real runs are recorded."
          : "Demo mode. The sample calls replay recorded runs of Claude Haiku 5.5 and Opus 5.5."}
        <span className="hidden sm:inline"> Add your key to order by voice yourself.</span>
      </span>
      <button
        type="button"
        onClick={openKeyModal}
        className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg hover:opacity-90"
      >
        Add key
      </button>
    </div>
  );
}
