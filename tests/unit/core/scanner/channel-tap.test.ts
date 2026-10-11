import { describe, expect, it, vi } from "vitest"
import { PassThrough } from "node:stream"
import { ChannelTaps } from "../../../../src/core/scanner/channel/channel-tap.js"
import type { ScannerChannelAttempt } from "../../../../src/core/scanner/channel/consumer-types.js"
import type { ChannelProvider } from "../../../../src/core/channelizer/types.js"
import type { PreparedScannerChannel } from "../../../../src/core/scanner/channel/provider-observer.js"
import { prepareDirectChannel } from "../../../../src/core/scanner/channel/provider-observer.js"

vi.mock("../../../../src/core/scanner/channel/provider-observer.js", () => ({
	prepareDirectChannel: vi.fn(),
}))

const attempt: ScannerChannelAttempt = {
	identity: {},
	sourceId: "s",
	decoderId: "tap",
	engine: {},
	engineInstanceId: "00000000-0000-4000-8000-000000000000",
	stream: 1,
	epoch: 1,
	captureRateHz: 2_048_000,
	captureCentreHz: 100_000_000,
	targetHz: 100_000_000,
	tuningTrust: "commanded",
	gainKey: "g",
}
describe("direct source tap admission", () => {
	it("default missing profile/ownership creates no source slot or classifier", async () => {
		const taps = new ChannelTaps({
				channels: null,
				ownership: undefined,
				profile: null,
				maxSources: 1,
				now: () => 0,
			}),
			collected = vi.fn()
		expect(
			taps.begin({ attempt, current: () => true, minMs: 500, collected }),
		).toBeUndefined()
		expect(taps.ownerCount).toBe(0)
		expect(await taps.stop()).toEqual({ ok: true })
		expect(collected).not.toHaveBeenCalled()
	})
	it("seal/currentness and bounds deny before buffer or callbacks", () => {
		const taps = new ChannelTaps({
				channels: null,
				ownership: undefined,
				profile: null,
				maxSources: 1,
				now: () => 0,
			}),
			collected = vi.fn()
		expect(
			taps.begin({ attempt, current: () => false, minMs: 500, collected }),
		).toBeUndefined()
		expect(
			taps.begin({ attempt, current: () => true, minMs: 2001, collected }),
		).toBeUndefined()
		taps.sealAdmission()
		expect(
			taps.begin({ attempt, current: () => true, minMs: 500, collected }),
		).toBeUndefined()
		expect(taps.ownerCount).toBe(0)
	})
})

function ownedTap() {
	// Consumer-only fake proofs: these schedules do not certify native receipts or numeric profiles.
	const stream = new PassThrough()
	let live = false,
		invalidated = false,
		physical = false,
		classifierState = "pending"
	let notifyEnded: () => void = () => undefined
	const classifier = {
		begin: vi.fn(() => true),
		settle: vi.fn(() => {
			classifierState = "settled"
		}),
		sealNeverStarted: vi.fn(() => {
			classifierState = "settled"
		}),
	}
	const analog = {
		begin: vi.fn(() => true),
		settle: vi.fn(),
		sealNeverStarted: vi.fn(),
	}
	const lifecycle = {
		get live() {
			return live
		},
		get readable() {
			return live ? stream : undefined
		},
		adopt: vi.fn(() => {
			live = !invalidated
			return live
		}),
		invalidate: vi.fn(() => {
			if (invalidated) return
			invalidated = true
			live = false
			notifyEnded()
			stream.destroy()
		}),
		logicalDrain: vi.fn(() => Promise.resolve()),
		reclaimIfSettled: () => physical,
	}
	const prepared = {
		classifier,
		analog,
		lifecycle,
		handle: {
			snapshot: () => ({ components: { classifier: classifierState } }),
		},
		request: {
			centerHz: attempt.targetHz,
			bandwidthHz: 16_000,
			transitionHz: 4_000,
			outputRateHz: 48_000,
			format: "cf32" as const,
		},
	} as unknown as PreparedScannerChannel
	vi.mocked(prepareDirectChannel).mockImplementation(input => {
		notifyEnded = input.ended
		return prepared
	})
	const requestChannel = vi.fn(async () => ({
		ok: true as const,
		stream,
		channelId: "opaque",
		generation: 1,
		realised: {
			outputRateHz: 48_000,
			format: "cf32" as const,
			groupDelaySamples: 2,
		},
	}))
	const taps = new ChannelTaps({
		channels: { requestChannel } as unknown as ChannelProvider,
		ownership: undefined,
		profile: null,
		maxSources: 1,
		now: () => 0,
	})
	return {
		taps,
		stream,
		classifier,
		analog,
		lifecycle,
		requestChannel,
		provePhysical: () => {
			physical = true
		},
		ready: async () => {
			await Promise.resolve()
			await Promise.resolve()
		},
	}
}

describe("bounded current tap intake and component drains", () => {
	it("partial pairs stay bounded and classifier runs once before analog can begin", async () => {
		const f = ownedTap(),
			collected = vi.fn()
		const tap = f.taps.begin({
			attempt,
			current: () => true,
			minMs: 500,
			collected,
		})!
		await f.ready()
		const bytes = Buffer.alloc(24_000 * 8)
		f.stream.write(bytes.subarray(0, 3))
		expect(collected).not.toHaveBeenCalled()
		f.stream.write(bytes.subarray(3))
		expect(collected).toHaveBeenCalledOnce()
		expect(collected.mock.calls[0]?.[0].samples.length).toBe(48_000)
		expect(f.classifier.settle).toHaveBeenCalledOnce()
		expect(tap.beginAnalog()).toBe(true)
		expect(tap.beginAnalog()).toBe(false)
		// Missing a begun analog owner is unknown; it cannot silently refund A.
		await expect(tap.finish()).rejects.toMatchObject({
			code: "SCANNER_CHANNEL_CLEANUP_PENDING",
		})
		expect(f.taps.ownerCount).toBe(1)
	})
	it("natural analog intake seal preserves grant until producer drain and keeps native tombstone", async () => {
		const f = ownedTap(),
			collected = vi.fn()
		const tap = f.taps.begin({
			attempt,
			current: () => true,
			minMs: 500,
			collected,
		})!
		await f.ready()
		f.stream.write(Buffer.alloc(24_000 * 8))
		expect(tap.beginAnalog()).toBe(true)
		let settle!: (value: { ok: true }) => void
		const settled = new Promise<{ ok: true }>(done => {
			settle = done
		})
		const push = vi.fn(),
			cancel = vi.fn()
		expect(tap.attachAnalog({ push, cancel, settled })).toBe(true)
		f.stream.write(Buffer.alloc(16))
		expect(push.mock.calls[0]?.[0].length).toBe(4)
		tap.sealIntake()
		expect(tap.current).toBe(true)
		f.stream.write(Buffer.alloc(16))
		expect(push).toHaveBeenCalledOnce()
		// Logical release returns without awaiting this same producer's settlement.
		await tap.releaseLogical()
		let drained = false
		const drain = tap.finish().then(() => {
			drained = true
		})
		await Promise.resolve()
		expect(drained).toBe(false)
		settle({ ok: true })
		await drain
		expect(f.analog.settle).toHaveBeenCalledWith({ ok: true })
		expect(f.taps.ownerCount).toBe(1)
		f.provePhysical()
		f.taps.tick()
		expect(f.taps.ownerCount).toBe(0)
	})
	it("reentrant cancellation shares the claimed drain and preserves first stop promise", async () => {
		const f = ownedTap(),
			collected = vi.fn()
		const tap = f.taps.begin({
			attempt,
			current: () => true,
			minMs: 500,
			collected,
		})!
		await f.ready()
		tap.cancel()
		const first = tap.finish()
		expect(tap.finish()).toBe(first)
		expect(f.lifecycle.invalidate).toHaveBeenCalled()
		await first
		const stop = f.taps.stop()
		expect(f.taps.stop()).toBe(stop)
		expect(await stop).toEqual({ ok: true })
		expect(collected).not.toHaveBeenCalled()
	})
})
