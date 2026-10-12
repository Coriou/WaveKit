import { expect, it, vi } from "vitest"
import { createWsClient, type WsHandlers } from "./ws-client.js"
import type { Inbound } from "./types.js"
import { initialState, reduce } from "./reducers.js"

it("ignores activity frames and does not subscribe to activity", () => {
	let handlers: WsHandlers | undefined
	const sent: string[] = []
	let state = initialState(0)
	const emit = vi.fn((item: Inbound) => {
		state = reduce(state, [item], 0)
	})
	const client = createWsClient({
		url: () => "ws://localhost/ws",
		factory: (_url, h) => {
			handlers = h
			return {
				send: text => {
					sent.push(text)
				},
				close: vi.fn(),
			}
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
	handlers!.message(
		JSON.stringify({
			type: "activity:records",
			channel: "activity",
			data: { id: "one", items: [], scannedThrough: "1", cursor: "c" },
		}),
	)
	handlers!.message(
		JSON.stringify({
			type: "error",
			channel: "activity",
			data: { code: "ACTIVITY_DISABLED", message: "Activity is disabled" },
		}),
	)
	expect(state.conn.invalidFrames).toBe(before.conn.invalidFrames)
	expect(state).toBe(before)
	expect(emit).not.toHaveBeenCalled()
	handlers!.open()
	const subscribe = JSON.parse(sent.at(-1) ?? "{}") as {
		type?: string
		channels?: string[]
	}
	expect(subscribe.type).toBe("subscribe")
	expect(subscribe.channels ?? []).not.toContain("activity")
	handlers!.message("{")
	expect(state.conn.invalidFrames).toBe(before.conn.invalidFrames + 1)
	client.stop()
})
