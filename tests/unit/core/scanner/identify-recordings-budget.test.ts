/**
 * Identify's dsd-fme trials against background recordings, through the production composition
 * (ScannerService, its ProbePool and identify runner, in-process fakes, no network). Each wideband
 * analog recording reserves widebandSessionCores(rate) in the probes' CPU budget
 * (ProbePool.reserveExternal), exactly as the recorder does.
 *
 * Arithmetic (cpuBudgetCores 1, one engine): engine 0.08 + offset probe 0.5 = 0.58 leaves 0.42 for
 * recordings. One recording at 2.4 Msps is (50 + 9 * 2.4) / 1000 = 0.0716 cores; 5 of them hold
 * 0.358 (fits: 0.938 <= 1, still 0.9972 with the service's own recorder session on the test signal
 * at 1.024 Msps, 0.0592), 6 hold 0.4296 (0.08 + 0.4296 + 0.5 = 1.0096 > 1). Six concurrent
 * recordings used to skip every dsd-fme trial `skipped-budget` with no probe running and a status
 * `cpuCoresInUse` of 0.08. Now identify (a user request) is admitted when only the recordings'
 * reservations are over (engines + probes + its probe <= budget); recordings already running go on,
 * and new ones are admitted beside it (engines + job probes + reservations + new <= budget: identify's
 * 0.5 does not count), so neither waits on the other. Seventh recording: 0.08 + 6 x 0.0716 (+ 0.0592)
 * + 0.0716 = 0.5812 (0.6404) <= 1; the full estimate is then at most budget + identify's 0.5.
 */
import { describe, expect, it } from "vitest"
import type { ScannerIdentifyTrial } from "@wavekit/api-types"
import type { DecoderConfig } from "../../../../src/decoders/types.js"
import { widebandSessionCores } from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import { CPU_COST } from "../../../../src/core/scanner/plan/cost.js"
import {
	CENTRE,
	FS,
	serviceHarness,
	tick,
} from "../../../mocks/scanner/service-fakes.js"
import {
	addInto,
	fsk4Burst,
	gaussianNoise,
	mulberry32,
	packCu8,
} from "../../../mocks/scanner/signals.js"

const OFFSET_HZ = 100_000
const AUTO = ["dmr", "ysf", "p25p1", "dstar"]
const RECORDING_CORES = widebandSessionCores(2_400_000)
const BUDGET = 1

const ambientDsd: DecoderConfig = {
	id: "dsd-ambient",
	type: "dsd-fme",
	enabled: true,
	sourceId: "rtl",
	options: { mode: "auto" },
}

interface Internals {
	probes: {
		reserveExternal(cores: number): (() => void) | null
		externalCoresInUse(): number
	}
}

async function run(recordings: number): Promise<{
	trials: ScannerIdentifyTrial[]
	inUseBefore: number
	inUseDuring: number
	externalBefore: number
	externalDuring: number
	newRecordingDuring: boolean
}> {
	const h = serviceHarness({
		decoderConfigs: [ambientDsd],
		patch: s => {
			s.cpuBudgetCores = BUDGET
		},
	})
	await h.service.start()
	const rng = mulberry32(7)
	const n = FS / 20
	const feed = (): void => {
		const iq = addInto(
			gaussianNoise(rng, n, 0.01),
			fsk4Burst(rng, n, FS, OFFSET_HZ, 0.5),
		)
		h.fanout.write(Buffer.from(packCu8(iq.re, iq.im)))
	}
	try {
		for (let i = 0; i < 20; i++) {
			feed()
			await tick(50)
		}
		const svc = h.service as unknown as Internals
		for (let i = 0; i < recordings; i++)
			expect(svc.probes.reserveExternal(RECORDING_CORES)).not.toBeNull()
		const inUseBefore = h.service.status().budgets.cpuCoresInUse
		const externalBefore = svc.probes.externalCoresInUse()
		const job = await h.service.identify({
			sourceId: "rtl",
			target: { frequencyHz: CENTRE + OFFSET_HZ },
			timeoutMs: 30_000,
			record: false,
		})
		const trials = (): ScannerIdentifyTrial[] =>
			h.service.getJob(job.id)?.identify?.targets[0]?.trials ?? []
		let inUseDuring = inUseBefore
		let newRecordingDuring = false
		let externalDuring = externalBefore
		for (let i = 0; i < 400; i++) {
			feed()
			await tick(50)
			const dmr = trials().find(t => t.protocol === "dmr")
			if (dmr && dmr.outcome !== "pending") {
				inUseDuring = h.service.status().budgets.cpuCoresInUse
				externalDuring = svc.probes.externalCoresInUse()
				const extra = svc.probes.reserveExternal(RECORDING_CORES)
				newRecordingDuring = extra !== null
				extra?.()
				break
			}
		}
		return {
			trials: trials(),
			inUseBefore,
			inUseDuring,
			externalBefore,
			externalDuring,
			newRecordingDuring,
		}
	} finally {
		await h.service.stop()
	}
}

describe("identify dsd-fme trials against background recordings (real wiring)", () => {
	it("arithmetic: 5 recordings leave room for the offset probe, 6 do not", () => {
		expect(RECORDING_CORES).toBeCloseTo(0.0716, 9)
		const fixed = CPU_COST.engine + CPU_COST.offsetProbe
		expect(fixed + 5 * RECORDING_CORES).toBeLessThanOrEqual(BUDGET)
		expect(fixed + 6 * RECORDING_CORES).toBeGreaterThan(BUDGET)
	})

	it("at the bound (5 recordings): the auto run starts on the offset transport", async () => {
		const { trials } = await run(5)
		const auto = trials.filter(t => AUTO.includes(t.protocol))
		expect(auto).toHaveLength(AUTO.length)
		for (const t of auto) expect(["running", "no-sync"]).toContain(t.outcome)
	}, 120_000)

	it("past the bound (6 recordings): the auto run still starts; running recordings keep their cores, new ones are still admitted", async () => {
		const r = await run(6)
		const auto = r.trials.filter(t => AUTO.includes(t.protocol))
		expect(auto).toHaveLength(AUTO.length)
		for (const t of auto) {
			expect(t).toMatchObject({ decoder: "dsd-fme", transport: "offset" })
			expect(["running", "no-sync"]).toContain(t.outcome)
		}
		// Identify's probe does not count against a recording: a recording starting now is not cut.
		expect(r.newRecordingDuring).toBe(true)
	}, 120_000)

	it("budgets.cpuCoresInUse counts the recordings' reservations", async () => {
		const r = await run(6)
		// The six reservations, plus the service's own recorder session on the test signal if one runs.
		expect(r.externalBefore).toBeGreaterThanOrEqual(6 * RECORDING_CORES - 1e-9)
		expect(r.inUseBefore).toBeCloseTo(CPU_COST.engine + r.externalBefore, 9)
		expect(r.inUseDuring).toBeCloseTo(
			CPU_COST.engine + r.externalDuring + CPU_COST.offsetProbe,
			9,
		)
		// Over the budget while identify runs (the bounded overshoot), never cut below the held six.
		expect(r.externalDuring).toBeGreaterThanOrEqual(6 * RECORDING_CORES - 1e-9)
		expect(r.inUseDuring).toBeGreaterThan(BUDGET)
		expect(r.inUseDuring).toBeLessThanOrEqual(
			BUDGET + CPU_COST.offsetProbe + 1e-9,
		)
	}, 120_000)
})
