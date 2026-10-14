/*
 * Screenshot harness only, never shipped to visitors: a stand-in for the
 * browser's voice.
 *
 * Headless Chromium has `speechSynthesis` but produces no sound and never
 * fires `start`, so a sample call there falls back to timed captions after a
 * 3-second wait. That makes screenshots show a "sound failed" state no real
 * visitor with speakers would see. This script, injected before the page
 * loads (see `initScripts` in screenshots.json), makes `speak()` fire `start`
 * and then `end` after roughly the time the sentence takes to say. Nothing is
 * heard; the UI goes through exactly the states it would with a real voice.
 */
(() => {
  const synth = window.speechSynthesis;
  if (!synth) return;
  let current = null;
  let timer;
  let speaking = false;
  Object.defineProperty(synth, "speaking", { get: () => speaking, configurable: true });

  synth.speak = (utterance) => {
    const text = utterance.text.trim();
    if (!text) {
      setTimeout(() => utterance.onend?.(new Event("end")), 10);
      return;
    }
    current = utterance;
    speaking = true;
    setTimeout(() => {
      if (current !== utterance) return;
      utterance.onstart?.(new Event("start"));
      // About 15 characters a second, the pace of an unhurried voice.
      timer = setTimeout(
        () => {
          if (current !== utterance) return;
          current = null;
          speaking = false;
          utterance.onend?.(new Event("end"));
        },
        Math.max(700, text.length * 62),
      );
    }, 80);
  };

  synth.cancel = () => {
    const utterance = current;
    current = null;
    speaking = false;
    clearTimeout(timer);
    if (utterance) utterance.onerror?.(Object.assign(new Event("error"), { error: "canceled" }));
  };
  synth.resume = () => {};
  synth.pause = () => {};
})();
