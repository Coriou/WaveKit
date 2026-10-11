import { describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { ChildProcess } from "node:child_process"
import type { ChannelProvider } from "../../../../src/core/channelizer/types.js"
import type {
	ChannelRequestResult,
	DecoderChannelRequest,
} from "../../../../src/core/channelizer/types.js"
import { ChannelTaps } from "../../../../src/core/scanner/channel/channel-tap.js"
import { prepareDirectChannel } from "../../../../src/core/scanner/channel/provider-observer.js"
import type {
	ScannerChannelAttempt,
	ScannerChannelOwnership,
	ScannerChannelProfile,
} from "../../../../src/core/scanner/channel/consumer-types.js"
import { ScannerLifecycleOwner } from "../../../../src/core/scanner/channel/consumer-lifecycle.js"
import {
	ObservedPermitLedger,
	SettlementRegistry,
} from "../../../../src/core/channelizer/settlement-observer.js"
import type {
	ObservedAcquisitionHandle,
	ProcessClaim,
} from "../../../../src/core/channelizer/settlement-observer.js"

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

function realCaller(queued = false) {
	// Actual accepted registry/forwarder/components; only process/network facts are synthetic.
	const registry = new SettlementRegistry()
	const lifetime = registry.registerProviderLifetime()!
	const observer = registry.createObserver(lifetime)
	const ledger = new ObservedPermitLedger(
		{ cpu: 10, bytes: 10_000 },
		{ cpu: 1, bytes: 100 },
	)
	const stream = new PassThrough()
	const request = {
		centerHz: attempt.targetHz,
		bandwidthHz: 16_000,
		transitionHz: 4000,
		outputRateHz: 48_000,
		format: "cf32" as const,
	}
	const profile: ScannerChannelProfile = {
		limits: { cpu: 10, bytes: 10_000 },
		baseline: { cpu: 1, bytes: 100 },
		baselineEngineCount: 1,
		baselineOffsetCount: 0,
		shapes: [
			{
				...request,
				captureRateHz: attempt.captureRateHz,
				nativeSend: { cpu: 0.1, bytes: 100 },
				process: { cpu: 0.1, bytes: 100 },
				downstream: {
					decoder: { cpu: 0, bytes: 0 },
					classifier: { cpu: 0.1, bytes: 100 },
					analog: { cpu: 0.1, bytes: 100 },
				},
			},
		],
	}
	let captured: ObservedAcquisitionHandle | undefined
	let process: ProcessClaim | undefined
	let deny!: () => void
	const held = new Promise<ChannelRequestResult>(resolve => {
		deny = () => {
			observer.finishAcquisition(captured!)
			resolve({
				ok: false,
				reasonCode: "channelizer-unavailable",
				detail: "fixture denied",
			})
		}
	})
	const underlying = Object.assign(new EventEmitter(), {
		requestChannel: (
			_sourceId: string,
			_decoderId: string,
			actual: DecoderChannelRequest,
		): Promise<ChannelRequestResult> => {
			captured = observer.takeAcquisition(
				attempt.sourceId,
				attempt.decoderId,
				actual,
			)!
			if (queued) return held
			const tx = observer.tryReserveObservedTransaction(captured)!
			process = observer.claimProcess(tx, {
				sourceId: attempt.sourceId,
				generation: 1,
				sampleRateHz: attempt.captureRateHz,
				centerHz: attempt.captureCentreHz,
			})!
			expect(process.beginSpawn()).toBe(true)
			process.recordReturnedChild(new EventEmitter() as ChildProcess)
			process.recordStartSettled()
			const send = observer.claimSend(tx, process, "opaque")!
			observer.recordTerminal(
				observer.captureTerminal(process, send.id, "opened")!,
				"opened",
			)
			const realised = {
				outputRateHz: 48_000,
				format: "cf32" as const,
				groupDelaySamples: 2,
				filterTaps: 5,
			}
			observer.recordGrant(send, {
				sourceId: attempt.sourceId,
				decoderId: attempt.decoderId,
				channelId: send.id,
				generation: 1,
				realised,
				process,
				send,
			})
			observer.finishAcquisition(captured)
			return Promise.resolve({
				ok: true,
				stream,
				channelId: send.id,
				generation: 1,
				realised,
			})
		},
		releaseChannel: () => {
			stream.destroy()
			return Promise.resolve()
		},
		currentGeneration: () => 1,
	})
	// EventEmitter's generic off signature is broader than the private never[] provider remover.
	const requestChannel = vi.spyOn(underlying, "requestChannel")
	const channels = observer.bindProvider(
		underlying as unknown as ChannelProvider,
	)
	const construction = new ScannerLifecycleOwner()
	construction.completeConstruction({ ok: true })
	const ownership = { lifetime, observer, ledger, construction }
	const taps = new ChannelTaps({
		channels,
		ownership,
		profile,
		maxSources: 1,
		now: () => 0,
	})
	return {
		registry,
		observer,
		lifetime,
		ownership,
		profile,
		channels,
		request,
		requestChannel,
		taps,
		stream,
		deny,
		physical: () => {
			process!.recordActualClose()
			process!.recordStdioSettled()
		},
		gap: () => {
			// Uses the agreed exact core capture/delivery seam, not public ID/gen inference.
			const send = observer.captureDiscontinuity(process!, "opaque", 1)!
			expect(send).toBeDefined()
			underlying.emit(
				"channel-discontinuity",
				"opaque",
				1,
				12_000,
				20,
				"input-gap",
			)
			observer.publishCapturedDiscontinuity(send)
		},
	}
}

describe("real caller component/reference integration", () => {
	it("a captured real forwarded live gap makes 250+250ms discontinuous (C5)", async () => {
		const f = realCaller()
		const collected = vi.fn()
		const tap = f.taps.begin({
			attempt,
			current: () => true,
			minMs: 500,
			collected,
		})!
		await Promise.resolve()
		await Promise.resolve()
		await Promise.resolve()
		f.stream.write(Buffer.alloc(12_000 * 8))
		expect(collected).not.toHaveBeenCalled()
		f.gap()
		f.stream.write(Buffer.alloc(12_000 * 8))
		expect(collected.mock.calls[0]?.[0].gaps).toBe(true)
		expect(tap.current).toBe(false)
		expect(tap.beginAnalog()).toBe(false)
		await tap.finish()
		f.physical()
		f.taps.sweepSettledReferences()
	})
	it("a live analog gap synchronously cuts intake while actual component drains stay held (C5)", async () => {
		const f = realCaller()
		const tap = f.taps.begin({
			attempt,
			current: () => true,
			minMs: 500,
			collected: vi.fn(),
		})!
		await Promise.resolve()
		await Promise.resolve()
		await Promise.resolve()
		f.stream.write(Buffer.alloc(24_000 * 8))
		expect(tap.beginAnalog()).toBe(true)
		let settle!: (value: { ok: true }) => void
		const held = new Promise<{ ok: true }>(resolve => {
			settle = resolve
		})
		const push = vi.fn(),
			cancel = vi.fn()
		expect(
			tap.attachAnalog({
				push,
				cancel,
				settled: held,
				filesystemSettled: held,
				operationSettled: held,
			}),
		).toBe(true)
		f.stream.write(Buffer.alloc(16))
		expect(push).toHaveBeenCalledOnce()
		f.gap()
		expect(cancel).toHaveBeenCalledOnce()
		f.stream.emit("data", Buffer.alloc(16))
		expect(push).toHaveBeenCalledOnce()
		let drained = false
		const drain = tap.finish().then(() => {
			drained = true
		})
		await Promise.resolve()
		expect(drained).toBe(false)
		settle({ ok: true })
		await drain
		f.physical()
		f.taps.sweepSettledReferences()
	})
	it("no recording explicitly settles all five slots and phase66 reclaims without a tick (C1/C2)", async () => {
		const f = realCaller()
		const collected = vi.fn()
		const tap = f.taps.begin({
			attempt,
			current: () => true,
			minMs: 500,
			collected,
		})!
		await Promise.resolve()
		await Promise.resolve()
		await Promise.resolve()
		f.stream.write(Buffer.alloc(24_000 * 8))
		expect(collected).toHaveBeenCalledOnce()
		await tap.finish()
		expect(tap.prepared.handle.snapshot().components).toEqual({
			decoder: "settled",
			classifier: "settled",
			analog: "settled",
			filesystem: "settled",
			operation: "settled",
		})
		expect(f.taps.ownerCount).toBe(1)
		f.physical()
		f.taps.sweepSettledReferences()
		expect(f.taps.ownerCount).toBe(0)
		expect(f.registry.snapshot().acquisitions).toEqual([])
	})
	it("queued cancellation seals actual slots after denial and detaches without native wait or tick (C2)", async () => {
		const f = realCaller(true)
		const tap = f.taps.begin({
			attempt,
			current: () => true,
			minMs: 500,
			collected: vi.fn(),
		})!
		const stop = f.taps.stop()
		f.deny()
		expect(await stop).toEqual({ ok: true })
		expect(tap.prepared.handle.snapshot().native).toBe("settled")
		expect(f.taps.ownerCount).toBe(0)
		expect(f.registry.snapshot().acquisitions).toEqual([])
	})
})
describe("observed direct preparation", () => {
	it("rejects present but ineligible profiles before allocating any request identity (C8)", () => {
		const registry = new SettlementRegistry()
		const lifetime = registry.registerProviderLifetime()!
		const observer = registry.createObserver(lifetime)
		const allocate = vi.spyOn(observer, "allocateAcquisition")
		const request = {
			centerHz: 100_000_000,
			bandwidthHz: 16_000,
			transitionHz: 4000,
			outputRateHz: 48_000,
			format: "cf32" as const,
		}
		const requestChannel = vi.fn<ChannelProvider["requestChannel"]>()
		const channels = Object.assign(new EventEmitter(), {
			requestChannel,
			releaseChannel: vi.fn<ChannelProvider["releaseChannel"]>(),
			currentGeneration: () => 1,
		}) as unknown as ChannelProvider
		const ownership: ScannerChannelOwnership = {
			lifetime,
			observer,
			ledger: new ObservedPermitLedger(
				{ cpu: 10, bytes: 10_000 },
				{ cpu: 1, bytes: 100 },
			),
			construction: new ScannerLifecycleOwner(),
		}
		const shape = {
			...request,
			captureRateHz: attempt.captureRateHz,
			nativeSend: { cpu: 0.1, bytes: 100 },
			process: { cpu: 0.1, bytes: 100 },
			downstream: {
				decoder: { cpu: 0, bytes: 0 },
				classifier: { cpu: 0.1, bytes: 100 },
				analog: { cpu: 0.1, bytes: 100 },
			},
		}
		const profile: ScannerChannelProfile = {
			limits: { cpu: 10, bytes: 10_000 },
			baseline: { cpu: 1, bytes: 100 },
			baselineEngineCount: 1,
			baselineOffsetCount: 0,
			shapes: [shape],
		}
		const invalidProfiles: ScannerChannelProfile[] = [
			{ ...profile, shapes: [] },
			{ ...profile, shapes: [shape, shape] },
			{ ...profile, shapes: [{ ...shape, captureRateHz: 1_000_000 }] },
			{ ...profile, baselineEngineCount: -1 },
			{ ...profile, limits: { cpu: Infinity, bytes: 100 } },
			{
				...profile,
				shapes: [
					{ ...shape, process: { cpu: 1, bytes: Number.MAX_SAFE_INTEGER + 1 } },
				],
			},
			{
				...profile,
				shapes: [
					{
						...shape,
						downstream: { ...shape.downstream, decoder: { cpu: 1, bytes: 1 } },
					},
				],
			},
		]
		for (const invalid of invalidProfiles) {
			expect(
				prepareDirectChannel({
					channels,
					ownership,
					profile: invalid,
					attempt,
					request,
					current: () => true,
					ended: vi.fn(),
				}),
			).toBeUndefined()
		}
		expect(allocate).not.toHaveBeenCalled()
		expect(requestChannel).not.toHaveBeenCalled()
		expect(registry.snapshot().queued).toBe(0)
		expect(ownership.ledger!.snapshot().committed).toEqual({ cpu: 0, bytes: 0 })
	})
	it("absent profile/ledger denies before allocate, arm or any provider effect", () => {
		const registry = new SettlementRegistry(),
			lifetime = registry.registerProviderLifetime()!
		const observer = registry.createObserver(lifetime),
			allocate = vi.spyOn(observer, "allocateAcquisition")
		const ownership: ScannerChannelOwnership = {
			lifetime,
			observer,
			construction: new ScannerLifecycleOwner(),
		}
		const request = {
			centerHz: 100_000_000,
			bandwidthHz: 16_000,
			transitionHz: 4000,
			outputRateHz: 48_000,
			format: "cf32" as const,
		}
		expect(
			prepareDirectChannel({
				channels: null,
				ownership,
				profile: null,
				attempt,
				request,
				current: () => true,
				ended: vi.fn(),
			}),
		).toBeUndefined()
		expect(allocate).not.toHaveBeenCalled()
		expect(registry.snapshot().queued).toBe(0)
		expect(registry.snapshot().receipts).toBe(0)
	})
})

describe("NC1 exact runtime registration continuations", () => {
	it.each(["classifier", "analog"] as const)(
		"cancellation inside %s data registration removes the late exact callback",
		async phase => {
			const f = realCaller()
			const unrelated = vi.fn()
			f.stream.on("data", unrelated)
			let cancel!: () => void
			const reenter = (event: string | symbol): void => {
				if (event === "data") cancel()
			}
			if (phase === "classifier") f.stream.on("newListener", reenter)
			const tap = f.taps.begin({
				attempt,
				current: () => true,
				minMs: 500,
				collected: vi.fn(),
			})!
			cancel = () => tap.cancel()
			await Promise.resolve()
			await Promise.resolve()
			await Promise.resolve()
			if (phase === "analog") {
				f.stream.write(Buffer.alloc(24_000 * 8))
				expect(tap.beginAnalog()).toBe(true)
				f.stream.on("newListener", reenter)
				const push = vi.fn(),
					canceled = vi.fn()
				const settled = Promise.resolve({ ok: true as const })
				expect(
					tap.attachAnalog({
						push,
						cancel: canceled,
						settled,
						filesystemSettled: settled,
						operationSettled: settled,
					}),
				).toBe(false)
				f.stream.emit("data", Buffer.alloc(16))
				expect(push).not.toHaveBeenCalled()
				expect(canceled).toHaveBeenCalledOnce()
			}
			await tap.finish()
			expect(f.stream.listeners("data")).toEqual([unrelated])
			expect(f.taps.ownerCount).toBe(1)
			f.physical()
			f.taps.sweepSettledReferences()
			expect(f.taps.ownerCount).toBe(0)
			expect(f.registry.snapshot().acquisitions).toEqual([])
		},
	)
	it.each(["classifier", "analog"] as const)(
		"failed exact %s data remover remains owned even after native closure",
		async phase => {
			const f = realCaller()
			const tap = f.taps.begin({
				attempt,
				current: () => true,
				minMs: 500,
				collected: vi.fn(),
			})!
			await Promise.resolve()
			await Promise.resolve()
			await Promise.resolve()
			if (phase === "analog") {
				f.stream.write(Buffer.alloc(24_000 * 8))
				expect(tap.beginAnalog()).toBe(true)
				const settled = Promise.resolve({ ok: true as const })
				expect(
					tap.attachAnalog({
						push: vi.fn(),
						cancel: vi.fn(),
						settled,
						filesystemSettled: settled,
						operationSettled: settled,
					}),
				).toBe(true)
			}
			const original = f.stream.off.bind(f.stream)
			vi.spyOn(f.stream, "off").mockImplementation((event, callback) => {
				if (event === "data") throw new TypeError("exact off unavailable")
				return original(event, callback)
			})
			tap.cancel()
			await expect(tap.finish()).rejects.toMatchObject({
				code: "SCANNER_CHANNEL_CLEANUP_PENDING",
			})
			expect(f.stream.listenerCount("data")).toBe(1)
			if (phase === "analog")
				expect(tap.prepared.handle.snapshot().components.analog).toBe("unknown")
			f.physical()
			f.taps.sweepSettledReferences()
			expect(f.taps.ownerCount).toBe(1)
			expect(f.registry.snapshot().acquisitions).toHaveLength(1)
		},
	)
})

describe("NC3 denied preparation ownership", () => {
	it("late currentness denial reclaims actual empty metadata repeatedly before returning", () => {
		const f = realCaller()
		for (let index = 0; index < 70; index++) {
			let calls = 0
			expect(
				prepareDirectChannel({
					channels: f.channels,
					ownership: f.ownership,
					profile: f.profile,
					attempt: { ...attempt, identity: {}, decoderId: `denied-${index}` },
					request: f.request,
					current: () => ++calls === 1,
					ended: vi.fn(),
				}),
			).toBeUndefined()
			expect(f.registry.snapshot().acquisitions).toEqual([])
			expect(f.registry.snapshot().queued).toBe(0)
		}
		expect(f.requestChannel).not.toHaveBeenCalled()
		expect(f.ownership.ledger.snapshot().committed).toEqual({
			cpu: 0,
			bytes: 0,
		})
	})
	it("arm collision cleans only the denied original, leaving the existing unclaimed arm", () => {
		const f = realCaller()
		const prepare = () =>
			prepareDirectChannel({
				channels: f.channels,
				ownership: f.ownership,
				profile: f.profile,
				attempt: { ...attempt, identity: {} },
				request: f.request,
				current: () => true,
				ended: vi.fn(),
			})
		const original = prepare()!
		expect(original).toBeDefined()
		expect(prepare()).toBeUndefined()
		expect(f.registry.snapshot().acquisitions).toHaveLength(1)
		expect(f.requestChannel).not.toHaveBeenCalled()
		original.lifecycle.invalidate()
		for (const component of [
			original.classifier,
			original.analog,
			original.filesystem,
			original.operation,
		])
			component.sealNeverStarted()
		original.handle.revokeUnclaimedArm()
		expect(original.lifecycle.reclaimIfSettled()).toBe(true)
		expect(f.registry.snapshot().acquisitions).toEqual([])
	})
	it("unknown denial cleanup retains a closing source owner reachable by stop and final sweep", async () => {
		const f = realCaller()
		const allocate = f.observer.allocateAcquisition.bind(f.observer)
		vi.spyOn(f.observer, "allocateAcquisition").mockImplementation(spec => {
			const handle = allocate(spec)!
			const onChange = handle.onChange.bind(handle)
			vi.spyOn(handle, "onChange").mockImplementation(callback => {
				onChange(callback)
				return () => {
					throw new TypeError("unsubscribe unknown")
				}
			})
			return handle
		})
		let calls = 0
		expect(
			f.taps.begin({
				attempt,
				current: () => ++calls < 3,
				minMs: 500,
				collected: vi.fn(),
			}),
		).toBeUndefined()
		expect(f.taps.ownerCount).toBe(1)
		expect(f.requestChannel).not.toHaveBeenCalled()
		expect(await f.taps.stop()).toMatchObject({ ok: false })
		f.taps.sweepSettledReferences()
		expect(f.taps.ownerCount).toBe(1)
		expect(f.registry.snapshot().acquisitions).toHaveLength(1)
	})
})
