import { describe, expect, it } from "vitest"
import { EventEmitter } from "node:events"
import {
	ObservedPermitLedger,
	SettlementRegistry,
} from "../../../../src/core/channelizer/settlement-observer.js"
import {
	prepareChannelAdmission,
	updateChannelAdmission,
} from "../../../../src/core/scanner/plan/resource-admission.js"
import type { ScannerChannelProfile } from "../../../../src/core/scanner/channel/consumer-types.js"
import type { DecoderChannelRequest } from "../../../../src/core/channelizer/types.js"

const request = {
	centerHz: 100_000_000,
	bandwidthHz: 16_000,
	transitionHz: 4_000,
	outputRateHz: 48_000,
	format: "cf32" as const,
}
function fixture() {
	// Synthetic formula fixture, never a measured/adoptable profile.
	const registry = new SettlementRegistry()
	const observer = registry.createObserver(registry.registerProviderLifetime()!)
	const handle = observer.allocateAcquisition({
		activation: "direct",
		sourceId: "s",
		decoderId: "tap",
		expectedRequest: request,
		scannerAttempt: {},
		expectedInputCaps: {
			kind: "iq",
			format: "U8_IQ",
			sampleRate: 2_048_000,
			centerFreq: 100_000_000,
		},
	})!
	const ledger = new ObservedPermitLedger(
		{ cpu: 5, bytes: 10_000 },
		{ cpu: 1, bytes: 100 },
	)
	const profile: ScannerChannelProfile = {
		limits: { cpu: 5, bytes: 10_000 },
		baseline: { cpu: 1, bytes: 100 },
		baselineEngineCount: 1,
		baselineOffsetCount: 0,
		shapes: [
			{
				captureRateHz: 2_048_000,
				...request,
				nativeSend: { cpu: 0.1, bytes: 100 },
				process: { cpu: 0.2, bytes: 200 },
				downstream: {
					decoder: { cpu: 0, bytes: 0 },
					classifier: { cpu: 0.3, bytes: 300 },
					analog: { cpu: 0.4, bytes: 400 },
				},
			},
		],
	}
	return { registry, observer, handle, ledger, profile }
}
describe("private channel admission", () => {
	it.each(["workload", "budget"] as const)("uses the CURRENT %s ledger at dequeue, not the prepared snapshot (C4)", async change => {
		const f = fixture()
		const permit = prepareChannelAdmission({
			handle: f.handle, ledger: f.ledger, profile: f.profile,
			captureRateHz: 2_048_000, request, activation: "direct",
		})!
		expect(f.handle.attachPermit(permit)).toBe(true)
		expect(f.handle.arm()).toBe(true)
		const provider = Object.assign(new EventEmitter(), {
			requestChannel: (_source: string, _decoder: string, actual: DecoderChannelRequest) => {
				const handle = f.observer.takeAcquisition("s", "tap", actual)!
				const state = f.ledger.admissionSnapshot()
				expect(updateChannelAdmission(f.ledger, state.version,
					change === "workload" ? { cpu: 4, bytes: 100 } : state.baseline,
					change === "budget" ? { cpu: 1, bytes: 10_000 } : state.limits,
				)).toBe(true)
				expect(f.observer.tryReserveObservedTransaction(handle)).toBeUndefined()
				f.observer.finishAcquisition(handle)
				return Promise.resolve({ ok: false as const, reasonCode: "channelizer-unavailable" as const, detail: "fixture denial" })
			},
			releaseChannel: () => Promise.resolve(),
			currentGeneration: () => 0,
		})
		const channels = f.observer.bindProvider(provider)
		await channels.requestChannel("s", "tap", request, {
			kind: "iq", format: "U8_IQ", sampleRate: 2_048_000, centerFreq: 100_000_000,
		})
		expect(f.ledger.snapshot().committed).toEqual({ cpu: 0, bytes: 0 })
		expect(f.registry.snapshot().receipts).toBe(0)
		expect(f.registry.snapshot().owners).toEqual({ V: 1, P: 0, L: 0 })
	})

	it("missing ledger or coverage denies and preparation is uncharged", () => {
		const f = fixture()
		const base = {
			handle: f.handle,
			ledger: f.ledger,
			profile: f.profile,
			captureRateHz: 2_048_000,
			request,
			activation: "direct" as const,
		}
		expect(
			prepareChannelAdmission({ ...base, ledger: undefined }),
		).toBeUndefined()
		expect(prepareChannelAdmission({ ...base, profile: null })).toBeUndefined()
		expect(
			prepareChannelAdmission({ ...base, captureRateHz: 1_000_000 }),
		).toBeUndefined()
		expect(prepareChannelAdmission(base)).toBeDefined()
		expect(f.ledger.snapshot().committed).toEqual({ cpu: 0, bytes: 0 })
		expect(f.registry.snapshot().receipts).toBe(0)
		expect(f.registry.snapshot().owners).toEqual({ V: 1, P: 0, L: 0 })
	})
	it("ambiguous coverage and invented direct decoder costs deny", () => {
		const f = fixture(),
			shape = f.profile.shapes[0]!
		const base = {
			handle: f.handle,
			ledger: f.ledger,
			captureRateHz: 2_048_000,
			request,
			activation: "direct" as const,
		}
		expect(
			prepareChannelAdmission({
				...base,
				profile: { ...f.profile, shapes: [shape, shape] },
			}),
		).toBeUndefined()
		expect(
			prepareChannelAdmission({
				...base,
				profile: {
					...f.profile,
					shapes: [
						{
							...shape,
							downstream: {
								...shape.downstream,
								decoder: { cpu: 0.1, bytes: 1 },
							},
						},
					],
				},
			}),
		).toBeUndefined()
	})
	it("baseline updates reject stale versions and unsafe physical bytes", () => {
		const f = fixture(),
			version = f.ledger.admissionSnapshot().version
		expect(
			updateChannelAdmission(
				f.ledger,
				version,
				{ cpu: 2, bytes: 200 },
				f.profile.limits,
			),
		).toBe(true)
		expect(
			updateChannelAdmission(
				f.ledger,
				version,
				{ cpu: 0, bytes: 0 },
				f.profile.limits,
			),
		).toBe(false)
		expect(
			updateChannelAdmission(
				f.ledger,
				version + 1,
				{ cpu: 2, bytes: Number.MAX_SAFE_INTEGER + 1 },
				f.profile.limits,
			),
		).toBe(false)
		expect(f.ledger.admissionSnapshot().baseline).toEqual({
			cpu: 2,
			bytes: 200,
		})
	})
})
