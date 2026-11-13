/**
 * Identify on a continuous 4FSK signal through the production composition (ScannerService, its
 * ProbePool and identify runner, in-process fakes, no network), with a configured dsd-fme decoder
 * on the source. A lower-priority probe holds the single offset slot when identify starts and its
 * decoder takes longer than IDENTIFY_QUEUE_WAIT_MS to stop (a real decoder may take its 5 s
 * graceful stop). The dsd-fme `auto` run (dmr, ysf, p25p1, dstar) used to end `skipped-budget`
 * at 3 s while the slot was being freed for it; it now waits for that slot and runs.
 */
import { describe, expect, it } from "vitest"
import type { ScannerIdentifyTrial } from "@wavekit/api-types"
import type { DecoderConfig } from "../../../../src/decoders/types.js"
import {
	IDENTIFY_QUEUE_WAIT_MS,
	IDENTIFY_SLOT_FREEING_MAX_MS,
	identifyQueueSkipWhy,
} from "../../../../src/core/scanner/identify.js"
import type { ProbeRequest } from "../../../../src/core/scanner/probes/probe-pool.js"
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

const ambientDsd: DecoderConfig = {
	id: "dsd-ambient",
	type: "dsd-fme",
	enabled: true,
	sourceId: "rtl",
	options: { mode: "auto" },
}

interface Internals {
	probes: { request(r: ProbeRequest): unknown }
	spectrum: { engine(id: string): { currentEpoch(): { epoch: number } } }
}

async function run(opts: {
	holderPriority: number
	stopMs: number
}): Promise<{ trials: ScannerIdentifyTrial[]; elapsedMs: number }> {
	const h = serviceHarness({ decoderConfigs: [ambientDsd] })
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
		// Decoders stop slowly from here on.
		const decoders = h.decoders as unknown as {
			removeEphemeralDecoder(id: string): Promise<void>
		}
		const remove = decoders.removeEphemeralDecoder.bind(h.decoders)
		decoders.removeEphemeralDecoder = async (id: string) => {
			await tick(opts.stopMs)
			await remove(id)
		}
		const svc = h.service as unknown as Internals
		const epoch = svc.spectrum.engine("rtl").currentEpoch().epoch
		expect(
			svc.probes.request({
				jobId: "holder",
				priority: opts.holderPriority,
				sourceId: "rtl",
				trackId: "holder-track",
				observationId: "holder-obs",
				discoveryId: null,
				targetHz: CENTRE + OFFSET_HZ,
				epoch,
				cls: "fsk4-12k5",
				protocols: [],
				preRollFromSample: null,
				holdMs: 600_000,
				record: false,
				admission: { kind: "undecoded", snrDb: 40 },
			}),
		).toHaveProperty("started")
		expect(h.service.status().budgets.probesInUse.offset).toBe(1)
		const startedAt = Date.now()
		const job = await h.service.identify({
			sourceId: "rtl",
			target: { frequencyHz: CENTRE + OFFSET_HZ },
			timeoutMs: 30_000,
			record: false,
		})
		const trials = (): ScannerIdentifyTrial[] =>
			h.service.getJob(job.id)?.identify?.targets[0]?.trials ?? []
		// Until the auto run has left the queue (started or skipped).
		for (let i = 0; i < 400; i++) {
			feed()
			await tick(50)
			const dmr = trials().find(t => t.protocol === "dmr")
			if (dmr && dmr.outcome !== "pending") break
		}
		return { trials: trials(), elapsedMs: Date.now() - startedAt }
	} finally {
		await h.service.stop()
	}
}

describe("identify dsd-fme trials on a continuous 4FSK signal (real wiring)", () => {
	it("a preempted probe stopping past the queue wait: the auto run waits for its slot and runs", async () => {
		const { trials } = await run({
			holderPriority: 50,
			stopMs: IDENTIFY_QUEUE_WAIT_MS + 1000,
		})
		const auto = trials.filter(t => AUTO.includes(t.protocol))
		expect(auto.map(t => t.protocol).sort()).toEqual([...AUTO].sort())
		for (const t of auto) {
			expect(t).toMatchObject({
				decoder: "dsd-fme",
				mode: "auto",
				transport: "offset",
			})
			expect(["running", "no-sync"]).toContain(t.outcome)
		}
	}, 120_000)

	it("a slot nobody frees (another identify's probe): skipped after the queue wait", async () => {
		const { trials } = await run({ holderPriority: 101, stopMs: 0 })
		const auto = trials.filter(t => AUTO.includes(t.protocol))
		expect(auto).toHaveLength(AUTO.length)
		for (const t of auto) expect(t.outcome).toBe("skipped-budget")
	}, 120_000)

	it("a stop that outlasts the bound: the run waits IDENTIFY_SLOT_FREEING_MAX_MS, no longer, then is skipped", async () => {
		const { trials, elapsedMs } = await run({
			holderPriority: 50,
			stopMs: IDENTIFY_SLOT_FREEING_MAX_MS + 3000,
		})
		const auto = trials.filter(t => AUTO.includes(t.protocol))
		expect(auto).toHaveLength(AUTO.length)
		for (const t of auto) expect(t.outcome).toBe("skipped-budget")
		// Queued after the job started; skipped once the bound passed, well before the stop ends.
		expect(elapsedMs).toBeGreaterThanOrEqual(IDENTIFY_SLOT_FREEING_MAX_MS)
		expect(elapsedMs).toBeLessThan(IDENTIFY_SLOT_FREEING_MAX_MS + 3000)
	}, 120_000)
})

describe("identifyQueueSkipWhy", () => {
	it("names the real reason a queued run was skipped", () => {
		expect(identifyQueueSkipWhy("max-probes", false)).toBe("slot-busy")
		expect(identifyQueueSkipWhy("budget", false)).toBe("cpu-budget")
		expect(identifyQueueSkipWhy("cpu", false)).toBe("cpu-guard")
		expect(identifyQueueSkipWhy(null, false)).toBe("unknown")
		expect(identifyQueueSkipWhy("max-probes", true)).toBe("slot-still-freeing")
	})
})
