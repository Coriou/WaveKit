/**
 * AprsTrackingManager feeds aprs decoder output into the tracker.
 */

import { describe, expect, it } from "vitest"
import type { DecoderOutput } from "../../../src/decoders/types.js"
import type { DecoderManager } from "../../../src/decoders/manager.js"
import { AprsTrackingManager } from "../../../src/core/aprs-tracking-manager.js"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "error" })

function fakeManager() {
	const handlers: Array<(decoderId: string, output: DecoderOutput) => void> = []
	const manager = {
		on(
			event: string,
			handler: (decoderId: string, output: DecoderOutput) => void,
		) {
			if (event === "decoder:output") handlers.push(handler)
		},
	} as unknown as DecoderManager
	return { manager, handlers }
}

function aprs(source: string, type = "aprs"): DecoderOutput {
	return {
		timestamp: new Date("2026-06-15T12:00:00.000Z"),
		decoder: "ignored",
		type: type as DecoderOutput["type"],
		data: {
			timestamp: new Date("2026-06-15T11:00:00.000Z"),
			source,
			destination: "APRS",
			path: ["WIDE1-1"],
			dataType: "Position",
			lat: 1,
			lon: 2,
			raw: `!${source}`,
		},
	}
}

describe("AprsTrackingManager", () => {
	it("accepts aprs output and ignores other types and other decoders", () => {
		const { manager, handlers } = fakeManager()
		const tracking = new AprsTrackingManager(
			manager,
			{ decoderIds: ["direwolf-1"] },
			logger,
		)
		expect(handlers).toHaveLength(1)
		const emit = handlers[0]
		expect(emit).toBeDefined()
		emit!("direwolf-1", aprs("N0CALL"))
		emit!("direwolf-2", aprs("W1AW"))
		emit!("direwolf-1", aprs("K1ABC", "ship"))
		emit!("direwolf-1", {
			...aprs("VE3ABC"),
			type: "aircraft",
		})
		emit!("direwolf-1", {
			...aprs("N0CALL"),
			data: null,
		})
		const stations = tracking.getTracker().getAll()
		expect(stations).toHaveLength(1)
		expect(stations[0]).toMatchObject({
			key: "callsign:N0CALL",
			decoderId: "direwolf-1",
		})
		expect(stations[0]?.position).toEqual({
			lat: 1,
			lon: 2,
			at: "2026-06-15T12:00:00.000Z",
		})
		expect(tracking.getTracker().getStats().invalidPackets).toBe(1)
	})

	it("listens to every decoder when no filter is set, and start/stop are idempotent", () => {
		const { manager, handlers } = fakeManager()
		const tracking = new AprsTrackingManager(manager, {}, logger)
		tracking.start()
		tracking.start()
		handlers[0]!("other", aprs("N0CALL"))
		expect(tracking.getTracker().get("callsign:N0CALL")?.callsign).toBe(
			"N0CALL",
		)
		tracking.stop()
		tracking.stop()
		handlers[0]!("other", aprs("W1AW"))
		expect(tracking.getTracker().get("callsign:W1AW")?.callsign).toBe("W1AW")
	})
})
