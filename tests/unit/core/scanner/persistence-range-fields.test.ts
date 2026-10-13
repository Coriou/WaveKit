import type * as FsPromises from "node:fs/promises"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { ScanRangeLive } from "../../../../src/core/scanner/plan/range-contract.js"
import { ScannerPersistence } from "../../../../src/core/scanner/store/persistence.js"
import type { PersistedJob } from "../../../../src/core/scanner/store/persistence.js"
import type {
	ScannerProtocol,
	ScanRange,
} from "../../../../src/core/scanner/types.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { makeNormalisedSpec } from "../../../mocks/scanner/job-spec.js"

/**
 * Durability is not under test here; the property writes jobs.json once per run and the fsync of
 * each atomic write would dominate. The write still goes through tmp file and rename.
 */
vi.mock("node:fs/promises", async importOriginal => {
	const fs = await importOriginal<typeof FsPromises>()
	const open: typeof fs.open = async (...args) => {
		const handle = await fs.open(...args)
		handle.sync = () => Promise.resolve()
		return handle
	}
	return { ...fs, default: { ...fs, open }, open }
})

const logger = createLogger({ level: "fatal" })
const T0 = Date.UTC(2026, 9, 13, 12, 0, 0)

let dir = ""
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "wavekit-scanner-sf1-"))
})
afterAll(async () => {
	await rm(dir, { recursive: true, force: true })
})

const protocols: ScannerProtocol[] = ["analog-fm", "dmr", "pocsag", "ysf"]

const liveArb: fc.Arbitrary<ScanRangeLive> = fc
	.record(
		{
			enabled: fc.boolean(),
			protocols: fc.uniqueArray(fc.constantFrom(...protocols), {
				maxLength: 3,
			}),
			name: fc.string({ maxLength: 100 }),
			dwellMs: fc.integer({ min: 0, max: 10_000 }),
			sensitivity: fc.constantFrom(
				"low" as const,
				"normal" as const,
				"high" as const,
			),
		},
		{ requiredKeys: [] },
	)
	// fc.record without required keys builds null-prototype objects; JSON gives plain ones
	.map(live => ({ ...live }))

const rangeArb: fc.Arbitrary<ScanRange> = fc
	.tuple(
		fc.integer({ min: 400_000, max: 469_000 }),
		fc.integer({ min: 1, max: 1_000 }),
		liveArb,
		fc.option(fc.constant("pmr446"), { nil: undefined }),
	)
	.map(([startKHz, widthKHz, live, bandplanId]) => ({
		startHz: startKHz * 1_000,
		endHz: (startKHz + widthKHz) * 1_000,
		rasters: [{ spacingHz: 12_500, firstChannelHz: startKHz * 1_000 + 6_250 }],
		obwHz: [9_000],
		...(bandplanId !== undefined ? { bandplanId } : {}),
		...live,
	}))

const jobArb: fc.Arbitrary<PersistedJob> = fc
	.tuple(
		fc.array(rangeArb, { minLength: 1, maxLength: 4 }),
		fc.option(fc.boolean(), { nil: undefined }),
		fc.option(fc.array(liveArb, { maxLength: 4 }), { nil: undefined }),
		fc.constantFrom(
			{ state: "running" as const },
			{ state: "paused" as const, reason: "operator" as const },
			{ state: "paused" as const, reason: "preempted-job" as const },
		),
	)
	.map(([ranges, signalsOnly, rangeLive, state]) => ({
		id: "j_sf1",
		spec: makeNormalisedSpec({
			ranges,
			...(signalsOnly !== undefined ? { signalsOnly } : {}),
		}),
		rawSpec: {
			name: "SF1 sweep",
			mode: "sweep" as const,
			ranges: ranges.map(r => ({ startHz: r.startHz, endHz: r.endHz })),
			...(signalsOnly !== undefined ? { signalsOnly } : {}),
			...(rangeLive !== undefined ? { rangeLive } : {}),
		},
		...state,
		createdAt: new Date(T0).toISOString(),
		updatedAt: new Date(T0 + 1_000).toISOString(),
	}))

describe("ScannerPersistence SF1 fields (scanner-followups req 6)", () => {
	// Feature: scanner-followups, Property 10: Persistence round trip
	// Validates: Requirements 6.1, 6.3
	it("round-trips range fields, signalsOnly and rangeLive unchanged", async () => {
		await fc.assert(
			fc.asyncProperty(jobArb, async job => {
				await new ScannerPersistence({ dir, logger, now: () => T0 }).writeJobs([
					job,
				])
				const loaded = await new ScannerPersistence({
					dir,
					logger,
					now: () => T0,
				}).loadConfig()
				expect(loaded.jobs).toStrictEqual([job])
			}),
			{ numRuns: 100 },
		)
	})

	// Feature: scanner-followups, Property 10: Persistence round trip
	// Validates: Requirements 6.2
	it("loads a jobs file written before SF1 exactly as before, with no new keys", async () => {
		const old = {
			id: "j_old",
			spec: makeNormalisedSpec(),
			rawSpec: {
				name: "UHF sweep",
				mode: "sweep",
				ranges: [{ startHz: 400_000_000, endHz: 470_000_000 }],
			},
			state: "paused",
			reason: "core-restart",
			createdAt: new Date(T0).toISOString(),
			updatedAt: new Date(T0 + 1_000).toISOString(),
		}
		await writeFile(
			join(dir, "jobs.json"),
			JSON.stringify({ version: 1, jobs: [old] }),
		)
		const loaded = await new ScannerPersistence({
			dir,
			logger,
			now: () => T0,
		}).loadConfig()
		expect(loaded.jobs).toStrictEqual([old])
		const [job] = loaded.jobs
		expect(job?.spec).not.toHaveProperty("signalsOnly")
		expect(job?.rawSpec).not.toHaveProperty("rangeLive")
		for (const range of job?.spec.ranges ?? [])
			for (const key of ["enabled", "name", "dwellMs", "sensitivity"])
				expect(range).not.toHaveProperty(key)
	})
})
