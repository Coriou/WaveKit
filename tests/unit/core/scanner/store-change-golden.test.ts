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
// such sighting in this run now joins the nearest same-family record instead (seed 1 o39, seed 7 o296, seed 42 o343).
// WG17 DM integration re-baseline: checked synthetic decodes explicitly persist
// contentVerified:true on M.payload.observations[].decode / S.observations[].decode.
// Stored discovery provenance also survives observation trimming: the same field
// appears on M.payload.discoveries[], S.discoveries[] and internal E[] eviction copies.
// Example decode fragment: {"crcClean":true,"identity":{"kind":"dmr-cc","value":"1"}}
// -> {"contentVerified":true,"crcClean":true,"identity":{"kind":"dmr-cc","value":"1"}}.
// Example stored discovery fragment: {"identity":{"kind":"dmr-cc","value":"1"}}
// -> {"identity":{"kind":"dmr-cc","value":"1"},"contentVerified":true}.
// The initial integration only added these provenance fields.
// WG17 DM task 9: seeds 1 and 42 now discard saved talkgroups on DMR records
// lacking contentVerified before a merge can promote them. The only semantic
// differences are metadata.talkgroups in M/S records and their R copies:
// seed 1 ["1"] -> []; seed 42 ["1", "5", "4"] -> [] and later
// ["5", "4", "1", "3"] -> ["1", "3"]. Identities, proof, association,
// confidence, events and every other field remain unchanged; seed 7 is unchanged.
const DIR = join(import.meta.dirname, "__goldens__")
const CASES: { seed: number; steps: number; slots?: number }[] = [
	{ seed: 1, steps: 700 },
	{ seed: 7, steps: 700 },
	{ seed: 42, steps: 900 },
]

describe("discovery store goldens (WG11 SC)", () => {
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
