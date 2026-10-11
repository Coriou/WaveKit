import { describe, expect, it, vi } from "vitest"
import { prepareDirectChannel } from "../../../../src/core/scanner/channel/provider-observer.js"
import type {
	ScannerChannelAttempt,
	ScannerChannelOwnership,
} from "../../../../src/core/scanner/channel/consumer-types.js"
import { ScannerLifecycleOwner } from "../../../../src/core/scanner/channel/consumer-lifecycle.js"
import { SettlementRegistry } from "../../../../src/core/channelizer/settlement-observer.js"

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
describe("observed direct preparation", () => {
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
