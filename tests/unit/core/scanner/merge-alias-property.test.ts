import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	RecordingAliasTable,
	holdsKeptWithAliases,
	withAliasFolders,
} from "../../../../src/core/scanner/recording-aliases.js"
import { DISCOVERY_RECORDING_ALIASES_MAX } from "../../../../src/core/recordings/contract.js"

const S = "d_SURVIVOR"

describe("merge aliases (WG10)", () => {
	// Feature: web-gaps-10, Property 2: Aliases keep meaning
	// Validates: Requirements 1.5, 1.6
	it("retention, holdsKept and removal read exactly the survivor's aliases", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						// aliases the dropped discovery had adopted itself before this merge
						own: fc.integer({ min: 0, max: 3 }),
						keptFolder: fc.boolean(),
						keptOwn: fc.array(fc.boolean(), { maxLength: 3 }),
					}),
					{ maxLength: 70 },
				),
				fc.boolean(),
				(merges, operatorKeep) => {
					const table = new RecordingAliasTable()
					const kept = new Set<string>()
					const expected: string[] = []
					let n = 0
					for (const m of merges) {
						const drop = `d_D${n++}`
						const own: string[] = []
						for (let i = 0; i < m.own; i++) {
							const sub = `d_D${n++}`
							own.push(sub)
							table.adopt(drop, sub)
							if (m.keptOwn[i] === true) kept.add(sub)
						}
						if (m.keptFolder) kept.add(drop)
						table.adopt(S, drop)
						expected.push(...own, drop)
						while (expected.length > DISCOVERY_RECORDING_ALIASES_MAX)
							expected.shift()
					}
					const aliases = table.aliasesOf(S)
					expect([...aliases]).toEqual(expected)
					for (const a of aliases) expect(table.aliasOwner(a)).toBe(S)
					// released aliases are orphans: no owner
					for (let i = 0; i < n; i++) {
						const id = `d_D${i}`
						if (!expected.includes(id))
							expect(table.aliasOwner(id)).toBeUndefined()
					}
					const port = { discoveryHoldsKept: (id: string) => kept.has(id) }
					const holds = holdsKeptWithAliases(port, id => table.aliasesOf(id), S)
					expect(holds).toBe(aliases.some(a => kept.has(a)))
					// retention: an operator keep of S protects every alias folder
					const keep = withAliasFolders(new Set(operatorKeep ? [S] : []), id =>
						table.aliasesOf(id),
					)
					for (const a of aliases) expect(keep.has(a)).toBe(operatorKeep)
					// removal: none when held, otherwise exactly S and its aliases
					const removed = holds ? [] : [S, ...aliases]
					expect(removed.length).toBe(holds ? 0 : 1 + expected.length)
					for (const id of removed) expect(kept.has(id)).toBe(false)
				},
			),
			{ numRuns: 200 },
		)
	})
})
