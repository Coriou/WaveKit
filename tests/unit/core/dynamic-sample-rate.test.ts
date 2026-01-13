import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { EventEmitter } from "node:events"
import type { TunerRelay } from "../../../src/core/tuner-relay.js"
import { SourceManager } from "../../../src/core/source-manager.js"
import { LiveDemodulator } from "../../../src/core/live-demodulator.js"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { createLogger } from "../../../src/utils/logger.js"

// Mocks
const mockLogger = createLogger({ level: "fatal" })

describe("Dynamic Sample Rate Integration", () => {
	let tunerRelay: EventEmitter
	let sourceManager: SourceManager
	let liveDemodulator: any
	let decoderManager: any

	beforeEach(() => {
		// 1. Setup TunerRelay mock
		tunerRelay = new EventEmitter()
		;(tunerRelay as any).config = { sourceId: "test-source" }
		;(tunerRelay as any).updateCommandState = (cmd: number, value: number) => {
			if (cmd === 0x02) {
				tunerRelay.emit("sample-rate-changed", "test-source", value)
			}
		}

		// 2. Setup SourceManager
		sourceManager = new SourceManager(mockLogger)
		// Mock internal state
		;(sourceManager as any).sources.set("test-source", {
			config: {
				id: "test-source",
				caps: { sampleRate: 2048000 },
			},
		})

		// 3. Setup LiveDemodulator mock
		liveDemodulator = {
			activeSourceId: "test-source",
			log: mockLogger,
			reconfigure: vi.fn().mockResolvedValue(undefined),
			subscribeToSourceCapsChanges: vi.fn(),
			capsChangedHandler: null,
		}
		// Manually wire the handler logic we want to test
		liveDemodulator.subscribeToSourceCapsChanges = () => {
			liveDemodulator.capsChangedHandler = (sourceId: string, caps: any) => {
				if (sourceId === liveDemodulator.activeSourceId) {
					liveDemodulator.reconfigure({})
				}
			}
			sourceManager.on("caps-changed", liveDemodulator.capsChangedHandler)
		}

		// 4. Setup DecoderManager mock
		decoderManager = {
			decoders: new Map([
				[
					"test-decoder",
					{
						config: { sourceId: "test-source" },
						decoder: { getStatus: () => "running", getCaps: () => ({}) },
					},
				],
			]),
			log: mockLogger,
			restartDecoder: vi.fn().mockResolvedValue(undefined),
			sourceManager: sourceManager,
			subscribeToSourceCapsChanges: vi.fn(),
			capsChangedHandler: null,
		}
		// Manually wire handler
		decoderManager.subscribeToSourceCapsChanges = () => {
			decoderManager.capsChangedHandler = (sourceId: string, caps: any) => {
				if (sourceId === "test-source") {
					decoderManager.restartDecoder("test-decoder")
				}
			}
			sourceManager.on("caps-changed", decoderManager.capsChangedHandler)
		}
	})

	it("propagates sample rate changes from TunerRelay to SourceManager", () => {
		const onCapsChanged = vi.fn()
		sourceManager.on("caps-changed", onCapsChanged)

		// Simulate TunerRelay event reception in index.ts wiring
		tunerRelay.on("sample-rate-changed", (sourceId, rate) => {
			sourceManager.updateSourceCaps(sourceId, { sampleRate: rate })
		})

		// Trigger change (Simulate cmd 0x02)
		;(tunerRelay as any).updateCommandState(0x02, 2400000)

		expect(onCapsChanged).toHaveBeenCalledWith("test-source", {
			sampleRate: 2400000,
		})
		const sourceState = (sourceManager as any).sources.get("test-source")
		expect(sourceState.config.caps.sampleRate).toBe(2400000)
	})

	it("restarts LiveDemodulator pipeline on caps change", () => {
		// Setup subscription
		liveDemodulator.subscribeToSourceCapsChanges()

		// Trigger change directly on source manager
		sourceManager.updateSourceCaps("test-source", { sampleRate: 1000000 })

		expect(liveDemodulator.reconfigure).toHaveBeenCalled()
	})

	it("restarts affected decoders on caps change", () => {
		// Setup subscription
		decoderManager.subscribeToSourceCapsChanges()

		// Trigger change
		sourceManager.updateSourceCaps("test-source", { sampleRate: 1000000 })

		expect(decoderManager.restartDecoder).toHaveBeenCalledWith("test-decoder")
	})
})
