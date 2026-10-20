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
import { DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ } from "@wavekit/api-types"
import { deriveProof } from "../../src/core/scanner/proof.js"
import type { ProofInput } from "../../src/core/scanner/scanner-redesign-contract.js"
import {
	DiscoveryStore,
	OBSERVATIONS_PER_DISCOVERY,
} from "../../src/core/scanner/store/discovery-store.js"
import { ScannerPersistence } from "../../src/core/scanner/store/persistence.js"
import type { ScannerConfidence } from "../../src/core/scanner/types.js"
import { createLogger } from "../../src/utils/logger.js"
import { evidence, makeObs } from "../../tests/mocks/scanner/observations.js"

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
	const nearHz = 100_000_000
	store.near(nearHz, DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ)
	const NEAR_REPS = 200
	const nearT0 = performance.now()
	let nearHits = 0
	for (let i = 0; i < NEAR_REPS; i++)
		nearHits += store.near(nearHz, DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ).length
	const nearMs = (performance.now() - nearT0) / NEAR_REPS
	const filterT0 = performance.now()
	const provenListed = store.list({ evidence: "proven", limit: 500 }).items
		.length
	const weakListed = store.list({ evidence: "weak", limit: 1 }).items.length
	const filterMs = performance.now() - filterT0

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

	// Steady state: the first writeSnapshotOf seeds the worker's mirror on the main thread; later
	// ones see only the journal lines. Feed 1 000 more hits through the journal, then time one.
	let steady: { mainMs: number; totalMs: number; p99Ms: number } | null = null
	if (hasOf) {
		store.on("mutation", (entry: Parameters<typeof persistence.append>[0]) => {
			persistence.append(entry).catch(() => undefined)
		})
		for (let i = 0; i < 1_000; i++)
			store.ingest(
				makeObs({
					id: `s-${i}`,
					centreHz: 100_000_000 + (i % DISCOVERIES) * 12_500,
					startedAt: T0 + (OBSERVATIONS + i) * 1_000,
					cls: "fsk4-12k5",
					hypotheses: [["dmr", 0.6]],
					jobIds: [JOB],
				}),
			)
		const steadyDelay = monitorEventLoopDelay({ resolution: 1 })
		steadyDelay.enable()
		const t1 = performance.now()
		const next = (
			persistence as unknown as Required<SnapshotOfPersistence>
		).writeSnapshotOf(store)
		const steadyMain = performance.now() - t1
		await next
		const steadyTotal = performance.now() - t1
		await new Promise<void>(resolve => setTimeout(resolve, 20))
		steadyDelay.disable()
		steady = {
			mainMs: steadyMain,
			totalMs: steadyTotal,
			p99Ms: steadyDelay.percentile(99) / 1e6,
		}
		await (
			persistence as unknown as { closeSnapshotWorker?: () => Promise<void> }
		).closeSnapshotWorker?.()
	}

	const proofInput: ProofInput = {
		observationId: "bench-obs",
		decodes: [
			{
				protocol: "dmr",
				transport: "live",
				at: T0,
				encrypted: false,
				identity: { kind: "dmr-cc", value: "1" },
				talkgroup: "9",
			},
		],
		trials: Array.from({ length: 32 }, (_, index) => ({
			protocol: index % 2 === 0 ? "dmr" : "dpmr",
			decoder: "dsd-fme",
			outcome: "no-sync" as const,
			order: index + 1,
			at: T0 + index,
		})),
		analog: Array.from({ length: 8 }, (_, index) => ({
			outcome: "no-sync" as const,
			mode: "nfm" as const,
			voice: false,
			tone: { ctcssHz: null, dcs: null },
			transport: "live" as const,
			at: T0 + index,
		})),
		unavailable: ["dsd-fme"],
		trust: "commanded",
		digitalPlanComplete: true,
	}
	for (let i = 0; i < 50; i++) deriveProof(proofInput)
	const proofSamples: number[] = []
	for (let i = 0; i < 1000; i++) {
		const started = performance.now()
		deriveProof(proofInput)
		proofSamples.push(performance.now() - started)
	}
	proofSamples.sort((a, b) => a - b)
	const proofAt = (fraction: number): number =>
		proofSamples[
			Math.min(
				proofSamples.length - 1,
				Math.ceil(proofSamples.length * fraction) - 1,
			)
		] ?? 0
	const proofP50Ms = proofAt(0.5)
	const proofP99Ms = proofAt(0.99)

	// Worst case the store actually serves: 256 observations, each with a full
	// decode, trial and analog bag. One trial is invalidated, then get() rebuilds
	// only that observation and compares the cached rest.
	const DECODE_MAX = 16
	const TRIAL_MAX = 32
	const ANALOG_MAX = 8
	const proofCentreHz = 446_006_250
	const proofStore = new DiscoveryStore({
		maxDiscoveries: 4,
		now: () => T0,
		newId: (() => {
			let n = 0
			return () => `proof-${++n}`
		})(),
		rasters: () => [{ spacingHz: 12_500, firstChannelHz: proofCentreHz }],
	})
	for (let i = 0; i < OBSERVATIONS_PER_DISCOVERY; i++) {
		proofStore.ingest(
			makeObs({
				id: `proof-obs-${i}`,
				centreHz: proofCentreHz,
				startedAt: T0 + i * 1_000,
			}),
		)
	}
	const proofPage = proofStore.list({ limit: 5 }).items
	if (proofPage.length !== 1)
		throw new Error(`proof bench expected 1 discovery, saw ${proofPage.length}`)
	const proofDiscoveryId = proofPage[0]?.id
	if (proofDiscoveryId === undefined)
		throw new Error("proof bench missing discovery")
	if (
		proofStore.observations(proofDiscoveryId, null, 500).items.length !==
		OBSERVATIONS_PER_DISCOVERY
	)
		throw new Error("proof bench did not retain every observation")
	for (let i = 0; i < OBSERVATIONS_PER_DISCOVERY; i++) {
		const id = `proof-obs-${i}`
		for (let decode = 0; decode < DECODE_MAX; decode++) {
			const kept = proofStore.appendObservationEvidence(id, {
				protocol: "dmr",
				metadata: {},
				crcClean: true,
				at: T0 + i * 1_000 + decode,
				epoch: 1,
				origin: "probe",
				identity: { kind: "dmr-cc", value: "1" },
			})
			if (!kept) throw new Error(`decode ${i}:${decode} was not retained`)
		}
		for (let order = 1; order <= TRIAL_MAX; order++) {
			const kept = proofStore.recordTrial(id, {
				protocol: "dmr",
				decoder: "dsd-fme",
				outcome: "no-sync",
				order,
				at: T0 + order,
			})
			if (!kept) throw new Error(`trial ${i}:${order} was not retained`)
		}
		for (let analog = 0; analog < ANALOG_MAX; analog++) {
			const kept = proofStore.recordAnalog(id, {
				outcome: "no-sync",
				mode: "nfm",
				voice: false,
				tone: { ctcssHz: null, dcs: null },
				transport: "live",
				at: T0 + analog,
			})
			if (!kept) throw new Error(`analog ${i}:${analog} was not retained`)
		}
	}
	const applied = proofStore.applyEvidence(proofDiscoveryId, {
		protocol: "dmr",
		metadata: {},
		crcClean: true,
		at: T0,
		epoch: 1,
		origin: "probe",
		identity: { kind: "dmr-cc", value: "1" },
	})
	if (applied === null)
		throw new Error("proof bench did not apply the identity")
	if (proofStore.get(proofDiscoveryId)?.proof?.kind !== "decoded")
		throw new Error("proof bench identity did not produce a decoded proof")
	const touched = "proof-obs-0"
	const caches = proofStore as unknown as {
		observationProofCache?: Map<string, unknown>
		proofCache?: Map<string, unknown>
	}
	if (
		!(caches.observationProofCache instanceof Map) ||
		!(caches.proofCache instanceof Map)
	)
		throw new Error("proof caches are not on the store")
	let flip: "no-sync" | "crc-errors" = "crc-errors"
	const getSamples: number[] = []
	for (let i = 0; i < 220; i++) {
		const wrote = proofStore.recordTrial(touched, {
			protocol: "dmr",
			decoder: "dsd-fme",
			outcome: flip,
			order: 1,
			at: T0 + 1,
		})
		if (!wrote) throw new Error("trial invalidation did not apply")
		if (!caches.observationProofCache.has(touched))
			throw new Error("observation proof was not cached after recordTrial")
		caches.observationProofCache.delete(touched)
		caches.proofCache.delete(proofDiscoveryId)
		const started = performance.now()
		const got = proofStore.get(proofDiscoveryId)
		const elapsed = performance.now() - started
		if (got?.proof?.observationId === undefined)
			throw new Error("get() lost the derived proof")
		if (i >= 20) getSamples.push(elapsed)
		flip = flip === "no-sync" ? "crc-errors" : "no-sync"
	}
	getSamples.sort((a, b) => a - b)
	const getAt = (fraction: number): number =>
		getSamples[
			Math.min(
				getSamples.length - 1,
				Math.ceil(getSamples.length * fraction) - 1,
			)
		] ?? 0
	const getP50Ms = getAt(0.5)
	const getP99Ms = getAt(0.99)
	const mutateSamples: number[] = []
	for (let i = 0; i < 220; i++) {
		const at = T0 + 1_000_000 + i
		const ev = {
			protocol: "dmr" as const,
			metadata: {},
			crcClean: true,
			at,
			epoch: 1,
			origin: "probe" as const,
			identity: { kind: "dmr-cc" as const, value: "1" },
		}
		const started = performance.now()
		const appended = proofStore.appendObservationEvidence(touched, ev)
		proofStore.applyEvidence(proofDiscoveryId, ev)
		const got = proofStore.get(proofDiscoveryId)
		const elapsed = performance.now() - started
		if (!appended) throw new Error("evidence append was not retained")
		if (
			got?.proof?.kind !== "decoded" ||
			got.proof.at !== new Date(at).toISOString()
		)
			throw new Error("append+apply+get did not publish the new proof")
		if (i >= 20) mutateSamples.push(elapsed)
	}
	mutateSamples.sort((a, b) => a - b)
	const mutateAt = (fraction: number): number =>
		mutateSamples[
			Math.min(
				mutateSamples.length - 1,
				Math.ceil(mutateSamples.length * fraction) - 1,
			)
		] ?? 0
	const mutateP50Ms = mutateAt(0.5)
	const mutateP99Ms = mutateAt(0.99)

	// Restored discoveries, each with one retained decoded proof. The first
	// walk validates every proof into the cache; the timed lists are warm.
	const proofList = new DiscoveryStore({
		maxDiscoveries: DISCOVERIES + 100,
		now: () => T0,
		newId: (() => {
			let n = 0
			return () => `pl-${++n}`
		})(),
	})
	const decoded = evidence("dmr", T0, {
		identity: { kind: "dmr-cc", value: "1" },
	})
	for (let i = 0; i < DISCOVERIES; i++) {
		const obsId = `pl-obs-${i}`
		const created = proofList.ingest(
			makeObs({
				id: obsId,
				centreHz: 100_000_000 + i * 12_500,
				startedAt: T0 + i * 1_000,
				jobIds: [JOB],
			}),
		)
		const proofId = created.discoveryId
		if (proofId === null) throw new Error(`proof list row ${i} did not surface`)
		if (!proofList.appendObservationEvidence(obsId, decoded))
			throw new Error(`proof list decode ${i} was not retained`)
		if (proofList.applyEvidence(proofId, decoded) === null)
			throw new Error(`proof list evidence ${i} was not applied`)
	}
	const proofSnap = proofList.snapshot()
	if (proofSnap.discoveries.length !== DISCOVERIES)
		throw new Error(
			`proof list built ${proofSnap.discoveries.length}, expected ${DISCOVERIES}`,
		)
	const restoredProofs = new DiscoveryStore({
		maxDiscoveries: DISCOVERIES + 100,
		now: () => T0,
		newId: (() => {
			let n = 0
			return () => `plr-${++n}`
		})(),
	})
	restoredProofs.restore(proofSnap)
	let provenCount = 0
	let proofCursor: string | null = null
	do {
		const page = restoredProofs.list({
			evidence: "proven",
			limit: 500,
			cursor: proofCursor,
		})
		for (const row of page.items) {
			if (row.evidenceLevel !== "proven" || row.proof?.kind !== "decoded")
				throw new Error("proof list DTO is not a decoded proof")
		}
		provenCount += page.items.length
		proofCursor = page.nextCursor
	} while (proofCursor !== null)
	if (provenCount !== DISCOVERIES)
		throw new Error(`proof list restored ${provenCount} proven discoveries`)
	if (
		restoredProofs.list({
			evidence: "proven",
			limit: 100,
			sourceId: "src-missing",
		}).items.length !== 0
	)
		throw new Error("proof list matched a missing source")
	const LIST_REPS = 25
	const timeList = (run: () => number, expectCount: number): number[] => {
		const samples: number[] = []
		for (let i = 0; i < LIST_REPS; i++) {
			const started = performance.now()
			const count = run()
			const elapsed = performance.now() - started
			if (count !== expectCount)
				throw new Error(`proof list saw ${count}, expected ${expectCount}`)
			samples.push(elapsed)
		}
		return samples
	}
	const listStats = (samples: number[]): { mean: number; p99: number } => {
		const sorted = [...samples].sort((a, b) => a - b)
		const mean = sorted.reduce((sum, n) => sum + n, 0) / sorted.length
		const p99 =
			sorted[
				Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)
			] ?? 0
		return { mean, p99 }
	}
	const plainList = listStats(
		timeList(() => restoredProofs.list({ limit: 100 }).items.length, 100),
	)
	const provenList = listStats(
		timeList(
			() =>
				restoredProofs.list({ evidence: "proven", limit: 100 }).items.length,
			100,
		),
	)
	const missedList = listStats(
		timeList(
			() =>
				restoredProofs.list({
					evidence: "proven",
					limit: 100,
					sourceId: "src-missing",
				}).items.length,
			0,
		),
	)
	const versus = (ms: number, base: number): string =>
		base === 0 ? "n/a" : `${f(ms / base, 2)}x`

	const [l1, l5, l15] = os.loadavg()
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
	if (steady !== null) {
		console.log(
			`  steady snapshot main-thread ${f(steady.mainMs, 2)} ms (until durable ${f(steady.totalMs, 1)} ms, loop p99 ${f(steady.p99Ms, 1)} ms)`,
		)
	}
	console.log(`  proof derive p50            ${f(proofP50Ms, 4)} ms`)
	console.log(`  proof derive p99            ${f(proofP99Ms, 4)} ms`)
	console.log(
		`  proof get p50               ${f(getP50Ms, 4)} ms (one trial invalidated, ${OBSERVATIONS_PER_DISCOVERY} observations)`,
	)
	console.log(
		`  proof get p99               ${f(getP99Ms, 4)} ms (${OBSERVATIONS_PER_DISCOVERY} × ${DECODE_MAX} decodes × ${TRIAL_MAX} trials × ${ANALOG_MAX} analog)`,
	)
	console.log(`  proof append+apply+get p50  ${f(mutateP50Ms, 4)} ms`)
	console.log(`  proof append+apply+get p99  ${f(mutateP99Ms, 4)} ms`)
	console.log(
		`  near mean                   ${f(nearMs, 4)} ms (${NEAR_REPS} reps, ${nearHits} hits, tol ${DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ} Hz)`,
	)
	console.log(
		`  evidence filter             ${f(filterMs, 2)} ms (proven ${provenListed}, weak page ${weakListed})`,
	)
	console.log(
		`  proof list plain mean/p99   ${f(plainList.mean, 2)} / ${f(plainList.p99, 2)} ms (${DISCOVERIES} decoded, warm, limit 100)`,
	)
	console.log(
		`  proof list proven mean/p99  ${f(provenList.mean, 2)} / ${f(provenList.p99, 2)} ms (${versus(provenList.mean, plainList.mean)} mean, ${versus(provenList.p99, plainList.p99)} p99)`,
	)
	console.log(
		`  proof list miss mean/p99    ${f(missedList.mean, 2)} / ${f(missedList.p99, 2)} ms (source matches nothing, ${versus(missedList.mean, plainList.mean)} mean, ${versus(missedList.p99, plainList.p99)} p99)`,
	)
	console.log(
		`  load average (uptime)       ${f(l1 ?? 0)} ${f(l5 ?? 0)} ${f(l15 ?? 0)}`,
	)
} finally {
	await rm(dir, { recursive: true, force: true })
}
