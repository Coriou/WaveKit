import { PassThrough } from "node:stream"
import { describe, expect, it, vi } from "vitest"
import type { ChannelProvider } from "../../../../src/core/channelizer/types.js"
import type {
	AcquisitionSnapshot,
	ObservedAcquisitionHandle,
	ObservedGrantBinding,
} from "../../../../src/core/channelizer/settlement-observer.js"
import { GrantLifecycle } from "../../../../src/core/scanner/channel/grant-lifecycle.js"
import type { ScannerChannelAttempt } from "../../../../src/core/scanner/channel/consumer-types.js"

function fixture() {
	// Explicit fake consumer proof schedule. This does not certify native witness implementation.
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
	const binding = {
		sourceId: "s",
		decoderId: "tap",
		channelId: "opaque:do-not-parse",
		generation: 3,
		realised: {
			outputRateHz: 48_000,
			format: "cf32",
			filterTaps: 5,
			groupDelaySamples: 2,
		},
		process: {},
		send: {},
	} as unknown as ObservedGrantBinding
	let state: AcquisitionSnapshot = {
		scannerAttempt: attempt.identity,
		logical: "granted",
		currentBinding: binding,
		ended: false,
		continuityLost: false,
		native: "pending",
		local: "pending",
		components: {
			decoder: "settled",
			classifier: "settled",
			analog: "settled",
			filesystem: "settled",
			operation: "settled",
		},
	}
	const listeners = new Set<() => void>(),
		unsubscribe = vi.fn()
	const fake = {
		binding,
		snapshot: () => state,
		cancel: vi.fn(() => {
			state = { ...state, ended: true }
		}),
		onChange: (callback: () => void) => {
			listeners.add(callback)
			return () => {
				unsubscribe()
				listeners.delete(callback)
			}
		},
	}
	const handle = fake as unknown as ObservedAcquisitionHandle
	const release = vi.fn(() => Promise.resolve()),
		provider = { releaseChannel: release } as unknown as ChannelProvider
	const stream = new PassThrough(),
		ended = vi.fn(),
		current = { value: true }
	const lifecycle = new GrantLifecycle(
		attempt,
		handle,
		provider,
		() => current.value,
		ended,
	)
	const result = {
		ok: true as const,
		stream,
		channelId: binding.channelId,
		generation: 3,
		realised: {
			outputRateHz: 48_000,
			format: "cf32" as const,
			groupDelaySamples: 2,
		},
	}
	return {
		lifecycle,
		fake,
		binding,
		result,
		ended,
		release,
		current,
		unsubscribe,
		change: (delta: Partial<AcquisitionSnapshot>) => {
			state = { ...state, ...delta }
			for (const notify of listeners) notify()
		},
	}
}
describe("exact direct grant lifecycle", () => {
	it("grant invalidated before await adoption cannot become live", async () => {
		const f = fixture()
		f.change({ ended: true })
		expect(f.lifecycle.adopt(f.result)).toBe(false)
		expect(f.lifecycle.binding).toBeUndefined()
		expect(f.result.stream.destroyed).toBe(true)
		await f.lifecycle.logicalDrain()
		expect(f.release).toHaveBeenCalledExactlyOnceWith("opaque:do-not-parse")
	})
	it("clears binding before ended reentry and never reuses old generation as liveness", async () => {
		const f = fixture()
		expect(f.lifecycle.adopt(f.result)).toBe(true)
		f.ended.mockImplementation(() => {
			expect(f.lifecycle.binding).toBeUndefined()
		})
		f.change({ ended: true })
		f.lifecycle.invalidate()
		await f.lifecycle.logicalDrain()
		expect(f.ended).toHaveBeenCalledOnce()
		expect(f.release).toHaveBeenCalledOnce()
		expect(f.lifecycle.reclaimIfSettled()).toBe(false)
		expect(f.unsubscribe).not.toHaveBeenCalled()
		f.change({ native: "settled", local: "settled" })
		expect(f.lifecycle.reclaimIfSettled()).toBe(true)
		expect(f.lifecycle.reclaimIfSettled()).toBe(true)
		expect(f.unsubscribe).toHaveBeenCalledOnce()
	})
	it("callback throw still cancels and releases once; stale source currentness refuses", async () => {
		const f = fixture()
		expect(f.lifecycle.adopt(f.result)).toBe(true)
		f.ended.mockImplementation(() => {
			throw new TypeError("fixture callback")
		})
		f.lifecycle.invalidate()
		await f.lifecycle.logicalDrain()
		expect(f.fake.cancel).toHaveBeenCalledOnce()
		expect(f.release).toHaveBeenCalledOnce()
		const stale = fixture()
		stale.current.value = false
		expect(stale.lifecycle.adopt(stale.result)).toBe(false)
		expect(stale.lifecycle.live).toBe(false)
	})
	it("throwing cancel cannot skip original stream destruction or logical release", async () => {
		const f = fixture()
		expect(f.lifecycle.adopt(f.result)).toBe(true)
		f.fake.cancel.mockImplementation(() => {
			throw new TypeError("fixture cancellation")
		})
		f.lifecycle.invalidate()
		expect(f.result.stream.destroyed).toBe(true)
		await f.lifecycle.logicalDrain()
		expect(f.release).toHaveBeenCalledExactlyOnceWith(f.binding.channelId)
		f.change({ native: "settled", local: "settled" })
		expect(f.lifecycle.reclaimIfSettled()).toBe(false)
		expect(f.unsubscribe).not.toHaveBeenCalled()
	})
})
