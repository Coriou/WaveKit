/**
 * MeshTrackingManager feeds meshtastic decoder output into the tracker.
 */

import { describe, expect, it } from "vitest"
import type { DecoderOutput } from "../../../src/decoders/types.js"
import type { DecoderManager } from "../../../src/decoders/manager.js"
import { MeshTrackingManager } from "../../../src/core/mesh-tracking-manager.js"
import { createLogger } from "../../../src/utils/logger.js"
import { meshPacket } from "../../mocks/fixtures/meshtastic/encode.js"

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

function output(
	from: number,
	type: DecoderOutput["type"] = "meshtastic",
): DecoderOutput {
	return {
		timestamp: new Date("2026-06-15T12:00:00.000Z"),
		decoder: "ignored",
		type,
		data: meshPacket({ from, portnum: 1, rxSnr: 4, rxRssi: -80 }),
	}
}

describe("MeshTrackingManager", () => {
	it("accepts meshtastic output and ignores other types and other decoders", () => {
		const { manager, handlers } = fakeManager()
		const tracking = new MeshTrackingManager(
			manager,
			{ decoderIds: ["lora-1"] },
			logger,
		)
		expect(handlers).toHaveLength(1)
		const emit = handlers[0]
		expect(emit).toBeDefined()
		emit!("lora-1", output(1))
		emit!("lora-2", output(2))
		emit!("lora-1", output(3, "ship"))
		const nodes = tracking.getTracker().getAll()
		expect(nodes).toHaveLength(1)
		expect(nodes[0]).toMatchObject({
			nodeId: "!00000001",
			key: "node:!00000001",
			decoderId: "lora-1",
			lastSeen: "2026-06-15T12:00:00.000Z",
		})
	})

	it("listens to every decoder when no filter is set, and start/stop are idempotent", () => {
		const { manager, handlers } = fakeManager()
		const tracking = new MeshTrackingManager(manager, {}, logger)
		tracking.start()
		tracking.start()
		handlers[0]!("other", output(7))
		expect(tracking.getTracker().get("!00000007")?.nodeNum).toBe(7)
		tracking.stop()
		tracking.stop()
		handlers[0]!("other", output(8))
		expect(tracking.getTracker().get("!00000008")?.nodeNum).toBe(8)
	})
})
