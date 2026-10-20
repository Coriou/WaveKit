import { describe, expect, it } from "vitest"
import {
	jobPhase,
	jobProgressFields,
} from "../../../../src/core/scanner/job-phase.js"
import type {
	JobActivityView,
	JobPhaseInput,
} from "../../../../src/core/scanner/scanner-redesign-contract.js"

const live = {
	protocol: "dmr" as const,
	decoder: "dsd-fme",
	transport: "offset" as const,
	discoveryId: "d_live",
	frequencyHz: 450_100_000,
	trackId: "t_live",
}
const hold = {
	discoveryId: "d_hold",
	frequencyHz: 450_200_000,
	trackId: "t_hold",
}
const replaying = {
	protocol: "pocsag" as const,
	decoder: "multimon-ng",
	discoveryId: "d_replay",
}

function activity(over: Partial<JobActivityView> = {}): JobActivityView {
	return {
		capturing: 0,
		replaying: null,
		replayQueueDepth: 0,
		...over,
	}
}

function input(over: Partial<JobPhaseInput> = {}): JobPhaseInput {
	return {
		schedulerPhase: null,
		parked: false,
		liveProbe: null,
		hold: null,
		activity: activity(),
		...over,
	}
}

describe("jobPhase precedence", () => {
	it.each([
		[
			"settling beats holding",
			input({ schedulerPhase: "tuning", hold }),
			"settling",
		],
		[
			"settling beats trialing",
			input({ schedulerPhase: "settling", parked: true, liveProbe: live }),
			"settling",
		],
		[
			"settling beats replaying",
			input({
				schedulerPhase: "tuning",
				activity: activity({ replaying }),
			}),
			"settling",
		],
		[
			"settling beats capturing",
			input({
				schedulerPhase: "settling",
				activity: activity({ capturing: 2 }),
			}),
			"settling",
		],
		[
			"settling beats watching",
			input({ schedulerPhase: "tuning" }),
			"settling",
		],
		[
			"holding beats trialing",
			input({ schedulerPhase: "hold", hold, parked: true, liveProbe: live }),
			"holding",
		],
		[
			"holding beats replaying",
			input({
				schedulerPhase: "dwell",
				hold,
				activity: activity({ replaying }),
			}),
			"holding",
		],
		[
			"holding beats capturing",
			input({ hold, activity: activity({ capturing: 1 }) }),
			"holding",
		],
		[
			"holding beats watching",
			input({ schedulerPhase: "hold", hold }),
			"holding",
		],
		[
			"trialing beats replaying",
			input({
				schedulerPhase: "dwell",
				parked: true,
				liveProbe: live,
				activity: activity({ replaying }),
			}),
			"trialing",
		],
		[
			"trialing beats capturing",
			input({
				parked: true,
				liveProbe: live,
				activity: activity({ capturing: 3 }),
			}),
			"trialing",
		],
		[
			"trialing beats watching",
			input({ parked: true, liveProbe: live }),
			"trialing",
		],
		[
			"replaying beats capturing",
			input({ activity: activity({ replaying, capturing: 4 }) }),
			"replaying",
		],
		[
			"replaying beats watching",
			input({ activity: activity({ replaying }) }),
			"replaying",
		],
		[
			"capturing beats watching",
			input({ activity: activity({ capturing: 1 }) }),
			"capturing",
		],
	] as const)("%s", (_name, row, phase) => {
		expect(jobPhase(row)).toBe(phase)
	})

	it("a live probe on a sweep that is not parked is not trialing", () => {
		expect(
			jobPhase(
				input({ schedulerPhase: "dwell", parked: false, liveProbe: live }),
			),
		).toBe("watching")
	})

	it("holding is the hold target and trialing is the live probe", () => {
		const held = jobProgressFields(
			input({ schedulerPhase: "dwell", hold }),
			1000,
		)
		expect(held.phase).toBe("holding")
		expect(held.holding).toEqual(hold)
		expect(held.trial).toBeUndefined()
		expect(held.sweepPeriodMs).toBe(1000)

		const trial = jobProgressFields(
			input({ parked: true, liveProbe: live }),
			1000,
		)
		expect(trial.phase).toBe("trialing")
		expect(trial.holding).toEqual({
			discoveryId: live.discoveryId,
			frequencyHz: live.frequencyHz,
			trackId: live.trackId,
		})
		expect(trial.trial).toEqual({
			protocol: live.protocol,
			decoder: live.decoder,
			transport: live.transport,
			discoveryId: live.discoveryId,
		})
		expect(trial.sweepPeriodMs).toBeNull()
	})

	it("a live trial wins over replay, including while settling", () => {
		const fields = jobProgressFields(
			input({
				schedulerPhase: "tuning",
				parked: true,
				liveProbe: live,
				hold,
				activity: activity({ replaying, replayQueueDepth: 4, capturing: 2 }),
			}),
			5000,
		)
		expect(fields.phase).toBe("settling")
		expect(fields.holding).toBeUndefined()
		expect(fields.trial).toEqual({
			protocol: "dmr",
			decoder: "dsd-fme",
			transport: "offset",
			discoveryId: "d_live",
		})
		expect(fields.replayQueueDepth).toBe(4)
		expect(fields.parked).toBe(true)
		expect(fields.sweepPeriodMs).toBeNull()
	})

	it("a replay trial is reported when nothing live is running", () => {
		const fields = jobProgressFields(
			input({
				schedulerPhase: "dwell",
				activity: activity({ replaying, replayQueueDepth: 2 }),
			}),
			250,
		)
		expect(fields.phase).toBe("replaying")
		expect(fields.holding).toBeUndefined()
		expect(fields.trial).toEqual({
			protocol: "pocsag",
			decoder: "multimon-ng",
			transport: "replay",
			discoveryId: "d_replay",
		})
		expect(fields.sweepPeriodMs).toBe(250)
	})
})
