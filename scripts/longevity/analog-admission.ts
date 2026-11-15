/**
 * Longevity: analog recording admission and finalize latency against store size (measure only,
 * not CI). Builds a synthetic scanner store in a temporary directory: --ops analog operation
 * folders (default 2500, each intent.json, receipt.json and its WAV under recordings/analog/)
 * and --legacy other recording files (default 7500, recordings/dv/), so 10 000 recordings in
 * all by default. The operation folders are clones of one real recording with fresh ids, so
 * they parse and match like live ones (recovery quarantines them: no live owner). Then it runs
 * the real EvidenceStore and reports:
 *   - recovery (`recoverAnalog`, which the scanner awaits before "Scanner started");
 *   - --records sequential recordings of one live discovery: admission (begin to ready) and
 *     finalize (finish to receipt) p50, p95 and max, and the longest exclusive lock hold seen;
 *   - --parallel recordings at once on two sources (the per-source limit), the same numbers;
 *   - a retention pass.
 * Lock hold: AnalogOperations' private `exclusive` is wrapped from the prototype here (the
 * harness only, never production code) to time each job from its start to its end.
 * Every number comes with the load average around it. The directory is deleted at the end
 * unless --keep is given.
 *
 *   pnpm exec esbuild scripts/longevity/analog-admission.ts --bundle --platform=node \
 *     --format=esm --packages=external --outfile=output/longevity/analog-admission.mjs
 *   node output/longevity/analog-admission.mjs [--ops 2500] [--legacy 7500] [--records 40]
 */
import { randomUUID } from "node:crypto"
import { mkdtemp, realpath, rm, unlink } from "node:fs/promises"
import os from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import process from "node:process"
import {
	AnalogOperations,
	type AnalogMetadataAdapter,
} from "../../src/core/scanner/store/analog-operations.js"
import { DiscoveryStore } from "../../src/core/scanner/store/discovery-store.js"
import { EvidenceStore } from "../../src/core/scanner/store/evidence-store.js"
import type { RecordingBinding } from "../../src/core/scanner/store/recording-operation.js"
import { createLogger } from "../../src/utils/logger.js"
import { counterIds, makeObs } from "../../tests/mocks/scanner/observations.js"
import { cloneAnalogStore } from "./analog-store-fixture.js"

const arg = (name: string, fallback: number): number => {
	const i = process.argv.indexOf(`--${name}`)
	const v = i >= 0 ? Number(process.argv[i + 1]) : Number.NaN
	return Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback
}
const OPS = arg("ops", 2500)
const LEGACY = arg("legacy", 7500)
const RECORDS = arg("records", 40)
const PARALLEL = arg("parallel", 4)
const FOLDERS = arg("folders", 250)
const keep = process.argv.includes("--keep")
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

// Lock hold: every exclusive job's duration from its start (not its queueing) to its end.
const holds: number[] = []
const proto = AnalogOperations.prototype as unknown as {
	exclusive: <T>(this: unknown, job: () => Promise<T>) => Promise<T>
}
const original = proto.exclusive
proto.exclusive = function <T>(this: unknown, job: () => Promise<T>) {
	return original.call(this, async () => {
		const t0 = performance.now()
		try {
			return await job()
		} finally {
			holds.push(performance.now() - t0)
		}
	}) as Promise<T>
}

// Recovery split: time inside full inventory scans (the rest is reconciliation).
let scanMs = 0
const scanProto = AnalogOperations.prototype as unknown as {
	scanInventory: (this: unknown) => Promise<void>
}
const originalScan = scanProto.scanInventory
scanProto.scanInventory = async function (this: unknown) {
	const t0 = performance.now()
	try {
		await originalScan.call(this)
	} finally {
		scanMs += performance.now() - t0
	}
}

const root = await realpath(
	await mkdtemp(join(os.tmpdir(), "wavekit-analog-admission-")),
)
try {
	const store = new DiscoveryStore({
		maxDiscoveries: 100,
		now: () => NOW,
		newId: counterIds(),
	})
	// One live discovery per parallel recording (an observation records one file at a time).
	const live = Array.from({ length: Math.max(1, PARALLEL) }, (_, i) => {
		const observationId = `o${i + 1}`
		const ingested = store.ingest(
			makeObs({
				id: observationId,
				sourceId: `src-${(i % 2) + 1}`,
				centreHz: 446_000_000 + i * 1_000_000,
				startedAt: NOW,
			}),
		)
		if (!ingested.discoveryId) throw new Error("live discovery missing")
		return { discoveryId: ingested.discoveryId, observationId }
	})
	const discoveryId = live[0]!.discoveryId
	const binding = (sourceId: string): RecordingBinding => ({
		sourceId,
		engineInstanceId: randomUUID(),
		stream: 1,
		epoch: 1,
		channelId: "opaque-native-grant",
		channelGeneration: 1,
		inputFormat: "cf32",
		inputSampleRateHz: 48000,
		groupDelayInputSamples: null,
		targetHz: 446_000_000,
		captureCentreHz: null,
		tuningTrust: "unverified",
	})
	const adapter: AnalogMetadataAdapter = {
		authorityHealthy: () => true,
		bindingLive: () => true,
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
	const steps = new Map<string, number[]>()
	const lastStep = new Map<string, number>()
	const open = async (): Promise<EvidenceStore> => {
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
			analogIo: {
				unlink: path => unlink(path),
				// Step timing: each checkpoint's time since the operation's previous one.
				checkpoint: async (name, operationId) => {
					const t = performance.now()
					const last = lastStep.get(operationId)
					if (last !== undefined) {
						const list = steps.get(name) ?? []
						list.push(t - last)
						steps.set(name, list)
					}
					lastStep.set(operationId, t)
				},
			},
		})
		evidence.configureAnalog(adapter)
		return evidence
	}
	const recordOne = async (
		evidence: EvidenceStore,
		sourceId: string,
		target = live[0]!,
	): Promise<{ admit: number; finish: number; outcome: string }> => {
		const t0 = performance.now()
		const op = evidence.beginAnalog({
			discoveryId: target.discoveryId,
			observationId: target.observationId,
			binding: binding(sourceId),
		})
		await op.ready
		const t1 = performance.now()
		await op.push(new Int16Array(8000))
		const t2 = performance.now()
		const receipt = await op.finish()
		return {
			admit: t1 - t0,
			finish: performance.now() - t2,
			outcome: receipt.outcome,
		}
	}

	// One real recording: the template every synthetic operation folder is cloned from.
	const seed = await open()
	await seed.recoverAnalog()
	const template = await recordOne(seed, "src-1")
	if (template.outcome !== "finalized")
		throw new Error(`template recording ${template.outcome}`)
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
		`store: ${OPS + 1} analog operations, ${LEGACY} other recordings, ${FOLDERS} folders (built in ${ms(performance.now() - t0)} ms)`,
	)

	console.log(`load before recovery: ${load()}`)
	const evidence = await open()
	holds.length = 0
	scanMs = 0
	const r0 = performance.now()
	const results = await evidence.recoverAnalog()
	const recoverMs = performance.now() - r0
	console.log(
		`recovery: ${ms(recoverMs)} ms (full scans ${ms(scanMs)} ms), ${results.length} reconciled, ready ${evidence.analogAuthorityReady}, longest lock hold ${ms(Math.max(...holds))} ms`,
	)
	// The first admission must not pay the other recordings' walk the recovery started.
	await new Promise(resolve => setTimeout(resolve, 3000))

	holds.length = 0
	const admit: number[] = []
	const finish: number[] = []
	for (let i = 0; i < RECORDS; i++) {
		const r = await recordOne(evidence, "src-1")
		if (r.outcome !== "finalized") throw new Error(`recording ${r.outcome}`)
		admit.push(r.admit)
		finish.push(r.finish)
	}
	console.log(`load after sequential: ${load()}`)
	console.log(summary("sequential admission", admit))
	console.log(summary("sequential finalize", finish))
	console.log(summary("sequential lock hold", holds))
	for (const [name, list] of steps)
		console.log(`  step to ${name}: p50 ${ms(pct(list, 0.5))} ms`)
	steps.clear()

	holds.length = 0
	const pAdmit: number[] = []
	const pFinish: number[] = []
	for (let round = 0; round < Math.max(1, Math.floor(RECORDS / 4)); round++) {
		const batch = await Promise.all(
			Array.from({ length: PARALLEL }, (_, i) =>
				recordOne(evidence, `src-${(i % 2) + 1}`, live[i]),
			),
		)
		for (const r of batch) {
			if (r.outcome !== "finalized") throw new Error(`recording ${r.outcome}`)
			pAdmit.push(r.admit)
			pFinish.push(r.finish)
		}
	}
	console.log(`load after parallel: ${load()}`)
	console.log(summary(`parallel x${PARALLEL} admission`, pAdmit))
	console.log(summary(`parallel x${PARALLEL} finalize`, pFinish))
	console.log(summary(`parallel x${PARALLEL} lock hold`, holds))

	holds.length = 0
	const rt = performance.now()
	await evidence.retention(new Set(live.map(l => l.discoveryId)))
	console.log(
		`retention pass: ${ms(performance.now() - rt)} ms, longest lock hold ${ms(Math.max(0, ...holds))} ms`,
	)
	await evidence.stopAnalog()
} catch (err) {
	console.error("harness failed:", err)
	process.exitCode = 1
} finally {
	if (keep) console.log(`kept ${root}`)
	else
		await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(
			(err: unknown) => console.error("cleanup failed:", err),
		)
}
