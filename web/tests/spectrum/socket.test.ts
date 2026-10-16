import { describe, expect, it } from "vitest"
import {
	parseServerMessage,
	subscribeMessage,
	wsUrlFrom,
} from "../../src/spectrum/socket.ts"
import { frameJson } from "./frames.ts"

describe("socket helpers", () => {
	it("builds the /ws URL from the page location", () => {
		expect(wsUrlFrom("http://localhost:5173/app/#x")).toBe(
			"ws://localhost:5173/ws",
		)
		expect(wsUrlFrom("https://wk.example/")).toBe("wss://wk.example/ws")
	})

	it("subscribes to the spectrum channel only with the given options", () => {
		expect(
			JSON.parse(subscribeMessage({ sourceId: "rtl", hz: 25, bins: 2048 })),
		).toEqual({
			type: "subscribe",
			channels: ["spectrum"],
			options: { spectrum: { sourceId: "rtl", hz: 25, bins: 2048 } },
		})
		expect(
			JSON.parse(subscribeMessage({ sourceId: "rtl" })).options.spectrum,
		).toEqual({ sourceId: "rtl" })
	})

	it("parses frames and profiles, ignores everything else", () => {
		expect(parseServerMessage(frameJson({}))?.type).toBe("spectrum:frame")
		expect(
			parseServerMessage(
				JSON.stringify({
					type: "spectrum:profile",
					channel: "spectrum",
					data: { selection: "source", outcome: "exact", adjusted: [] },
				}),
			)?.type,
		).toBe("spectrum:profile")
		expect(parseServerMessage("{")).toBeNull()
		expect(
			parseServerMessage(JSON.stringify({ type: "metrics", data: {} })),
		).toBeNull()
		expect(parseServerMessage(frameJson({ binEncoding: "f32" }))).toBeNull()
		expect(parseServerMessage(frameJson({ binHz: 0 }))).toBeNull()
		expect(parseServerMessage(frameJson({ bins: 3 }))).toBeNull()
	})
})
