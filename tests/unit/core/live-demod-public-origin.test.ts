/**
 * Legacy access mode: `liveDemod.publicOrigin` is the origin advertised in the
 * live-audio status `httpUrl` / `wavUrl`, so a browser on another machine gets
 * a stream URL it can reach (the default stays http://localhost:<httpPort>).
 */
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import Fastify from "fastify"
import type { WebSocket } from "ws"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AccessRuntimeConfigSchema } from "../../../src/access/runtime-config.js"
import { liveAudioRoutes } from "../../../src/api/routes/live-audio.js"
import { WebSocketEventBroadcaster } from "../../../src/api/websocket/events.js"
import {
	ConfigSchema,
	LiveDemodConfigSchema,
	liveDemodAdvertisedOrigin,
	parseEnvironmentVariables,
	splitLiveDemodConfig,
} from "../../../src/config.js"
import {
	LiveDemodRuntimeConfigSchema,
	LiveDemodulator,
	type LiveDemodConfig,
	type LiveDemodReconfigureUpdates,
} from "../../../src/core/live-demodulator.js"
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

	it("rejects origins over 320 characters with a length issue", () => {
		const label = "a".repeat(63)
		const long = `http://${[label, label, label, label, label].join(".")}.lan`
		expect(long.length).toBeGreaterThan(320)
		const result = LiveDemodConfigSchema.safeParse({ publicOrigin: long })
		expect(result.success).toBe(false)
		expect(
			result.error?.issues.some(
				issue => issue.code === "too_big" && issue.path[0] === "publicOrigin",
			),
		).toBe(true)
		// 320 characters exactly passes the length bound.
		const atLimit = `http://${"a".repeat(313)}`
		expect(atLimit.length).toBe(320)
		expect(
			LiveDemodConfigSchema.safeParse({
				publicOrigin: atLimit,
			}).error?.issues.some(issue => issue.code === "too_big") ?? false,
		).toBe(false)
	})

	it("rejects non-canonical origins", () => {
		for (const bad of [
			"http://receiver.lan:8081?x=1",
			"http://receiver.lan:8081#a",
			"http://user@receiver.lan:8081",
			" http://receiver.lan:8081",
			"http://receiver.lan:8081 ",
			"https://receiver.lan:443",
			"http://Receiver.lan:8081",
			"ws://receiver.lan:8081",
			"http://",
		])
			expect(
				LiveDemodConfigSchema.safeParse({ publicOrigin: bad }).success,
			).toBe(false)
	})
})

describe("live demod advertised origin precedence", () => {
	const legacyOrigin = "http://receiver.lan:8081"
	const protectedAccess = AccessRuntimeConfigSchema.parse({
		mode: "protected",
		listenerScheme: "http",
		exposure: "local-http",
		allowedAuthorities: ["wavekit.example.org"],
		allowedOrigins: ["https://wavekit.example.org"],
		audio: {
			analog: {
				allowedAuthorities: ["audio.example.org"],
				bindHost: "127.0.0.1",
			},
			digital: {
				allowedAuthorities: ["voice.example.org"],
				bindHost: "127.0.0.1",
			},
		},
		publicOrigins: {
			api: "https://wavekit.example.org",
			analogAudio: "https://audio.example.org",
			digitalAudio: "https://voice.example.org",
		},
		healthProbe: {
			target: "http://127.0.0.1:3000",
			host: "wavekit.example.org",
		},
	})

	it("protected mode advertises access.publicOrigins.analogAudio and ignores liveDemod.publicOrigin", () => {
		expect(liveDemodAdvertisedOrigin(protectedAccess, legacyOrigin)).toBe(
			"https://audio.example.org",
		)
		expect(liveDemodAdvertisedOrigin(protectedAccess, undefined)).toBe(
			"https://audio.example.org",
		)
	})

	it("legacy mode advertises liveDemod.publicOrigin, or nothing when unset", () => {
		const legacy = AccessRuntimeConfigSchema.parse(undefined)
		expect(legacy.mode).toBe("legacy")
		expect(liveDemodAdvertisedOrigin(legacy, legacyOrigin)).toBe(legacyOrigin)
		expect(liveDemodAdvertisedOrigin(legacy, undefined)).toBeUndefined()
	})

	it("a protected-mode demodulator built from the resolved origin advertises the analog audio origin", () => {
		const { config, publicOrigin } = splitLiveDemodConfig(
			LiveDemodConfigSchema.parse({
				enabled: true,
				sourceId: "rtl",
				httpPort: 8081,
				publicOrigin: legacyOrigin,
			}),
		)
		const origin = liveDemodAdvertisedOrigin(protectedAccess, publicOrigin)
		const demod = new LiveDemodulator(
			logger,
			sourceManager(),
			fanout(),
			config,
			origin !== undefined ? { publicOrigin: origin } : {},
		)
		const status = demod.getStatus()
		expect(status.httpUrl).toBe("https://audio.example.org/stream")
		expect(status.wavUrl).toBe("https://audio.example.org/stream.wav")
		expect(JSON.stringify(status)).not.toContain("receiver.lan")
	})
})

describe("liveDemod.publicOrigin stays out of the runtime config", () => {
	const legacyOrigin = "http://receiver.lan:8081"

	function legacyDemod(): LiveDemodulator {
		const { config, publicOrigin } = splitLiveDemodConfig(
			LiveDemodConfigSchema.parse({
				enabled: true,
				sourceId: "rtl",
				httpPort: 8081,
				publicOrigin: legacyOrigin,
			}),
		)
		return new LiveDemodulator(
			logger,
			sourceManager(),
			fanout(),
			config,
			publicOrigin !== undefined ? { publicOrigin } : {},
		)
	}

	it("the runtime schema strips publicOrigin", () => {
		const parsed: Record<string, unknown> = LiveDemodRuntimeConfigSchema.parse({
			httpPort: 8081,
			publicOrigin: legacyOrigin,
		})
		expect(Object.hasOwn(parsed, "publicOrigin")).toBe(false)
	})

	it("a config carrying publicOrigin is not echoed in status", () => {
		const config = {
			...LiveDemodConfigSchema.parse({ sourceId: "rtl", httpPort: 8091 }),
			publicOrigin: legacyOrigin,
		} as LiveDemodConfig
		const demod = new LiveDemodulator(logger, sourceManager(), fanout(), config)
		const status = demod.getStatus()
		expect(Object.hasOwn(status.config, "publicOrigin")).toBe(false)
		expect(status.httpUrl).toBe("http://localhost:8091/stream")
	})

	it("reconfigure with publicOrigin neither stores it nor changes the advertised origin", async () => {
		const demod = legacyDemod()
		const emitted: LiveDemodConfig[] = []
		demod.on("config-changed", config => emitted.push(config))
		const before = demod.getStatus().config
		await demod.reconfigure({
			publicOrigin: "http://other.lan:8081",
		} as LiveDemodReconfigureUpdates)
		const status = demod.getStatus()
		expect(Object.hasOwn(status.config, "publicOrigin")).toBe(false)
		expect(status.config).toEqual(before)
		expect(status.httpUrl).toBe(`${legacyOrigin}/stream`)
		for (const config of emitted)
			expect(Object.hasOwn(config, "publicOrigin")).toBe(false)
	})

	it("is absent from GET status and PATCH responses, and PATCH cannot set it", async () => {
		const demod = legacyDemod()
		const app = Fastify({ logger: false })
		await app.register(liveAudioRoutes, { liveDemod: demod })
		try {
			const status = await app.inject({
				method: "GET",
				url: "/api/live-audio/status",
			})
			expect(status.statusCode).toBe(200)
			expect(status.body).not.toContain("publicOrigin")
			expect((JSON.parse(status.body) as { httpUrl: string }).httpUrl).toBe(
				`${legacyOrigin}/stream`,
			)

			const patch = await app.inject({
				method: "PATCH",
				url: "/api/live-audio/config",
				payload: { publicOrigin: "http://other.lan:8081", gain: 3 },
			})
			expect(patch.body).not.toContain("publicOrigin")
			expect(patch.body).not.toContain("other.lan")
			expect(Object.hasOwn(demod.getStatus().config, "publicOrigin")).toBe(
				false,
			)
			expect(demod.getStatus().httpUrl).toBe(`${legacyOrigin}/stream`)
		} finally {
			await app.close()
		}
	})

	it("is absent from the WebSocket live-audio:config payload", async () => {
		const demod = legacyDemod()
		const broadcaster = new WebSocketEventBroadcaster(logger)
		const messages: string[] = []
		const socket = {
			readyState: 1,
			send: (data: string) => {
				messages.push(data)
			},
			close: () => undefined,
			on: () => undefined,
			bufferedAmount: 0,
		}
		const clients = (
			broadcaster as unknown as {
				clients: Map<
					string,
					{ socket: WebSocket; subscriptions: Set<string>; id: string }
				>
			}
		).clients
		clients.set("client-1", {
			socket: socket as unknown as WebSocket,
			subscriptions: new Set(["live-audio"]),
			id: "client-1",
		})
		demod.on("config-changed", config => {
			broadcaster.broadcastLiveAudioConfig(config)
		})
		await demod.reconfigure({
			gain: 3,
			publicOrigin: "http://other.lan:8081",
		} as LiveDemodReconfigureUpdates)
		broadcaster.broadcastLiveAudioConfig(demod.getStatus().config)
		expect(messages.length).toBeGreaterThan(0)
		for (const raw of messages) {
			expect((JSON.parse(raw) as { type: string }).type).toBe(
				"live-audio:config",
			)
			expect(raw).not.toContain("publicOrigin")
			expect(raw).not.toContain("receiver.lan")
			expect(raw).not.toContain("other.lan")
		}
	})
})
