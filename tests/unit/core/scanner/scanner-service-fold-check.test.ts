// Detection quality requirement 10.3: the service-side evidence check that lets the fragment pass
// merge away or retire a record.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ScannerCapture } from "@wavekit/api-types"
import type { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { TrialMemory } from "../../../../src/core/scanner/trial-memory.js"
import type { Raster } from "../../../../src/core/spectrum/types.js"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"
import { fragmentSnapshot, RASTER, ch } from "./fragment-retirement-fixtures.js"

interface Internal {
	storageDir: string
	store: DiscoveryStore
	captures: { list(): ScannerCapture[] }
	trialMemory: TrialMemory
	foldCheck(): (discoveryId: string) => boolean
	maintenance(): Promise<void>
}

const harnesses: ReturnType<typeof serviceHarness>[] = []

async function boot(): Promise<{
	h: ReturnType<typeof serviceHarness>
	internal: Internal
}> {
	const h = serviceHarness({ patch: s => void (s.passive.enabled = false) })
	harnesses.push(h)
	await h.service.start()
	return { h, internal: h.service as unknown as Internal }
}

afterEach(async () => {
	vi.restoreAllMocks()
	for (const h of harnesses.splice(0)) {
		await h.service.stop()
		await rm(h.dir, { recursive: true, force: true })
	}
})

const capture = (discoveryId: string): ScannerCapture =>
	({ id: "c_1", discoveryId }) as unknown as ScannerCapture

/** The record `d_frag` with alias `d_old`, or no alias. */
function withAlias(internal: Internal, alias: boolean): void {
	vi.spyOn(internal.store, "aliasesOf").mockImplementation(id =>
		alias && id === "d_frag" ? ["d_old"] : [],
	)
}

describe("fold check (DQ 10.3)", () => {
	it("allows a record when nothing holds evidence for it", async () => {
		const { internal } = await boot()
		withAlias(internal, true)
		expect(internal.foldCheck()("d_frag")).toBe(true)
	})

	for (const alias of [false, true]) {
		const target = alias ? "d_old" : "d_frag"
		const on = alias ? " on an alias" : ""

		it(`refuses an evidence folder${on}`, async () => {
			const { internal } = await boot()
			withAlias(internal, alias)
			mkdirSync(join(internal.storageDir, "evidence", target), {
				recursive: true,
			})
			expect(internal.foldCheck()("d_frag")).toBe(false)
		})

		it(`refuses a capture naming the id${on}`, async () => {
			const { internal } = await boot()
			withAlias(internal, alias)
			vi.spyOn(internal.captures, "list").mockReturnValue([capture(target)])
			expect(internal.foldCheck()("d_frag")).toBe(false)
		})

		it(`refuses a remembered trial${on}`, async () => {
			const { internal } = await boot()
			withAlias(internal, alias)
			expect(
				internal.trialMemory.record(target, "dmr", "dsd-fme", "decoded"),
			).toBe(true)
			expect(internal.foldCheck()("d_frag")).toBe(false)
		})

		for (const kind of ["dv", "analog"])
			it(`refuses a ${kind} recording folder${on}`, async () => {
				const { internal } = await boot()
				withAlias(internal, alias)
				mkdirSync(join(internal.storageDir, "recordings", kind, target), {
					recursive: true,
				})
				expect(internal.foldCheck()("d_frag")).toBe(false)
			})
	}

	it.skipIf(process.getuid?.() === 0)(
		"refuses when the evidence folder cannot be checked (EACCES fails closed)",
		async () => {
			const { internal } = await boot()
			withAlias(internal, false)
			const parent = join(internal.storageDir, "evidence")
			mkdirSync(parent, { recursive: true })
			chmodSync(parent, 0o000)
			try {
				expect(internal.foldCheck()("d_frag")).toBe(false)
			} finally {
				chmodSync(parent, 0o755)
			}
			// Restored: the same record with nothing on disk is allowed again.
			expect(internal.foldCheck()("d_frag")).toBe(true)
		},
	)
})

describe("maintenance folds clean fragments only (DQ 10.3)", () => {
	it("merges a clean fragment and keeps one that holds evidence", async () => {
		const { internal } = await boot()
		const HOUR = 3_600_000
		const now = Date.now()
		const snap = fragmentSnapshot([
			{
				id: "d_main",
				centreHz: ch(8) + 300,
				count: 40,
				firstSeenMs: now - 5 * HOUR,
			},
			{
				id: "d_clean",
				centreHz: ch(8) - 2_500,
				count: 4,
				firstSeenMs: now - 9 * HOUR,
			},
			{
				id: "d_held",
				centreHz: ch(8) + 4_000,
				count: 2,
				firstSeenMs: now - 3 * HOUR,
			},
		])
		for (const d of snap.discoveries) d.sourceIds = ["rtl"]
		for (const o of snap.observations) o.sourceId = "rtl"
		internal.store.restore(snap)
		// The channel grid the passive job would supply.
		;(
			internal.store as unknown as {
				channelRastersFor: (sourceId: string, hz: number) => Raster[]
			}
		).channelRastersFor = () => [RASTER]
		const held = join(internal.storageDir, "evidence", "d_held")
		mkdirSync(held, { recursive: true })
		writeFileSync(join(held, "psd.json"), "{}")
		await internal.maintenance()
		await internal.maintenance()
		expect(internal.store.get("d_clean")).toBeUndefined()
		expect(internal.store.survivorOf("d_clean")).toBe("d_main")
		expect(internal.store.get("d_held")).toBeDefined()
		expect(internal.store.get("d_main")?.observationCount).toBe(44)
	})
})
