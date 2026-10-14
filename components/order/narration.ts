/**
 * A plain-words status line for a sample call while it plays, so a visitor who
 * has never seen a voice agent can follow what is happening on each beat.
 * Pure: it reads only the snapshot.
 */
import type { CallSnapshot, LogEntry } from "@/lib/voice/session";

/** The newest tool call made since the customer last spoke, if any. */
export function latestStepThisTurn(captions: CallSnapshot["captions"]): LogEntry | null {
  for (let index = captions.length - 1; index >= 0; index--) {
    const caption = captions[index];
    if (caption.role === "customer") return null;
    if (caption.role === "tool") return caption.entry;
  }
  return null;
}

/** What the order code just did, from the engine's own summary of the tool call. */
export function describeStep(entry: LogEntry): string {
  if (!entry.ok) return "Code refused that request, so nothing changed.";
  const verb = entry.summary.split(":")[0].trim();
  if (verb.startsWith("added group plan")) return "Code added the planned meals to the cart.";
  if (verb === "added") return "Code checked the item, priced it, and added it to the cart.";
  if (verb === "changed") return "Code checked the change and updated the cart.";
  if (verb === "removed") return "Code took it out of the cart.";
  if (verb === "pickup name") return "Code saved the name for pickup.";
  if (verb.startsWith("read back"))
    return "Code pulled up the order so the cashier can read it back.";
  if (verb === "confirmed") return "Code placed the order and printed the receipt.";
  if (verb.startsWith("planned")) return "Code checked the plan against the budget and diets.";
  return "Code checked the request.";
}

export function narrate(snapshot: CallSnapshot): string {
  if (snapshot.planning) return "A stronger AI model is planning the group order…";
  const step = latestStepThisTurn(snapshot.captions);
  switch (snapshot.phase) {
    case "listening":
      return "The customer is ordering…";
    case "thinking":
      return step ? describeStep(step) : "The AI cashier is deciding what to do…";
    case "speaking": {
      const answering = snapshot.soundOn
        ? "The AI cashier is answering out loud."
        : "The AI cashier is answering (sound is off).";
      return step ? `${describeStep(step)} ${answering}` : answering;
    }
    default:
      return "Next, the customer replies.";
  }
}
