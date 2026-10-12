/**
 * Turns caption text into text a speech synthesizer reads well.
 *
 * Synthesizers disagree about "$8.50", "16 oz", "w/", and stray markdown, and
 * some read symbols aloud. The system prompt already asks the model to write
 * for the ear; this is the deterministic backstop. Captions keep the original.
 */

const UNITS: [RegExp, string, string][] = [
  [/\b(\d+(?:\.\d+)?)\s?(?:fl\.?\s?)?oz\b\.?/gi, "ounce", "ounces"],
  [/\b(\d+(?:\.\d+)?)\s?lbs?\b\.?/gi, "pound", "pounds"],
  [/\b(\d+(?:\.\d+)?)\s?mins?\b\.?/gi, "minute", "minutes"],
  [/\b(\d+(?:\.\d+)?)\s?(?:cals?|kcal)\b\.?/gi, "calorie", "calories"],
];

const WORDS: [RegExp, string][] = [
  [/\bw\/o\b/gi, "without"],
  [/\bw\/(?=\s|\w)/gi, "with "],
  [/\b(?:sm)\b\.?(?=\s|$|[,;)])/gi, "small"],
  [/\b(?:med)\b\.?(?=\s|$|[,;)])/gi, "medium"],
  [/\b(?:lg|lrg)\b\.?(?=\s|$|[,;)])/gi, "large"],
  [/\b(?:reg)\b\.?(?=\s|$|[,;)])/gi, "regular"],
  [/\bqty\b\.?/gi, "quantity"],
  [/\bapprox\b\.?/gi, "about"],
  [/\betc\b\.?/gi, "and so on"],
];

function dollars(whole: string, cents: string | undefined): string {
  const amount = Number(whole.replaceAll(",", ""));
  const fraction = cents ? Number(cents.padEnd(2, "0").slice(0, 2)) : 0;
  const dollarPart = `${amount} ${amount === 1 ? "dollar" : "dollars"}`;
  const centPart = `${fraction} ${fraction === 1 ? "cent" : "cents"}`;
  if (amount === 0 && fraction > 0) return centPart;
  return fraction > 0 ? `${dollarPart} and ${centPart}` : dollarPart;
}

export function speakable(text: string): string {
  let out = text;

  // Markdown that slipped through: links, emphasis, code, headings, list markers.
  out = out.replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1");
  out = out.replace(/(\*\*|__)(.+?)\1/g, "$2");
  out = out.replace(/(^|[\s(])[*_](\S(?:.*?\S)?)[*_](?=[\s).,!?;:]|$)/g, "$1$2");
  out = out.replace(/`+/g, "");
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  out = out.replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, "");

  // Emoji and pictographs are never spoken.
  out = out.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "");

  // Money: "-$2.00" → "minus 2 dollars", "$8.50" → "8 dollars and 50 cents", "$0.75" → "75 cents".
  out = out.replace(
    /([-−–])?\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?!\d)/g,
    (_match, minus: string | undefined, whole: string, cents: string | undefined) =>
      `${minus ? "minus " : ""}${dollars(whole, cents)}`,
  );
  out = out.replace(
    /(\d+)\s?¢/g,
    (_match, cents: string) => `${cents} ${cents === "1" ? "cent" : "cents"}`,
  );
  out = out.replace(/(\d)\s?%/g, "$1 percent");

  // Units and counter shorthand.
  for (const [pattern, one, many] of UNITS) {
    out = out.replace(
      pattern,
      (_match, amount: string) => `${amount} ${amount === "1" ? one : many}`,
    );
  }
  for (const [pattern, word] of WORDS) out = out.replace(pattern, word);
  out = out.replace(/\b(\d+)\s?[x×]\s+(?=\p{L})/giu, "$1 ");
  out = out.replace(/\s[x×]\s?(\d+)\b/gi, " times $1");
  out = out.replace(/#\s?(\d+)/g, "number $1");
  out = out.replace(/(\d)\s?[–-]\s?(\d)/g, "$1 to $2");

  // Symbols a synthesizer would read aloud or stumble on.
  out = out.replace(/\s*&\s*/g, " and ");
  out = out.replace(/\s\+\s?(?=\p{L})/gu, " plus ");
  out = out.replace(/(^|[\s,])\+(?=\p{L})/gu, "$1plus ");
  out = out.replace(/\s@\s/g, " at ");
  out = out.replace(/\s=\s/g, " is ");
  out = out.replace(/~\s?(?=\d)/g, "about ");
  out = out.replace(/(\p{L})\/(\p{L})/gu, "$1 or $2");
  out = out.replace(/\s[—–]\s|—/g, ", ");
  out = out.replace(/\s*\(([^()]*)\)/g, ", $1,");
  out = out.replace(/[*_#|<>^~`\\[\]{}]/g, " ");

  // Tidy the joins the replacements left behind.
  out = out.replace(/\s+/g, " ");
  out = out.replace(/\s+([,.;:!?])/g, "$1");
  out = out.replace(/,(?=[.!?;:])/g, "");
  out = out.replace(/,{2,}/g, ",");
  out = out.replace(/^[,\s]+/, "");
  return out.trim();
}
