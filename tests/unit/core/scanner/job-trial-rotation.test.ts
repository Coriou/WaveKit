import { rm } from "node:fs/promises"
import { expect, it, vi } from "vitest"
import type {
	JobRunner,
	LiveObservation,
} from "../../../../src/core/scanner/job-runner.js"
import type {
	ProbePool,
	ProbeRequest,
} from "../../../../src/core/scanner/probes/probe-pool.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import { serviceHarness, CENTRE } from "../../../mocks/scanner/service-fakes.js"
import { makeLive, makeTrack } from "./cancel-ended-harness.js"

it("records queued admission and subsequent mode starts before ordering the next keyup", async () => {
	const h = serviceHarness({
		patch: s => {
			s.passive.enabled = false
		},
	})
	try {
		await h.service.start()
		const job = await h.service.createJob({
			sourceId: "rtl",
			mode: "in-window",
			protocols: ["dmr", "dpmr", "nxdn48"],
			ranges: [{ startHz: CENTRE - 100_000, endHz: CENTRE + 100_000 }],
		})
		const internal = h.service as unknown as {
			drivers: Map<string, JobRunner>
			probes: ProbePool
			onProbeState(id: string, state: string, req: ProbeRequest): void
		}
		const driver = internal.drivers.get(job.id)! as unknown as {
			requestProbe(
				live: LiveObservation,
				track: TrackSnapshot,
				holdMs: number,
			): unknown
		}
		const request = vi
			.spyOn(internal.probes, "request")
			.mockReturnValue({ deferred: "budget" })
		const track = makeTrack({ centreHz: CENTRE, obwHz: 9000 })
		const live = makeLive(track, {
			discoveryId: "d_same",
			jobIds: [job.id],
			classification: { class: "fsk4-6k25", hypotheses: [], tier: "spectral" },
		})
		driver.requestProbe(live, track, 6000)
		const first = request.mock.calls[0]![0]
		expect(first.modes!.length).toBeGreaterThan(2)
		// The queued probe starts later, then steps to its second mode.
		internal.onProbeState("p_queued", "starting", first)
		internal.onProbeState("p_queued", "starting", first)
		driver.requestProbe({ ...live, observationId: "o_next" }, track, 6000)
		const next = request.mock.calls[1]![0]
		expect(next.modes![0]).toEqual(first.modes![2])
		request.mockRestore()
	} finally {
		await h.service.stop()
		await rm(h.dir, { recursive: true, force: true })
	}
})

it.each(["fsk4-6k25", "carrier", "unknown"] as const)(
	"admits an explicitly allowed DMR trial despite the new observation class %s",
	async cls => {
		const h = serviceHarness({
			patch: s => {
				s.passive.enabled = false
			},
		})
		try {
			await h.service.start()
			const job = await h.service.createJob({
				sourceId: "rtl",
				mode: "in-window",
				protocols: ["dmr"],
				ranges: [{ startHz: CENTRE - 100_000, endHz: CENTRE + 100_000 }],
			})
			const internal = h.service as unknown as {
				needsConfirm(live: LiveObservation, track: TrackSnapshot): boolean
			}
			const track = makeTrack({ centreHz: CENTRE, obwHz: 9000, gate: "passed" })
			const live = makeLive(track, {
				jobIds: [job.id],
				classification: { class: cls, hypotheses: [], tier: "spectral" },
			})
			expect(internal.needsConfirm(live, track)).toBe(true)
		} finally {
			await h.service.stop()
			await rm(h.dir, { recursive: true, force: true })
		}
	},
)
