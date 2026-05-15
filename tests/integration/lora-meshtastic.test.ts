/**
 * LoRa/Meshtastic integration test - fixture replay via recording source.
 *
 * Skipped automatically unless:
 * - /usr/local/bin/lora_meshtastic_decode.py exists
 * - gr-lora_sdr imports successfully
 * - fixtures/lora/meshtastic-sample.real-fixture exists
 *
 * The marker avoids accidentally running against the committed placeholder IQ.
 */

import { describe, it, expect } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"
import pino from "pino"
import { SourceManager } from "../../src/core/source-manager.js"
import { FanoutManager } from "../../src/core/fanout-manager.js"
import { DecoderManager } from "../../src/decoders/manager.js"
import { DecoderRegistry } from "../../src/decoders/registry.js"
import {
	createLoraMeshtasticDecoder,
	LORA_MESHTASTIC_CAPS,
	WRAPPER_SCRIPT_PATH,
} from "../../src/decoders/builtin/lora-meshtastic.js"
import type { DecoderOutput } from "../../src/decoders/types.js"

const FIXTURE_PATH = resolve("fixtures/lora/meshtastic-sample.cu8")
const EXPECTED_PATH = resolve("fixtures/lora/meshtastic-sample.expected.jsonl")
const REAL_FIXTURE_MARKER = resolve(
	"fixtures/lora/meshtastic-sample.real-fixture",
)

function hasGrLoraSdr(): boolean {
	const result = spawnSync("python3", ["-c", "from gnuradio import lora_sdr"], {
		stdio: "ignore",
	})
	return result.status === 0
}

const runIntegration =
	existsSync(WRAPPER_SCRIPT_PATH) &&
	hasGrLoraSdr() &&
	existsSync(FIXTURE_PATH) &&
	existsSync(EXPECTED_PATH) &&
	existsSync(REAL_FIXTURE_MARKER)

describe.skipIf(!runIntegration)("lora-meshtastic integration", () => {
	it("emits at least one meshtastic event matching the expected sidecar", async () => {
		const logger = pino({ level: "silent" })
		const registry = new DecoderRegistry()
		registry.register(
			"lora-meshtastic",
			createLoraMeshtasticDecoder,
			LORA_MESHTASTIC_CAPS,
		)

		const sourceManager = new SourceManager(logger)
		const fanoutManager = new FanoutManager(logger)
		const decoderManager = new DecoderManager(registry, fanoutManager, logger)
		decoderManager.setSourceManager(sourceManager)

		const sourceStream = await sourceManager.connect({
			id: "fixture-iq",
			type: "recording",
			filePath: FIXTURE_PATH,
			loop: false,
			playbackSpeed: 1.0,
			caps: {
				kind: "iq",
				sampleRate: 2_048_000,
				format: "U8_IQ",
				exclusive: false,
			},
		})
		fanoutManager.attachSource(sourceStream)

		decoderManager.createDecoder({
			id: "fixture-lora",
			type: "lora-meshtastic",
			enabled: true,
			sourceId: "fixture-iq",
			options: {
				region: "EU_868",
				preset: "LongFast",
				frequency: 869_525_000,
				channelKey: "AQ==",
			},
		})

		const events: DecoderOutput[] = []
		decoderManager.on("decoder:output", (_decoderId, out) => {
			events.push(out)
		})

		try {
			await decoderManager.startAll()
			await new Promise(resolveTimeout => setTimeout(resolveTimeout, 10_000))
		} finally {
			await decoderManager.destroy()
			await sourceManager.disconnectAll()
		}

		const meshEvents = events.filter(e => e.type === "meshtastic")
		expect(meshEvents.length).toBeGreaterThan(0)

		const expected = readFileSync(EXPECTED_PATH, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as Record<string, unknown>)

		const expectedHeaders = expected.map(e => ({
			from: e["from"],
			id: e["id"],
			portnum: e["portnum"],
			payloadB64: e["payload_b64"],
		}))

		const matched = meshEvents.some(ev => {
			const data = ev.data as Record<string, unknown>
			return expectedHeaders.some(
				header =>
					header.from === data["from"] &&
					header.id === data["id"] &&
					header.portnum === data["portnum"] &&
					header.payloadB64 === data["payloadB64"],
			)
		})

		expect(matched).toBe(true)
	}, 20_000)
})
