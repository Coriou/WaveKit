import { expect, it, vi } from "vitest"
import { createWsClient, type WsHandlers } from "./ws-client.js"
import type { Inbound } from "./types.js"
import { initialState, reduce } from "./reducers.js"

it("accepts and drops live audio transmissions without invalid frames or store updates", () => {
	let handlers: WsHandlers | undefined
	let state = initialState(0)
	const emit = vi.fn((item: Inbound) => {
		state = reduce(state, [item], 0)
	})
	const client = createWsClient({
		url: () => "ws://localhost/ws",
		factory: (_url, h) => {
			handlers = h
			return { send: vi.fn(), close: vi.fn() }
		},
		emit,
		now: () => 0,
		random: () => 0,
		setTimeout: () => 0,
		clearTimeout: () => {},
	})
	client.start()
	const before = state
	emit.mockClear()
	for (const phase of ["open", "closed"] as const) {
		handlers!.message(
			JSON.stringify({
				type: "live-audio:transmission",
				channel: "live-audio",
				data: {
					transmissionId: "5b0c7f0e-2d1a-4c7b-9f43-0d8e6a1b2c3d",
					sourceId: "rtl-pi",
					state: phase,
					startedAt: "2026-10-13T14:02:11.250Z",
					endedAt: phase === "closed" ? "2026-10-13T14:02:14.100Z" : null,
					durationMs: phase === "closed" ? 2850 : null,
					frequency: { hz: 446006250, tuningTrust: "commanded" },
					modulation: "nfm",
					bandwidthHz: 12500,
					squelchMode: "manual",
					thresholdDbfs: -40,
					peakChannelPowerDbfs: null,
					meanChannelPowerDbfs: null,
					closeReason: phase === "closed" ? "squelch" : null,
				},
			}),
		)
	}
	expect(state).toBe(before)
	expect(emit).not.toHaveBeenCalled()
	handlers!.message(
		JSON.stringify({
			type: "live-audio:transmission",
			data: { sourceId: "rtl-pi" },
		}),
	)
	expect(state.conn.invalidFrames).toBe(before.conn.invalidFrames + 1)
	client.stop()
})
