import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { gunzipSync, gzipSync } from "node:zlib"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { runGolden } from "./__goldens__/store-golden-driver.js"

// WG11 lane SC (req 3.4, 3.5): the goldens were recorded from the frozen store (before the index,
// counts and revision-counter rework). Every journal line, change event, evicted list, return
// value and snapshot text must stay byte-identical.
// WG15 DQ 9.3 re-baseline: an evidence-less sighting no longer reaches a decoded record of another
// family beyond 1 000 Hz or outside its band (decoded-record shortcut and key fallback), so the first
// such sighting in this run now joins the nearest same-family record instead (seed 5 o1261).
const DIR = join(import.meta.dirname, "__goldens__")
const CASES: { seed: number; steps: number; slots?: number }[] = [
	{ seed: 5, steps: 1400, slots: 2 },
]

describe("discovery store goldens, dense (WG11 SC)", () => {
	for (const { seed, steps, slots } of CASES)
		it(
			`seed ${seed}: journal lines, events and snapshot texts are unchanged`,
			{ timeout: 30_000 },
			() => {
				const run = runGolden(seed, steps, slots)
				const text = `${[...run.lines, ...run.snapshots.map(s => `S ${s}`)].join("\n")}\n`
				const file = join(DIR, `store-seed-${seed}.txt.gz`)
				if (process.env["RECORD_STORE_GOLDENS"] === "1") {
					mkdirSync(DIR, { recursive: true })
					writeFileSync(file, gzipSync(text, { level: 9 }))
				}
				expect(existsSync(file)).toBe(true)
				const golden = gunzipSync(readFileSync(file)).toString("utf8")
				expect(text.length).toBe(golden.length)
				expect(text === golden).toBe(true)
			},
		)
})
