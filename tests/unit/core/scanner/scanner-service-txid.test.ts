/**
 * The scanner's transmission ids: a gate-passed observation claims at its start and ends with its
 * close; a max-duration rollover successor continues its predecessor's id; a file begun while the
 * observation's transmission is open carries it, one begun after does not (counted); the kept
 * event names the file's transmissions and own start. Without a registry nothing carries one.
 */
import { rm } from "node:fs/promises"
import { expect, it } from "vitest"
import type { LiveObservation } from "../../../../src/core/scanner/job-runner.js"
import type { ScannerRecordingKept } from "../../../../src/core/scanner/scanner-service.js"
import type {
	AnalogCommitExtra,
	AnalogInput,
} from "../../../../src/core/scanner/store/analog-operations.js"
import type { RecordingCommitPlan } from "../../../../src/core/scanner/store/discovery-store.js"
import type {
	PipelineEvent,
	TrackSnapshot,
} from "../../../../src/core/spectrum/types.js"
import { TransmissionRegistry } from "../../../../src/core/transmissions/index.js"
import { makeTrack } from "../../../mocks/scanner/observations.js"
import { CENTRE, serviceHarness } from "../../../mocks/scanner/service-fakes.js"

type TrackEvent = Extract<
	PipelineEvent,
	{ kind: "track-open" | "track-update" | "track-close" }
>

interface Internal {
	live: Map<string, LiveObservation>
	onTrack(sourceId: string, ev: TrackEvent): void
	withTx(input: AnalogInput): AnalogInput
	emitRecordingKept(plan: RecordingCommitPlan, extra?: AnalogCommitExtra): void
}

const HZ = CENTRE + 25_000

function passed(id: string, centreHz = HZ): TrackSnapshot {
	const track = makeTrack({ id, centreHz, startedAt: 0 })
	track.sourceId = "rtl"
	track.gate = "passed"
	return track
}

async function setup(registry: TransmissionRegistry | null) {
	const h = serviceHarness(registry ? { transmissions: registry } : {})
	await h.service.start()
	await h.service.createJob({
		sourceId: "rtl",
		mode: "in-window",
		ranges: [{ startHz: CENTRE - 50_000, endHz: CENTRE + 50_000 }],
		protocols: ["analog-fm"],
	})
	const internal = h.service as unknown as Internal
	return {
		h,
		internal,
		done: async () => {
			await h.service.stop()
			await rm(h.dir, { recursive: true, force: true })
		},
	}
}

function observationOf(internal: Internal, trackId: string): string {
	const live = internal.live.get(trackId)
	if (!live) throw new Error("no live observation")
	return live.observationId
}

it("an observation claims at its start, its activity carries the id and its close ends it", async () => {
	const registry = new TransmissionRegistry()
	const { h, internal, done } = await setup(registry)
	const activity: { observationId: string; txId?: string; active: boolean }[] =
		[]
	h.service.on("activity", (a: (typeof activity)[number]) => activity.push(a))
	try {
		const track = passed("a")
		internal.onTrack("rtl", { kind: "track-open", track })
		const obs = observationOf(internal, track.trackId)
		const txId = registry.openTxOf(`obs:${obs}`)
		expect(txId).not.toBeNull()
		// a file begun now carries it
		expect(internal.withTx({ observationId: obs } as AnalogInput).txId).toBe(
			txId,
		)
		internal.onTrack("rtl", { kind: "track-close", track, endReason: "quiet" })
		const v = registry.get(txId!)!
		expect(v.close).toBe("ended")
		expect(v.complete).toBe(true)
		expect(activity.map(a => [a.active, a.txId])).toEqual([
			[true, txId],
			[false, txId],
		])
		// a file begun after the close carries none, counted
		expect(
			internal.withTx({ observationId: obs } as AnalogInput),
		).not.toHaveProperty("txId")
		expect(registry.stats().fileNoTx).toBe(1)
	} finally {
		await done()
	}
})

it("a max-duration rollover successor continues its predecessor's id", async () => {
	const registry = new TransmissionRegistry()
	const { internal, done } = await setup(registry)
	try {
		const first = passed("r1")
		internal.onTrack("rtl", { kind: "track-open", track: first })
		const txId = registry.openTxOf(
			`obs:${observationOf(internal, first.trackId)}`,
		)
		internal.onTrack("rtl", {
			kind: "track-close",
			track: first,
			endReason: "max-duration",
		})
		expect(registry.get(txId!)!.state).toBe("hang")
		const next = passed("r2")
		internal.onTrack("rtl", {
			kind: "track-open",
			track: next,
			rolloverFrom: first.trackId,
		})
		const nextObs = observationOf(internal, next.trackId)
		expect(registry.openTxOf(`obs:${nextObs}`)).toBe(txId)
		internal.onTrack("rtl", {
			kind: "track-close",
			track: next,
			endReason: "quiet",
		})
		expect(registry.get(txId!)!.close).toBe("ended")
		// a new over on the channel afterwards is a new transmission
		const third = passed("r3")
		internal.onTrack("rtl", { kind: "track-open", track: third })
		expect(
			registry.openTxOf(`obs:${observationOf(internal, third.trackId)}`),
		).not.toBe(txId)
	} finally {
		await done()
	}
})

it("two simultaneous tracks 12.5 kHz apart get distinct ids", async () => {
	const registry = new TransmissionRegistry()
	const { internal, done } = await setup(registry)
	try {
		const a = passed("p1", HZ)
		const b = passed("p2", HZ + 12_500)
		internal.onTrack("rtl", { kind: "track-open", track: a })
		internal.onTrack("rtl", { kind: "track-open", track: b })
		const ta = registry.openTxOf(`obs:${observationOf(internal, a.trackId)}`)
		const tb = registry.openTxOf(`obs:${observationOf(internal, b.trackId)}`)
		expect(ta).not.toBeNull()
		expect(tb).not.toBeNull()
		expect(ta).not.toBe(tb)
	} finally {
		await done()
	}
})

it("the kept event names the file's transmissions and own start, and indexes the file", async () => {
	const registry = new TransmissionRegistry()
	const { h, internal, done } = await setup(registry)
	const kept: ScannerRecordingKept[] = []
	h.service.on("recording-kept", (k: ScannerRecordingKept) => kept.push(k))
	try {
		const track = passed("k")
		internal.onTrack("rtl", { kind: "track-open", track })
		const txId = registry.openTxOf(
			`obs:${observationOf(internal, track.trackId)}`,
		)!
		const plan = {
			metadata: {
				alias: "d_1~analog-1.wav",
				discoveryId: "d_1",
				observationId: "o_1",
				binding: { sourceId: "rtl", targetHz: HZ },
				expectedOutput: { outputFrames: 8000, sampleRateHz: 8000 },
			},
			observation: { startedAt: "2026-10-12T00:00:00.000Z", centerHz: HZ },
			discovery: { id: "d_1", frequencyHz: HZ },
		} as unknown as RecordingCommitPlan
		internal.emitRecordingKept(plan, {
			txIds: [txId],
			startedAt: "2026-10-12T00:00:01.000Z",
		})
		expect(kept[0]).toMatchObject({
			txId,
			startedAt: "2026-10-12T00:00:01.000Z",
		})
		expect(kept[0]).not.toHaveProperty("moreTxIds")
		expect(registry.get(txId)!.aliases.rec).toEqual([
			"rec:scan:d_1~analog-1.wav",
		])
		// without extra (an older adapter): no transmission members
		internal.emitRecordingKept(plan)
		expect(kept[1]).not.toHaveProperty("txId")
		expect(kept[1]).not.toHaveProperty("startedAt")
	} finally {
		await done()
	}
})

it("without a registry nothing carries a txId", async () => {
	const { h, internal, done } = await setup(null)
	const activity: { txId?: string }[] = []
	h.service.on("activity", (a: { txId?: string }) => activity.push(a))
	try {
		const track = passed("n")
		internal.onTrack("rtl", { kind: "track-open", track })
		const obs = observationOf(internal, track.trackId)
		expect(
			internal.withTx({ observationId: obs } as AnalogInput),
		).not.toHaveProperty("txId")
		internal.onTrack("rtl", { kind: "track-close", track, endReason: "quiet" })
		expect(activity.length).toBeGreaterThan(0)
		for (const a of activity) expect(a).not.toHaveProperty("txId")
	} finally {
		await done()
	}
})
