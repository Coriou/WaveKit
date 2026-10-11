import { PassThrough } from "node:stream"
import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"
import type { SourceCaps } from "../../../src/config.js"
import { describe, expect, it, vi } from "vitest"
import {
	ObservedPermitLedger,
	SettlementRegistry,
} from "../../../src/core/channelizer/settlement-observer.js"
import type {
	ChannelSettlementObserver,
	ObservedAcquisitionHandle,
	ObservedTransaction,
	ProcessClaim,
	SendClaim,
} from "../../../src/core/channelizer/settlement-observer.js"
import type {
	ChannelProvider,
	ChannelRequestResult,
	DecoderChannelRequest,
} from "../../../src/core/channelizer/types.js"

class ProviderEmitter extends EventEmitter {
	override off(
		event: string | symbol,
		listener: (...args: never[]) => void,
	): this {
		return super.off(event, listener as (...args: unknown[]) => void)
	}
}

const request: DecoderChannelRequest = {
	centerHz: 100e6,
	bandwidthHz: 16_000,
	transitionHz: 4_000,
	outputRateHz: 48_000,
	format: "cf32",
}
const caps = {
	kind: "iq",
	format: "U8_IQ",
	sampleRate: 2_048_000,
	centerFreq: 100e6,
	exclusive: false,
} as const
const source = {
	sourceId: "s",
	generation: 1,
	sampleRateHz: caps.sampleRate,
	centerHz: caps.centerFreq,
}
const cost = { cpu: 1, bytes: 100 }
const downstream = { decoder: cost, classifier: cost, analog: cost }
const six = Array.from({ length: 6 }, () => cost)
const ok = { ok: true } as const
const child = () => new EventEmitter() as ChildProcess

function setup() {
	const registry = new SettlementRegistry()
	const provider = registry.registerProviderLifetime()!
	const observer = registry.createObserver(provider)
	const ledger = new ObservedPermitLedger(
		{ cpu: 1000, bytes: 100_000 },
		{ cpu: 0, bytes: 0 },
	)
	const emitter = new ProviderEmitter()
	const underlying = Object.assign(emitter, {
		requestChannel: vi.fn(
			(
				sourceId: string,
				decoderId: string,
				actual: DecoderChannelRequest,
				_caps: SourceCaps | undefined,
			): Promise<ChannelRequestResult> => {
				observer.takeAcquisition(sourceId, decoderId, actual)
				return Promise.resolve({
					ok: false,
					reasonCode: "channelizer-unavailable",
					detail: "held",
				} as const)
			},
		),
		releaseChannel: vi.fn(() => Promise.resolve()),
		currentGeneration: () => 1,
	}) satisfies ChannelProvider
	const adapter = observer.bindProvider(underlying)
	function allocate(id: string, activation: "decoder" | "direct" = "decoder") {
		const handle = observer.allocateAcquisition({
			activation,
			sourceId: "s",
			decoderId: id,
			expectedRequest: request,
			expectedInputCaps: caps,
			scannerAttempt: {},
		})!
		const permit = ledger.prepareObservedPermit(
			handle.requestToken,
			six,
			six,
			downstream,
		)!
		expect(handle.attachPermit(permit)).toBe(true)
		return handle
	}
	function dequeue(id: string) {
		const handle = allocate(id)
		expect(handle.arm()).toBe(true)
		void adapter.requestChannel("s", id, { ...request }, caps)
		const tx = observer.tryReserveObservedTransaction(handle)
		return { handle, tx }
	}
	return {
		registry,
		provider,
		observer,
		ledger,
		underlying,
		adapter,
		allocate,
		dequeue,
	}
}
function processFor(
	observer: ChannelSettlementObserver,
	tx: ObservedTransaction,
): ProcessClaim {
	const process = observer.claimProcess(tx, source)!
	expect(process.beginSpawn()).toBe(true)
	process.recordReturnedChild(child())
	process.recordStartSettled()
	return process
}
function sealComponents(handle: ObservedAcquisitionHandle): void {
	for (const kind of [
		"decoder",
		"classifier",
		"analog",
		"filesystem",
		"operation",
	] as const)
		handle.retainComponent(kind)?.sealNeverStarted()
}

function openedSend(
	s: ReturnType<typeof setup>,
	tx: ObservedTransaction,
	id = "same",
	process = processFor(s.observer, tx),
): SendClaim {
	const send = s.observer.claimSend(tx, process, id)!
	s.observer.recordTerminal(
		s.observer.captureTerminal(process, id, "opened")!,
		"opened",
	)
	return send
}
function grantContinuity(
	s: ReturnType<typeof setup>,
	send: SendClaim,
	decoderId: string,
): void {
	s.observer.recordGrant(send, {
		sourceId: "s",
		decoderId,
		channelId: send.id,
		generation: send.process.source.generation,
		realised: {
			outputRateHz: 48_000,
			format: "cf32",
			filterTaps: 10,
			groupDelaySamples: 2,
		},
		process: send.process,
		send,
	})
}

describe("exact selected-grant continuity", () => {
	it("transfers a pre-connect gap before the first grant callback, with no credit or public-event inference", () => {
		const s = setup(),
			{ handle, tx } = s.dequeue("d"),
			send = openedSend(s, tx!)
		const changed = vi.fn(() =>
			expect(handle.snapshot().continuityLost).toBe(true),
		)
		handle.onChange(changed)
		const grant = vi.fn(() =>
			expect(handle.snapshot().continuityLost).toBe(true),
		)
		s.observer.subscribeGrants(grant)
		const before = s.ledger.snapshot()
		s.underlying.emit("channel-discontinuity", send.id, 1, 5, 10, "input-gap")
		expect(handle.snapshot().continuityLost).toBe(false)
		expect(s.observer.captureDiscontinuity(send.process, send.id, 1)).toBe(send)
		s.underlying.emit("channel-discontinuity", send.id, 1, 5, 10, "input-gap")
		expect(changed).not.toHaveBeenCalled()
		expect(handle.snapshot().continuityLost).toBe(false) // No selected grant yet.
		grantContinuity(s, send, "d")
		expect(grant).toHaveBeenCalledOnce()
		expect(changed).toHaveBeenCalledOnce()
		expect(s.ledger.snapshot()).toEqual(before)
	})

	it("uses the same owned gap listener and eight V slots; duplicate live gaps notify once", () => {
		const s = setup(),
			{ handle, tx } = s.dequeue("d"),
			send = openedSend(s, tx!)
		for (let i = 0; i < 3; i++)
			expect(s.provider.ownListener(() => {})).toBeDefined()
		s.adapter.on("channel-invalidated", () => {})
		s.observer.subscribeGrants(() => {})
		s.observer.subscribeEnded(() => {})
		expect(s.provider.ownListener(() => {})).toBeUndefined()
		expect(s.underlying.listenerCount("channel-discontinuity")).toBe(1)
		grantContinuity(s, send, "d")
		s.observer.finishAcquisition(handle)
		expect(handle.snapshot()).toMatchObject({
			logical: "terminal",
			ended: false,
		})
		const changed = vi.fn()
		const off = handle.onChange(changed)
		for (let i = 0; i < 100; i++) {
			s.observer.captureDiscontinuity(send.process, send.id, 1)
			s.underlying.emit("channel-discontinuity", send.id, 1, i, 1, "input-gap")
			s.observer.publishCapturedDiscontinuity(send)
		}
		expect(changed).toHaveBeenCalledOnce()
		expect(handle.snapshot().continuityLost).toBe(true)
		for (let i = 0; i < 7; i++) handle.onChange(() => {})
		expect(() => handle.onChange(() => {})).toThrow("notification capacity")
		off()
	})

	it("refuses wrong identity and terminal attempts without contaminating same-ID processes", () => {
		const s = setup(),
			a = s.dequeue("a"),
			b = s.dequeue("b")
		const first = openedSend(s, a.tx!),
			second = openedSend(s, b.tx!)
		grantContinuity(s, first, "a")
		grantContinuity(s, second, "b")
		const foreign = setup(),
			f = foreign.dequeue("foreign"),
			foreignSend = openedSend(foreign, f.tx!)
		expect(
			s.observer.captureDiscontinuity(foreignSend.process, "same", 1),
		).toBeUndefined()
		expect(
			s.observer.captureDiscontinuity(first.process, "wrong", 1),
		).toBeUndefined()
		expect(
			s.observer.captureDiscontinuity(first.process, "same", 2),
		).toBeUndefined()
		const pending = s.observer.claimSend(a.tx!, first.process, "pending")!
		expect(
			s.observer.captureDiscontinuity(first.process, pending.id, 1),
		).toBeUndefined()
		s.observer.recordTerminal(
			s.observer.captureTerminal(first.process, pending.id, "rejected")!,
			"rejected",
		)
		expect(
			s.observer.captureDiscontinuity(first.process, pending.id, 1),
		).toBeUndefined()
		s.observer.captureDiscontinuity(first.process, "same", 1)
		s.underlying.emit("channel-discontinuity", "same", 1, 0, 1, "input-gap")
		expect(a.handle.snapshot().continuityLost).toBe(true)
		expect(b.handle.snapshot().continuityLost).toBe(false)
		s.observer.endGrant(second, "original ended")
		expect(
			s.observer.captureDiscontinuity(second.process, "same", 1),
		).toBeUndefined()
		expect(b.handle.snapshot().continuityLost).toBe(false)
		s.observer.recordTerminal(
			s.observer.captureTerminal(first.process, "same", "closed")!,
			"closed",
		)
		expect(
			s.observer.captureDiscontinuity(first.process, "same", 1),
		).toBeUndefined()
	})

	it("never transfers a superseded pre-grant bit or an old pending notification to a successor", () => {
		const s = setup(),
			{ handle, tx } = s.dequeue("d"),
			old = openedSend(s, tx!)
		s.observer.captureDiscontinuity(old.process, old.id, 1)
		s.observer.recordTerminal(
			s.observer.captureTerminal(old.process, old.id, "closed")!,
			"closed",
		)
		const successor = openedSend(s, tx!, old.id, old.process)
		grantContinuity(s, successor, "d")
		expect(handle.snapshot().continuityLost).toBe(false)
		const changed = vi.fn(() => {
			s.observer.endGrant(successor, "reentrant-end")
			s.observer.recordTerminal(
				s.observer.captureTerminal(successor.process, successor.id, "closed")!,
				"closed",
			)
		})
		handle.onChange(() => {
			if (!handle.snapshot().ended) changed()
		})
		s.observer.captureDiscontinuity(successor.process, successor.id, 1)
		s.underlying.emit(
			"channel-discontinuity",
			successor.id,
			1,
			0,
			1,
			"input-gap",
		)
		s.observer.publishCapturedDiscontinuity(old)
		s.observer.publishCapturedDiscontinuity(successor)
		expect(changed).toHaveBeenCalledOnce()
		expect(handle.snapshot()).toMatchObject({
			continuityLost: true,
			ended: true,
		})
	})

	it("retains callback failure without resetting continuity or refunding credit", () => {
		const s = setup(),
			{ handle, tx } = s.dequeue("d"),
			send = openedSend(s, tx!)
		grantContinuity(s, send, "d")
		const before = s.ledger.snapshot()
		handle.onChange(() => {
			throw new Error("synthetic gap callback")
		})
		s.observer.captureDiscontinuity(send.process, send.id, 1)
		s.observer.publishCapturedDiscontinuity(send)
		expect(handle.snapshot().continuityLost).toBe(true)
		expect(s.provider.inspectFinal(ok)).toMatchObject({
			ok: false,
			state: "failed",
		})
		expect(s.ledger.snapshot()).toEqual(before)
	})
})

describe("bounded channel settlement registry", () => {
	it("holds only queue metadata before commit, with exactly 64 global slots", () => {
		const s = setup()
		const handles = Array.from({ length: 64 }, (_, i) => s.allocate(`d${i}`))
		const decoder = handles[0]!.retainComponent("decoder")!
		expect(decoder.begin()).toBe(false)
		expect(s.registry.snapshot()).toMatchObject({
			receipts: 0,
			owners: { V: 1, P: 0, L: 0 },
			queued: 64,
		})
		expect(s.ledger.snapshot().committed).toEqual({ cpu: 0, bytes: 0 })
		expect(
			s.observer.allocateAcquisition({
				activation: "decoder",
				sourceId: "s",
				decoderId: "overflow",
				expectedRequest: request,
				expectedInputCaps: caps,
				scannerAttempt: {},
			}),
		).toBeUndefined()
		for (const h of handles) {
			h.retainComponent("decoder")?.sealNeverStarted()
			h.revokeUnclaimedArm()
		}
		decoder.sealNeverStarted()
		expect(s.registry.snapshot().queued).toBe(0)
	})

	it("commits six receipts, six P and six L together; owner capacity denies the eleventh before effects", () => {
		const s = setup()
		for (let i = 0; i < 10; i++) expect(s.dequeue(`d${i}`).tx).toBeDefined()
		expect(s.registry.snapshot()).toMatchObject({
			receipts: 60,
			owners: { V: 1, P: 60, L: 60 },
			queued: 0,
		})
		expect(s.ledger.snapshot().committed).toEqual({ cpu: 150, bytes: 15_000 })
		const denied = s.dequeue("denied")
		expect(denied.tx).toBeUndefined()
		expect(s.registry.snapshot().receipts).toBe(60)
		expect(s.ledger.snapshot().committed.cpu).toBe(150)
		s.observer.finishAcquisition(denied.handle)
		expect(s.registry.snapshot().queued).toBe(0)
	})

	it("checks the current baseline and limits at dequeue, including version conflict and byte overflow", () => {
		const s = setup(),
			h = s.allocate("d")
		expect(
			s.ledger.updateAdmission(
				0,
				{ cpu: 999, bytes: 0 },
				{ cpu: 1000, bytes: 100_000 },
			),
		).toBe(true)
		expect(
			s.ledger.updateAdmission(
				0,
				{ cpu: 0, bytes: 0 },
				{ cpu: 1000, bytes: 100_000 },
			),
		).toBe(false)
		h.arm()
		void s.adapter.requestChannel("s", "d", request, caps)
		expect(s.observer.tryReserveObservedTransaction(h)).toBeUndefined()
		expect(s.ledger.snapshot().committed.cpu).toBe(0)
		expect(s.registry.snapshot()).toMatchObject({
			receipts: 0,
			owners: { P: 0, L: 0 },
		})
		const huge = new ObservedPermitLedger(
			{ cpu: 1000, bytes: Number.MAX_SAFE_INTEGER },
			{ cpu: 0, bytes: 0 },
		)
		expect(
			huge.prepareObservedPermit(
				h.requestToken,
				six.map(() => ({ cpu: 1, bytes: Number.MAX_SAFE_INTEGER })),
				six,
				downstream,
			),
		).toBeUndefined()
	})

	it("captures terminal before same-ID reentry; early nonFIFO ACK credits only its exact terminal send", () => {
		const s = setup(),
			{ handle, tx } = s.dequeue("d"),
			process = processFor(s.observer, tx!)
		const tokens: string[] = []
		for (let i = 0; i < 6; i++) {
			const send = s.observer.claimSend(tx!, process, "same")!
			tokens.push(send.token)
			expect(s.observer.recordDisposed(process, send.token, "same")).toBe(true)
			expect(s.registry.snapshot().receipts).toBe(6)
			const captured = s.observer.captureTerminal(process, "same", "rejected")!
			expect(captured).toBe(send)
			// The ID is synchronously freed by capture, not by recordTerminal or promise resolution.
			if (i === 0) {
				const successor = s.observer.claimSend(tx!, process, "same")!
				tokens.push(successor.token)
				s.observer.recordTerminal(captured, "rejected")
				expect(
					s.observer.recordDisposed(process, successor.token, "wrong"),
				).toBe(false)
				const next = s.observer.captureTerminal(process, "same", "rejected")!
				s.observer.recordTerminal(next, "rejected")
				s.observer.recordDisposed(process, successor.token, "same")
				i++
			} else s.observer.recordTerminal(captured, "rejected")
		}
		expect(tokens).toEqual(["1", "2", "3", "4", "5", "6"])
		expect(s.observer.claimSend(tx!, process, "seventh")).toBeUndefined()
		sealComponents(handle)
		s.observer.finishAcquisition(handle)
		expect(s.registry.snapshot()).toMatchObject({
			receipts: 0,
			owners: { P: 1, L: 0 },
		})
		expect(s.ledger.snapshot()).toMatchObject({
			nativeAttempts: { cpu: 0 },
			processResiduals: { cpu: 1 },
		})
		process.recordActualClose()
		process.recordStdioSettled()
		expect(s.registry.snapshot().owners.P).toBe(0)
	})

	it("keeps live process R and distinct downstream cells while N receipt returns", () => {
		const s = setup(),
			{ handle, tx } = s.dequeue("d"),
			process = processFor(s.observer, tx!)
		const decoder = handle.retainComponent("decoder")!,
			classifier = handle.retainComponent("classifier")!,
			analog = handle.retainComponent("analog")!
		handle.retainComponent("filesystem")!.sealNeverStarted()
		handle.retainComponent("operation")!.sealNeverStarted()
		const send = s.observer.claimSend(tx!, process, "same")!
		s.observer.recordTerminal(
			s.observer.captureTerminal(process, "same", "opened")!,
			"opened",
		)
		s.observer.recordGrant(send, {
			sourceId: "s",
			decoderId: "d",
			channelId: "same",
			generation: 1,
			realised: {
				outputRateHz: 48_000,
				format: "cf32",
				filterTaps: 10,
				groupDelaySamples: 2,
			},
			process,
			send,
		})
		expect(decoder.begin()).toBe(true)
		expect(classifier.begin()).toBe(true)
		s.observer.finishAcquisition(handle)
		s.observer.recordDisposed(process, send.token, send.id)
		expect(s.registry.snapshot().receipts).toBe(1)
		s.observer.recordTerminal(
			s.observer.captureTerminal(process, "same", "closed")!,
			"closed",
		)
		expect(s.registry.snapshot().receipts).toBe(0)
		classifier.settle(ok)
		expect(s.ledger.snapshot().downstream).toEqual({
			decoder: cost,
			classifier: { cpu: 0, bytes: 0 },
			analog: cost,
		})
		expect(s.ledger.snapshot().nativeAttempts.cpu).toBe(1)
		decoder.settle(ok)
		analog.sealNeverStarted()
		expect(s.ledger.snapshot().nativeAttempts.cpu).toBe(0)
		expect(s.ledger.snapshot().processResiduals.cpu).toBe(1)
	})

	it("proves assigned no-process after logical terminal, R before two directory cleanup owners", () => {
		const s = setup(),
			{ handle, tx } = s.dequeue("d"),
			process = s.observer.claimProcess(tx!, source)!
		const managerDir = process.retainLocal("directory")!,
			observerDir = process.retainLocal("directory")!
		expect(process.retainLocal("directory")).toBeUndefined()
		process.sealStartup()
		process.recordStartSettled()
		expect(process.recordNoProcess()).toBe(false)
		s.observer.finishAcquisition(handle)
		expect(process.recordNoProcess()).toBe(true)
		expect(s.ledger.snapshot().processResiduals.cpu).toBe(0)
		expect(s.registry.snapshot().owners.P).toBe(1)
		managerDir.settle(ok)
		expect(s.registry.snapshot().owners.P).toBe(1)
		observerDir.settle(ok)
		expect(s.registry.snapshot().owners.P).toBe(0)
	})

	it("distinguishes supported no-return, call-in-progress uncertainty and every returned noPID child", () => {
		for (const branch of ["supported", "uncertain", "returned"] as const) {
			const s = setup(),
				{ handle, tx } = s.dequeue(branch),
				process = s.observer.claimProcess(tx!, source)!
			process.beginSpawn()
			if (branch === "supported") process.recordSupportedNoReturn()
			if (branch === "uncertain") process.recordUncertainSpawn()
			if (branch === "returned") process.recordReturnedChild(child())
			process.sealStartup()
			s.observer.finishAcquisition(handle)
			expect(process.recordNoProcess()).toBe(false)
			process.recordStartSettled()
			expect(process.recordNoProcess()).toBe(branch === "supported")
			if (branch === "returned") {
				process.recordActualClose()
				expect(s.ledger.snapshot().processResiduals.cpu).toBe(1)
				process.recordStdioSettled()
				expect(s.ledger.snapshot().processResiduals.cpu).toBe(0)
			}
			if (branch === "uncertain")
				expect(s.ledger.snapshot().processResiduals.cpu).toBe(1)
		}
	})

	it("retains immutable first final failure while later physical proof improves accounting", () => {
		const s = setup(),
			{ handle, tx } = s.dequeue("d"),
			process = processFor(s.observer, tx!)
		s.observer.finishAcquisition(handle)
		s.observer.sealAdmission()
		const first = s.observer.inspectFinal({
			ok: false,
			state: "failed",
			detail: "producer failed",
		})
		process.recordActualClose()
		process.recordStdioSettled()
		expect(s.ledger.snapshot().committed.cpu).toBe(0)
		expect(s.observer.inspectFinal(ok)).toBe(first)
		expect(first).toEqual({
			ok: false,
			state: "failed",
			detail: "producer failed",
		})
	})

	it("keeps canceled one-use interception fenced and captures exact old adapter listener ownership", async () => {
		const s = setup(),
			h = s.allocate("d"),
			metadata = h.retainComponent("decoder")!
		h.arm()
		h.cancel()
		await expect(
			s.adapter.requestChannel("s", "d", request, caps),
		).resolves.toMatchObject({ ok: false })
		expect(s.underlying.requestChannel).not.toHaveBeenCalled()
		expect(metadata.begin()).toBe(false)
		metadata.sealNeverStarted()
		const listener = vi.fn()
		s.adapter.on("channel-invalidated", listener)
		expect(() => s.adapter.on("channel-invalidated", listener)).toThrow()
		const other = setup()
		other.adapter.on("channel-invalidated", listener)
		s.adapter.off("channel-invalidated", vi.fn())
		s.underlying.emit("channel-invalidated", "s", 1, ["id"])
		expect(listener).toHaveBeenCalledTimes(1)
		s.adapter.off("channel-invalidated", listener)
		s.adapter.off("channel-invalidated", listener)
		other.underlying.emit("channel-invalidated", "s", 1, ["id"])
		expect(listener).toHaveBeenCalledTimes(2)
		s.observer.sealAdmission()
		expect(s.provider.disposeListenersIfSettled()).toEqual(ok)
	})
})

describe("activation and retained notification ownership", () => {
	it.each(["decoder", "direct"] as const)(
		"claims explicit %s activation after commit/current binding, without absence inference",
		async activation => {
			const s = setup(),
				handle = s.allocate("d", activation)
			const decoder = handle.retainComponent("decoder")!,
				classifier = handle.retainComponent("classifier")!
			handle.retainComponent("analog")!.sealNeverStarted()
			handle.retainComponent("filesystem")!.sealNeverStarted()
			handle.retainComponent("operation")!.sealNeverStarted()
			const begun = vi.spyOn(decoder, "begin")
			expect(classifier.begin()).toBe(false)
			s.underlying.requestChannel.mockImplementation(
				(sourceId, decoderId, actual) => {
					const captured = s.observer.takeAcquisition(
						sourceId,
						decoderId,
						actual,
					)!
					const tx = s.observer.tryReserveObservedTransaction(captured)!
					const process = processFor(s.observer, tx),
						send = s.observer.claimSend(tx, process, "native")!
					s.observer.recordTerminal(
						s.observer.captureTerminal(process, "native", "opened")!,
						"opened",
					)
					s.observer.recordGrant(send, {
						sourceId,
						decoderId,
						channelId: send.id,
						generation: 1,
						realised: {
							outputRateHz: 48_000,
							format: "cf32",
							filterTaps: 10,
							groupDelaySamples: 2,
						},
						process,
						send,
					})
					s.observer.finishAcquisition(captured)
					return Promise.resolve({
						ok: true,
						stream: new PassThrough(),
						channelId: send.id,
						generation: 1,
						realised: {
							outputRateHz: 48_000,
							format: "cf32",
							groupDelaySamples: 2,
						},
					})
				},
			)
			handle.arm()
			await expect(
				s.adapter.requestChannel("s", "d", { ...request }, caps),
			).resolves.toMatchObject({ ok: true })
			expect(begun).toHaveBeenCalledTimes(activation === "decoder" ? 1 : 0)
			expect(classifier.begin()).toBe(true)
			await expect(
				s.adapter.requestChannel("s", "d", { ...request }, caps),
			).resolves.toMatchObject({ ok: false })
			expect(s.underlying.requestChannel).toHaveBeenCalledTimes(1)
		},
	)

	it("requires all successful-grant component proofs and actual notification unsubscribe before releasing L", () => {
		const s = setup(),
			{ handle, tx } = s.dequeue("d"),
			process = processFor(s.observer, tx!)
		const send = s.observer.claimSend(tx!, process, "native")!
		const classifier = handle.retainComponent("classifier")!
		s.observer.recordTerminal(
			s.observer.captureTerminal(process, send.id, "opened")!,
			"opened",
		)
		s.observer.recordGrant(send, {
			sourceId: "s",
			decoderId: "d",
			channelId: send.id,
			generation: 1,
			realised: {
				outputRateHz: 48_000,
				format: "cf32",
				filterTaps: 0,
				groupDelaySamples: 0,
			},
			process,
			send,
		})
		expect(classifier.begin()).toBe(true)
		const unsubscribe = handle.onChange(() => {})
		s.observer.finishAcquisition(handle)
		s.observer.recordTerminal(
			s.observer.captureTerminal(process, send.id, "closed")!,
			"closed",
		)
		s.observer.recordDisposed(process, send.token, send.id)
		classifier.settle(ok)
		expect(s.registry.snapshot().owners.L).toBeGreaterThan(0)
		expect(handle.snapshot().components.analog).toBe("pending")
		process.recordActualClose()
		process.recordStdioSettled()
		expect(s.registry.snapshot().owners.L).toBeGreaterThan(0)
		unsubscribe()
		// Missing slots never silently acquire a successful-grant proof, even after actual native CLOSE.
		expect(s.registry.snapshot().owners.L).toBeGreaterThan(0)
		expect(s.provider.disposeListenersIfSettled().ok).toBe(false)
	})

	it("uses exactly the remaining two V slots for concrete grant/end subscriptions and ends once before reentry", () => {
		const s = setup()
		for (let i = 0; i < 3; i++)
			expect(s.provider.ownListener(() => {})).toBeDefined()
		s.adapter.on("channel-invalidated", () => {})
		const granted = vi.fn(),
			ended = vi.fn()
		const offGrant = s.observer.subscribeGrants(granted),
			offEnd = s.observer.subscribeEnded(ended)
		expect(s.provider.ownListener(() => {})).toBeUndefined()
		const { handle, tx } = s.dequeue("d"),
			process = processFor(s.observer, tx!)
		sealComponents(handle)
		const send = s.observer.claimSend(tx!, process, "native")!
		s.observer.recordTerminal(
			s.observer.captureTerminal(process, send.id, "opened")!,
			"opened",
		)
		s.observer.recordGrant(send, {
			sourceId: "s",
			decoderId: "d",
			channelId: send.id,
			generation: 1,
			realised: {
				outputRateHz: 48_000,
				format: "cf32",
				filterTaps: 0,
				groupDelaySamples: 0,
			},
			process,
			send,
		})
		expect(granted).toHaveBeenCalledWith(handle, handle.binding)
		s.observer.endGrant(send, "closed")
		handle.cancel()
		s.observer.endGrant(send, "again")
		expect(ended).toHaveBeenCalledTimes(1)
		offGrant()
		offEnd()
		offGrant()
		offEnd()
	})

	it("returns receipt credits while retaining old process owners and refuses successors before new side effects", () => {
		const s = setup()
		for (let i = 0; i < 116; i++) {
			const { handle, tx } = s.dequeue(`d${i}`)
			expect(tx).toBeDefined()
			const process = processFor(s.observer, tx!),
				send = s.observer.claimSend(tx!, process, `n${i}`)!
			s.observer.recordTerminal(
				s.observer.captureTerminal(process, send.id, "rejected")!,
				"rejected",
			)
			s.observer.recordDisposed(process, send.token, send.id)
			s.observer.finishAcquisition(handle)
		}
		expect(s.registry.snapshot()).toMatchObject({
			receipts: 0,
			owners: { V: 1, P: 116, L: 0 },
		})
		const successor = s.dequeue("capacity-denied")
		expect(successor.tx).toBeUndefined()
		expect(s.registry.snapshot().owners.P).toBe(116)
		expect(s.ledger.snapshot().processResiduals.cpu).toBe(116)
	})
})

describe("exact sharing and proof reuse", () => {
	it("reserves all six R cells first and deduplicates only an issued incumbent process claim", () => {
		const s = setup(),
			first = s.dequeue("first"),
			process = processFor(s.observer, first.tx!)
		const second = s.dequeue("second")
		expect(s.ledger.snapshot().processResiduals.cpu).toBe(12)
		expect(s.observer.shareProcess(second.tx!, process)).toBe(true)
		expect(s.ledger.snapshot().processResiduals.cpu).toBe(11)
		expect(s.observer.shareProcess(second.tx!, process)).toBe(true)
		expect(s.ledger.snapshot().processResiduals.cpu).toBe(11)
		const foreign = setup(),
			unrelated = foreign.dequeue("unrelated"),
			other = processFor(foreign.observer, unrelated.tx!)
		expect(s.observer.shareProcess(second.tx!, other)).toBe(false)
		const send = s.observer.claimSend(second.tx!, process, "shared")!
		expect(send.process).toBe(process)
		const captured = s.observer.captureTerminal(process, send.id, "rejected")!
		s.observer.recordTerminal(captured, "rejected")
		s.observer.recordDisposed(process, send.token, send.id)
		s.observer.finishAcquisition(second.handle)
		expect(s.observer.recordDisposed(process, send.token, send.id)).toBe(true)
		expect(
			s.observer.recordDisposed(
				process,
				String(BigInt(send.token) + 1n),
				send.id,
			),
		).toBe(false)
		expect(s.registry.snapshot().receipts).toBe(6)
	})

	it("does not reclaim logical metadata until the exact consumer notification has unsubscribed", () => {
		const s = setup(),
			{ handle, tx } = s.dequeue("d"),
			process = processFor(s.observer, tx!)
		sealComponents(handle)
		const unsub = handle.onChange(() => {}),
			send = s.observer.claimSend(tx!, process, "native")!
		s.observer.recordTerminal(
			s.observer.captureTerminal(process, send.id, "rejected")!,
			"rejected",
		)
		s.observer.recordDisposed(process, send.token, send.id)
		s.observer.finishAcquisition(handle)
		process.recordActualClose()
		process.recordStdioSettled()
		expect(s.registry.snapshot().owners.L).toBeGreaterThan(0)
		unsub()
		expect(s.registry.snapshot()).toMatchObject({
			receipts: 0,
			owners: { P: 0, L: 0 },
			queued: 0,
		})
	})
})
