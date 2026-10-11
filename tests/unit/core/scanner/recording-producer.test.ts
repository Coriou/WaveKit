import { randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import {
	RecordingProducers,
	type RecordingNativeOutcome,
	type RecordingProducerDeps,
	type RecordingProducerInput,
} from "../../../../src/core/scanner/channel/recording-producer.js"
import type {
	AnalogHandle,
	AnalogReceipt,
} from "../../../../src/core/scanner/store/analog-operations.js"
import type { RecordingBinding } from "../../../../src/core/scanner/store/recording-operation.js"

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (cause: unknown) => void
	const promise = new Promise<T>((done, fail) => {
		resolve = done
		reject = fail
	})
	return { promise, resolve, reject }
}
function tone(samples = 480): Float32Array {
	const input = new Float32Array(samples * 2)
	for (let i = 0; i < samples; i++) {
		input[i * 2] = Math.cos(i / 10)
		input[i * 2 + 1] = Math.sin(i / 10)
	}
	return input
}
function fixture() {
	const binding: RecordingBinding = Object.freeze({
		sourceId: "source",
		engineInstanceId: randomUUID(),
		stream: 1,
		epoch: 2,
		channelId: "opaque-id",
		channelGeneration: 3,
		inputFormat: "cf32",
		inputSampleRateHz: 48000,
		groupDelayInputSamples: 64,
		targetHz: 446e6,
		captureCentreHz: 446e6,
		tuningTrust: "commanded",
	})
	const provider = {},
		token = {},
		native = deferred<RecordingNativeOutcome>()
	const input: RecordingProducerInput = {
		binding,
		provider,
		token,
		discoveryId: "d1",
		observationId: "o1",
		recordAudio: true,
		analogFm: true,
		encrypted: false,
		nativeOwnershipSettled: native.promise,
		thresholdDbfs: null,
	}
	const id = randomUUID(),
		finished = deferred<AnalogReceipt>(),
		settled = deferred<AnalogReceipt>()
	const ready = deferred<void>()
	ready.resolve()
	const receipt = (
		outcome: "finalized" | "aborted" | "failed" = "finalized",
	): AnalogReceipt =>
		Object.freeze<AnalogReceipt>({
			version: 1,
			operationId: id,
			producerRecordingId: id,
			producerId: "scanner-analog",
			producerRunId: randomUUID(),
			producerStoreId: null,
			discoveryId: "d1",
			observationId: "o1",
			alias: outcome === "finalized" ? `d1~analog-${id}.wav` : null,
			binding,
			output:
				outcome === "finalized"
					? {
							format: "s16le-wav",
							sampleRateHz: 8000,
							channelCount: 1,
							outputFrames: 80,
							fileBytes: 204,
						}
					: {
							format: null,
							sampleRateHz: null,
							channelCount: null,
							outputFrames: null,
							fileBytes: null,
						},
			gaps: [],
			omittedGapCount: 0,
			cutReason: outcome === "finalized" ? "completed" : "cancelled",
			closure: outcome === "finalized" ? "closed" : "incomplete",
			outcome,
			artifact:
				outcome === "finalized"
					? `recordings/analog/d1/analog-${id}.wav`
					: null,
			cleanup: outcome === "finalized" ? "pending" : "complete",
			residueBytes: outcome === "finalized" ? null : 0,
			errorCode: null,
			durability: {
				mediaFileSync: outcome === "finalized" ? "synced" : "not-acknowledged",
				metadata:
					outcome === "finalized"
						? "journal-append-prepared-link"
						: "not-acknowledged",
				metadataPowerLossDurable: false,
				finalMarkerFileSync:
					outcome === "finalized" ? "synced" : "not-acknowledged",
				finalMarkerDirectorySync: "not-attempted",
			},
		})
	const push = vi.fn(async (_pcm: Int16Array) => undefined),
		cancel = vi.fn(),
		finish = vi.fn(() => finished.promise),
		gap = vi.fn()
	const operation: AnalogHandle = {
		operationId: id,
		ready: ready.promise,
		settled: settled.promise,
		push,
		cancel,
		finish,
		addGap: gap,
	}
	const current = vi.fn(() => true),
		begin = vi.fn(() => operation),
		component = vi.fn(() => true),
		release = vi.fn(async () => undefined)
	const deps: RecordingProducerDeps = {
		enabled: true,
		profileReady: true,
		adoptionReady: true,
		maxOwners: 1,
		isCurrentCommitted: current,
		beginAnalogComponent: component,
		beginAnalog: begin,
		releaseLogical: release,
	}
	return {
		input,
		binding,
		native,
		ready,
		finished,
		settled,
		operation,
		receipt,
		push,
		cancel,
		finish,
		gap,
		current,
		begin,
		component,
		release,
		deps,
		complete(value = receipt()) {
			finished.resolve(value)
			settled.resolve(value)
			return value
		},
		proveNative() {
			native.resolve({ status: "released", provider, token })
		},
	}
}

describe("current-grant recording producer", () => {
	it("exact native ending before buffered output synchronously fences the original producer", async () => {
		const f = fixture(),
			producers = new RecordingProducers(f.deps),
			h = producers.begin(f.input)
		await h.ready
		expect(
			producers.observeNativeOwnership(h.identity, {
				status: "released",
				provider: f.input.provider,
				token: f.input.token,
			}),
		).toBe(true)
		expect(producers.bindingLive(f.binding)).toBe(false)
		await expect(h.push(tone())).rejects.toThrow("fenced")
		expect(f.push).not.toHaveBeenCalled()
		expect(f.cancel).toHaveBeenCalledWith("channel-invalidated")
		f.complete(f.receipt("aborted"))
		await h.settled
		expect(producers.ownerCount).toBe(0)
	})

	it("snapshots association/options before reentrant callbacks and copies scalar binding", async () => {
		const f = fixture(),
			mutable = { ...f.input, binding: { ...f.binding } }
		f.component.mockImplementation(() => {
			mutable.discoveryId = "different"
			mutable.observationId = "other"
			mutable.binding.targetHz = 1
			return true
		})
		const producers = new RecordingProducers(f.deps),
			h = producers.begin(mutable)
		await h.ready
		expect(f.begin).toHaveBeenCalledWith({
			discoveryId: "d1",
			observationId: "o1",
			binding: f.binding,
		})
		expect(h.identity.binding.targetHz).toBe(446e6)
		f.complete()
		await h.finish()
		await h.settled
	})
	it("creation callback failure settles producer-only attempts and retains uncertain bounded ownership", async () => {
		const f = fixture()
		f.component.mockImplementation(() => {
			throw new Error("component callback failed")
		})
		const producers = new RecordingProducers(f.deps),
			h = producers.begin(f.input)
		await expect(h.ready).rejects.toThrow("creation failed")
		expect(await h.settled).toMatchObject({
			operationSettled: false,
			logicalReleased: true,
			componentClosed: false,
		})
		expect(f.begin).not.toHaveBeenCalled()
		expect(producers.ownerCount).toBe(1)
		f.proveNative()
		await f.native.promise
		await Promise.resolve()
		expect(producers.ownerCount).toBe(1)
	})
	it("post-create predicate reentry cancels the captured original operation before returning ready", async () => {
		const f = fixture()
		let calls = 0,
			producers!: RecordingProducers
		f.current.mockImplementation(() => {
			if (++calls === 3) producers.cancelSource("source", "stream-changed")
			return true
		})
		producers = new RecordingProducers(f.deps)
		const h = producers.begin(f.input)
		await expect(h.ready).rejects.toThrow()
		expect(f.cancel).toHaveBeenCalledWith("stream-changed")
		f.complete(f.receipt("aborted"))
		expect((await h.settled).operationSettled).toBe(true)
		expect(f.begin).toHaveBeenCalledTimes(1)
	})
	it("later exact native proof may retire clean ownership but wrong tuple/token cannot", async () => {
		const f = fixture(),
			producers = new RecordingProducers(f.deps),
			h = producers.begin(f.input)
		await h.ready
		f.complete()
		await h.finish()
		await h.settled
		const proof: RecordingNativeOutcome = {
			status: "released",
			provider: f.input.provider,
			token: f.input.token,
		}
		expect(
			producers.observeNativeOwnership(
				{ ...h.identity, binding: { ...f.binding, epoch: 999 } },
				proof,
			),
		).toBe(false)
		expect(
			producers.observeNativeOwnership(h.identity, { ...proof, token: {} }),
		).toBe(false)
		expect(
			producers.observeNativeOwnership(h.identity, {
				...proof,
				status: "unknown",
			}),
		).toBe(false)
		expect(producers.ownerCount).toBe(1)
		expect(
			producers.observeNativeOwnership(
				{ ...h.identity, binding: { ...f.binding } },
				proof,
			),
		).toBe(true)
		expect(producers.ownerCount).toBe(0)
	})

	it.each(["enabled", "profileReady", "adoptionReady"] as const)(
		"denies missing %s before component or operation effects",
		flag => {
			const f = fixture(),
				producers = new RecordingProducers({ ...f.deps, [flag]: false })
			expect(() => producers.begin(f.input)).toThrow("denied")
			expect(f.component).not.toHaveBeenCalled()
			expect(f.begin).not.toHaveBeenCalled()
			expect(producers.ownerCount).toBe(0)
		},
	)
	it("requires affirmative analog recording, nonencrypted association and actual rate/format/delay", () => {
		const f = fixture(),
			producers = new RecordingProducers(f.deps)
		for (const change of [
			{ recordAudio: false },
			{ analogFm: false },
			{ encrypted: true },
		])
			expect(() => producers.begin({ ...f.input, ...change })).toThrow()
		for (const change of [
			{ inputSampleRateHz: 24000 },
			{ inputFormat: null },
			{ groupDelayInputSamples: null },
			{ engineInstanceId: null },
		])
			expect(() =>
				producers.begin({ ...f.input, binding: { ...f.binding, ...change } }),
			).toThrow()
		expect(f.begin).not.toHaveBeenCalled()
		expect(f.component).not.toHaveBeenCalled()
	})
	it("natural finish fences intake but retains binding until marker and actual operation settlement", async () => {
		const f = fixture(),
			producers = new RecordingProducers(f.deps),
			h = producers.begin(f.input)
		await h.ready
		const finish = h.finish()
		expect(h.finish()).toBe(finish)
		await expect(h.push(tone())).rejects.toThrow("fenced")
		expect(producers.bindingLive({ ...f.binding })).toBe(true)
		const marker = f.receipt()
		f.finished.resolve(marker)
		await Promise.resolve()
		await Promise.resolve()
		expect(f.release).not.toHaveBeenCalled()
		expect(producers.bindingLive(f.binding)).toBe(true)
		f.settled.resolve(marker)
		expect(await finish).toBe(marker)
		expect(await h.settled).toMatchObject({
			receipt: marker,
			filesystem: { ok: false, state: "unknown" },
			operation: { ok: true },
			operationSettled: true,
			logicalReleased: true,
			componentClosed: true,
			error: null,
		})
		expect(producers.bindingLive(f.binding)).toBe(false)
		expect(f.release).toHaveBeenCalledWith(h.identity)
		expect(producers.ownerCount).toBe(1) // Logical release does not certify native ownership.
		f.proveNative()
		await f.native.promise
		await Promise.resolve()
		expect(producers.ownerCount).toBe(0)
	})
	it("cloned scalar tuples resolve the original token and refuse collision across retained providers", async () => {
		const f = fixture(),
			producers = new RecordingProducers(f.deps),
			h = producers.begin(f.input)
		await h.ready
		expect(producers.bindingLive({ ...f.binding })).toBe(true)
		expect(f.current).toHaveBeenLastCalledWith(h.identity)
		expect(h.identity.token).toBe(f.input.token)
		expect(h.identity.provider).toBe(f.input.provider)
		expect(Object.isFrozen(h.identity.binding)).toBe(true)
		expect(() =>
			producers.begin({
				...f.input,
				binding: { ...f.binding },
				provider: {},
				token: {},
			}),
		).toThrow("collision")
		f.complete()
		await h.finish()
		await h.settled
		expect(() =>
			producers.begin({
				...f.input,
				binding: { ...f.binding, engineInstanceId: randomUUID() },
				provider: {},
				token: {},
			}),
		).toThrow("retained")
		f.native.resolve({ status: "released", provider: {}, token: f.input.token })
		await f.native.promise
		await Promise.resolve()
		expect(producers.ownerCount).toBe(1)
		expect(f.begin).toHaveBeenCalledTimes(1)
	})
	it("invalidation while ready is pending synchronously fences/cancels and component stop never waits native proof", async () => {
		const f = fixture(),
			ready = deferred<void>()
		const operation = { ...f.operation, ready: ready.promise }
		f.begin.mockReturnValue(operation)
		const producers = new RecordingProducers(f.deps),
			h = producers.begin(f.input)
		const rejected = expect(h.ready).rejects.toThrow()
		h.cancel("epoch-changed")
		expect(f.cancel).toHaveBeenCalledWith("epoch-changed")
		expect(producers.bindingLive(f.binding)).toBe(false)
		await expect(h.push(tone())).rejects.toThrow("fenced")
		ready.resolve()
		await rejected
		const aborted = f.complete(f.receipt("aborted"))
		expect(await h.finish()).toBe(aborted)
		const stopped = await producers.stop()
		expect(stopped).toHaveLength(1)
		expect(stopped[0]?.operationSettled).toBe(true)
		expect(producers.ownerCount).toBe(1)
	})
	it("a reentrant component callback invalidates before beginAnalog and retains the original bounded owner", async () => {
		const f = fixture()
		let producers!: RecordingProducers
		f.component.mockImplementation(() => {
			producers.cancelSource("source")
			return true
		})
		producers = new RecordingProducers(f.deps)
		const h = producers.begin(f.input)
		await expect(h.ready).rejects.toThrow()
		expect(f.begin).not.toHaveBeenCalled()
		expect((await h.settled).componentClosed).toBe(false)
		expect(f.release).toHaveBeenCalledWith(h.identity)
		expect(producers.ownerCount).toBe(1)
	})
	it("predicate reentry cannot return a stale live binding or copy intake", async () => {
		const f = fixture(),
			producers = new RecordingProducers(f.deps),
			h = producers.begin(f.input)
		await h.ready
		f.current.mockImplementation(() => {
			producers.cancelSource("source", "source-lost")
			return true
		})
		expect(producers.bindingLive({ ...f.binding })).toBe(false)
		await expect(h.push(tone())).rejects.toThrow("fenced")
		expect(f.push).not.toHaveBeenCalled()
		f.complete(f.receipt("aborted"))
		await h.settled
	})
	it("cancel during PCM await stops after the pending 10 ms block and drains operation separately", async () => {
		const f = fixture(),
			entered = deferred<void>(),
			release = deferred<void>()
		f.push.mockImplementationOnce(async () => {
			entered.resolve()
			await release.promise
		})
		const producers = new RecordingProducers(f.deps),
			h = producers.begin(f.input)
		await h.ready
		const write = h.push(tone(4800))
		const rejected = expect(write).rejects.toThrow("cancelled")
		await entered.promise
		h.cancel("source-lost")
		expect(producers.bindingLive(f.binding)).toBe(false)
		release.resolve()
		await rejected
		f.complete(f.receipt("aborted"))
		await h.settled
		expect(f.push).toHaveBeenCalledTimes(1)
		expect(producers.ownerCount).toBe(1)
	})
	it("post-marker cancellation and logical-release failure never turn the immutable receipt into aborted", async () => {
		const f = fixture(),
			producers = new RecordingProducers(f.deps),
			h = producers.begin(f.input)
		await h.ready
		f.release.mockRejectedValueOnce(new Error("logical release failed"))
		const finish = h.finish(),
			marker = f.receipt()
		f.finished.resolve(marker)
		h.cancel("discovery-deleted")
		f.settled.resolve(marker)
		expect(await finish).toBe(marker)
		expect(await h.settled).toMatchObject({
			receipt: marker,
			operationSettled: true,
			logicalReleased: false,
			componentClosed: false,
		})
		f.proveNative()
		await f.native.promise
		await Promise.resolve()
		expect(producers.ownerCount).toBe(1)
	})
	it("unknown failed-close receipt remains a charged tombstone even after positive native proof", async () => {
		const f = fixture(),
			producers = new RecordingProducers(f.deps),
			h = producers.begin(f.input)
		await h.ready
		const pending: AnalogReceipt = {
			...f.receipt("failed"),
			closure: "unknown",
			cleanup: "pending",
			residueBytes: null,
			errorCode: "cleanup-failed",
		}
		f.complete(pending)
		f.proveNative()
		expect(await h.finish()).toBe(pending)
		expect(await h.settled).toMatchObject({
			componentClosed: false,
			filesystem: { ok: false, state: "unknown" },
			operation: { ok: false, state: "unknown" },
			operationSettled: true,
		})
		expect(producers.ownerCount).toBe(1)
	})
	it("finalized closed media with retained disposable cleanup separates filesystem from operation proof", async () => {
		const f = fixture(),
			h = new RecordingProducers(f.deps).begin(f.input)
		await h.ready
		const marker = f.complete()
		expect(await h.finish()).toBe(marker)
		expect(await h.settled).toMatchObject({
			filesystem: { ok: false, state: "unknown" },
			operation: { ok: true },
			logicalReleased: true,
		})
		expect(marker.cleanup).toBe("pending")
		expect(marker.residueBytes).toBeNull()
		expect(Object.isFrozen(marker)).toBe(true)
	})
	it("validated complete final cleanup preserves both facts when subsequent logical release fails", async () => {
		const f = fixture(),
			h = new RecordingProducers(f.deps).begin(f.input)
		await h.ready
		const receipt: AnalogReceipt = Object.freeze({
			...f.receipt(),
			cleanup: "complete",
			residueBytes: 0,
		})
		f.release.mockRejectedValueOnce(new Error("logical release failed"))
		f.complete(receipt)
		expect(await h.finish()).toBe(receipt)
		const result = await h.settled
		expect(result).toMatchObject({
			filesystem: { ok: true },
			operation: { ok: true },
			logicalReleased: false,
			componentClosed: false,
		})
		expect(result.error?.message).toContain("logical release failed")
		expect(Object.isFrozen(result.filesystem)).toBe(true)
		expect(Object.isFrozen(result.operation)).toBe(true)
	})
	it("failed decision with confirmed cleanup frees only filesystem, never operation", async () => {
		const f = fixture(),
			h = new RecordingProducers(f.deps).begin(f.input)
		await h.ready
		const receipt: AnalogReceipt = Object.freeze({
			...f.receipt("failed"),
			errorCode: "write-failed",
		})
		f.complete(receipt)
		await h.finish()
		expect(await h.settled).toMatchObject({
			filesystem: { ok: true },
			operation: { ok: false, state: "failed" },
			logicalReleased: true,
		})
	})
	it("aborted complete cleanup proves filesystem and operation without finalized media", async () => {
		const f = fixture(),
			h = new RecordingProducers(f.deps).begin(f.input)
		await h.ready
		h.cancel()
		f.complete(f.receipt("aborted"))
		expect(await h.settled).toMatchObject({
			filesystem: { ok: true },
			operation: { ok: true },
		})
	})
	it.each([null, 123])(
		"closed finalized media with pending residue %s never credits filesystem",
		async residueBytes => {
			const f = fixture(),
				h = new RecordingProducers(f.deps).begin(f.input)
			await h.ready
			f.complete(Object.freeze({ ...f.receipt(), residueBytes }))
			await h.finish()
			expect(await h.settled).toMatchObject({
				filesystem: { ok: false, state: "unknown" },
				operation: { ok: true },
			})
		},
	)
	it.each(["identity", "association", "binding", "header"] as const)(
		"rejects %s receipt proof even when promises and release fulfill",
		async fault => {
			const f = fixture(),
				h = new RecordingProducers(f.deps).begin(f.input)
			await h.ready
			const original = f.receipt(),
				id = randomUUID()
			const receipt: AnalogReceipt = Object.freeze({
				...original,
				cleanup: "complete",
				residueBytes: 0,
				...(fault === "identity"
					? {
							operationId: id,
							producerRecordingId: id,
							alias: `d1~analog-${id}.wav`,
							artifact: `recordings/analog/d1/analog-${id}.wav`,
						}
					: {}),
				...(fault === "association" ? { observationId: "other" } : {}),
				...(fault === "binding"
					? { binding: { ...f.binding, epoch: 99 } }
					: {}),
				...(fault === "header"
					? { output: { ...original.output, fileBytes: 205 } }
					: {}),
			})
			f.complete(receipt)
			expect(await h.finish()).toBe(receipt)
			expect(await h.settled).toMatchObject({
				filesystem: { ok: false, state: "unknown" },
				operation: { ok: false, state: "unknown" },
				operationSettled: true,
				logicalReleased: true,
			})
		},
	)
	it("custom begin throw grants neither component proof even after successful logical release", async () => {
		const f = fixture()
		f.begin.mockImplementation(() => {
			throw new Error("effect then throw")
		})
		const h = new RecordingProducers(f.deps).begin(f.input)
		await expect(h.ready).rejects.toThrow("creation failed")
		expect(await h.settled).toMatchObject({
			receipt: null,
			operationSettled: false,
			logicalReleased: true,
			filesystem: { ok: false, state: "unknown" },
			operation: { ok: false, state: "unknown" },
		})
	})
	it("a finish receipt cannot replace a rejected actual operation settlement", async () => {
		const f = fixture(),
			h = new RecordingProducers(f.deps).begin(f.input)
		await h.ready
		const receipt: AnalogReceipt = Object.freeze({
			...f.receipt(),
			cleanup: "complete",
			residueBytes: 0,
		})
		const finish = h.finish()
		f.finished.resolve(receipt)
		f.settled.reject(new Error("settlement unknown"))
		expect(await finish).toBe(receipt)
		expect(await h.settled).toMatchObject({
			filesystem: { ok: false, state: "unknown" },
			operation: { ok: false, state: "unknown" },
			operationSettled: false,
			componentClosed: false,
		})
	})
})
