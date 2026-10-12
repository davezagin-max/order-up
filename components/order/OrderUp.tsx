"use client";

import { useEffect, useRef, useState } from "react";
import { useKey } from "@/components/kit/KeyProvider";
import { ThemeToggle } from "@/components/kit/ThemeToggle";
import { CAFE } from "@/lib/menu";
import { formatCents } from "@/lib/money";
import { useCallSession, useSpeechSupport } from "@/lib/voice/useCallSession";
import { CartPanel } from "./CartPanel";
import { Conversation } from "./Conversation";
import { BagIcon, ChevronIcon, SoundOffIcon, SoundOnIcon } from "./icons";
import { KitchenPanel } from "./KitchenPanel";
import { MicDock } from "./MicDock";
import { ModeBanner } from "./ModeBanner";
import { TimelinePanel } from "./TimelinePanel";

const ERROR_TITLE: Record<string, string> = {
  refusal: "Claude declined that one",
  auth: "There is a problem with your key",
  rate_limit: "Too many requests",
  demo_miss: "That needs a key",
  limit: "This call has reached its limit",
  speech: "Microphone",
  too_large: "This call has grown too long",
  invalid: "The request was not accepted",
  server: "Something went wrong",
};

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A", "SUMMARY"].includes(target.tagName)
  );
}

export function OrderUp({ placeholder }: { placeholder: boolean }) {
  const { isLive, openKeyModal } = useKey();
  const { session, snapshot } = useCallSession();
  const support = useSpeechSupport();
  const [panelOpen, setPanelOpen] = useState(false);

  // Hold Space to talk, let go to send. Escape stops whatever is happening.
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code === "Escape") {
        session.stop();
        return;
      }
      if (event.code !== "Space" || isTypingTarget(event.target)) return;
      event.preventDefault();
      if (!event.repeat) session.micDown();
    };
    const up = (event: KeyboardEvent) => {
      if (event.code !== "Space" || isTypingTarget(event.target)) return;
      session.micUp();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [session]);

  // Keep the newest caption in view as the call moves.
  const endRef = useRef<HTMLDivElement>(null);
  const { captions, planning, interim } = snapshot;
  const hasError = snapshot.error !== null;
  useEffect(() => {
    if (captions.length > 0) endRef.current?.scrollIntoView({ block: "end" });
  }, [captions, planning, interim, hasError]);

  // Opening the order on a phone starts at its top, wherever the conversation was scrolled to.
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (panelOpen) panelRef.current?.scrollIntoView({ block: "start" });
  }, [panelOpen]);

  const play = (sampleId: string) => {
    setPanelOpen(false);
    void session.playSample(sampleId);
  };

  const { cart, error } = snapshot;
  const hasCall = snapshot.captions.length > 0;
  const soundAvailable = support?.synthesis ?? false;

  return (
    <>
      <ModeBanner placeholder={placeholder} />
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="neon neon-frame rounded-md px-2 py-0.5 text-xs font-bold tracking-[0.2em]">
            OPEN
          </span>
          <div className="min-w-0">
            <h1 className="text-base leading-5 font-semibold whitespace-nowrap">Order Up</h1>
            <p className="hidden truncate text-xs text-muted sm:block">
              Voice ordering at {CAFE.name}, a fictional cafe
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {hasCall && (
            <button
              type="button"
              onClick={() => session.reset()}
              aria-label="Start a new call"
              className="rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-surface"
            >
              New<span className="hidden sm:inline"> call</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => session.setSound(!snapshot.soundOn)}
            aria-pressed={snapshot.soundOn}
            aria-label={
              snapshot.soundOn ? "Sound is on. Turn sound off." : "Sound is off. Turn sound on."
            }
            title={soundAvailable ? undefined : "This browser cannot speak; captions only."}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-surface"
          >
            {snapshot.soundOn ? (
              <SoundOnIcon className="size-4" />
            ) : (
              <SoundOffIcon className="size-4" />
            )}
            <span className="hidden sm:inline">{snapshot.soundOn ? "Sound on" : "Sound off"}</span>
          </button>
          <ThemeToggle />
        </div>
      </header>

      {/* On a phone the order collapses to a bar that expands on tap. */}
      <div className="sticky top-0 z-20 border-b border-border bg-bg lg:hidden">
        <button
          type="button"
          onClick={() => setPanelOpen((open) => !open)}
          aria-expanded={panelOpen}
          aria-controls="order-panels"
          className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-sm"
        >
          <span className="inline-flex items-center gap-2 font-medium">
            <BagIcon className="size-4 text-accent" />
            {cart.itemCount === 0
              ? "Order is empty"
              : `${cart.itemCount} ${cart.itemCount === 1 ? "item" : "items"}`}
            {snapshot.receipt && <span className="text-success">· placed</span>}
          </span>
          <span className="inline-flex items-center gap-2">
            <span className="text-base font-semibold tabular-nums">
              {formatCents(cart.totalCents)}
            </span>
            <ChevronIcon
              className={`size-4 text-muted transition-transform ${panelOpen ? "rotate-180" : ""}`}
            />
          </span>
        </button>
      </div>

      <main
        id="main"
        className="mx-auto grid w-full max-w-[88rem] flex-1 grid-cols-1 lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_25rem]"
      >
        <div className={`flex min-w-0 flex-col lg:min-h-0 ${panelOpen ? "hidden lg:flex" : ""}`}>
          <div className="flex-1 px-4 py-5 sm:px-6 lg:min-h-0 lg:overflow-y-auto lg:py-6">
            <Conversation
              snapshot={snapshot}
              placeholder={placeholder}
              isLive={isLive}
              onPlay={play}
            />
            {error && (
              <div
                role="alert"
                className="mt-4 rounded-lg border border-danger bg-surface px-3.5 py-3 text-sm"
              >
                <p className="font-semibold text-danger">
                  {ERROR_TITLE[error.kind] ?? ERROR_TITLE.server}
                </p>
                <p className="mt-0.5">{error.message}</p>
                {error.kind === "refusal" && (
                  <p className="mt-0.5 text-muted">
                    Nothing was added to the order. Say it another way and carry on.
                  </p>
                )}
                {(error.kind === "auth" || error.kind === "demo_miss") && (
                  <button
                    type="button"
                    onClick={openKeyModal}
                    className="mt-2 underline underline-offset-2"
                  >
                    {error.kind === "auth" ? "Check your key" : "Add your key"}
                  </button>
                )}
              </div>
            )}
            <div ref={endRef} aria-hidden className="h-px scroll-mb-64 lg:scroll-mb-6" />
          </div>
          <div className="sticky bottom-0 z-10 border-t border-border bg-bg px-4 py-3 sm:px-6 lg:static lg:py-4">
            <MicDock
              session={session}
              snapshot={snapshot}
              support={support}
              isLive={isLive}
              onAddKey={openKeyModal}
              onPlay={play}
            />
          </div>
        </div>

        <aside
          ref={panelRef}
          id="order-panels"
          aria-label="Order, kitchen, and turn timeline"
          className={`min-w-0 scroll-mt-12 flex-col gap-4 border-border px-4 py-4 lg:flex lg:min-h-0 lg:overflow-y-auto lg:border-l lg:py-6 lg:pr-6 lg:pl-5 ${
            panelOpen ? "flex" : "hidden"
          }`}
        >
          <CartPanel snapshot={snapshot} />
          <KitchenPanel session={session} snapshot={snapshot} isLive={isLive} />
          <TimelinePanel snapshot={snapshot} />
        </aside>
      </main>

      <footer className="border-t border-border px-4 py-2.5 text-center text-xs leading-5 text-muted">
        {CAFE.name} is fictional. No payment is taken, no real order is placed, and the allergen
        tags describe a made-up menu.{" "}
        <span className="whitespace-nowrap">Built with Claude Code and Claude Opus 5.5.</span>
      </footer>
    </>
  );
}
