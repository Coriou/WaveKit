/**
 * A sweep hop through the production composition: the spectrum pipeline closes the old epoch's
 * tracks (`track-close`, retune) before it announces the new epoch (`epoch-started`), and both reach
 * every listener synchronously, so the scanner ends a sweep's observation `hop` before the
 * composition's retune close runs; that close then finds nothing of the scanner's left open. A hop
 * return joins the hopped transmission's group past the 15 s gap; a retune close does not.
 */
import { rm } from "node:fs/promises"
import pino from "pino"
import { describe, expect, it } from "vitest"
import type { EngineEpoch } from "../../../../src/core/spectrum/spectrum-engine.js"
import type {
	PipelineEvent,
	TrackSnapshot,
} from "../../../../src/core/spectrum/types.js"
import { composeTransmissions } from "../../../../src/core/transmissions/compose.js"
import {
	TX_GROUP_GAP_MS,
	TX_HOP_GROUP_MS,
} from "../../../../src/core/transmissions/index.js"
import type { LiveObservation } from "../../../../src/core/scanner/job-runner.js"
import { makeTrack } from "../../../mocks/scanner/observations.js"
import {
	CENTRE,
	feedTone,
	serviceHarness,
	settled,
} from "../../../mocks/scanner/service-fakes.js"

const HZ = CENTRE + 25_000
const RANGE = { startHz: CENTRE - 50_000, endHz: CENTRE + 50_000 }
const T0 = Date.UTC(2026, 0, 1)

async function world(mode: "sweep" | "in-window") {
	let clock = T0
	const comp = composeTransmissions({
		logger: pino({ level: "silent" }),
		now: () => clock,
	})
	const h = serviceHarness({
		transmissions: comp.scanner.transmissions,
		now: () => clock,
		patch: s => {
			s.passive.enabled = false
		},
	})
	// As src/index.ts: bound once the service is built, before it starts.
	const unbind = comp.bindSpectrum(h.service.spectrum)
	await h.service.start()
	const job = await h.service.createJob(
		mode === "sweep"
			? {
					sourceId: "rtl",
					mode: "sweep",
					ranges: [RANGE],
					priority: 50,
					takeover: true,
					resume: { autoAfterIdleMs: null },
				}
			: {
					sourceId: "rtl",
					mode: "in-window",
					ranges: [RANGE],
					protocols: ["analog-fm"],
				},
	)
	for (
		let i = 0;
		i < 50 && h.service.getJob(job.id)?.state === "starting";
		i++
	) {
		await settled(h.service)
		feedTone(h.fanout, 0.1, 0, 0, 20 + i)
	}
	await settled(h.service)
	const cur: EngineEpoch = h.service.spectrum.engine("rtl")!.currentEpoch()
	const emit = (ev: PipelineEvent, epoch: EngineEpoch = cur) => {
		h.service.spectrum.emit("pipeline", "rtl", ev, epoch)
	}
	const live = (h.service as unknown as { live: Map<string, LiveObservation> })
		.live
	const open = (id: string, epoch: number): TrackSnapshot => {
		const track = makeTrack({ id, centreHz: HZ, startedAt: 0 })
		track.sourceId = "rtl"
		track.gate = "passed"
		track.stream = cur.stream
		track.epoch = epoch
		emit({ kind: "track-open", track })
		return track
	}
	const viewOf = (track: TrackSnapshot) => {
		const obs = live.get(track.trackId)?.observationId
		expect(obs).toBeDefined()
		return comp.api.transmissions.byAlias(`obs:${obs}`)
	}
	return {
		comp,
		emit,
		open,
		viewOf,
		advance: (ms: number) => {
			clock += ms
		},
		/** The pipeline's order on a hop: the old tracks close, then the new epoch starts. */
		hop: (track: TrackSnapshot, epoch: number) => {
			emit({ kind: "track-close", track, endReason: "retune" })
			// The sweep's own commanded epoch, as its hop's is: the job keeps its window.
			emit(
				{ kind: "epoch-started", epoch, startSample: 0, settleMode: "none" },
				{ ...cur, epoch, requestedEpoch: cur.epoch, tuningTrust: "commanded" },
			)
		},
		done: async () => {
			unbind()
			comp.stop()
			await h.service.stop()
			await rm(h.dir, { recursive: true, force: true })
		},
	}
}

describe("transmission composition: a sweep hop and the retune close", () => {
	it("a sweep's hop closes its observation `hop`, and a hop return joins its group", async () => {
		const w = await world("sweep")
		try {
			const first = w.open("hop-a", 900)
			const before = w.viewOf(first)
			expect(before?.state).toBe("open")
			w.advance(2_000)
			w.hop(first, 901)
			const closed = w.comp.api.transmissions.get(before!.id)
			expect(closed?.state).toBe("closed")
			expect(closed?.close).toBe("hop")

			// Back on the channel past the 15 s gap, inside the hop-return window.
			w.advance(TX_GROUP_GAP_MS + 30_000)
			expect(TX_GROUP_GAP_MS + 30_000).toBeLessThan(TX_HOP_GROUP_MS)
			const back = w.open("hop-b", 902)
			const returned = w.viewOf(back)
			expect(returned?.id).not.toBe(before!.id)
			expect(returned?.groupId).toBe(before!.groupId)
		} finally {
			await w.done()
		}
	}, 30_000)

	it("without a sweep the same order closes `retune`, and a return past the gap starts its own group", async () => {
		const w = await world("in-window")
		try {
			const first = w.open("rt-a", 900)
			const before = w.viewOf(first)
			w.advance(2_000)
			w.hop(first, 901)
			expect(w.comp.api.transmissions.get(before!.id)?.close).toBe("retune")
			w.advance(TX_GROUP_GAP_MS + 30_000)
			const back = w.open("rt-b", 902)
			expect(w.viewOf(back)?.groupId).not.toBe(before!.groupId)
		} finally {
			await w.done()
		}
	}, 30_000)
})
