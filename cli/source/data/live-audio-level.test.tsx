import { expect, it, vi } from "vitest"
import { createWsClient, type WsHandlers } from "./ws-client.js"
import type { Inbound } from "./types.js"
import { initialState, reduce } from "./reducers.js"

it("accepts and drops live audio levels without invalid frames or store updates", () => {
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
	for (const power of [null, -80, -60]) {
		handlers!.message(
			JSON.stringify({
				type: "live-audio:level",
				data: {
					sourceId: "rtl-pi",
					channelPowerDbfs: power,
					noiseFloorDbfs: power,
					squelchOpen: false,
					thresholdDbfs: -74,
				},
			}),
		)
	}
	expect(state.conn.invalidFrames).toBe(before.conn.invalidFrames)
	expect(state).toBe(before)
	expect(emit).not.toHaveBeenCalled()
	handlers!.message(
		JSON.stringify({ type: "live-audio:level", data: { sourceId: "rtl-pi" } }),
	)
	expect(state.conn.invalidFrames).toBe(before.conn.invalidFrames + 1)
	client.stop()
})
