/** Money is integer cents everywhere. These are the only places it becomes text or tax. */

/** `1425` → `"$14.25"`. Negative amounts keep the sign in front: `"-$2.00"`. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, "0");
  return `${sign}$${dollars.toLocaleString("en-US")}.${rest}`;
}

/** Tax on an amount in cents, rounded half up, using integer math only. */
export function taxOn(cents: number, basisPoints: number): number {
  return Math.floor((cents * basisPoints + 5000) / 10_000);
}

/** A dollar figure from a tool call (`60`, `59.5`) as cents, or null when it is not a sane amount. */
export function dollarsToCents(dollars: unknown): number | null {
  if (typeof dollars !== "number" || !Number.isFinite(dollars)) return null;
  const cents = Math.round(dollars * 100);
  return cents > 0 && cents <= 100_000_00 ? cents : null;
}
