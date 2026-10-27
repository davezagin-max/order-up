#!/usr/bin/env node
/**
 * Functional check for Order Up, in headless Chromium, against the production build.
 *
 * The production server must already be running on port 3125:
 *   pnpm build && pnpm exec next start -p 3125
 * Then run:
 *   pnpm functional
 *
 * Every check runs at 1280x800 and 390x844, in light and dark, unless it is marked n/a.
 * The script never calls the Claude API. A request to /api/turn that carries a key is
 * answered by the script (a recorded fixture or a canned error), so the key goes nowhere
 * but this app's own route. Requests without a key replay the sample fixtures on the
 * server. Real speech and the microphone cannot run in headless Chromium, so only the UI
 * states around them are checked; the speech layer runs through scripts/fake-voice.js.
 *
 * Exits non-zero on any failed check, console error, or page error. Set ONLY=desktop-light
 * to run one layout, and FUNCTIONAL_REPORT=<path> to also write the results as JSON.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "http://localhost:3125";
const FAKE_VOICE = path.join(ROOT, "scripts/fake-voice.js");
const FIXTURES = JSON.parse(readFileSync(path.join(ROOT, "fixtures/turn.json"), "utf8"));
// A made-up key of the right shape. It only ever travels to this app's own /api/turn route,
// and this script answers that route itself, so it reaches no other host.
const TEST_KEY = "sk-ant-functional-test-0000000000000000";
const WAIT = 20_000;
const CALL_TIMEOUT = 240_000;
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;

const COMBOS = [
  { id: "desktop-light", width: 1280, height: 800, scheme: "light", phone: false },
  { id: "phone-light", width: 390, height: 844, scheme: "light", phone: true },
  { id: "desktop-dark", width: 1280, height: 800, scheme: "dark", phone: false },
  { id: "phone-dark", width: 390, height: 844, scheme: "dark", phone: true },
];

// The customer's lines, as written in lib/samples.ts.
const QUICK = [
  "Hi, can I get a large carnitas burrito with no onions, and add guac?",
  "Yeah, a horchata. And some chips and salsa.",
  "That's it. It's for Dave.",
  "Yep, sounds good.",
];
const CHANGES = [
  "Can I do two chicken burritos and a quesadilla?",
  "Carnitas. Actually, make one of those burritos a bowl with steak.",
  "And can I add a large cold brew?",
  "Oh. Steak's fine, I guess.",
  "No onions on the burrito. That's everything, and the name's Priya.",
  "That's right.",
];
// A speech engine that never starts: the stand-in for a browser whose voice stays silent.
// The app's start watchdog must notice and fall back to captions only.
const DEAD_VOICE = `(() => {
  const synth = window.speechSynthesis;
  if (!synth) return;
  synth.speak = () => {};
  synth.cancel = () => {};
  synth.resume = () => {};
  synth.pause = () => {};
  Object.defineProperty(synth, "speaking", { get: () => false, configurable: true });
})();`;

// Records every request for the microphone (getUserMedia, or a recogniser starting to listen).
const MIC_SPY = `(() => {
  window.__mic = [];
  const devices = navigator.mediaDevices;
  if (devices && devices.getUserMedia) {
    const getUserMedia = devices.getUserMedia.bind(devices);
    devices.getUserMedia = (...args) => { window.__mic.push("getUserMedia"); return getUserMedia(...args); };
  }
  for (const name of ["SpeechRecognition", "webkitSpeechRecognition"]) {
    const Recognition = window[name];
    if (!Recognition || !Recognition.prototype || !Recognition.prototype.start) continue;
    const start = Recognition.prototype.start;
    Recognition.prototype.start = function (...args) { window.__mic.push("recognition.start"); return start.apply(this, args); };
  }
})();`;

// Records every line handed to the browser's speech synthesis, so checks can see what was "said".
const RECORDER = `(() => {
  const synth = window.speechSynthesis;
  window.__spoken = [];
  if (!synth || !synth.speak) return;
  const speak = synth.speak.bind(synth);
  synth.speak = (utterance) => { window.__spoken.push(utterance.text); return speak(utterance); };
})();`;

const NA = Symbol("not applicable");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Canned live answers. The reply replays the quick-order turn 1 fixture, which was produced by the
// real order engine; it stands in for a model reply and is labelled as such in the report.
const LIVE_META = { mode: "live", placeholder: false, recordedAt: null };
function sseBody(frames) {
  return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
}
function replyBody() {
  const fixture = FIXTURES["quick-1"];
  // The server reports each model's use in the reply, so the stand-in does too.
  const models = [
    { role: "conversation", model: "claude-haiku-5-5", calls: 1, usage: fixture.usage, costUsd: 0 },
  ];
  return sseBody([
    { type: "meta", meta: LIVE_META },
    ...fixture.events.map(({ event }) => ({ type: "event", event })),
    {
      type: "done",
      data: { ...fixture.data, models },
      meta: { ...LIVE_META, model: "claude-haiku-5-5", usage: fixture.usage, costUsd: 0 },
    },
  ]);
}
const STUBS = {
  reply: (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: replyBody() }),
  slowReply: async (route) => {
    await sleep(4_000);
    try {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: replyBody() });
    } catch {
      // The visitor cancelled and the request was already gone.
    }
  },
  refusal: (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sseBody([
        { type: "meta", meta: LIVE_META },
        { type: "error", error: { kind: "refusal", message: "The model declined this request." } },
      ]),
    }),
  auth: (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: { kind: "auth", message: "Your key was not accepted." } }),
    }),
  demoMiss: (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: { kind: "demo_miss", message: "Demo mode only answers the presets." },
      }),
    }),
};

const results = new Map(); // feature -> Map(combo id -> { status, detail })
const pageErrors = new Map(); // combo id -> string[]
const layoutProblems = new Map(); // combo id -> number

function record(combo, feature, status, detail = "") {
  if (!results.has(feature)) results.set(feature, new Map());
  results.get(feature).set(combo.id, { status, detail });
}

async function openPage(browser, combo, { voice = true, stub = null, allowHttp = false } = {}) {
  const context = await browser.newContext({
    viewport: { width: combo.width, height: combo.height },
    colorScheme: combo.scheme,
    deviceScaleFactor: 1,
  });
  if (voice === true) await context.addInitScript({ path: FAKE_VOICE });
  if (voice === "dead") await context.addInitScript(DEAD_VOICE);
  await context.addInitScript(MIC_SPY);
  await context.addInitScript(RECORDER);
  const page = await context.newPage();
  const errors = [];
  const keyed = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    // A deliberate error reply from the stub shows up as a failed resource; only those are allowed.
    if (allowHttp && text.startsWith("Failed to load resource")) return;
    errors.push(`console: ${text}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  await page.route("**/api/turn", async (route) => {
    const request = route.request();
    if (!request.headers()["x-anthropic-key"]) return route.continue();
    keyed.push(JSON.parse(request.postData() ?? "{}"));
    if (!stub) {
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: '{"ok":false,"error":{"kind":"server","message":"No stub is set for this check."}}',
      });
    }
    return stub(route);
  });
  // Wait for the page to be usable rather than for a fully quiet network: a stalled request
  // elsewhere on the machine must not fail a check of the page itself.
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.locator("h1").first().waitFor({ state: "visible", timeout: 30_000 });
  return {
    page,
    keyed,
    close: async () => {
      const list = pageErrors.get(combo.id) ?? [];
      list.push(...errors);
      pageErrors.set(combo.id, list);
      await context.close();
    },
  };
}

async function check(combo, feature, page, fn) {
  let status = "PASS";
  let detail = "";
  try {
    const value = await fn();
    if (value === NA) status = "N/A";
    else detail = value ?? "";
  } catch (error) {
    status = "FAIL";
    detail = String(error?.message ?? error).split("\n")[0];
  }
  if (combo.phone && status !== "N/A") {
    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      screen: window.innerWidth,
    }));
    if (widths.scroll > widths.screen) {
      layoutProblems.set(combo.id, (layoutProblems.get(combo.id) ?? 0) + 1);
      if (status === "PASS") {
        status = "FAIL";
        detail = `page is ${widths.scroll}px wide on a ${widths.screen}px screen`;
      }
    }
  }
  record(combo, feature, status, detail);
}

const bodyText = (page) => page.locator("body").innerText();

async function see(page, text) {
  try {
    await page.waitForFunction((t) => document.body.innerText.includes(t), text, {
      timeout: WAIT,
      polling: 200,
    });
  } catch {
    throw new Error(`not on screen: "${text}"`);
  }
  return text;
}

async function unseen(page, text) {
  try {
    await page.waitForFunction((t) => !document.body.innerText.includes(t), text, {
      timeout: WAIT,
      polling: 200,
    });
  } catch {
    throw new Error(`still on screen: "${text}"`);
  }
}

/** On a phone the order panels are a drawer: open them before reading the cart. */
async function cart(page, combo, open) {
  if (!combo.phone) return;
  const bar = page.locator("button[aria-controls=order-panels]");
  if ((await bar.getAttribute("aria-expanded")) !== String(open)) await bar.click();
  await page.waitForFunction(
    (want) => {
      const aside = document.querySelector("#order-panels");
      return Boolean(aside) && (aside.offsetParent !== null) === want;
    },
    open,
    { timeout: WAIT },
  );
}

async function setKey(page) {
  await page.locator("[role=status]").first().getByRole("button", { name: "Add key" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible" });
  await dialog.locator("input[name=key]").fill(TEST_KEY);
  await dialog.getByRole("button", { name: "Use this key" }).click();
  await see(page, "Live: your key runs the AI cashier");
}

const NARRATION = (line) =>
  line.startsWith("Code ") ||
  line === "The customer is ordering…" ||
  line === "Next, the customer replies." ||
  line.includes("The AI cashier is answering") ||
  line.startsWith("The AI cashier is deciding") ||
  line.startsWith("A stronger AI model is planning");

/** Waits for a sample call to finish in real time, collecting the status lines it showed. */
async function playToEnd(page, timeout = CALL_TIMEOUT) {
  const narration = new Set();
  let planning = false;
  const deadline = Date.now() + timeout;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`the call did not finish within ${timeout / 1000}s`);
    const text = await bodyText(page);
    if (text.includes("Planning the group order")) planning = true;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (NARRATION(line)) narration.add(line);
    }
    if (text.includes("Sample call finished")) return { narration, planning };
    await page.waitForTimeout(250);
  }
}

/** The page background as sRGB bytes. A canvas turns any CSS colour (including oklch) into bytes. */
async function backgroundRgb(page) {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = getComputedStyle(document.body).backgroundColor;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b];
  });
}

function relativeLuminance([r, g, b]) {
  const [R, G, B] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

// Page 1: the first screen, the banner, the controls that need no call, and the key dialog.
async function firstScreen(browser, combo) {
  const { page, close } = await openPage(browser, combo);
  const F = (feature, fn) => check(combo, feature, page, fn);

  await F("F01 First screen: product name, one-line pitch, primary button above the fold", async () => {
    await see(page, "Talk to a cafe's AI cashier.");
    await see(page, "It answers out loud and fills your cart as you order.");
    if (!(await page.getByRole("heading", { name: "Order Up", level: 1 }).isVisible())) {
      throw new Error("the product name is not visible");
    }
    const box = await page.getByRole("button", { name: "Play a sample call" }).boundingBox();
    if (!box) throw new Error("the primary button is not on the page");
    const bottom = Math.round(box.y + box.height);
    if (bottom > combo.height) throw new Error(`primary button ends at ${bottom}px, below the fold`);
    return `primary button ends at ${bottom}px of ${combo.height}px`;
  });

  await F("F43 Microphone is not requested on load: no permission request and no recogniser start", async () => {
    await page.waitForTimeout(1_000);
    const requests = await page.evaluate(() => window.__mic);
    if (requests.length > 0) throw new Error(`the page asked for the microphone on load: ${requests.join(", ")}`);
    return "no getUserMedia or recogniser start in the first second after load";
  });

  await F("F02 Demo banner: one calm line saying the replies are pre-written, with an Add key link", async () => {
    await see(page, "Demo: the AI replies here are pre-written examples.");
    const banner = page.locator("[role=status]").first();
    if (!(await banner.getByRole("button", { name: "Add key" }).isVisible())) {
      throw new Error("no Add key button in the banner");
    }
    return "banner shows the pre-written line and Add key";
  });

  await F("F03 Theme toggle switches light and dark, and the page colours follow", async () => {
    const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
    if ((await theme()) !== combo.scheme) {
      throw new Error(`theme is ${await theme()}, expected ${combo.scheme} from the system setting`);
    }
    const first = await backgroundRgb(page);
    const other = combo.scheme === "light" ? "dark" : "light";
    await page.getByRole("button", { name: `Switch to ${other} theme` }).click();
    if ((await theme()) !== other) throw new Error(`theme did not become ${other}`);
    const second = await backgroundRgb(page);
    if (second.join() === first.join()) throw new Error("the page background did not change");
    const lum = relativeLuminance(second);
    if (other === "dark" && lum > 0.05) throw new Error(`dark background is too light (rgb ${second.join(",")})`);
    if (other === "light" && lum < 0.7) throw new Error(`light background is too dark (rgb ${second.join(",")})`);
    await page.getByRole("button", { name: `Switch to ${combo.scheme} theme` }).click();
    if ((await theme()) !== combo.scheme) throw new Error("the toggle did not switch back");
    return `background rgb(${first.join(",")}) -> rgb(${second.join(",")}), back again`;
  });

  await F("F04 Sound toggle flips its label and the welcome text", async () => {
    await page.getByRole("button", { name: "Sound is on. Turn sound off." }).click();
    await see(page, "Sound is off, so the call plays as on-screen captions. Turn it on at the top.");
    await page.getByRole("button", { name: "Sound is off. Turn sound on." }).click();
    await see(page, "Plays out loud, so turn your sound up.");
    return "on -> off -> on";
  });

  await F("F05 Keyboard: first Tab reaches the skip link, Enter moves to the content", async () => {
    // A reload resets the keyboard starting point, which earlier clicks had moved.
    await page.reload({ waitUntil: "networkidle" });
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => document.activeElement?.textContent?.trim());
    if (focused !== "Skip to content") throw new Error(`first Tab focused "${focused}"`);
    await page.keyboard.press("Enter");
    const hash = await page.evaluate(() => location.hash);
    if (hash !== "#main") throw new Error(`Enter left the hash at "${hash}"`);
    return "Tab -> Skip to content; Enter -> #main";
  });

  await F("F06 Typing needs a key: text box and Send are disabled, and the UI says why", async () => {
    const input = page.getByLabel("Type what you would say");
    if (!(await input.isDisabled())) throw new Error("the text box is enabled without a key");
    if (!(await page.getByRole("button", { name: "Send", exact: true }).isDisabled())) {
      throw new Error("Send is enabled without a key");
    }
    if ((await input.getAttribute("placeholder")) !== "Or type it (needs a key)") {
      throw new Error("the placeholder does not say a key is needed");
    }
    await see(page, "Talk or type. Needs your Anthropic API key.");
    return "input and Send disabled; 'Needs your Anthropic API key.' shown";
  });

  await F("F07 How the microphone works: visible on desktop, opened on a phone", async () => {
    if (combo.phone) {
      await unseen(page, "Chrome and Safari may send the audio to Google or Apple");
      await page.locator("summary", { hasText: "How the microphone works" }).click();
      await see(page, "Chrome and Safari may send the audio to Google or Apple");
      return "closed by default, opens on tap";
    }
    await see(page, "How the microphone works:");
    await see(page, "Chrome and Safari may send the audio to Google or Apple");
    return "shown without a tap";
  });

  await F("F08 Sample cards: the two other sample calls are listed", async () => {
    await see(page, "Changes and a sold-out item");
    await see(page, "A pushy customer, then a group order");
    return "both listed";
  });

  await F("F09 Kitchen: the rest of the menu expands; staff chips are disabled without a key", async () => {
    await cart(page, combo, true);
    const chips = page.getByRole("switch");
    const proteins = await chips.count();
    await page.getByText("The rest of the menu", { exact: true }).click();
    const all = await chips.count();
    if (all <= proteins) throw new Error(`expanding added no chips (${proteins} -> ${all})`);
    const enabled = await chips.evaluateAll((list) => list.filter((chip) => !chip.disabled).length);
    if (enabled !== 0) throw new Error(`${enabled} staff chips are enabled without a key`);
    await see(page, "with a key, you can try it.");
    await cart(page, combo, false);
    return `${proteins} protein chips, ${all} after expanding, all disabled`;
  });

  await F("F10 Microphone without a key opens the Add key dialog; Cancel closes it", async () => {
    await page.getByRole("button", { name: "Microphone: add your Anthropic API key to talk" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ state: "visible" });
    if (!(await dialog.getByRole("heading", { name: "Add your Anthropic key" }).isVisible())) {
      throw new Error("the dialog has no heading");
    }
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "hidden" });
    return "dialog opened and closed";
  });

  await F("F10b Add key beside the locked microphone opens the same dialog", async () => {
    await page.locator("main").getByRole("button", { name: "Add key", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ state: "visible" });
    if (!(await dialog.getByRole("heading", { name: "Add your Anthropic key" }).isVisible())) {
      throw new Error("the dialog has no heading");
    }
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "hidden" });
    return "dock Add key opened the dialog; Cancel closed it";
  });

  await F("F11 Add key dialog: a malformed key is refused; Escape closes the dialog", async () => {
    await page.locator("[role=status]").first().getByRole("button", { name: "Add key" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ state: "visible" });
    await dialog.locator("input[name=key]").fill("not-a-key");
    await dialog.getByRole("button", { name: "Use this key" }).click();
    const alert = await dialog.getByRole("alert").innerText();
    if (!alert.includes("Anthropic keys start with sk-ant-")) throw new Error(`alert says "${alert}"`);
    if (!(await dialog.isVisible())) throw new Error("the dialog closed on a bad key");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    return "refused with 'Anthropic keys start with sk-ant-'; Escape closed it";
  });

  await F("F11b Add key dialog: a click on the backdrop, outside the dialog, closes it", async () => {
    await page.locator("[role=status]").first().getByRole("button", { name: "Add key" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ state: "visible" });
    const box = await dialog.boundingBox();
    if (!box) throw new Error("the dialog has no box");
    if (box.x <= 2 || box.y <= 2) throw new Error("the dialog leaves no room outside it to click");
    await page.mouse.click(2, 2);
    await dialog.waitFor({ state: "hidden" });
    return "click at 2,2, outside the dialog, closed it";
  });

  await F("F12 Add key dialog: a key makes the banner live and Remove key goes back to demo", async () => {
    await page.locator("[role=status]").first().getByRole("button", { name: "Add key" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ state: "visible" });
    const link = await dialog.getByRole("link", { name: "Create a key" }).getAttribute("href");
    await dialog.locator("input[name=key]").fill(TEST_KEY);
    await dialog.getByLabel("Remember for this tab").check();
    await dialog.getByRole("button", { name: "Use this key" }).click();
    await dialog.waitFor({ state: "hidden" });
    await see(page, "Live: your key runs the AI cashier");
    const stored = await page.evaluate(() => sessionStorage.getItem("anthropic-key"));
    if (stored !== TEST_KEY) throw new Error("the remembered key is not in sessionStorage");
    await page.locator("[role=status]").first().getByRole("button", { name: "Change key" }).click();
    await dialog.waitFor({ state: "visible" });
    await dialog.getByRole("button", { name: "Remove key" }).click();
    await dialog.waitFor({ state: "hidden" });
    await see(page, "Demo: the AI replies here are pre-written examples.");
    const cleared = await page.evaluate(() => sessionStorage.getItem("anthropic-key"));
    if (cleared !== null) throw new Error("Remove key left the key in sessionStorage");
    return `'Create a key' links to ${link} (not clicked)`;
  });

  await F("F13 Keyboard: Enter on Play a sample call starts the call", async () => {
    await page.getByRole("button", { name: "Play a sample call" }).focus();
    await page.keyboard.press("Enter");
    await see(page, "Sample call · turn 1 of 4");
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await see(page, "Order yourself");
    return "Enter started turn 1 of 4; Stop ended it";
  });

  await close();
}

// Page 2: the quick order, played in real time with the fake voice.
async function quickCall(browser, combo) {
  const { page, close } = await openPage(browser, combo);
  const F = (feature, fn) => check(combo, feature, page, fn);
  let narration = new Set();

  await F("F14 Play a sample call (quick order) in real time: every line, reply, and the end state", async () => {
    await page.getByRole("button", { name: "Play a sample call" }).click();
    await see(page, "Sample call · turn 1 of 4");
    ({ narration } = await playToEnd(page));
    for (const line of QUICK) await see(page, line);
    await see(page, "One large carnitas burrito, no onions, with guacamole.");
    await see(page, "Counter Combo, so the register took $2.00 off.");
    await see(page, "Sample call finished");
    await see(page, "Play it again");
    await see(page, "Other sample calls");
    return "4 customer lines, the replies, and the finished state";
  });

  await F("F15 Narration: the status line says what is happening in plain words", async () => {
    const lines = [...narration];
    if (!lines.includes("The customer is ordering…")) throw new Error("never said the customer is ordering");
    const code = lines.find((line) => line.startsWith("Code "));
    if (!code) throw new Error("never narrated a code check");
    return `${lines.length} distinct status lines, e.g. "${code}"`;
  });

  await F("F16 Voice out: the call's sentences reach the browser's speech (fake voice)", async () => {
    const spoken = await page.evaluate(() => window.__spoken);
    if (!spoken.some((text) => text.includes("Hi, can I get a large carnitas burrito"))) {
      throw new Error("the customer's first line was never spoken");
    }
    if (!spoken.some((text) => text.includes("One large carnitas burrito, no onions, with guacamole"))) {
      throw new Error("the cashier's first sentence was never spoken");
    }
    return `${spoken.length} utterances, customer and cashier`;
  });

  await F("F17 Cart and receipt after the call: lines, combo discount, tax, total, pickup name", async () => {
    await cart(page, combo, true);
    for (const text of [
      "large carnitas burrito",
      "no onions, +guacamole",
      "regular horchata agua fresca",
      "chips and salsa",
      "Counter Combo",
      "-$2.00",
      "$21.25",
      "$1.49",
      "$20.74",
      "Order 534 placed for Dave",
    ]) {
      await see(page, text);
    }
    await cart(page, combo, false);
    return "subtotal $21.25, combo -$2.00, tax $1.49, total $20.74, order 534 for Dave";
  });

  await F("F17b Receipt says no payment was taken and nothing is cooked", async () => {
    await cart(page, combo, true);
    await see(page, "This is a demo: no payment was taken and nothing is being cooked.");
    await cart(page, combo, false);
    return "receipt note shown";
  });

  await F("F18 Price check line: every dollar amount the cashier said matches a code price", async () => {
    await cart(page, combo, true);
    await see(page, "Price check: every dollar amount the cashier said matches a price the code produced.");
    await cart(page, combo, false);
    return "line shown";
  });

  await F("F19 Response speed for a sample: stages named, and no milliseconds invented", async () => {
    await cart(page, combo, true);
    for (const stage of ["You stop talking", "AI starts replying", "First sentence ready", "Voice starts", "Reply complete"]) {
      await see(page, stage);
    }
    await see(page, "No times shown on purpose");
    const text = await bodyText(page);
    if (/\b\d+(?:\.\d+)?\s?ms\b/.test(text)) throw new Error("a millisecond figure is on screen for a sample reply");
    await cart(page, combo, false);
    return "five stages, sample note, no ms figures";
  });

  await F("F20 Phone cart bar: item count, placed, total; expands and collapses", async () => {
    if (!combo.phone) return NA;
    const bar = page.locator("button[aria-controls=order-panels]");
    const label = (await bar.innerText()).replace(/\s+/g, " ");
    if (!label.includes("3 items in cart") || !label.includes("placed") || !label.includes("$20.74")) {
      throw new Error(`bar says "${label}"`);
    }
    await cart(page, combo, true);
    if ((await bar.getAttribute("aria-expanded")) !== "true") throw new Error("bar did not expand");
    await cart(page, combo, false);
    if ((await bar.getAttribute("aria-expanded")) !== "false") throw new Error("bar did not collapse");
    return `"${label}", expands and collapses`;
  });

  await close();
}

// Page 3: stop, escape, the kitchen during a call, skip, replay, the group order, sound off, new call.
async function controls(browser, combo) {
  const { page, close } = await openPage(browser, combo);
  const F = (feature, fn) => check(combo, feature, page, fn);

  await F("F21 Stop ends a sample mid-call and keeps what was said", async () => {
    await page.getByRole("button", { name: "Play a sample call" }).click();
    await see(page, "Sample call · turn 2 of 4");
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await see(page, "Order yourself");
    await see(page, "Play it again");
    await page.waitForTimeout(6_000);
    await unseen(page, "That's it. It's for Dave.");
    return "stopped in turn 2; no later line appeared";
  });

  await F("F22 Escape stops a sample, and the staff chips say the script plays staff", async () => {
    await page.getByRole("button", { name: "Other sample calls" }).click();
    await see(page, "Talk to a cafe's AI cashier.");
    await page.getByRole("button", { name: /Changes and a sold-out item/ }).click();
    await see(page, "Sample call · turn 1 of 6");
    await cart(page, combo, true);
    await see(page, "In a sample call the script plays the staff. Watch what sells out.");
    const disabled = await page.getByRole("switch").evaluateAll((list) => list.every((chip) => chip.disabled));
    if (!disabled) throw new Error("a staff chip is enabled during a sample");
    await cart(page, combo, false);
    await page.keyboard.press("Escape");
    await see(page, "Order yourself");
    await unseen(page, "Sample call · turn");
    return "chips disabled during the sample; Escape ended it";
  });

  await F("F23 Other sample calls returns to the welcome screen", async () => {
    await page.getByRole("button", { name: "Other sample calls" }).click();
    await see(page, "Talk to a cafe's AI cashier.");
    // The heading is set in capitals with CSS, so the page text reads in capitals.
    await see(page, "TWO MORE SAMPLE CALLS");
    return "welcome screen back";
  });

  await F("F24 Play it again replays the call from the start", async () => {
    await page.getByRole("button", { name: "Play a sample call" }).click();
    await see(page, "Sample call · turn 1 of 4");
    await page.getByRole("button", { name: "Skip to end" }).click();
    await see(page, "Play it again");
    await page.getByRole("button", { name: "Play it again" }).click();
    await see(page, "Sample call · turn 1 of 4");
    const count = (await bodyText(page)).split(QUICK[0]).length - 1;
    if (count !== 1) throw new Error(`the first line appears ${count} times after a replay`);
    await page.getByRole("button", { name: "Skip to end" }).click();
    await see(page, "Sample call finished");
    return "one copy of the first line after replay";
  });

  await F("F25 Skip to end (changes): the kitchen sells out, the cart is corrected, the order is placed", async () => {
    await page.getByRole("button", { name: "Other sample calls" }).click();
    await page.getByRole("button", { name: /Changes and a sold-out item/ }).click();
    await page.getByRole("button", { name: "Skip to end" }).click();
    await see(page, "Play it again");
    // On a phone the captions are hidden while the cart is open, so the caption is read first.
    await see(page, "Carnitas just ran out.");
    await cart(page, combo, true);
    await see(page, "1 sold out");
    const carnitas = await page.getByRole("switch", { name: "Carnitas: out of stock" }).getAttribute("aria-checked");
    if (carnitas !== "false") throw new Error("the carnitas chip is not marked out of stock");
    await see(page, "steak quesadilla");
    await see(page, "$37.98");
    await see(page, "Order 745 placed for Priya");
    await unseen(page, "Cannot be made");
    await cart(page, combo, false);
    return "carnitas out, steak quesadilla instead, total $37.98, order 745";
  });

  await F("F26 Skip to end (group): planned six-person order, no discount, order placed", async () => {
    await page.getByRole("button", { name: "Other sample calls" }).click();
    await page.getByRole("button", { name: /A pushy customer, then a group order/ }).click();
    await page.getByRole("button", { name: "Skip to end" }).click();
    await see(page, "Play it again");
    await see(page, "We don't have lobster rolls, and I can't give anything away or change a price.");
    await see(page, "There's no discount I can apply.");
    // The plan card is in the captions, which a phone hides while the cart is open, so it is read first.
    await see(page, "Group plan P1");
    await see(page, "Total with tax (budget $60.00)");
    await see(page, "every line is a valid, in-stock menu item");
    await cart(page, combo, true);
    await unseen(page, "-$");
    await see(page, "$59.26");
    await see(page, "Order 578 placed for Sam");
    await cart(page, combo, false);
    return "plan P1 checked and priced at $59.26 of $60.00; no discount line";
  });

  await F("F27 Sound off: the call plays as captions only (nothing is spoken)", async () => {
    await page.getByRole("button", { name: "Other sample calls" }).click();
    await page.getByRole("button", { name: "Sound is on. Turn sound off." }).click();
    const before = await page.evaluate(() => window.__spoken.length);
    await page.getByRole("button", { name: "Play a sample call" }).click();
    await see(page, QUICK[0]);
    await page.waitForTimeout(8_000);
    const after = await page.evaluate(() => window.__spoken.length);
    if (after !== before) throw new Error(`${after - before} utterances were spoken with sound off`);
    await see(page, "Sample call · turn");
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await page.getByRole("button", { name: "Sound is off. Turn sound on." }).click();
    return "no speech with sound off; captions kept coming";
  });

  await F("F28 New call (header) clears the call and returns to the welcome screen", async () => {
    await page.getByRole("button", { name: "Start a new call" }).click();
    await see(page, "Talk to a cafe's AI cashier.");
    await see(page, "TWO MORE SAMPLE CALLS");
    if ((await page.getByRole("button", { name: "Start a new call" }).count()) !== 0) {
      throw new Error("the New call button is still shown after the reset");
    }
    await unseen(page, "Carnitas just ran out.");
    return "welcome back; New call button gone";
  });

  await close();
}

// Page 4: a live session against the stub. Nothing reaches the model.
async function liveSession(browser, combo) {
  const { page, keyed, close } = await openPage(browser, combo, { stub: STUBS.reply });
  const F = (feature, fn) => check(combo, feature, page, fn);
  await setKey(page);

  await F("F29 With a key: a kitchen change is queued for the next words, and no request is sent", async () => {
    await cart(page, combo, true);
    await page.getByRole("switch", { name: "Carnitas: in stock" }).click();
    if ((await page.getByRole("switch", { name: "Carnitas: out of stock" }).getAttribute("aria-checked")) !== "false") {
      throw new Error("the chip did not switch to out of stock");
    }
    await see(page, "1 change queued.");
    await page.getByRole("switch", { name: "Carnitas: out of stock" }).click();
    await unseen(page, "1 change queued.");
    await cart(page, combo, false);
    if (keyed.length !== 0) throw new Error(`${keyed.length} request(s) were sent by a kitchen toggle`);
    return "queued, cleared, and no request sent";
  });

  await F("F29b With a key: a chip under The rest of the menu queues a kitchen change the same way", async () => {
    const before = keyed.length;
    await cart(page, combo, true);
    await page.locator("summary", { hasText: "The rest of the menu" }).click();
    await page.getByRole("switch", { name: "Chips and Salsa: in stock" }).click();
    await see(page, "1 change queued.");
    await page.getByRole("switch", { name: "Chips and Salsa: out of stock" }).click();
    await unseen(page, "1 change queued.");
    await cart(page, combo, false);
    if (keyed.length !== before) throw new Error(`${keyed.length - before} request(s) were sent by a kitchen toggle`);
    return "Chips and Salsa queued and cleared; no request sent";
  });

  await F("F30 Typed request with a key: the queued kitchen change goes with it; the reply, cart, and tool line appear", async () => {
    await cart(page, combo, true);
    await page.getByRole("switch", { name: "Steak: in stock" }).click();
    await see(page, "1 change queued.");
    await cart(page, combo, false);
    await page.getByLabel("Type what you would say").fill("two chicken burritos and a horchata");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await see(page, "One large carnitas burrito, no onions, with guacamole.");
    await see(page, "added: large carnitas burrito, no onions, +guacamole");
    if (keyed.length !== 1) throw new Error(`expected 1 keyed request, saw ${keyed.length}`);
    const body = keyed[0];
    if (body.text !== "two chicken burritos and a horchata") throw new Error("the typed text was not sent");
    if (JSON.stringify(body.kitchen) !== JSON.stringify([{ id: "steak", inStock: false }])) {
      throw new Error(`kitchen change sent as ${JSON.stringify(body.kitchen)}`);
    }
    const value = await page.getByLabel("Type what you would say").inputValue();
    if (value !== "") throw new Error("the text box was not cleared after sending");
    await cart(page, combo, true);
    await see(page, "$15.35");
    await unseen(page, "1 change queued.");
    await cart(page, combo, false);
    return "request carried the text and the steak change; cart shows $15.35";
  });

  await F("F30b A sold-out item is refused by the order code and the cart does not change", async () => {
    await cart(page, combo, true);
    await page.getByRole("switch", { name: "Carnitas: in stock" }).click();
    await see(page, "1 change queued.");
    await cart(page, combo, false);
    await page.getByLabel("Type what you would say").fill("one more carnitas burrito");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    // The refusal is written to the Behind the scenes log, which is shown on desktop. On a phone the
    // captions come from the stub's canned events, which never include the refusal, so only the cart is checked.
    if (!combo.phone) {
      await see(page, "refused: carnitas is out of stock.");
      await see(page, "Refused by the order code:");
    }
    await cart(page, combo, true);
    await see(page, "$15.35");
    await cart(page, combo, false);
    // The stub's canned reply still says carnitas, so only the engine's refusal is asserted here.
    return combo.phone
      ? "cart still $15.35 (refusal log is desktop-only; not checked on a phone)"
      : "engine refused the carnitas line; cart still $15.35";
  });

  await F("F31 Barge-in: tapping the microphone while the cashier speaks cuts it off", async () => {
    await page.getByLabel("Type what you would say").fill("two burritos");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await see(page, "Tap or hold Space to interrupt.");
    await page.getByRole("button", { name: "Interrupt the agent" }).click();
    await see(page, "Cut off before it finished.");
    await see(page, "Listening");
    await page.keyboard.press("Escape");
    await see(page, "Tap to talk");
    return "cut off, listening, then Escape returned to idle";
  });

  await F("F32 Microphone tap and Space hold: listening states, and no empty request is sent", async () => {
    await page.evaluate(() => document.activeElement?.blur());
    const sentBefore = keyed.length;
    await page.getByRole("button", { name: "Start talking" }).click();
    await see(page, "Tap again, or let go of Space, when you are done.");
    await page.getByRole("button", { name: "Stop listening and send" }).click();
    await page.waitForTimeout(1_500);
    await unseen(page, "Listening");
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.down("Space");
    await see(page, "Listening");
    await page.keyboard.up("Space");
    await page.waitForTimeout(1_500);
    await unseen(page, "Listening");
    if (keyed.length !== sentBefore) throw new Error(`${keyed.length - sentBefore} empty request(s) were sent`);
    return "tap and Space both enter and leave listening; nothing sent";
  });

  await F("F33 Live timeline and cost after a reply: stage rows, and the cost line for this run", async () => {
    await cart(page, combo, true);
    await see(page, "Last live reply");
    await see(page, "AI starts replying");
    await see(page, "Reply complete");
    await cart(page, combo, false);
    await see(page, "This run:");
    return "live reply timeline shown; cost line for this run shown";
  });

  await F("F33b Tokens and cost table: the cashier, its model, and the token and cost columns", async () => {
    await cart(page, combo, true);
    await page.locator("summary", { hasText: "Tokens and cost, by AI model" }).click();
    await see(page, "Tokens are the small chunks of text an AI model reads and writes");
    const table = page.locator("table").filter({ hasText: "Cashier (fast model)" });
    if ((await table.count()) !== 1) throw new Error("no per-model table for the reply");
    const heads = await table.locator("thead th").allInnerTexts();
    const wanted = ["Model", "Read", "Reused", "Written", "Cost"];
    if (heads.join("|") !== wanted.join("|")) throw new Error(`table columns are ${heads.join(", ")}`);
    const text = await table.innerText();
    if (!text.includes("claude-haiku-5-5")) throw new Error("the table does not name the model");
    await cart(page, combo, false);
    return "Cashier (fast model) claude-haiku-5-5 with Model, Read, Reused, Written, Cost";
  });

  await F("F34 New call from the header clears a live call", async () => {
    await page.getByRole("button", { name: "Start a new call" }).click();
    await see(page, "Talk to a cafe's AI cashier.");
    await unseen(page, "AI CASHIER");
    return "welcome back";
  });

  await F("F35 With a key set, sample calls still replay the fixtures and never send the key", async () => {
    const before = keyed.length;
    await page.getByRole("button", { name: "Play a sample call" }).click();
    await see(page, "Sample call · turn 1 of 4");
    await page.getByRole("button", { name: "Skip to end" }).click();
    // With a key the finished sample offers a fresh call rather than a replay.
    await see(page, "That was a sample.");
    // The "your own call" line is hidden on phones (sm:inline), so it is checked on wider screens only.
    if (!combo.phone) await see(page, "Your own call starts fresh.");
    if (keyed.length !== before) throw new Error(`${keyed.length - before} keyed request(s) during a sample`);
    return "sample finished from fixtures; no keyed request";
  });

  await close();
}

// Pages that answer the request with a single error: each checks the copy and the way out.
async function errorStates(browser, combo) {
  const F = (page, feature, fn) => check(combo, feature, page, fn);

  {
    const { page, close } = await openPage(browser, combo, { stub: STUBS.slowReply });
    await setKey(page);
    await F(page, "F36 Stop while the cashier is thinking cancels the reply", async () => {
      await page.getByLabel("Type what you would say").fill("two burritos");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await see(page, "Thinking");
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await see(page, "Tap to talk");
      await page.waitForTimeout(6_000);
      if ((await bodyText(page)).includes("One large carnitas burrito")) throw new Error("the reply still arrived after Stop");
      await see(page, "two burritos");
      return "Stop returned to idle; the late reply never appeared";
    });
    await close();
  }

  {
    const { page, close } = await openPage(browser, combo, { stub: STUBS.refusal, allowHttp: true });
    await setKey(page);
    await F(page, "F37 A refusal says so and adds nothing to the order", async () => {
      await page.getByLabel("Type what you would say").fill("something rude");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await see(page, "Claude declined that one");
      await see(page, "Nothing was added to the order. Say it another way and carry on.");
      return "refusal copy shown; the call carries on";
    });
    await close();
  }

  {
    const { page, close } = await openPage(browser, combo, { stub: STUBS.auth, allowHttp: true });
    await setKey(page);
    await F(page, "F38 A rejected key says so and opens the Add key dialog", async () => {
      await page.getByLabel("Type what you would say").fill("hello");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await see(page, "There is a problem with your key");
      await page.getByRole("button", { name: "Check your key" }).click();
      await page.getByRole("dialog").waitFor({ state: "visible" });
      return "auth copy shown; dialog opened";
    });
    await close();
  }

  {
    const { page, close } = await openPage(browser, combo, { stub: STUBS.demoMiss, allowHttp: true });
    await setKey(page);
    await F(page, "F39 A demo-only refusal asks for a key and opens the Add key dialog", async () => {
      await page.getByLabel("Type what you would say").fill("hello");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await see(page, "That needs a key");
      await page.getByRole("button", { name: "Add your key" }).click();
      await page.getByRole("dialog").waitFor({ state: "visible" });
      return "copy shown; dialog opened";
    });
    await close();
  }
}

// Desktop-light only: a voice that never starts must make the app say so and carry on with captions.
async function voiceFallback(browser, combo) {
  const { page, close } = await openPage(browser, combo, { voice: "dead" });
  await check(combo, "F40 A voice that never starts: the app says replies are captions only, and the call goes on", page, async () => {
    await page.getByRole("button", { name: "Play a sample call" }).click();
    await see(page, QUICK[0]);
    await see(page, "its voice is not making sound, so replies are captions only.");
    await see(page, "One large carnitas burrito, no onions, with guacamole.");
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    return "fallback message shown after the voice failed; captions kept coming";
  });
  await close();
}

// Desktop-light only: the two longer sample calls played in real time, with the planning step shown.
async function longCalls(browser, combo) {
  const { page, close } = await openPage(browser, combo);
  const F = (feature, fn) => check(combo, feature, page, fn);

  await F("F41 Sample 'changes' plays end to end in real time, with the kitchen sell-out on screen", async () => {
    await page.getByRole("button", { name: /Changes and a sold-out item/ }).click();
    const { narration } = await playToEnd(page);
    await see(page, "Carnitas just ran out.");
    await see(page, "Order 745 placed for Priya");
    if (narration.size < 3) throw new Error(`only ${narration.size} status line(s) shown`);
    return `${CHANGES.length} customer lines; ${narration.size} status lines`;
  });

  await F("F42 Sample 'group' plays end to end in real time, with the Opus planning step shown", async () => {
    await page.getByRole("button", { name: "Other sample calls" }).click();
    await page.getByRole("button", { name: /A pushy customer, then a group order/ }).click();
    const { planning } = await playToEnd(page);
    if (!planning) throw new Error("the planning step was never shown");
    await see(page, "Order 578 placed for Sam");
    await see(page, "Group plan P1");
    return "planning step shown; order 578 placed";
  });

  await close();
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const started = Date.now();
  try {
    for (const combo of COMBOS) {
      if (ONLY && !ONLY.has(combo.id)) continue;
      console.log(`\n== ${combo.id} (${combo.width}x${combo.height}, ${combo.scheme})`);
      await firstScreen(browser, combo);
      await quickCall(browser, combo);
      await controls(browser, combo);
      await liveSession(browser, combo);
      await errorStates(browser, combo);
      if (combo.id === "desktop-light") {
        await voiceFallback(browser, combo);
        await longCalls(browser, combo);
      }
      const errors = pageErrors.get(combo.id) ?? [];
      record(
        combo,
        "F00 No console errors or page errors during the checks",
        errors.length === 0 ? "PASS" : "FAIL",
        errors.length === 0 ? "" : `${errors.length}: ${errors[0]}`,
      );
      if (combo.phone) {
        const count = layoutProblems.get(combo.id) ?? 0;
        record(
          combo,
          "F00b No horizontal scroll at 390px after each step",
          count === 0 ? "PASS" : "FAIL",
          count === 0 ? "" : `${count} step(s) overflowed`,
        );
      }
    }
  } finally {
    await browser.close();
  }

  // Report
  let failures = 0;
  for (const [feature, perCombo] of results) {
    const parts = COMBOS.map((combo) => {
      const entry = perCombo.get(combo.id);
      if (!entry) return `${combo.id}:-`;
      if (entry.status === "FAIL") failures++;
      return `${combo.id}:${entry.status}`;
    });
    console.log(`${feature}\n    ${parts.join("  ")}`);
    for (const combo of COMBOS) {
      const entry = perCombo.get(combo.id);
      if (entry?.status === "FAIL") console.log(`    FAIL ${combo.id}: ${entry.detail}`);
    }
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  const total = [...results.values()].reduce((sum, m) => sum + m.size, 0);
  const passed = [...results.values()].reduce(
    (sum, m) => sum + [...m.values()].filter((e) => e.status === "PASS").length,
    0,
  );
  console.log(`\nRESULT: ${passed} passed, ${failures} failed, ${total - passed - failures} n/a, in ${seconds}s`);
  if (process.env.FUNCTIONAL_REPORT) {
    const report = Object.fromEntries(
      [...results].map(([feature, perCombo]) => [feature, Object.fromEntries(perCombo)]),
    );
    writeFileSync(process.env.FUNCTIONAL_REPORT, JSON.stringify(report, null, 2));
  }
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
