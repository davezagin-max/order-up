import { describe, expect, it } from "vitest";
import { SentenceChunker, splitSentences } from "@/lib/speech/chunker";

/** Feeds text one character at a time, the worst case for a token stream. */
function byCharacter(text: string): string[] {
  const chunker = new SentenceChunker();
  const out: string[] = [];
  for (const char of text) out.push(...chunker.push(char));
  return [...out, ...chunker.flush()];
}

describe("sentence chunker", () => {
  it("emits each sentence as soon as the next one starts, not at the end of the reply", () => {
    const chunker = new SentenceChunker();
    expect(chunker.push("Got it.")).toEqual([]); // could still be "Got it.50"
    expect(chunker.push(" ")).toEqual([]);
    expect(chunker.push("One")).toEqual(["Got it."]);
    expect(chunker.push(" large burrito. Anything")).toEqual(["One large burrito."]);
    expect(chunker.pending).toBe("Anything");
    expect(chunker.push(" else?")).toEqual([]);
    expect(chunker.flush()).toEqual(["Anything else?"]);
    expect(chunker.pending).toBe("");
  });

  it("does not split prices or decimals, even when the stream cuts them in half", () => {
    const text = "That is $8.50 for the burrito. Tax is 7.75 percent. Your total is $9.16.";
    const expected = [
      "That is $8.50 for the burrito.",
      "Tax is 7.75 percent.",
      "Your total is $9.16.",
    ];
    expect(splitSentences(text)).toEqual(expected);
    expect(byCharacter(text)).toEqual(expected);

    const chunker = new SentenceChunker();
    expect(chunker.push("It comes to $8.")).toEqual([]);
    expect(chunker.push("50")).toEqual([]);
    expect(chunker.push(" total. Okay?")).toEqual(["It comes to $8.50 total."]);
  });

  it("keeps abbreviations and initials inside their sentence", () => {
    expect(splitSentences("We have Dr. Pepper and root beer. Which one?")).toEqual([
      "We have Dr. Pepper and root beer.",
      "Which one?",
    ]);
    expect(splitSentences("We open at 6 a.m. and close late. See you then.")).toEqual([
      "We open at 6 a.m. and close late.",
      "See you then.",
    ]);
    expect(splitSentences("We close at 11 p.m. Anything else?")).toEqual([
      "We close at 11 p.m.",
      "Anything else?",
    ]);
    expect(splitSentences("That is item No. 5 on the board. Want it?")).toEqual([
      "That is item No. 5 on the board.",
      "Want it?",
    ]);
    expect(splitSentences("Oh no. We just ran out.")).toEqual(["Oh no.", "We just ran out."]);
    expect(splitSentences("Order for J. Smith is ready. Thanks!")).toEqual([
      "Order for J. Smith is ready.",
      "Thanks!",
    ]);
    expect(splitSentences("Sides, e.g. chips, are extra. Okay?")).toEqual([
      "Sides, e.g. chips, are extra.",
      "Okay?",
    ]);
  });

  it("handles question marks, exclamations, ellipses, and closing quotes", () => {
    expect(splitSentences("Really?! Yes! Hmm... let me check. Done.")).toEqual([
      "Really?!",
      "Yes!",
      "Hmm... let me check.",
      "Done.",
    ]);
    expect(splitSentences('You said "no onions." Is that right?')).toEqual([
      'You said "no onions."',
      "Is that right?",
    ]);
    expect(splitSentences("Hmm... Let me check.")).toEqual(["Hmm...", "Let me check."]);
  });

  it("treats a newline as the end of a sentence", () => {
    expect(splitSentences("One burrito\nOne horchata\n\nAnything else")).toEqual([
      "One burrito",
      "One horchata",
      "Anything else",
    ]);
  });

  it("gives the same sentences however the text is chopped up", () => {
    const text =
      "Sure thing! One large carnitas burrito with no onions, plus guacamole, is $14.25. We are out of Dr. Pepper... sorry. Cola instead?";
    const whole = splitSentences(text);
    expect(whole).toEqual([
      "Sure thing!",
      "One large carnitas burrito with no onions, plus guacamole, is $14.25.",
      "We are out of Dr. Pepper... sorry.",
      "Cola instead?",
    ]);
    expect(byCharacter(text)).toEqual(whole);
    for (const size of [2, 3, 5, 7, 11]) {
      const chunker = new SentenceChunker();
      const out: string[] = [];
      for (let i = 0; i < text.length; i += size)
        out.push(...chunker.push(text.slice(i, i + size)));
      expect([...out, ...chunker.flush()], `chunks of ${size}`).toEqual(whole);
    }
  });

  it("cuts a run-on at a clause break so speech can start, and never loses text", () => {
    const runOn =
      "We have burritos with chicken, steak, carnitas, barbacoa, sofritas, or fajita veggies, and bowls with the same choices, and street tacos on corn or flour tortillas, and quesadillas, and loaded nachos, and a chopped salad, and then there is breakfast which we serve all night long";
    const chunker = new SentenceChunker();
    const early = chunker.push(runOn);
    expect(early.length).toBeGreaterThanOrEqual(1);
    expect(early[0].length).toBeLessThanOrEqual(220);
    const all = [...early, ...chunker.flush()];
    expect(all.join(" ").replace(/\s+/g, " ")).toBe(runOn);
  });

  it("flush on an empty or whitespace-only buffer yields nothing", () => {
    const chunker = new SentenceChunker();
    expect(chunker.flush()).toEqual([]);
    chunker.push("  \n ");
    expect(chunker.flush()).toEqual([]);
  });
});
