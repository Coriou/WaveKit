/**
 * VesselTrackingManager feeds ship decoder output into the tracker.
 */

import { describe, expect, it } from "vitest"
import type { DecoderOutput } from "../../../src/decoders/types.js"
import type { DecoderManager } from "../../../src/decoders/manager.js"
import { VesselTrackingManager } from "../../../src/core/vessel-tracking-manager.js"
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

function ship(mmsi: string, type = "ship"): DecoderOutput {
	return {
		timestamp: new Date("2026-06-15T12:00:00.000Z"),
		decoder: "ignored",
		type: type as DecoderOutput["type"],
		data: { mmsi, messageType: 1, lat: 1, lon: 2 },
	}
}

describe("VesselTrackingManager", () => {
	it("accepts ship output and ignores other types and other decoders", () => {
		const { manager, handlers } = fakeManager()
		const tracking = new VesselTrackingManager(
			manager,
			{ decoderIds: ["ais-1"] },
			logger,
		)
		expect(handlers).toHaveLength(1)
		const emit = handlers[0]
		expect(emit).toBeDefined()
		emit!("ais-1", ship("123456789"))
		emit!("ais-2", ship("999999999"))
		emit!("ais-1", ship("123456789", "message"))
		emit!("ais-1", {
			...ship("555555555"),
			type: "aircraft",
		})
		const vessels = tracking.getTracker().getAll()
		expect(vessels).toHaveLength(1)
		expect(vessels[0]).toMatchObject({
			mmsi: "123456789",
			decoderId: "ais-1",
		})
		expect(vessels[0]?.position).toEqual({
			lat: 1,
			lon: 2,
			at: "2026-06-15T12:00:00.000Z",
		})
	})

	it("listens to every decoder when no filter is set, and start/stop are idempotent", () => {
		const { manager, handlers } = fakeManager()
		const tracking = new VesselTrackingManager(manager, {}, logger)
		tracking.start()
		tracking.start()
		handlers[0]!("other", ship("42"))
		expect(tracking.getTracker().get("42")?.mmsi).toBe("000000042")
		tracking.stop()
		tracking.stop()
		handlers[0]!("other", ship("43"))
		expect(tracking.getTracker().get("43")?.mmsi).toBe("000000043")
	})
})
