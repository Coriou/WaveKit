import { describe, expect, it, vi } from "vitest"
import { createScannerRuntimePhases } from "../../../src/index.js"

function deferred() {
	let resolve!: () => void
	let reject!: (error: unknown) => void
	const promise = new Promise<void>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}

function fixture() {
	const front = deferred()
	const producer = deferred()
	const native = deferred()
	const local = deferred()
	const completion = deferred()
	const deps = {
		sealAdmission: vi.fn(),
		drainBeforeProducer: vi.fn(() => front.promise),
		beginStop: vi.fn(() => ({
			producerSettled: producer.promise,
			completed: completion.promise,
		})),
		stopDecoders: vi.fn(async () => undefined),
		stopChannelizer: vi.fn(() => native.promise),
		attemptLocalCleanup: vi.fn(async () => {
			await local.promise
			return [{ ok: true as const }]
		}),
		finalizeStopNative: vi.fn(async () => {
			completion.resolve()
		}),
	}
	const phases = createScannerRuntimePhases(deps)
	return { front, producer, native, local, completion, deps, phases }
}

// Advance promise continuations without timers or a timeout as settlement proof.
async function continuations() {
	for (let index = 0; index < 20; index++) await Promise.resolve()
}

describe("index scanner composition actual phase ownership", () => {
	it("reentrant sealing cannot create a second phase graph", async () => {
		const f = fixture()
		let reentrant: Promise<void> | undefined
		f.deps.sealAdmission.mockImplementation(() => {
			reentrant = f.phases.completed()
		})
		const actual = f.phases.completed()
		expect(reentrant).toBe(actual)
		f.front.resolve()
		f.producer.resolve()
		f.native.resolve()
		f.local.resolve()
		await actual
		expect(f.deps.beginStop).toHaveBeenCalledOnce()
		expect(f.deps.stopDecoders).toHaveBeenCalledOnce()
		expect(f.deps.stopChannelizer).toHaveBeenCalledOnce()
	})

	it("seals synchronously before operator/API drain and retains each phase promise", async () => {
		const f = fixture()
		const result = f.phases.completed()
		expect(f.deps.sealAdmission).toHaveBeenCalledOnce()
		expect(f.phases.completed()).toBe(result)
		await continuations()
		expect(f.deps.beginStop).not.toHaveBeenCalled()
		f.front.resolve()
		await continuations()
		expect(f.deps.beginStop).toHaveBeenCalledOnce()
		expect(f.deps.stopDecoders).not.toHaveBeenCalled()
		f.producer.resolve()
		await continuations()
		expect(f.deps.stopDecoders).toHaveBeenCalledOnce()
		expect(f.deps.stopChannelizer).toHaveBeenCalledOnce()
		expect(f.deps.attemptLocalCleanup).toHaveBeenCalledOnce()
		expect(f.deps.finalizeStopNative).not.toHaveBeenCalled()
		f.native.resolve()
		f.local.resolve()
		await result
		expect(f.deps.finalizeStopNative).toHaveBeenCalledWith({ ok: true })
		expect(f.deps.sealAdmission).toHaveBeenCalledOnce()
	})

	it("phase 40 never waits for the native completion handle", async () => {
		const f = fixture()
		f.front.resolve()
		f.producer.resolve()
		await f.phases.producerSettled()
		expect(f.deps.stopChannelizer).not.toHaveBeenCalled()
		expect(f.deps.finalizeStopNative).not.toHaveBeenCalled()
		expect(f.phases.producerSettled()).toBe(f.phases.producerSettled())
	})

	it("an early rejected component cannot advance 60 before its sibling settles", async () => {
		const f = fixture()
		const sibling = deferred()
		const componentFailure = Promise.reject(new Error("component failed"))
		const allComponents = Promise.allSettled([componentFailure, sibling.promise]).then(() => {
			throw new Error("component aggregate failed")
		})
		f.deps.beginStop.mockReturnValue({ producerSettled: allComponents, completed: f.completion.promise })
		const result = f.phases.completed().catch(error => error as unknown)
		f.front.resolve()
		await continuations()
		expect(f.deps.stopDecoders).not.toHaveBeenCalled()
		sibling.resolve()
		await continuations()
		expect(f.deps.stopDecoders).toHaveBeenCalledOnce()
		f.native.resolve()
		f.local.resolve()
		expect(await result).toMatchObject({ code: "ACCESS_UNAVAILABLE" })
		expect(f.deps.finalizeStopNative).toHaveBeenCalledWith(expect.objectContaining({ ok: false, state: "unknown" }))
	})

	it("manager failure still initiates both native and local cleanup and retains first failure", async () => {
		const f = fixture()
		f.deps.stopDecoders.mockRejectedValue(new Error("decoder failure"))
		f.front.resolve()
		f.producer.resolve()
		const manager = f.phases.managerSettled().catch(error => error as unknown)
		const result = f.phases.completed().catch(error => error as unknown)
		await continuations()
		expect(f.deps.stopChannelizer).toHaveBeenCalledOnce()
		expect(f.deps.attemptLocalCleanup).toHaveBeenCalledOnce()
		f.native.resolve()
		await continuations()
		expect(f.deps.finalizeStopNative).not.toHaveBeenCalled()
		f.local.resolve()
		expect(await result).toBe(await manager)
		expect(f.phases.completed()).toBe(f.phases.completed())
	})

	it("native failure does not skip a held independently owned local attempt", async () => {
		const f = fixture()
		f.front.resolve()
		f.producer.resolve()
		const result = f.phases.completed().catch(error => error as unknown)
		await continuations()
		f.native.reject(new Error("native closure unknown"))
		await continuations()
		expect(f.deps.attemptLocalCleanup).toHaveBeenCalledOnce()
		expect(f.deps.finalizeStopNative).not.toHaveBeenCalled()
		f.local.resolve()
		expect(await result).toMatchObject({ code: "ACCESS_UNAVAILABLE" })
	})

	it("a caller timeout race cannot reorder the actual dependency graph", async () => {
		const f = fixture()
		const actual = f.phases.producerSettled()
		await Promise.race([actual, Promise.resolve("caller timeout")])
		const final = f.phases.completed()
		void f.phases.managerSettled()
		void f.phases.coreSettled()
		await continuations()
		expect(f.deps.stopDecoders).not.toHaveBeenCalled()
		expect(f.deps.stopChannelizer).not.toHaveBeenCalled()
		f.front.resolve()
		f.producer.resolve()
		f.native.resolve()
		f.local.resolve()
		await final
	})

	it("a synchronous partial-construction failure still attempts later cleanup", async () => {
		const f = fixture()
		f.deps.beginStop.mockImplementation(() => { throw new Error("construction cleanup failed") })
		const final = f.phases.completed().catch(error => error as unknown)
		f.front.resolve()
		f.native.resolve()
		f.local.resolve()
		expect(await final).toMatchObject({ code: "ACCESS_UNAVAILABLE" })
		expect(f.deps.stopDecoders).toHaveBeenCalledOnce()
		expect(f.deps.stopChannelizer).toHaveBeenCalledOnce()
		expect(f.deps.attemptLocalCleanup).toHaveBeenCalledOnce()
	})

	it("an unknown final outcome stays failed after later receipts and repeated stop", async () => {
		const f = fixture()
		f.deps.finalizeStopNative.mockRejectedValueOnce(new Error("ownership unknown"))
		f.front.resolve()
		f.producer.resolve()
		f.native.resolve()
		f.local.resolve()
		const actual = f.phases.completed()
		const first = await actual.catch(error => error as unknown)
		f.deps.finalizeStopNative.mockResolvedValue(undefined)
		expect(f.phases.completed()).toBe(actual)
		expect(await actual.catch(error => error as unknown)).toBe(first)
		expect(f.deps.finalizeStopNative).toHaveBeenCalledOnce()
	})
})
