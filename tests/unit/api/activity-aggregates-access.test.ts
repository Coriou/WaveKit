/**
 * WG5: in protected mode the band map and timeline GETs are ordinary reads: an
 * anonymous request is refused at admission, a token-bearing GET without an Origin
 * reaches the route (no per-path write rule).
 */
import { EventEmitter } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"
import { openAccessRuntime } from "../../../src/access/runtime-context.js"
import { ApiServer } from "../../../src/api/server.js"
import type { ApiServerDependencies } from "../../../src/api/server.js"
import { ActivityQueryError } from "../../../src/core/activity/query/errors.js"
import {
	inertActivityService,
	type ActivityRuntime,
} from "../../../src/core/activity/runtime.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import { SourceManager } from "../../../src/core/source-manager.js"

const logger = pino({ level: "silent" })
const host = "receiver.lan:9000"
const origin = "http://receiver.lan:9000"
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(calls: string[]) {
	const root = await mkdtemp(
		join(tmpdir(), "wavekit-activity-aggregates-access-"),
	)
	cleanups.push(() => rm(root, { recursive: true, force: true }))
	const directory = join(root, "private")
	const storage = await PrivateAccessStorage.open({
		directory,
		mode: "provision",
		ownership: "single-host-pid-namespace",
	})
	const token = storage.useMachineCredential(value => value)
	await storage.close()
	const access = await openAccessRuntime({
		directory,
		ownership: "single-host-pid-namespace",
		bootstrap: {
			mode: "protected",
			listenerScheme: "http",
			allowedAuthorities: [host],
			allowedOrigins: [origin],
			externalAudioOrigins: [
				"http://receiver.lan:9001",
				"http://receiver.lan:9002",
			],
		},
		audio: {
			analog: {
				listenerScheme: "http",
				allowedAuthorities: ["receiver.lan:9001"],
			},
			digital: {
				listenerScheme: "http",
				allowedAuthorities: ["receiver.lan:9002"],
			},
		},
	})
	cleanups.push(() => access.close())
	// The route is reached when the service is called; a 400 keeps the DTO out of it.
	const reached = (name: string) => async (): Promise<never> => {
		calls.push(name)
		throw new ActivityQueryError("reached", "ACTIVITY_QUERY_INVALID", 400)
	}
	const activity: ActivityRuntime = {
		status: "ready",
		service: {
			...inertActivityService(),
			bandMap: reached("bandMap"),
			timeline: reached("timeline"),
		},
		discloseErrors: false,
		stats: () => {
			throw new Error("not used")
		},
		bindSubscriptions: () => undefined,
		transmissionSink: () => null,
		close: async () => {},
	}
	const sourceManager = new SourceManager(logger)
	cleanups.push(() => sourceManager.disconnectAll())
	const fanoutManager = new FanoutManager(logger)
	cleanups.push(async () => fanoutManager.destroy())
	const decoderManager = Object.assign(new EventEmitter(), {
		getAllDecoders: () => [],
		getAllStatus: () => [],
		getAllHealth: () => new Map(),
		getStatus: () => undefined,
	}) as unknown as ApiServerDependencies["decoderManager"]
	const audioOutput = Object.assign(new EventEmitter(), {
		getConnectedClients: () => 0,
		getPort: () => 8080,
	}) as unknown as ApiServerDependencies["audioOutput"]
	const server = new ApiServer(
		{
			access,
			activity,
			sourceManager,
			fanoutManager,
			decoderManager,
			audioOutput,
			logger,
		},
		{ host: "127.0.0.1", port: 0 },
	)
	cleanups.push(() => server.stop())
	await server.start()
	return { app: server.getApp(), authorization: `Bearer ${token}` }
}

describe("activity aggregate routes in protected mode (WG5)", () => {
	it.each([
		["/api/activity/bandmap", "bandMap"],
		["/api/activity/timeline", "timeline"],
	])(
		"%s is a read: 401 without a token, routed with one",
		async (url, name) => {
			const calls: string[] = []
			const env = await setup(calls)
			const anonymous = await env.app.inject({ url, headers: { host } })
			expect(anonymous.statusCode).toBe(401)
			expect(anonymous.json()).toEqual({ code: "AUTH_REQUIRED" })
			expect(calls).toEqual([])
			const authorized = await env.app.inject({
				url,
				headers: { host, authorization: env.authorization },
			})
			expect(authorized.statusCode).toBe(400)
			expect(calls).toEqual([name])
		},
	)
})
