"use client";

import { ADD_ON_IDS, CATEGORIES, GROUPS, MENU, OPTION_IDS, componentName } from "@/lib/menu";
import type { CallSession, CallSnapshot } from "@/lib/voice/session";

interface KitchenPanelProps {
  session: CallSession;
  snapshot: CallSnapshot;
  isLive: boolean;
}

const PROTEINS = GROUPS.protein.options.map((option) => option.id as string);
const FILLINGS = GROUPS.filling.options.map((option) => option.id as string);
/** Add-ons that are not already listed as a protein or filling. */
const EXTRAS = (ADD_ON_IDS as string[]).filter(
  (id) => !PROTEINS.includes(id) && !FILLINGS.includes(id),
);
const OTHER_OPTIONS = (OPTION_IDS as string[]).filter(
  (id) => !PROTEINS.includes(id) && !FILLINGS.includes(id),
);

function label(id: string): string {
  const name = componentName(id);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function KitchenPanel({ session, snapshot, isLive }: KitchenPanelProps) {
  const out = new Set(snapshot.outOfStock);
  const pending = new Set(snapshot.pendingKitchen.map((change) => change.id));
  const placed = snapshot.origin === "live" && Boolean(snapshot.receipt);
  const disabled = !isLive || Boolean(snapshot.sample) || placed;

  const chip = (id: string, name: string) => {
    const isOut = out.has(id);
    return (
      <li key={id}>
        <button
          type="button"
          role="switch"
          aria-checked={!isOut}
          aria-label={`${name}: ${isOut ? "out of stock" : "in stock"}`}
          disabled={disabled}
          onClick={() => session.toggleStock(id)}
          className={`rounded-md border px-2 py-1 text-xs transition-colors disabled:cursor-default ${
            isOut
              ? "border-danger bg-bg font-medium text-danger line-through decoration-1"
              : "border-border bg-bg text-fg enabled:hover:border-accent"
          } ${pending.has(id) ? "ring-1 ring-accent" : ""}`}
        >
          {name}
        </button>
      </li>
    );
  };

  const group = (title: string, ids: string[]) => (
    <div>
      <h3 className="mb-1.5 text-xs font-medium tracking-wide text-muted uppercase">{title}</h3>
      <ul className="flex flex-wrap gap-1.5">{ids.map((id) => chip(id, label(id)))}</ul>
    </div>
  );

  return (
    <section
      aria-labelledby="kitchen-heading"
      className="rounded-xl border border-border bg-surface p-4"
    >
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h2 id="kitchen-heading" className="text-base font-semibold">
          Kitchen <span className="font-normal text-muted">(staff side)</span>
        </h2>
        <p className="text-sm text-muted">
          {out.size === 0 ? "Everything in stock" : `${out.size} sold out`}
        </p>
      </div>
      <p className="mb-3 text-xs leading-5 text-muted">
        {snapshot.sample
          ? "In a sample call the script plays the staff. Watch what sells out."
          : isLive
            ? "You play the staff: tap an item to mark it sold out mid-call. The AI cashier hears about it with your next words."
            : "Staff controls: mark an item sold out mid-call and the AI cashier has to cope. The second sample call shows it; with a key, you can try it."}
      </p>
      <div className="flex flex-col gap-3">
        {group("Proteins", PROTEINS)}
        <details className="group">
          <summary className="cursor-pointer text-xs font-medium tracking-wide text-muted uppercase hover:text-fg">
            The rest of the menu
          </summary>
          <div className="mt-2 flex flex-col gap-3">
            {group("Breakfast fillings and extras", [...FILLINGS, ...EXTRAS])}
            {CATEGORIES.map((category) => (
              <div key={category.id}>
                <h3 className="mb-1.5 text-xs text-muted">{category.name}</h3>
                <ul className="flex flex-wrap gap-1.5">
                  {MENU.filter((item) => item.category === category.id).map((item) =>
                    chip(item.id, item.name),
                  )}
                </ul>
              </div>
            ))}
            {group("Tortillas, milks, and flavors", OTHER_OPTIONS)}
          </div>
        </details>
      </div>
      {snapshot.pendingKitchen.length > 0 && !snapshot.sample && (
        <p role="status" className="mt-3 text-xs text-accent">
          {snapshot.pendingKitchen.length === 1
            ? "1 change"
            : `${snapshot.pendingKitchen.length} changes`}{" "}
          queued. The AI cashier hears about it with the customer&apos;s next words.
        </p>
      )}
    </section>
  );
}
