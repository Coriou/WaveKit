/**
 * Longevity: scanner state size against startup cost (measure only, not CI). Builds a synthetic
 * discovery store through the real DiscoveryStore (ingest), writes it with the real
 * ScannerPersistence snapshot path, then measures what a restart pays: `persistence.load()` (read,
 * JSON.parse, Zod) and `DiscoveryStore.restoreInSlices` with the event-loop delay while it runs.
 * Also times one main-thread snapshot write, the cost the scanner pays whenever it is dirty.
 *
 *   pnpm exec esbuild scripts/longevity/scanner-state.ts --bundle \
 *     --platform=node --format=esm --packages=external \
 *     --outfile=output/longevity/scanner-state.mjs
 *   node --expose-gc output/longevity/scanner-state.mjs --discoveries 3000 --obs-per 33 --dir <tmp>
 *
 * Synthetic data only: frequencies are a 12.5 kHz grid from 100 MHz, ids are counters.
 */
import { mkdtemp, rm, stat } from "node:fs/promises"
import os from "node:os"
import { join } from "node:path"
import { monitorEventLoopDelay, performance } from "node:perf_hooks"
import process from "node:process"
import { DiscoveryStore } from "../../src/core/scanner/store/discovery-store.js"
import { ScannerPersistence } from "../../src/core/scanner/store/persistence.js"
import { createLogger } from "../../src/utils/logger.js"
import { makeObs } from "../../tests/mocks/scanner/observations.js"

const arg = (name: string, fallback: number): number => {
	const i = process.argv.indexOf(`--${name}`)
	const v = i >= 0 ? Number(process.argv[i + 1]) : Number.NaN
	return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback
}
const argText = (name: string): string | null => {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 ? (process.argv[i + 1] ?? null) : null
}

const DISCOVERIES = arg("discoveries", 3_000)
const OBS_PER = arg("obs-per", 33)
const T0 = 1_700_000_000_000
const logger = createLogger({ level: "fatal" })

const gc = (): void => {
	const g = (globalThis as { gc?: () => void }).gc
	if (g) g()
}
const heapMb = (): number => process.memoryUsage().heapUsed / 2 ** 20
const f = (n: number, d = 1): string => n.toFixed(d)

const parent = argText("dir") ?? os.tmpdir()
const dir = await mkdtemp(join(parent, "wavekit-longevity-scanner-"))
try {
	let n = 0
	const store = new DiscoveryStore({
		maxDiscoveries: DISCOVERIES + 100,
		now: () => T0 + OBS_PER * DISCOVERIES * 1_000,
		newId: () => `d-${++n}`,
	})
	const persistence = new ScannerPersistence({
		dir,
		logger,
		now: () => T0,
	})
	await persistence.load()

	// Round-robin over the grid so every discovery gets OBS_PER observations.
	const total = DISCOVERIES * OBS_PER
	const i0 = performance.now()
	for (let i = 0; i < total; i++) {
		store.ingest(
			makeObs({
				id: `o-${i}`,
				centreHz: 100_000_000 + (i % DISCOVERIES) * 12_500,
				startedAt: T0 + i * 1_000,
				cls: "fsk4-12k5",
				hypotheses: [["dmr", 0.6]],
				jobIds: ["job-1"],
			}),
		)
	}
	const ingestMs = performance.now() - i0
	gc()
	const heapAfterIngest = heapMb()

	const snap = store.snapshot()
	const w0 = performance.now()
	await persistence.writeSnapshot(snap)
	const writeMs = performance.now() - w0
	const bytes = (await stat(join(dir, "discoveries.json"))).size

	// Restart: fresh persistence + store, as ScannerService.start does.
	gc()
	const heapBase = heapMb()
	const fresh = new ScannerPersistence({ dir, logger, now: () => T0 })
	const delay = monitorEventLoopDelay({ resolution: 1 })
	delay.enable()
	const l0 = performance.now()
	const loaded = await fresh.load()
	const loadMs = performance.now() - l0
	const restoreStore = new DiscoveryStore({
		maxDiscoveries: DISCOVERIES + 100,
		now: () => T0 + total * 1_000,
		newId: () => `r-${++n}`,
	})
	const r0 = performance.now()
	await restoreStore.restoreInSlices({
		discoveries: loaded.discoveries,
		observations: loaded.observations,
		corrections: loaded.corrections,
		...(loaded.aliases ? { aliases: loaded.aliases } : {}),
	})
	const restoreMs = performance.now() - r0
	delay.disable()
	gc()
	const heapRestored = heapMb() - heapBase

	console.log(
		JSON.stringify({
			discoveries: snap.discoveries.length,
			observations: snap.observations.length,
			snapshotMiB: Number(f(bytes / 2 ** 20)),
			bytesPerObservation: Math.round(bytes / snap.observations.length),
			ingestMs: Math.round(ingestMs),
			heapAfterIngestMiB: Number(f(heapAfterIngest)),
			snapshotWriteMs: Math.round(writeMs),
			loadMs: Math.round(loadMs),
			restoreInSlicesMs: Math.round(restoreMs),
			eventLoopMaxMs: Number(f(delay.max / 1e6)),
			eventLoopP99Ms: Number(f(delay.percentile(99) / 1e6)),
			restoredHeapMiB: Number(f(heapRestored)),
			loadavg: os.loadavg().map(x => Number(x.toFixed(2))),
		}),
	)
} finally {
	await rm(dir, { recursive: true, force: true })
}
