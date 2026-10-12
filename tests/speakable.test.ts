import { describe, expect, it } from "vitest";
import { speakable } from "@/lib/speech/speakable";

describe("speakable text", () => {
  it("reads money the way a person says it", () => {
    expect(speakable("Your total is $14.25.")).toBe("Your total is 14 dollars and 25 cents.");
    expect(speakable("That is $8.00 even.")).toBe("That is 8 dollars even.");
    expect(speakable("Guacamole is $2.25 more.")).toBe("Guacamole is 2 dollars and 25 cents more.");
    expect(speakable("It adds $0.75.")).toBe("It adds 75 cents.");
    expect(speakable("Just $1.")).toBe("Just 1 dollar.");
    expect(speakable("$1.01")).toBe("1 dollar and 1 cent");
    expect(speakable("The combo saves $2.00, so $13.50 before tax.")).toBe(
      "The combo saves 2 dollars, so 13 dollars and 50 cents before tax.",
    );
    expect(speakable("Catering starts at $1,250.00")).toBe("Catering starts at 1250 dollars");
    expect(speakable("-$2.00 combo")).toBe("minus 2 dollars combo");
    expect(speakable("99¢ refills")).toBe("99 cents refills");
  });

  it("expands percent signs, units, and counter shorthand", () => {
    expect(speakable("Tax is 7.75%.")).toBe("Tax is 7.75 percent.");
    expect(speakable("A 16 oz cold brew")).toBe("A 16 ounces cold brew");
    expect(speakable("12oz. or 16oz?")).toBe("12 ounces or 16 ounces?");
    expect(speakable("Ready in 10 min")).toBe("Ready in 10 minutes");
    expect(speakable("1 lb of carnitas")).toBe("1 pound of carnitas");
    expect(speakable("Burrito w/ guac & chips")).toBe("Burrito with guac and chips");
    expect(speakable("lg latte, sm coffee")).toBe("large latte, small coffee");
    expect(speakable("2x burrito")).toBe("2 burrito");
    expect(speakable("Combo #2")).toBe("Combo number 2");
    expect(speakable("Ready in 5-10 minutes")).toBe("Ready in 5 to 10 minutes");
    expect(speakable("corn/flour tortillas")).toBe("corn or flour tortillas");
  });

  it("strips markdown, list markers, and emoji instead of reading them aloud", () => {
    expect(speakable("**One** large _carnitas_ burrito")).toBe("One large carnitas burrito");
    expect(speakable("- One burrito\n- One horchata")).toBe("One burrito One horchata");
    expect(speakable("1. Burrito\n2. Tacos")).toBe("Burrito Tacos");
    expect(speakable("# Your order")).toBe("Your order");
    expect(speakable("Thanks! 🌯🎉")).toBe("Thanks!");
    expect(speakable("See [the menu](https://example.com/menu) for more")).toBe(
      "See the menu for more",
    );
    expect(speakable("Use `add_item` now")).toBe("Use add item now");
  });

  it("turns asides and dashes into pauses", () => {
    expect(speakable("One burrito (no onions) and a drink")).toBe(
      "One burrito, no onions, and a drink",
    );
    expect(speakable("We are out — sorry about that")).toBe("We are out, sorry about that");
    expect(speakable("Total (with tax): $9.16")).toBe("Total, with tax: 9 dollars and 16 cents");
  });

  it("leaves ordinary sentences alone", () => {
    for (const plain of [
      "Got it, one large carnitas burrito with no onions.",
      "Anything to drink?",
      "We're out of carnitas. Would chicken work?",
      "It'll be ready in about 9 minutes.",
    ]) {
      expect(speakable(plain)).toBe(plain);
    }
  });

  it("returns an empty string when nothing is speakable", () => {
    expect(speakable("🎉")).toBe("");
    expect(speakable("   ")).toBe("");
    expect(speakable("***")).toBe("");
  });
});
