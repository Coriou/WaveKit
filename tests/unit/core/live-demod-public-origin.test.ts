/**
 * Legacy access mode: `liveDemod.publicOrigin` is the origin advertised in the
 * live-audio status `httpUrl` / `wavUrl`, so a browser on another machine gets
 * a stream URL it can reach (the default stays http://localhost:<httpPort>).
 */
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	ConfigSchema,
	LiveDemodConfigSchema,
	parseEnvironmentVariables,
	splitLiveDemodConfig,
} from "../../../src/config.js"
import { LiveDemodulator } from "../../../src/core/live-demodulator.js"
import type { FanoutManager } from "../../../src/core/fanout-manager.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "fatal" })

function sourceManager(): SourceManager {
	const emitter = new EventEmitter()
	const fake = {
		getAllStatus: () => [{ id: "rtl", connected: true }],
		getStatus: () => ({ id: "rtl", connected: true }),
		getCaps: () => ({ kind: "iq", sampleRate: 2_048_000, format: "U8_IQ" }),
		on: (event: string, listener: (...args: unknown[]) => void) =>
			emitter.on(event, listener),
		off: (event: string, listener: (...args: unknown[]) => void) =>
			emitter.off(event, listener),
	}
	return fake as unknown as SourceManager
}

function fanout(): FanoutManager {
	const fake = {
		addBranch: () => new PassThrough(),
		removeBranch: () => undefined,
	}
	return fake as unknown as FanoutManager
}

describe("liveDemod.publicOrigin (legacy advertised stream origin)", () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it("accepts canonical http(s) origins only", () => {
		for (const ok of [
			"http://receiver.lan:8081",
			"https://radio.example.org",
			"http://192.168.1.20:8081",
			"http://[fd00::1]:8081",
		])
			expect(
				LiveDemodConfigSchema.parse({ publicOrigin: ok }).publicOrigin,
			).toBe(ok)
		for (const bad of [
			"receiver.lan:8081",
			"http://receiver.lan:8081/",
			"http://receiver.lan:8081/stream",
			"ftp://receiver.lan",
			"http://receiver.lan:80",
			"HTTP://Receiver.lan:8081",
			"",
		])
			expect(
				LiveDemodConfigSchema.safeParse({ publicOrigin: bad }).success,
			).toBe(false)
	})

	it("is absent by default", () => {
		expect(LiveDemodConfigSchema.parse({}).publicOrigin).toBeUndefined()
	})

	it("is read from WAVEKIT_LIVE_DEMOD__PUBLIC_ORIGIN", () => {
		vi.stubEnv("WAVEKIT_LIVE_DEMOD__PUBLIC_ORIGIN", "http://receiver.lan:8081")
		const env = parseEnvironmentVariables()
		const config = ConfigSchema.parse(env)
		expect(config.liveDemod?.publicOrigin).toBe("http://receiver.lan:8081")
	})

	it("is split off the runtime config", () => {
		const parsed = LiveDemodConfigSchema.parse({
			httpPort: 8081,
			publicOrigin: "http://receiver.lan:8081",
		})
		const { config, publicOrigin } = splitLiveDemodConfig(parsed)
		expect(publicOrigin).toBe("http://receiver.lan:8081")
		expect("publicOrigin" in config).toBe(false)
		expect(config.httpPort).toBe(8081)
		expect(
			splitLiveDemodConfig(LiveDemodConfigSchema.parse({})).publicOrigin,
		).toBe(undefined)
	})

	it("is advertised by a legacy live demodulator, never echoed in its config", () => {
		const { config, publicOrigin } = splitLiveDemodConfig(
			LiveDemodConfigSchema.parse({
				enabled: true,
				sourceId: "rtl",
				httpPort: 8081,
				publicOrigin: "http://receiver.lan:8081",
			}),
		)
		const demod = new LiveDemodulator(
			logger,
			sourceManager(),
			fanout(),
			config,
			publicOrigin !== undefined ? { publicOrigin } : {},
		)
		const status = demod.getStatus()
		expect(status.httpUrl).toBe("http://receiver.lan:8081/stream")
		expect(status.wavUrl).toBe("http://receiver.lan:8081/stream.wav")
		expect("publicOrigin" in status.config).toBe(false)
	})

	it("keeps http://localhost:<httpPort> when unset", () => {
		const { config } = splitLiveDemodConfig(
			LiveDemodConfigSchema.parse({
				enabled: true,
				sourceId: "rtl",
				httpPort: 8091,
			}),
		)
		const demod = new LiveDemodulator(logger, sourceManager(), fanout(), config)
		expect(demod.getStatus().httpUrl).toBe("http://localhost:8091/stream")
		expect(demod.getStatus().wavUrl).toBe("http://localhost:8091/stream.wav")
	})
})
