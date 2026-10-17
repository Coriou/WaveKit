import { afterEach, expect, it, vi } from "vitest"
import fc from "fast-check"

import type { RecordingProtection } from "../../../src/core/recordings/contract.js"

/**
 * In-memory filesystem behind node:fs `promises` (the only fs surface the pruner uses). Every
 * awaited fs call first runs the interleaved operations queued for that step, so Keep, unkeep
 * and delete land between the pruner's list, stat and unlink.
 */
const mem = vi.hoisted(() => {
	const state = {
		files: new Map<string, { size: number; mtimeMs: number }>(),
		between: [] as Array<() => void>,
		onUnlink: (_name: string): void => {},
	}
	const base = (p: string): string => p.slice(p.lastIndexOf("/") + 1)
	const step = async (): Promise<void> => {
		await Promise.resolve()
		state.between.shift()?.()
	}
	const enoent = (): Error =>
		Object.assign(new Error("ENOENT"), { code: "ENOENT" })
	const promises = {
		readdir: async (): Promise<string[]> => {
			await step()
			return [...state.files.keys()]
		},
		stat: async (p: string) => {
			await step()
			const f = state.files.get(base(p))
			if (!f) throw enoent()
			return { isFile: () => true, size: f.size, mtimeMs: f.mtimeMs }
		},
		unlink: async (p: string): Promise<void> => {
			const name = base(p)
			state.onUnlink(name)
			if (!state.files.delete(name)) throw enoent()
			await step()
		},
	}
	return { state, promises }
})

vi.mock("node:fs", () => ({
	promises: mem.promises,
	default: { promises: mem.promises },
}))

const { pruneCallRecordings, setCallRecordingProtection } =
	await import("../../../src/decoders/builtin/call-recordings.js")

const NOW = 1_800_000_000_000
const nameOf = (i: number): string =>
	`20261001_0101${String(i).padStart(2, "0")}_${String(i).padStart(5, "0")}_1_GROUP_TGT_9_SRC_${i}.wav`

interface Small {
	t: "keep" | "unkeep"
	i: number
}
interface Prune {
	t: "prune"
	mb: number
	during: Small[]
}
type Op =
	| { t: "keep"; i: number }
	| { t: "unkeep"; i: number }
	| { t: "delete"; i: number }
	| { t: "fail" }
	| { t: "recover" }
	| Prune

afterEach(() => {
	setCallRecordingProtection(null)
	mem.state.files.clear()
	mem.state.between = []
})

// Feature: web-gaps-9, Property 4: No owner deletes a kept file
// Validates: Requirements 2.5, 2.7, 2.8
it("no interleaving of keep, unkeep, delete, store failure and pruner runs unlinks a kept file", async () => {
	const idx = fc.integer({ min: 0, max: 7 })
	const small = fc.record({
		t: fc.constantFrom("keep" as const, "unkeep" as const),
		i: idx,
	})
	const op: fc.Arbitrary<Op> = fc.oneof(
		fc.record({ t: fc.constant("keep" as const), i: idx }),
		fc.record({ t: fc.constant("unkeep" as const), i: idx }),
		fc.record({ t: fc.constant("delete" as const), i: idx }),
		fc.record({ t: fc.constant("fail" as const) }),
		fc.record({ t: fc.constant("recover" as const) }),
		fc.record({
			t: fc.constant("prune" as const),
			mb: fc.constantFrom(0, 0.001, 0.01, 1),
			during: fc.array(small, { maxLength: 6 }),
		}),
	)
	await fc.assert(
		fc.asyncProperty(
			fc.array(
				fc.record({
					size: fc.integer({ min: 1, max: 4000 }),
					ageH: fc.integer({ min: 0, max: 400 }),
				}),
				{ minLength: 1, maxLength: 8 },
			),
			fc.array(op, { maxLength: 12 }),
			async (recordings, ops) => {
				mem.state.files.clear()
				mem.state.between = []
				recordings.forEach((r, i) =>
					mem.state.files.set(nameOf(i), {
						size: r.size,
						mtimeMs: NOW - r.ageH * 3_600_000 - 20_000,
					}),
				)
				// Fake keep store: kept names, plus a failed state that protects everything.
				const kept = new Set<string>()
				let ready = true
				const protection: RecordingProtection = {
					isProtected: () => true,
					isDsdFmeFileProtected: n => !ready || kept.has(n),
					isScannerFileProtected: () => true,
					discoveryHoldsKept: () => true,
				}
				setCallRecordingProtection(protection)
				const violations: string[] = []
				mem.state.onUnlink = n => {
					if (kept.has(n) || !ready) violations.push(n)
				}
				const apply = (o: { t: "keep" | "unkeep"; i: number }): void => {
					if (!ready) return // store failed: Keep and unkeep answer 503
					if (o.t === "keep" && mem.state.files.has(nameOf(o.i)))
						kept.add(nameOf(o.i))
					if (o.t === "unkeep") kept.delete(nameOf(o.i))
				}
				for (const o of ops) {
					if (o.t === "keep" || o.t === "unkeep") apply(o)
					else if (o.t === "fail") ready = false
					else if (o.t === "recover") ready = true
					else if (o.t === "delete") {
						// Explicit delete consults the same decision (kept -> 409, failed -> 503).
						const n = nameOf(o.i)
						if (!protection.isDsdFmeFileProtected(n)) mem.state.files.delete(n)
					} else {
						mem.state.between = o.during.map(d => () => apply(d))
						await pruneCallRecordings(
							["/rec"],
							{ maxTotalMb: o.mb, maxAgeHours: 24 },
							NOW,
						)
						mem.state.between = []
					}
				}
				expect(violations).toEqual([])
				for (const n of kept) {
					if (
						recordings[Number(/_SRC_(\d+)\.wav$/.exec(n)?.[1])] !== undefined
					) {
						expect(mem.state.files.has(n)).toBe(true)
					}
				}
			},
		),
		{ numRuns: 200 },
	)
})
