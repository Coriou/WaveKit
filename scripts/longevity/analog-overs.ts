/**
 * Longevity: the wideband analog recorder against a real EvidenceStore on a large store, in
 * real time (measure only, not CI). A synthetic store of --ops analog operation folders and
 * --legacy other recordings (analog-store-fixture.ts, default 2500 + 7500 = 10 000 recordings)
 * is recovered, then the real recorder (fake engine ring and NFM signal from the recorder test
 * harness) records a scene of continuous overs on one channel: --overs transmissions of
 * --over-s seconds with --gap-s seconds between them, each its own observation, fed at the
 * signal's own pace (wall clock), so every file of the session queues behind the previous one's
 * settlement as on a busy repeater. It reports the recorder's decision counts (refusals named,
 * `discarded:buffer-full` and `discarded:store-backlog` among them), finalized files, admission
 * (begin to ready) and settlement p50/p95/max and the longest session backlog seen, with the
 * load average. Add host load with --burn N (N busy worker threads for the scene's duration).
 * The directory is deleted at the end.
 *
 *   pnpm exec esbuild scripts/longevity/analog-overs.ts --bundle --platform=node \
 *     --format=esm --packages=external --outfile=output/longevity/analog-overs.mjs
 *   node output/longevity/analog-overs.mjs [--ops 2500] [--legacy 7500] [--overs 20] [--burn 0]
 */
import { randomUUID } from "node:crypto"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import process from "node:process"
import { Worker } from "node:worker_threads"
import type {
	AnalogHandle,
	AnalogInput,
	AnalogMetadataAdapter,
} from "../../src/core/scanner/store/analog-operations.js"
import { DiscoveryStore } from "../../src/core/scanner/store/discovery-store.js"
import { EvidenceStore } from "../../src/core/scanner/store/evidence-store.js"
import { createLogger } from "../../src/utils/logger.js"
import { counterIds, makeObs } from "../../tests/mocks/scanner/observations.js"
import {
	CENTRE,
	LOW,
	LOW_FS,
	LOW_OFFSET,
	harness,
	input,
	snapshot,
} from "../../tests/unit/core/scanner/wideband-recorder-harness.js"
import { cloneAnalogStore } from "./analog-store-fixture.js"

const arg = (name: string, fallback: number): number => {
	const i = process.argv.indexOf(`--${name}`)
	const v = i >= 0 ? Number(process.argv[i + 1]) : Number.NaN
	return Number.isFinite(v) && v >= 0 ? v : fallback
}
const OPS = Math.floor(arg("ops", 2500))
const LEGACY = Math.floor(arg("legacy", 7500))
const FOLDERS = Math.floor(arg("folders", 250))
const OVERS = Math.floor(arg("overs", 20))
const OVER_S = arg("over-s", 6)
const GAP_S = arg("gap-s", 0.4)
const BURN = Math.floor(arg("burn", 0))
const NOW = Date.now()
const logger = createLogger({ level: "fatal" })
const load = (): string =>
	os
		.loadavg()
		.map(v => v.toFixed(2))
		.join(" ")
const pct = (values: readonly number[], p: number): number => {
	if (values.length === 0) return Number.NaN
	const sorted = [...values].sort((a, b) => a - b)
	return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!
}
const ms = (v: number): string => v.toFixed(1)
const summary = (label: string, values: readonly number[]): string =>
	`${label}: p50 ${ms(pct(values, 0.5))} ms, p95 ${ms(pct(values, 0.95))} ms, max ${ms(Math.max(...values))} ms (n ${values.length})`
const sleep = (msDelay: number): Promise<void> =>
	new Promise(resolve => setTimeout(resolve, Math.max(0, msDelay)))

const root = await realpath(
	await mkdtemp(join(os.tmpdir(), "wavekit-analog-overs-")),
)
const burners: Worker[] = []
try {
	const store = new DiscoveryStore({
		maxDiscoveries: 1000,
		now: () => NOW,
		newId: counterIds(),
	})
	const hz = CENTRE + LOW_OFFSET
	// Every over its own observation of the one channel's discovery, on the recorder's source.
	const ids = Array.from({ length: OVERS + 1 }, (_, i) => `ov-${i}`)
	let discoveryId: string | null = null
	for (const id of ids) {
		const out = store.ingest(
			makeObs({ id, sourceId: "rtl", centreHz: hz, startedAt: NOW }),
		)
		discoveryId ??= out.discoveryId
	}
	if (!discoveryId) throw new Error("live discovery missing")
	let bindingLive: (b: AnalogInput["binding"]) => boolean = () => true
	const adapter: AnalogMetadataAdapter = {
		authorityHealthy: () => true,
		bindingLive: b => bindingLive(b),
		association: (d, o, historical) =>
			store.recordingAssociation(d, o, historical),
		prepare: async metadata => {
			store.prepareRecording(metadata)
		},
		inverse: async id => {
			store.removePreparedRecording(id)
		},
		buildCommitPlan: id => store.buildRecordingCommitPlan(id),
		commitPlanCurrent: plan => store.recordingCommitPlanCurrent(plan),
		publishCommit: plan => store.publishRecordingCommit(plan),
	}
	const open = (): EvidenceStore => {
		const evidence = new EvidenceStore({
			dir: root,
			caps: {
				maxRecordingsMb: 100_000,
				maxEvidenceMb: 1000,
				maxAgeDays: 30,
				minFreeDiskMb: 1,
			},
			logger,
			now: () => NOW,
			statfs: async () => ({ freeBytes: 1e12 }),
			isDiscoveryLive: id => !!store.get(id),
		})
		evidence.configureAnalog(adapter)
		return evidence
	}

	// The template recording, then the clones.
	const seed = open()
	await seed.recoverAnalog()
	const op = seed.beginAnalog({
		discoveryId,
		observationId: ids[0]!,
		binding: {
			sourceId: "rtl",
			engineInstanceId: randomUUID(),
			stream: 1,
			epoch: 1,
			channelId: "seed",
			channelGeneration: 1,
			inputFormat: "cf32",
			inputSampleRateHz: 48000,
			groupDelayInputSamples: null,
			targetHz: hz,
			captureCentreHz: null,
			tuningTrust: "unverified",
		},
	})
	await op.ready
	await op.push(new Int16Array(8000))
	if ((await op.finish()).outcome !== "finalized")
		throw new Error("template recording failed")
	await seed.stopAnalog()
	const t0 = performance.now()
	await cloneAnalogStore({
		root,
		seedDiscoveryId: discoveryId,
		ops: OPS,
		legacy: LEGACY,
		folders: FOLDERS,
	})
	console.log(
		`store: ${OPS + 1} analog operations, ${LEGACY} other recordings (built in ${ms(performance.now() - t0)} ms)`,
	)
	const evidence = open()
	const r0 = performance.now()
	await evidence.recoverAnalog()
	console.log(
		`recovery: ${ms(performance.now() - r0)} ms, ready ${evidence.analogAuthorityReady}; load ${load()}`,
	)
	await sleep(2000)

	const admissions: number[] = []
	const settlements: number[] = []
	const outcomes = new Map<string, number>()
	const settled: Promise<unknown>[] = []
	const h = harness({
		fs: LOW_FS,
		offset: LOW_OFFSET,
		liveClock: true,
		beginWrap: () => (analog: AnalogInput) => {
			const begun = performance.now()
			const handle: AnalogHandle = evidence.beginAnalog(analog)
			handle.ready.then(
				() => admissions.push(performance.now() - begun),
				() => undefined,
			)
			const finished = handle.settled.then(receipt => {
				outcomes.set(receipt.outcome, (outcomes.get(receipt.outcome) ?? 0) + 1)
				settlements.push(performance.now() - begun)
			})
			settled.push(finished)
			return handle
		},
	})
	bindingLive = b => h.rec.bindingLive(b)

	for (let i = 0; i < BURN; i++)
		burners.push(
			new Worker("for (;;) {}", {
				eval: true,
			}),
		)
	if (BURN > 0) console.log(`burning ${BURN} threads`)

	// Fed at the signal's own pace: 25 ms chunks, the wall clock kept level with the signal.
	const wallStart = performance.now()
	let signalS = 0
	let maxBacklogMs = 0
	const chunk = LOW_FS / 40
	const paced = async (
		seconds: number,
		on: boolean,
		each?: () => void,
	): Promise<void> => {
		for (let i = 0; i < Math.round((seconds * LOW_FS) / chunk); i++) {
			h.engine.write(h.src.next(chunk, on))
			each?.()
			await h.pump()
			signalS += chunk / LOW_FS
			for (const s of h.rec.diagnostics().sessions)
				maxBacklogMs = Math.max(maxBacklogMs, s.backlogMs)
			await sleep(wallStart + signalS * 1000 - performance.now())
		}
	}
	for (let i = 1; i <= OVERS; i++) {
		const id = ids[i]!
		const onset = h.engine.liveEdge()
		const end = onset + OVER_S * LOW_FS
		await paced(OVER_S, true, () => {
			const edge = h.engine.liveEdge()
			if (edge - onset >= 0.1 * LOW_FS)
				h.rec.track(
					input(id, snapshot(id, onset, Math.min(edge, end), LOW), {
						discoveryId: discoveryId!,
					}),
				)
		})
		await paced(GAP_S, false)
		h.rec.closed(id, snapshot(id, onset, end, LOW), null)
	}
	await paced(3, false)
	await h.fire()
	await paced(1, false)
	for (const w of burners.splice(0)) await w.terminate()
	await Promise.all(settled)
	const status = h.rec.diagnostics()
	console.log(
		`scene: ${OVERS} overs of ${OVER_S} s, ${GAP_S} s apart, ${ms((performance.now() - wallStart) / 1000)} s wall; load ${load()}`,
	)
	console.log(`decisions: ${JSON.stringify(status.counts)}`)
	console.log(`receipts: ${JSON.stringify(Object.fromEntries(outcomes))}`)
	console.log(
		`buffer-full ${status.counts["discarded:buffer-full"] ?? 0}, store-backlog ${status.counts["discarded:store-backlog"] ?? 0}, longest session backlog ${maxBacklogMs} ms`,
	)
	console.log(summary("admission", admissions))
	console.log(summary("begin to settled", settlements))
	await h.rec.stop()
	await evidence.stopAnalog()
} catch (err) {
	console.error("harness failed:", err)
	process.exitCode = 1
} finally {
	for (const w of burners) await w.terminate()
	await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(
		(err: unknown) => console.error("cleanup failed:", err),
	)
}
