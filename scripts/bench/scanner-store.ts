/**
 * WG11 lane SC: scanner store CPU on a wide sweep, measure only (not CI). Ingests 10 000
 * discoveries on one source with 50 000 observations, then reports per-ingest cost, the progress
 * counts build, the snapshot cost on the main thread and until durable, event-loop delay p99 while
 * a snapshot is written, and the load average. Feature-detects `countsByJob` and
 * `ScannerPersistence.writeSnapshotOf` so the same script yields before and after numbers.
 *
 *   pnpm exec esbuild scripts/bench/scanner-store.ts --bundle \
 *     --platform=node --format=esm --packages=external \
 *     --outfile=output/bench/scanner-store.mjs
 *   node output/bench/scanner-store.mjs [--discoveries 10000] [--observations 50000]
 */
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import { join } from "node:path"
import { monitorEventLoopDelay, performance } from "node:perf_hooks"
import process from "node:process"
import { DiscoveryStore } from "../../src/core/scanner/store/discovery-store.js"
import { ScannerPersistence } from "../../src/core/scanner/store/persistence.js"
import type { ScannerConfidence } from "../../src/core/scanner/types.js"
import { createLogger } from "../../src/utils/logger.js"
import { makeObs } from "../../tests/mocks/scanner/observations.js"

const arg = (name: string, fallback: number): number => {
	const i = process.argv.indexOf(`--${name}`)
	const v = i >= 0 ? Number(process.argv[i + 1]) : Number.NaN
	return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback
}
const DISCOVERIES = arg("discoveries", 10_000)
const OBSERVATIONS = arg("observations", 50_000)
const JOB = "job-1"
const T0 = 1_700_000_000_000

type Counts = Record<ScannerConfidence, number>
interface CountsStore {
	countsByJob?: (jobId: string) => Counts
}
interface SnapshotOfPersistence {
	writeSnapshotOf?: (store: DiscoveryStore) => Promise<void>
}

const f = (n: number, d = 2): string => n.toFixed(d)
const logger = createLogger({ level: "fatal" })
const dir = await mkdtemp(join(os.tmpdir(), "wavekit-scanner-store-bench-"))
try {
	const store = new DiscoveryStore({
		maxDiscoveries: DISCOVERIES + 100,
		now: () => T0,
		newId: (() => {
			let n = 0
			return () => `d-${++n}`
		})(),
	})
	const persistence = new ScannerPersistence({
		dir,
		logger,
		now: () => T0,
	})
	await persistence.load()

	// Pre-build the inputs so the ingest timing is the store alone.
	const inputs = Array.from({ length: OBSERVATIONS }, (_, i) =>
		makeObs({
			id: `o-${i}`,
			centreHz: 100_000_000 + (i % DISCOVERIES) * 12_500,
			startedAt: T0 + i * 1_000,
			cls: "fsk4-12k5",
			hypotheses: [["dmr", 0.6]],
			jobIds: [JOB],
		}),
	)
	const t0 = performance.now()
	for (const input of inputs) store.ingest(input)
	const ingestUs = ((performance.now() - t0) * 1000) / inputs.length
	const discoveries = store.list({ limit: 1 }).items.length

	const countsStore = store as unknown as CountsStore
	const hasCounts = typeof countsStore.countsByJob === "function"
	const buildCounts = (): Counts => {
		if (hasCounts && countsStore.countsByJob)
			return countsStore.countsByJob(JOB)
		const counts = { activity: 0, candidate: 0, classified: 0, decoded: 0 }
		let cursor: string | null = null
		do {
			const page = store.list({ jobId: JOB, limit: 500, cursor })
			for (const d of page.items) counts[d.confidence] += 1
			cursor = page.nextCursor
		} while (cursor)
		return counts
	}
	const REPS = 20
	buildCounts()
	const c0 = performance.now()
	let counts = buildCounts()
	for (let i = 1; i < REPS; i++) counts = buildCounts()
	const progressUs = ((performance.now() - c0) * 1000) / REPS
	const total =
		counts.activity + counts.candidate + counts.classified + counts.decoded

	const hasOf =
		typeof (persistence as unknown as SnapshotOfPersistence).writeSnapshotOf ===
		"function"
	const delay = monitorEventLoopDelay({ resolution: 1 })
	delay.enable()
	const s0 = performance.now()
	let pending: Promise<void>
	if (hasOf) {
		pending = (
			persistence as unknown as Required<SnapshotOfPersistence>
		).writeSnapshotOf(store)
	} else {
		pending = persistence.writeSnapshot(store.snapshot())
	}
	const mainMs = performance.now() - s0
	await pending
	const totalMs = performance.now() - s0
	// Let a final delay sample land before reading the histogram.
	await new Promise<void>(resolve => setTimeout(resolve, 20))
	delay.disable()

	const [l1] = os.loadavg()
	console.log(
		`scanner-store bench (${hasCounts ? "countsByJob" : "list() recount"}, ${hasOf ? "writeSnapshotOf" : "writeSnapshot(snapshot())"})`,
	)
	console.log(
		`  discoveries                 ${total} (listed first page ${discoveries})`,
	)
	console.log(`  observations                ${OBSERVATIONS}`)
	console.log(`  ingest mean                 ${f(ingestUs)} us/observation`)
	console.log(`  progress counts build       ${f(progressUs, 1)} us`)
	console.log(`  snapshot main-thread        ${f(mainMs, 1)} ms`)
	console.log(
		`  snapshot until durable      ${f(totalMs, 1)} ms (worker/write portion ${f(totalMs - mainMs, 1)} ms)`,
	)
	console.log(
		`  event-loop delay p99        ${f(delay.percentile(99) / 1e6, 1)} ms (max ${f(delay.max / 1e6, 1)} ms)`,
	)
	console.log(`  load average (1 min)        ${f(l1 ?? 0)}`)
} finally {
	await rm(dir, { recursive: true, force: true })
}
