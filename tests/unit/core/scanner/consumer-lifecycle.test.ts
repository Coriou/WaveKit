import { describe, expect, it, vi } from "vitest"
import { EventEmitter } from "node:events"
import type {
	ChannelSettlementObserver,
	CleanupOutcome,
	ProviderLifetime,
} from "../../../../src/core/channelizer/settlement-observer.js"
import {
	ConstructorListenerRegistration,
	ScannerLifecycleOwner,
} from "../../../../src/core/scanner/channel/consumer-lifecycle.js"
import type { ScannerCleanupSlot } from "../../../../src/core/scanner/channel/consumer-lifecycle.js"

const OK: CleanupOutcome = { ok: true }
const UNKNOWN: CleanupOutcome = {
	ok: false,
	state: "unknown",
	detail: "Owned component remains unknown",
}
const FAILED: CleanupOutcome = {
	ok: false,
	state: "failed",
	detail: "Owned component cleanup failed",
}
const SLOTS: readonly ScannerCleanupSlot[] = [
	"service",
	"probes",
	"grants",
	"tap",
	"classifier",
	"producer",
	"admission",
]

describe("exact constructor listener ownership (C6)", () => {
	it("captures before install-then-throw and removes only the actual owned callback", () => {
		const emitter = new EventEmitter()
		const unrelated = vi.fn()
		const owned = vi.fn()
		emitter.on("event", unrelated)
		const original = new Error("install failed after effect")
		let retained: (() => void) | undefined
		const registration = new ConstructorListenerRegistration(
			() => {
				emitter.on("event", owned)
				throw original
			},
			() => {
				emitter.off("event", owned)
			},
			() => !emitter.listeners("event").includes(owned),
		)
		expect(() =>
			registration.register(remove => {
				retained = remove
				return true
			}),
		).toThrow(original)
		expect(retained).toBeDefined()
		retained!()
		expect(emitter.listeners("event")).toEqual([unrelated])
	})
	it("never treats registration-time removal as settled while .on can still add the listener", () => {
		const emitter = new EventEmitter()
		const owned = vi.fn()
		let retained!: () => void
		const registration = new ConstructorListenerRegistration(
			() => {
				expect(retained).toThrow(
					expect.objectContaining({
						code: "SCANNER_COMPONENT_CLEANUP_UNKNOWN",
					}),
				)
				emitter.on("event", owned)
			},
			() => {
				emitter.off("event", owned)
			},
			() => !emitter.listeners("event").includes(owned),
		)
		expect(() =>
			registration.register(remove => {
				retained = remove
				return true
			}),
		).toThrow(expect.objectContaining({ code: "SCANNER_OWNER_UNAVAILABLE" }))
		expect(emitter.listeners("event")).toEqual([])
	})
	it("keeps an unverified exact removal retryable without reporting success", () => {
		const emitter = new EventEmitter()
		const owned = vi.fn()
		let canRemove = false
		const registration = new ConstructorListenerRegistration(
			() => {
				emitter.on("event", owned)
			},
			() => {
				if (canRemove) emitter.off("event", owned)
			},
			() => !emitter.listeners("event").includes(owned),
		)
		registration.register()
		expect(() => registration.remove()).toThrow(
			expect.objectContaining({ code: "SCANNER_COMPONENT_CLEANUP_UNKNOWN" }),
		)
		canRemove = true
		registration.remove()
		expect(emitter.listeners("event")).toEqual([])
	})
})
function hold<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
async function flush() {
	await Promise.resolve()
	await Promise.resolve()
	await Promise.resolve()
}
function nativeInspector(outcome: CleanupOutcome = OK) {
	const inspectFinal = vi.fn((_producer: CleanupOutcome) => outcome)
	const attemptLocalCleanup = vi.fn(() => Promise.resolve([OK]))
	const disposeListenersIfSettled = vi.fn(() => OK)
	// The owner unit test exercises typed synchronous inspection, never claims core proof.
	// Full native/local proof is tested by the independently owned core implementation.
	const observer = {
		inspectFinal,
		attemptLocalCleanup,
	} as unknown as ChannelSettlementObserver
	const lifetime = {
		inspectFinal,
		attemptLocalCleanup,
		disposeListenersIfSettled,
	} as unknown as ProviderLifetime
	return {
		observer,
		lifetime,
		inspectFinal,
		attemptLocalCleanup,
		disposeListenersIfSettled,
	}
}

describe("ScannerLifecycleOwner fixed component boundary", () => {
	it("sweeps settled references once at phase66 before the first nonwaiting inspection", async () => {
		const owner = new ScannerLifecycleOwner()
		const component = hold<CleanupOutcome>()
		owner.ownCleanup("tap", () => component.promise)
		owner.completeConstruction(OK)
		const handle = owner.beginStop()
		const order: string[] = []
		const inspector = nativeInspector()
		inspector.inspectFinal.mockImplementation(() => {
			order.push("inspect")
			return OK
		})
		const sweep = vi.fn(() => {
			order.push("sweep")
			return OK
		})
		const completed = owner.finalizeStopNative(
			inspector.observer,
			inspector.lifetime,
			sweep,
		)
		await flush()
		expect(sweep).not.toHaveBeenCalled()
		expect(inspector.inspectFinal).not.toHaveBeenCalled()
		component.resolve(OK)
		await handle.producerSettled
		await completed
		expect(order).toEqual(["sweep", "inspect"])
		expect(
			owner.finalizeStopNative(inspector.observer, inspector.lifetime, sweep),
		).toBe(completed)
		expect(sweep).toHaveBeenCalledOnce()
	})

	it("is inert and refuses duplicate/new sealed effect registration before effects", async () => {
		const owner = new ScannerLifecycleOwner()
		const cleanup = vi.fn(() => Promise.resolve(OK))
		expect(owner.admissionSealed).toBe(false)
		for (const slot of SLOTS) expect(owner.ownCleanup(slot, cleanup)).toBe(true)
		expect(owner.ownCleanup("service", cleanup)).toBe(false)
		expect(cleanup).not.toHaveBeenCalled()
		owner.sealAdmission()
		expect(owner.admissionSealed).toBe(true)
		expect(owner.ownCleanup("service", cleanup)).toBe(false)
		owner.completeConstruction(OK)
		await owner.beginStop().producerSettled
		expect(cleanup).toHaveBeenCalledTimes(7)
	})

	it("claims one frozen handle before reentrant cleanup and never repeats actual cleanup", async () => {
		const owner = new ScannerLifecycleOwner()
		let reentered: ReturnType<ScannerLifecycleOwner["beginStop"]> | undefined
		const cleanup = vi.fn(() => {
			reentered = owner.beginStop()
			return Promise.resolve(OK)
		})
		owner.ownCleanup("service", cleanup)
		owner.completeConstruction(OK)
		const handle = owner.beginStop()
		expect(Object.isFrozen(handle)).toBe(true)
		expect(owner.beginStop()).toBe(handle)
		await handle.producerSettled
		expect(reentered).toBe(handle)
		expect(cleanup).toHaveBeenCalledTimes(1)
		expect(owner.finalizeStopNative(undefined)).toBe(handle.completed)
		await handle.completed
		expect(owner.finalizeStopNative(undefined)).toBe(handle.completed)
	})

	it("waits the actual construction checkpoint and cleanup of a late-created component", async () => {
		const owner = new ScannerLifecycleOwner()
		let resource: { removed: boolean } | undefined
		const cleanup = vi.fn(() => {
			if (resource !== undefined) resource.removed = true
			return Promise.resolve(OK)
		})
		owner.ownCleanup("tap", cleanup)
		const handle = owner.beginStop()
		let settled = false
		void handle.producerSettled.then(() => {
			settled = true
		})
		await flush()
		expect(cleanup).not.toHaveBeenCalled()
		expect(settled).toBe(false)
		resource = { removed: false }
		owner.completeConstruction(OK)
		await handle.producerSettled
		expect(resource.removed).toBe(true)
	})

	it("drains EVERY independent sibling before publishing an early rejection", async () => {
		const owner = new ScannerLifecycleOwner()
		const sibling = hold<CleanupOutcome>()
		const heldCleanup = vi.fn(() => sibling.promise)
		const independent = vi.fn(() => Promise.resolve(OK))
		owner.ownCleanup("service", async () => {
			throw new Error("Original exception is not outcome authority")
		})
		owner.ownCleanup("producer", heldCleanup)
		owner.ownCleanup("tap", independent)
		owner.completeConstruction(OK)
		const handle = owner.beginStop()
		let rejected = false
		void handle.producerSettled.catch(() => {
			rejected = true
		})
		await flush()
		expect(heldCleanup).toHaveBeenCalledTimes(1)
		expect(independent).toHaveBeenCalledTimes(1)
		expect(rejected).toBe(false)
		sibling.resolve(OK)
		await expect(handle.producerSettled).rejects.toMatchObject({
			code: "SCANNER_COMPONENT_CLEANUP_FAILED",
		})
	})

	it("retains the first actual component failure regardless of later sibling outcome", async () => {
		const owner = new ScannerLifecycleOwner()
		const first = hold<CleanupOutcome>()
		const later = hold<CleanupOutcome>()
		owner.ownCleanup("probes", () => later.promise)
		owner.ownCleanup("producer", () => first.promise)
		owner.completeConstruction(OK)
		const handle = owner.beginStop()
		await flush()
		first.resolve(UNKNOWN)
		await flush()
		later.resolve(FAILED)
		await expect(handle.producerSettled).rejects.toMatchObject({
			message: UNKNOWN.detail,
		})
		const inspector = nativeInspector(OK)
		await expect(
			owner.finalizeStopNative(inspector.observer, inspector.lifetime),
		).rejects.toMatchObject({ message: UNKNOWN.detail })
		expect(inspector.inspectFinal).toHaveBeenCalledWith(UNKNOWN)
	})

	it("retains partial constructor resources without treating the missing service as disposal", async () => {
		const owner = new ScannerLifecycleOwner()
		const held = hold<CleanupOutcome>()
		const actual = { removed: false }
		owner.ownCleanup("service", async () => {
			actual.removed = true
			return OK
		})
		owner.ownCleanup("producer", () => held.promise)
		owner.completeConstruction(FAILED)
		expect(owner.admissionSealed).toBe(true)
		const handle = owner.beginStop()
		let done = false
		void handle.producerSettled.catch(() => {
			done = true
		})
		await flush()
		expect(actual.removed).toBe(true)
		expect(done).toBe(false)
		held.resolve(OK)
		await expect(handle.producerSettled).rejects.toMatchObject({
			message: FAILED.detail,
		})
		const inspector = nativeInspector()
		await expect(
			owner.finalizeStopNative(undefined, inspector.lifetime),
		).rejects.toMatchObject({ message: FAILED.detail })
		expect(inspector.inspectFinal).toHaveBeenCalledWith(FAILED)
	})

	it("never overwrites the first construction checkpoint with a duplicate or competing result", async () => {
		const owner = new ScannerLifecycleOwner()
		owner.completeConstruction(FAILED)
		owner.completeConstruction(OK)
		await expect(owner.beginStop().producerSettled).rejects.toMatchObject({
			message: FAILED.detail,
		})
		const success = new ScannerLifecycleOwner()
		success.completeConstruction(OK)
		success.completeConstruction(FAILED)
		await success.beginStop().producerSettled
	})

	it("freezes first construction failure facts against caller mutation", async () => {
		const owner = new ScannerLifecycleOwner()
		const failure: { ok: false; state: "failed" | "unknown"; detail: string } =
			{ ok: false, state: "failed", detail: "First construction failure" }
		owner.completeConstruction(failure)
		failure.state = "unknown"
		failure.detail = "Later caller rewrite"
		await expect(owner.beginStop().producerSettled).rejects.toMatchObject({
			message: "First construction failure",
			code: "SCANNER_COMPONENT_CLEANUP_FAILED",
		})
	})
})

describe("ScannerLifecycleOwner nonwaiting final native inspection", () => {
	it("phase40 completes without native/local/provider waits, and completed waits explicit finalization", async () => {
		const owner = new ScannerLifecycleOwner()
		const inspector = nativeInspector(UNKNOWN)
		owner.completeConstruction(OK)
		const handle = owner.beginStop()
		let completed = false
		void handle.completed.then(
			() => {
				completed = true
			},
			() => {
				completed = true
			},
		)
		await handle.producerSettled
		expect(completed).toBe(false)
		expect(inspector.inspectFinal).not.toHaveBeenCalled()
		expect(inspector.attemptLocalCleanup).not.toHaveBeenCalled()
		await expect(
			owner.finalizeStopNative(inspector.observer, inspector.lifetime),
		).rejects.toMatchObject({ message: UNKNOWN.detail })
		expect(inspector.attemptLocalCleanup).not.toHaveBeenCalled()
		expect(inspector.disposeListenersIfSettled).not.toHaveBeenCalled()
	})

	it("runs inspection only AFTER successful cleanup removed its exact subscription and refs", async () => {
		const owner = new ScannerLifecycleOwner()
		let listenerRemoved = false
		let reference: object | undefined = {}
		owner.ownCleanup("grants", async () => {
			listenerRemoved = true
			reference = undefined
			return OK
		})
		owner.completeConstruction(OK)
		const inspector = nativeInspector()
		inspector.inspectFinal.mockImplementation(() => {
			expect(listenerRemoved).toBe(true)
			expect(reference).toBeUndefined()
			return OK
		})
		await owner.finalizeStopNative(inspector.observer, inspector.lifetime)
		expect(inspector.inspectFinal).toHaveBeenCalledTimes(1)
	})

	it("first unknown native outcome stays rejected after late proof and alternate inspector", async () => {
		const owner = new ScannerLifecycleOwner()
		owner.completeConstruction(OK)
		const inspector = nativeInspector(UNKNOWN)
		const handle = owner.beginStop()
		const result = owner.finalizeStopNative(
			inspector.observer,
			inspector.lifetime,
		)
		expect(result).toBe(handle.completed)
		await expect(result).rejects.toMatchObject({ message: UNKNOWN.detail })
		const late = nativeInspector(OK)
		expect(owner.finalizeStopNative(late.observer, late.lifetime)).toBe(result)
		await expect(result).rejects.toMatchObject({ message: UNKNOWN.detail })
		expect(late.inspectFinal).not.toHaveBeenCalled()
	})

	it("claims first completion before inspection can reenter finalization", async () => {
		const owner = new ScannerLifecycleOwner()
		owner.completeConstruction(OK)
		const inspector = nativeInspector()
		const handle = owner.beginStop()
		inspector.inspectFinal.mockImplementation(() => {
			expect(
				owner.finalizeStopNative(inspector.observer, inspector.lifetime),
			).toBe(handle.completed)
			return OK
		})
		await owner.finalizeStopNative(inspector.observer, inspector.lifetime)
		expect(inspector.inspectFinal).toHaveBeenCalledTimes(1)
	})

	it("inspects the retained V directly when observer construction never returned", async () => {
		const owner = new ScannerLifecycleOwner()
		const cleanup = vi.fn(() => Promise.resolve(OK))
		owner.ownCleanup("service", cleanup)
		owner.completeConstruction(FAILED)
		const inspector = nativeInspector(UNKNOWN)
		await expect(
			owner.finalizeStopNative(undefined, inspector.lifetime),
		).rejects.toMatchObject({ message: FAILED.detail })
		expect(cleanup).toHaveBeenCalledTimes(1)
		expect(inspector.inspectFinal).toHaveBeenCalledWith(FAILED)
	})

	it("turns throwing typed inspection into a retained immutable failure", async () => {
		const owner = new ScannerLifecycleOwner()
		owner.completeConstruction(OK)
		const inspector = nativeInspector()
		inspector.inspectFinal.mockImplementation(() => {
			throw new Error("External inspection fault")
		})
		const result = owner.finalizeStopNative(
			inspector.observer,
			inspector.lifetime,
		)
		await expect(result).rejects.toMatchObject({
			message: "Scanner final ownership inspection failed",
			code: "SCANNER_COMPONENT_CLEANUP_FAILED",
		})
		expect(owner.finalizeStopNative(undefined)).toBe(result)
	})

	it("supports standalone no-channel component cleanup without inventing a native authority", async () => {
		const owner = new ScannerLifecycleOwner()
		const cleanup = vi.fn(() => Promise.resolve(OK))
		owner.ownCleanup("service", cleanup)
		owner.completeConstruction(OK)
		const handle = owner.beginStop()
		expect(owner.finalizeStopNative(undefined)).toBe(handle.completed)
		await handle.completed
		expect(cleanup).toHaveBeenCalledTimes(1)
	})
})
