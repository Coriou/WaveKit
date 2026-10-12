import { Socket } from "node:net"
import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { describe, expect, it } from "vitest"
import { ApiServer } from "../../../src/api/server.js"
import type { ApiServerDependencies } from "../../../src/api/server.js"
import { ConfigSchema, stationIdentity } from "../../../src/config.js"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"
import { openAccessRuntime } from "../../../src/access/runtime-context.js"
import type { NamedAccessRuntimeOptions } from "../../../src/access/runtime-context.js"
const origin = "http://receiver.lan:9000"
const browser = { host: "receiver.lan:9000", origin }
function runtimeOptions(directory: string): NamedAccessRuntimeOptions {
	return {
		directory,
		ownership: "single-host-pid-namespace",
		bootstrap: {
			mode: "protected",
			listenerScheme: "http",
			allowedAuthorities: [browser.host],
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
	}
}

interface WireResponse {
	statusCode: number
	headers: Record<string, string>
	wireBody: Buffer
}
function rawHttp(
	server: ApiServer,
	method: string,
	target: string,
	headers: Readonly<Record<string, string>> = {},
	payload = "",
): Promise<WireResponse> {
	const address = server.getApp().server.address()
	if (address === null || typeof address === "string")
		throw new Error("TEST missing TCP listener")
	return new Promise((resolve, reject) => {
		const socket = new Socket()
		const chunks: Buffer[] = []
		let size = 0
		let settled = false
		const finish = (error: Error | null, value?: WireResponse) => {
			if (settled) return
			settled = true
			socket.setTimeout(0)
			socket.removeListener("data", onData)
			socket.removeListener("end", onEnd)
			socket.removeListener("connect", onConnect)
			socket.removeListener("timeout", onTimeout)
			// Keep the error/close listeners through destroy; late errors are sunk.
			socket.destroy()
			if (error !== null) reject(error)
			else if (value !== undefined) resolve(value)
			else reject(new Error("TEST missing raw response"))
		}
		const onError = (error: Error) => finish(error)
		const onTimeout = () => finish(new Error("TEST raw HTTP timeout"))
		const onData = (chunk: Buffer) => {
			size += chunk.length
			if (size > 256 * 1024)
				finish(new Error("TEST raw HTTP response overflow"))
			else chunks.push(chunk)
		}
		const onEnd = () => {
			const bytes = Buffer.concat(chunks)
			const boundary = bytes.indexOf("\r\n\r\n")
			if (boundary < 0)
				return finish(new Error("TEST incomplete raw HTTP headers"))
			const lines = bytes.subarray(0, boundary).toString("latin1").split("\r\n")
			const status = /^HTTP\/1\.[01] ([0-9]{3})(?: |$)/.exec(
				lines.shift() ?? "",
			)
			if (status?.[1] === undefined)
				return finish(new Error("TEST invalid raw HTTP status"))
			const responseHeaders: Record<string, string> = {}
			for (const line of lines) {
				const colon = line.indexOf(":")
				if (colon < 1) return finish(new Error("TEST invalid raw HTTP header"))
				const name = line.slice(0, colon).toLowerCase()
				const value = line.slice(colon + 1).trim()
				responseHeaders[name] =
					responseHeaders[name] === undefined
						? value
						: `${responseHeaders[name]}, ${value}`
			}
			finish(null, {
				statusCode: Number(status[1]),
				headers: responseHeaders,
				wireBody: bytes.subarray(boundary + 4),
			})
		}
		const onConnect = () => {
			const fields = { host: "127.0.0.1", ...headers, connection: "close" }
			const request = `${method} ${target} HTTP/1.1\r\n${Object.entries(fields)
				.map(([name, value]) => `${name}: ${value}`)
				.join("\r\n")}\r\n\r\n${payload}`
			socket.write(request, "latin1")
		}
		const onClose = () => {
			if (!settled)
				finish(new Error("TEST raw HTTP closed before response end"))
			socket.removeListener("error", onError)
			socket.removeListener("close", onClose)
		}
		socket.on("error", onError)
		socket.once("close", onClose)
		socket.on("data", onData)
		socket.once("end", onEnd)
		socket.once("connect", onConnect)
		socket.once("timeout", onTimeout)
		socket.setTimeout(2000)
		socket.connect(address.port, "127.0.0.1")
	})
}

describe.each([true, false])("station legacy=%s", legacy => {
	it("mounts GET and HEAD under root admission and permits no writes", async () => {
		const root = await fs.mkdtemp(join(tmpdir(), "station-api-"))
		const directory = join(root, "private")
		const storage = legacy
			? null
			: await PrivateAccessStorage.open({
					directory,
					ownership: "single-host-pid-namespace",
					mode: "provision",
				})
		const token = storage?.useMachineCredential(value => value)
		await storage?.close()
		const access = legacy
			? undefined
			: await openAccessRuntime(runtimeOptions(directory))
		const station = stationIdentity(
			ConfigSchema.parse({ station: { country: "FR", lat: 48 } }),
			"EU",
		)
		const deps = {
			station,
			...(access ? { access } : {}),
			logger: pino({ level: "silent" }),
			sourceManager: Object.assign(new EventEmitter(), {
				getAllStatus: () => [],
			}),
			decoderManager: Object.assign(new EventEmitter(), {
				getAllDecoders: () => [],
				getAllStatus: () => [],
				getAllHealth: () => new Map(),
			}),
			fanoutManager: Object.assign(new EventEmitter(), {
				getTelemetrySnapshot: () => ({
					timestamp: new Date().toISOString(),
					branches: [],
					backpressureActiveCount: 0,
					droppedBytesTotal: 0,
					droppedChunksTotal: 0,
				}),
			}),
			audioOutput: Object.assign(new EventEmitter(), {
				getConnectedClients: () => 0,
				getPort: () => 0,
			}),
		} as unknown as ApiServerDependencies
		const server = new ApiServer(deps, {
			host: "127.0.0.1",
			port: 0,
			...(access
				? {
						accessBootstrap: runtimeOptions(directory).bootstrap,
						publicOrigins: {
							api: origin,
							analogAudio: "http://receiver.lan:9001",
							digitalAudio: "http://receiver.lan:9002",
						},
					}
				: {}),
		})
		try {
			await server.start()
			const app = server.getApp()
			const headers = {
				host: browser.host,
				...(token ? { authorization: `Bearer ${token}` } : {}),
			}
			const wireHead = await rawHttp(server, "HEAD", "/api/station", headers)
			expect(wireHead.statusCode).toBe(200)
			expect(wireHead.wireBody.length).toBe(0)
			const get = await app.inject({ url: "/api/station", headers })
			expect(wireHead.headers["content-length"]).toBe(
				String(Buffer.byteLength(get.body)),
			)
			for (const method of ["GET", "HEAD"] as const) {
				const response = await app.inject({
					method,
					url: "/api/station",
					headers,
				})
				expect(response.statusCode).toBe(200)
				expect(response.headers["cache-control"]).toBe("no-store")
				if (method === "GET") expect(response.json()).toEqual(station)
				else expect(response.body).toBe("")
				if (!legacy)
					expect(
						(
							await app.inject({
								method,
								url: "/api/station",
								headers: { host: browser.host },
							})
						).statusCode,
					).toBe(401)
			}
			expect(
				(await app.inject({ method: "PUT", url: "/api/station", headers }))
					.statusCode,
			).toBe(404)
		} finally {
			await server.stop()
			await access?.close()
			await fs.rm(root, { recursive: true, force: true })
		}
	})
})
