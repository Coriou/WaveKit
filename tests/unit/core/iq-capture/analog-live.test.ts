import { describe, expect, it } from "vitest"
import { createAnalogLiveRunner } from "../../../../src/core/iq-capture/analog-live.js"
import type { AnalogTrialResult } from "../../../../src/core/scanner/scanner-redesign-contract.js"
import type { IqCaptureRequest } from "../../../../src/core/scanner/iq-capture-contract.js"
import { WaveKitError } from "../../../../src/utils/errors.js"

const req: IqCaptureRequest = {
	sourceId: "source",
	observationId: null,
	epoch: 1,
	rfHz: 100000000,
	tuningTrust: "commanded",
	fromSample: 0,
	reason: "identify",
}

describe("private analog adapter trust boundary", () => {
	it.each([
		undefined,
		null,
		{},
		{ outcome: "unknown" },
		{
			outcome: "decoded",
			mode: "nfm",
			tones: { ctcssHz: 74.4, dcs: null, audioSeconds: 4 },
			voice: false,
			stats: null,
		},
		{ outcome: "heard", mode: "nfm", tones: {}, stats: null },
		{
			get outcome() {
				throw new TypeError("malformed")
			},
		},
	])("fails closed on malformed evidence %#", async raw => {
		const runner = createAnalogLiveRunner(
			{ withTrial: (_req, _signal, run) => run("private") },
			{ run: () => Promise.resolve(raw as AnalogTrialResult) },
		)
		const result = await runner.runLive!(
			req,
			"nfm",
			new AbortController().signal,
		)
		expect(result.outcome).toBe("no-sync")
		expect(result.error).toBeDefined()
		expect(result.tones).toEqual({ ctcssHz: null, dcs: null, audioSeconds: 0 })
	})

	it("a throwing native runner yields no evidence", async () => {
		const runner = createAnalogLiveRunner(
			{ withTrial: (_req, _signal, run) => run("private") },
			{
				run: () => {
					throw new WaveKitError("trial failed", "TRIAL_FAILED")
				},
			},
		)
		expect(
			(await runner.runLive!(req, "nfm", new AbortController().signal)).error,
		).toBe("unavailable")
	})

	it("reports the legacy proof restriction without evidence", async () => {
		const runner = createAnalogLiveRunner(
			{ withTrial: () => Promise.resolve("not-protected") },
			{
				run: () =>
					Promise.reject(new WaveKitError("unexpected", "TRIAL_FAILED")),
			},
		)
		const result = await runner.runLive!(
			req,
			"nfm",
			new AbortController().signal,
		)
		expect(result.error).toBe("not-protected")
		expect(result.outcome).toBe("no-sync")
	})
})

it("an abort before the lease returns suppresses a late positive result", async () => {
	const ac = new AbortController()
	const runner = createAnalogLiveRunner(
		{
			withTrial: () => {
				ac.abort()
				return Promise.resolve({
					outcome: "decoded",
					mode: "nfm",
					voice: false,
					tones: { ctcssHz: 74.4, dcs: null, audioSeconds: 4 },
					stats: null,
				})
			},
		},
		{
			run: () => Promise.reject(new WaveKitError("unexpected", "TRIAL_FAILED")),
		},
	)
	const result = await runner.runLive!(req, "nfm", ac.signal)
	expect(result.error).toBe("cancelled")
	expect(result.outcome).toBe("no-sync")
	expect(result.tones.ctcssHz).toBeNull()
})
