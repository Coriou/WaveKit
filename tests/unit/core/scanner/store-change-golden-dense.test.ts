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
// WG17 DM integration re-baseline: checked synthetic decodes explicitly persist
// contentVerified:true on M.payload.observations[].decode / S.observations[].decode.
// Stored discovery provenance also survives observation trimming: the same field
// appears on M.payload.discoveries[], S.discoveries[] and internal E[] eviction copies.
// Example decode fragment: {"crcClean":true,"identity":{"kind":"dmr-cc","value":"1"}}
// -> {"contentVerified":true,"crcClean":true,"identity":{"kind":"dmr-cc","value":"1"}}.
// Example stored discovery fragment: {"identity":{"kind":"dmr-cc","value":"1"}}
// -> {"identity":{"kind":"dmr-cc","value":"1"},"contentVerified":true}.
// Only these added fields differ semantically: no unverifiedCc/tgSrcVerified,
// identity, confidence, metadata, association, R return value or C event changes.
// Task 10: 125 lines between 2738 and 3648 add only contentVerified:true,
// preserving checked provenance through a rekey merge. All other fields are unchanged.
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
