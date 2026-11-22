/**
 * Scanner channel taps read their channel in Node (the classifier and the analog trials consume the samples), so they
 * keep the relay whatever WAVEKIT_CHANNEL_INPUT says: a tap asks without the `input` option, which is a relay
 * request, and a provider that serves direct input answers it with a stream, never the socket.
 */
import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ChannelTaps } from "../../../../src/core/scanner/channel/channel-tap.js"
import type { ScannerChannelAttempt } from "../../../../src/core/scanner/channel/consumer-types.js"
import type { PreparedScannerChannel } from "../../../../src/core/scanner/channel/provider-observer.js"
import { prepareDirectChannel } from "../../../../src/core/scanner/channel/provider-observer.js"
import {
	CHANNEL_INPUT_ENV,
	processChannelInputMode,
	resetProcessChannelInputModeForTests,
} from "../../../../src/decoders/channel-input-mode.js"
import { DirectProvider } from "../../decoders/direct-channel-fakes.js"

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

afterEach(() => {
	vi.unstubAllEnvs()
	resetProcessChannelInputModeForTests()
})

describe("scanner channel taps with WAVEKIT_CHANNEL_INPUT=direct", () => {
	it("ask a direct-capable provider with the relay call and are granted a stream", async () => {
		vi.stubEnv(CHANNEL_INPUT_ENV, "direct")
		resetProcessChannelInputModeForTests()
		expect(processChannelInputMode(pino({ level: "silent" }))).toBe("direct")
		const adopt = vi.fn((_grant: { stream?: unknown }) => false)
		const sealed = () => ({
			begin: vi.fn(() => true),
			settle: vi.fn(),
			sealNeverStarted: vi.fn(),
		})
		const prepared = {
			classifier: sealed(),
			analog: sealed(),
			filesystem: sealed(),
			operation: sealed(),
			lifecycle: {
				continuityLost: false,
				live: false,
				readable: undefined,
				adopt,
				invalidate: vi.fn(),
				logicalDrain: vi.fn(() => Promise.resolve()),
				reclaimIfSettled: () => true,
			},
			handle: {
				snapshot: () => ({ components: { classifier: "settled" } }),
			},
			request: {
				centerHz: attempt.targetHz,
				bandwidthHz: 16_000,
				transitionHz: 4_000,
				outputRateHz: 48_000,
				format: "cf32" as const,
			},
		} as unknown as PreparedScannerChannel
		vi.mocked(prepareDirectChannel).mockImplementation(() => prepared)
		const provider = new DirectProvider()
		const taps = new ChannelTaps({
			channels: provider,
			ownership: undefined,
			profile: null,
			maxSources: 1,
			now: () => 0,
		})
		taps.begin({
			attempt,
			current: () => true,
			minMs: 500,
			collected: vi.fn(),
		})
		await vi.waitFor(() => expect(adopt).toHaveBeenCalledOnce())
		// Four arguments: no signal, no options, so no `input: "direct"`.
		expect(provider.calls).toEqual([{ decoderId: "tap", args: 4 }])
		const grant = adopt.mock.calls[0]?.[0]
		expect(grant).toMatchObject({ ok: true, channelId: "tap-g1" })
		expect(grant).not.toHaveProperty("socket")
		expect(grant).not.toHaveProperty("input")
		expect(grant?.stream).toBe(provider.streams.get("tap-g1"))
		expect(provider.sockets.size).toBe(0)
		await taps.stop()
	})
})
