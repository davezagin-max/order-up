/**
 * `pnpm fixtures` runs this file with WRITE_FIXTURES=1 to regenerate the
 * placeholder fixtures and the preset list. Without the flag it does nothing,
 * so it is safe in the normal test run. The checks live in fixtures.test.ts.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPresets, buildSampleFixtures, type TurnFixtureStore } from "@/fixtures/build";

const write = process.env.WRITE_FIXTURES === "1";

describe.runIf(write)("write placeholder fixtures", () => {
  it("rewrites placeholders and keeps recorded runs", async () => {
    const file = path.join(process.cwd(), "fixtures", "turn.json");
    let current: TurnFixtureStore = {};
    try {
      current = JSON.parse(await readFile(file, "utf8")) as TurnFixtureStore;
    } catch {
      // First build.
    }
    const built = await buildSampleFixtures();
    // A real recording is never overwritten by a hand-written sample.
    const merged = Object.fromEntries(
      Object.entries(built)
        .map(
          ([key, fixture]) =>
            [key, current[key]?.placeholder === false ? current[key] : fixture] as const,
        )
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    await writeFile(file, `${JSON.stringify(merged, null, 2)}\n`);
    await writeFile(
      path.join(process.cwd(), "fixtures", "presets.json"),
      `${JSON.stringify(buildPresets(), null, 2)}\n`,
    );
    expect(Object.keys(merged).length).toBeGreaterThan(0);
  });
});
