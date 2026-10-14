"use client";

import { useEffect, useRef } from "react";
import { formatCents } from "@/lib/money";
import type { PricedCart, Receipt } from "@/lib/order/engine";
import type { CallSnapshot } from "@/lib/voice/session";
import { PlanCard, TapeLine } from "./Tape";

function Totals({ cart }: { cart: PricedCart }) {
  return (
    <dl className="flex flex-col gap-1 border-t border-border pt-3 text-sm">
      <div className="flex justify-between">
        <dt className="text-muted">Subtotal</dt>
        <dd className="tabular-nums">{formatCents(cart.subtotalCents)}</dd>
      </div>
      {cart.combos.map((combo) => (
        <div key={combo.id} className="flex justify-between text-success">
          <dt>
            {combo.count > 1 ? `${combo.count} × ` : ""}
            {combo.name}
          </dt>
          <dd className="tabular-nums">{formatCents(-combo.savingsCents)}</dd>
        </div>
      ))}
      <div className="flex justify-between">
        <dt className="text-muted">Tax</dt>
        <dd className="tabular-nums">{formatCents(cart.taxCents)}</dd>
      </div>
      <div className="mt-1 flex items-baseline justify-between">
        <dt className="text-base font-semibold">Total</dt>
        <dd className="text-2xl font-semibold tabular-nums">{formatCents(cart.totalCents)}</dd>
      </div>
    </dl>
  );
}

function ReceiptNote({ receipt }: { receipt: Receipt }) {
  return (
    <div className="rounded-lg border border-accent bg-bg p-3 text-sm">
      <p className="font-semibold">
        Order {receipt.orderNumber} placed for {receipt.pickupName}
      </p>
      <p className="mt-0.5 text-muted">
        Ready in about {receipt.readyInMinutes} minutes, according to the order code. This is a
        demo: no payment was taken and nothing is being cooked.
      </p>
    </div>
  );
}

export function CartPanel({ snapshot }: { snapshot: CallSnapshot }) {
  const { cart, receipt, log } = snapshot;
  const tapeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const tape = tapeRef.current;
    if (tape) tape.scrollTop = tape.scrollHeight;
  }, [log.length]);

  return (
    <section
      aria-labelledby="order-heading"
      className="rounded-xl border border-border bg-surface p-4"
    >
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 id="order-heading" className="text-base font-semibold">
          {receipt ? "Receipt" : "Cart"}
        </h2>
        <p className="text-sm text-muted">
          {cart.pickupName ? `For ${cart.pickupName}` : "No pickup name yet"}
        </p>
      </div>

      {receipt && (
        <div className="mb-3">
          <ReceiptNote receipt={receipt} />
        </div>
      )}

      {cart.lines.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm leading-6 text-muted">
          <p className="font-medium text-fg">Your cart is empty</p>
          <p className="text-balance">Items appear here as the AI cashier adds them.</p>
        </div>
      ) : (
        <ul className="mb-3 flex flex-col">
          {cart.lines.map((line) => (
            <li
              key={`${line.id}-${line.quantity}-${line.name}-${line.details.join()}`}
              className="land -mx-1.5 rounded-sm px-1.5 py-1.5"
            >
              <div className="flex items-baseline justify-between gap-3">
                <p className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]">
                  {line.quantity > 1 && <span className="text-muted">{line.quantity} × </span>}
                  {line.name}
                </p>
                <p className="shrink-0 text-sm tabular-nums">{formatCents(line.totalCents)}</p>
              </div>
              {line.details.length > 0 && (
                <p className="text-xs text-muted">{line.details.join(", ")}</p>
              )}
              {line.issue && (
                <p className="mt-0.5 text-xs font-medium text-danger">
                  Cannot be made: {line.issue}. The order cannot be placed until this changes.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {cart.lines.length > 0 && <Totals cart={cart} />}

      <div className="mt-4 hidden lg:block">
        <h3 className="text-xs font-medium tracking-wide text-muted uppercase">
          Behind the scenes
        </h3>
        <p className="mb-1.5 text-xs leading-5 text-muted">
          Each action the AI asked for, and whether the order code allowed it.
        </p>
        <div
          ref={tapeRef}
          role="log"
          aria-label="Actions the AI asked for"
          tabIndex={0}
          className="max-h-64 overflow-y-auto rounded-lg border border-border bg-bg p-1.5"
        >
          {log.length === 0 ? (
            <p className="px-1.5 py-1 font-mono text-xs text-muted">nothing yet</p>
          ) : (
            log.map((entry, index) => (
              <div key={entry.id}>
                <TapeLine entry={entry} fresh={index === log.length - 1} />
                <PlanCard entry={entry} handWritten={snapshot.handWritten} />
              </div>
            ))
          )}
        </div>
      </div>

      <p className="mt-3 text-xs leading-5 text-muted">
        Prices come from code, never from the AI. The AI can only add, change, or remove menu items,
        set a pickup name, read the order back, and place it. It has no way to set a price or give a
        discount.
      </p>
    </section>
  );
}
