/**
 * WG9 lane PA: an actual protected API server plus both audio servers on 127.0.0.1, configured
 * through the runtime mapping check with a web app origin on its own port of the API hostname.
 * Test helper only; it reuses BrowserClient and CookieJar unchanged.
 */
import { EventEmitter } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, request as httpRequest } from "node:http"
import type { IncomingHttpHeaders, Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { vi } from "vitest"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"
import { openAccessRuntime } from "../../../src/access/runtime-context.js"
import type { NamedAccessRuntimeContext } from "../../../src/access/runtime-context.js"
import { validateProtectedRuntimeMapping } from "../../../src/access/runtime-config.js"
import type { ProtectedRuntimeAccessConfig } from "../../../src/access/runtime-config.js"
import { ApiServer } from "../../../src/api/server.js"
import type { ApiServerDependencies } from "../../../src/api/server.js"
import {
	AudioClientRegistry,
	AudioHttpServer,
} from "../../../src/core/audio-stream-server.js"
import { BrowserClient } from "./browser-client.js"
import type { LoopbackBinding } from "./browser-client.js"
import { CookieJar } from "./cookie-jar.js"

export interface RawResponse {
	readonly status: number
	readonly headers: IncomingHttpHeaders
	readonly body: string
}

/** One plain HTTP/1.1 request to 127.0.0.1 with exactly the given headers. */
export function rawRequest(
	port: number,
	method: string,
	path: string,
	headers: Readonly<Record<string, string>>,
	body?: string,
): Promise<RawResponse> {
	return new Promise((resolve, reject) => {
		const sent: Record<string, string> = { Connection: "close", ...headers }
		if (body !== undefined)
			sent["Content-Length"] = String(Buffer.byteLength(body))
		const req = httpRequest(
			{ host: "127.0.0.1", port, method, path, headers: sent },
			response => {
				const chunks: Buffer[] = []
				response.on("data", (chunk: Buffer) => chunks.push(chunk))
				response.on("error", reject)
				response.on("end", () =>
					resolve({
						status: response.statusCode ?? 0,
						headers: response.headers,
						body: Buffer.concat(chunks).toString("utf8"),
					}),
				)
			},
		)
		req.setTimeout(2000, () => req.destroy(new Error("Raw request timed out")))
		req.on("error", reject)
		req.end(body)
	})
}

function listenOn(server: Server, port: number): Promise<string | null> {
	return new Promise(resolve => {
		const onError = (error: NodeJS.ErrnoException) =>
			resolve(error.code ?? "unknown")
		server.once("error", onError)
		server.listen(port, "127.0.0.1", () => {
			server.off("error", onError)
			resolve(null)
		})
	})
}

function closeServer(server: Server): Promise<void> {
	return new Promise(resolve => {
		if (!server.listening) return resolve()
		server.close(() => resolve())
		server.closeAllConnections()
	})
}

/**
 * Hold `count` distinct 127.0.0.1 ports outside the OS ephemeral ranges (Linux 32768+, macOS
 * 49152+), so a concurrent listen(0) cannot take one between release and the real bind
 * (the cd805233 approach).
 */
async function holdPorts(count: number): Promise<Server[]> {
	const held: Server[] = []
	const ports = new Set<number>()
	for (let attempt = 0; held.length < count; attempt += 1) {
		if (attempt >= 200) {
			await Promise.all(held.map(closeServer))
			throw new Error("No free test port after 200 attempts")
		}
		const port = 24000 + Math.floor(Math.random() * 6000)
		if (ports.has(port)) continue
		const server = createServer((_request, response) => {
			response.writeHead(200, { "Content-Type": "text/html" })
			response.end("<!doctype html><title>web app</title>")
		})
		const failure = await listenOn(server, port)
		if (failure === "EADDRINUSE") continue
		if (failure !== null) {
			await Promise.all(held.map(closeServer))
			throw new Error(`Test port reservation failed: ${failure}`)
		}
		ports.add(port)
		held.push(server)
	}
	return held
}

function portOf(server: Server): number {
	const address = server.address()
	if (!address || typeof address === "string") throw new Error("Missing port")
	return address.port
}

export interface WebOriginStack {
	readonly scheme: "http" | "https"
	readonly token: string
	readonly privateDirectory: string
	readonly apiOrigin: string
	readonly webOrigin: string
	readonly analogOrigin: string
	readonly digitalOrigin: string
	/** Same scheme and hostname, a port not in allowedOrigins. */
	readonly foreignPortOrigin: string
	/** Same port as the web origin, another hostname (`localhost`). */
	readonly foreignHostOrigin: string
	/** Public API authority (Host header) and the plaintext API listener port. */
	readonly apiAuthority: string
	readonly apiPort: number
	readonly analogPort: number
	readonly access: ProtectedRuntimeAccessConfig
	readonly bindings: readonly LoopbackBinding[]
	/** A browser whose page is the web app origin (default) or another origin. */
	browser(documentOrigin?: string, jar?: CookieJar): BrowserClient
	close(): Promise<void>
}

function fakeDependencies(
	context?: NamedAccessRuntimeContext,
): ApiServerDependencies {
	const sourceManager = Object.assign(new EventEmitter(), {
		connect: vi.fn(),
		disconnect: vi.fn(),
		getStatus: vi.fn(),
		getAllStatus: vi.fn(() => []),
		getStream: vi.fn(),
		getSourceAssignments: vi.fn(() => []),
		isSourceAvailable: vi.fn(() => true),
		assignDecoder: vi.fn(),
		unassignDecoder: vi.fn(),
		getAssignedSource: vi.fn(),
		getCaps: vi.fn(),
		isCompatible: vi.fn(() => true),
	})
	const decoderManager = Object.assign(new EventEmitter(), {
		createDecoder: vi.fn(),
		startDecoder: vi.fn(),
		stopDecoder: vi.fn(),
		restartDecoder: vi.fn(),
		getDecoder: vi.fn(),
		getAllDecoders: vi.fn(() => []),
		getStatus: vi.fn(),
		getAllStatus: vi.fn(() => []),
		getAllHealth: vi.fn(() => new Map()),
	})
	const fanoutManager = Object.assign(new EventEmitter(), {
		attachSource: vi.fn(),
		detachSource: vi.fn(),
		addBranch: vi.fn(),
		removeBranch: vi.fn(),
		getBranchIds: vi.fn(() => []),
		getBranchStatus: vi.fn(),
		getBranchTelemetry: vi.fn(),
		getTelemetrySnapshot: vi.fn(() => ({
			timestamp: new Date().toISOString(),
			branches: [],
			backpressureActiveCount: 0,
			droppedBytesTotal: 0,
			droppedChunksTotal: 0,
		})),
		destroy: vi.fn(),
	})
	return {
		...(context ? { access: context } : {}),
		logger: pino({ level: "silent" }),
		liveDemod: {
			getStatus: () => ({ running: false }),
		} as unknown as ApiServerDependencies["liveDemod"],
		digitalVoice: {
			getStatus: () => ({ running: false }),
		} as unknown as ApiServerDependencies["digitalVoice"],
		sourceManager:
			sourceManager as unknown as ApiServerDependencies["sourceManager"],
		decoderManager:
			decoderManager as unknown as ApiServerDependencies["decoderManager"],
		fanoutManager:
			fanoutManager as unknown as ApiServerDependencies["fanoutManager"],
		audioOutput: Object.assign(new EventEmitter(), {
			start: vi.fn(),
			stop: vi.fn(),
			attachSource: vi.fn(),
			detachSource: vi.fn(),
			getConnectedClients: vi.fn(() => 0),
			getPort: vi.fn(() => 8080),
		}) as unknown as ApiServerDependencies["audioOutput"],
	}
}

/** Legacy-mode ApiServer (no access runtime) on 127.0.0.1:0. */
export async function startLegacyServer(): Promise<{
	readonly port: number
	close(): Promise<void>
}> {
	const server = new ApiServer(fakeDependencies(), {
		host: "127.0.0.1",
		port: 0,
	})
	await server.start()
	const bound = server.getApp().addresses()[0]
	if (!bound) throw new Error("Missing API listener")
	return { port: bound.port, close: () => server.stop() }
}

function audioServer(
	label: "analog" | "digital",
	policy: NamedAccessRuntimeContext["analogAudio"],
): AudioHttpServer {
	const logger = pino({ level: "silent" })
	const stream = { rate: 16000, format: "s16le" as const }
	const registry = new AudioClientRegistry(logger, {
		stallTimeoutMs: 60_000,
		label,
		stream,
	})
	return new AudioHttpServer(
		logger,
		label,
		request => {
			const path = (request.url ?? "").split("?")[0] ?? ""
			const wav = path.endsWith(".wav")
			const base = wav ? path.slice(0, -4) : path
			if (base !== "/stream") return null
			return { registry, stream, wav }
		},
		() => undefined,
		policy,
	)
}

/**
 * http: public origins are the real 127.0.0.1 listener ports (local-http exposure).
 * https: tls-termination exposure with `https://127.0.0.1:<public port>` origins; the browser
 * bindings stand in for the terminator by mapping each public authority to the plaintext
 * listener (no TLS on the wire, Host carries the public authority as Caddy forwards it).
 */
export async function startWebOriginStack(
	scheme: "http" | "https",
): Promise<WebOriginStack> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await tryStart(scheme)
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code
			if (code !== "EADDRINUSE" || attempt >= 4) throw error
		}
	}
}

async function tryStart(scheme: "http" | "https"): Promise<WebOriginStack> {
	const cleanups: (() => Promise<void>)[] = []
	const close = async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
	}
	try {
		// api, analog, digital listeners; web app and foreign port stay held (served) to the end.
		const held = await holdPorts(5)
		const [apiHold, analogHold, digitalHold, webHold, foreignHold] = held as [
			Server,
			Server,
			Server,
			Server,
			Server,
		]
		cleanups.push(async () => {
			for (const server of held) await closeServer(server)
		})
		const apiPort = portOf(apiHold)
		const analogPort = portOf(analogHold)
		const digitalPort = portOf(digitalHold)
		const webPort = portOf(webHold)
		const foreignPort = portOf(foreignHold)
		// The https form's public ports are the terminator's; they only need to differ.
		const pub =
			scheme === "http"
				? { api: apiPort, analog: analogPort, digital: digitalPort }
				: { api: 9443, analog: 9444, digital: 9445 }
		const webPublic = scheme === "http" ? webPort : 9446
		const foreignPublic = scheme === "http" ? foreignPort : 9447
		const host = "127.0.0.1"
		const origin = (port: number) => `${scheme}://${host}:${port}`
		const apiOrigin = origin(pub.api)
		const webOrigin = origin(webPublic)
		const analogOrigin = origin(pub.analog)
		const digitalOrigin = origin(pub.digital)
		const apiAuthority = `${host}:${pub.api}`
		const access: ProtectedRuntimeAccessConfig = {
			mode: "protected",
			listenerScheme: scheme,
			exposure: scheme === "http" ? "local-http" : "tls-termination",
			allowedAuthorities: [apiAuthority],
			allowedOrigins: [apiOrigin, webOrigin],
			audio: {
				analog: {
					allowedAuthorities: [`${host}:${pub.analog}`],
					bindHost: "127.0.0.1",
				},
				digital: {
					allowedAuthorities: [`${host}:${pub.digital}`],
					bindHost: "127.0.0.1",
				},
			},
			publicOrigins: {
				api: apiOrigin,
				analogAudio: analogOrigin,
				digitalAudio: digitalOrigin,
			},
			healthProbe: { target: `http://${host}:${apiPort}`, host: apiAuthority },
		}
		const plan = validateProtectedRuntimeMapping(
			access,
			{ host, port: apiPort },
			{ analog: analogPort, digital: digitalPort },
		)
		const root = await mkdtemp(join(tmpdir(), "wavekit-web-origin-"))
		cleanups.push(() => rm(root, { recursive: true, force: true }))
		const directory = join(root, "private")
		const provisioned = await PrivateAccessStorage.open({
			directory,
			mode: "provision",
			ownership: "single-host-pid-namespace",
		})
		const token = provisioned.useMachineCredential(value => value)
		await provisioned.close()
		const context = await openAccessRuntime({
			directory,
			ownership: "single-host-pid-namespace",
			bootstrap: plan,
			audio: {
				analog: {
					listenerScheme: scheme,
					allowedAuthorities: access.audio.analog.allowedAuthorities,
				},
				digital: {
					listenerScheme: scheme,
					allowedAuthorities: access.audio.digital.allowedAuthorities,
				},
			},
		})
		cleanups.push(() => context.close())
		const server = new ApiServer(fakeDependencies(context), {
			host,
			port: apiPort,
			accessBootstrap: plan,
			publicOrigins: access.publicOrigins,
		})
		const analog = audioServer("analog", context.analogAudio)
		const digital = audioServer("digital", context.digitalAudio)
		await closeServer(apiHold)
		await closeServer(analogHold)
		await closeServer(digitalHold)
		cleanups.push(() => server.stop())
		await server.start()
		cleanups.push(() => analog.close())
		await analog.start(analogPort, host)
		cleanups.push(() => digital.close())
		await digital.start(digitalPort, host)
		const bindings: LoopbackBinding[] = [
			{ host: apiAuthority, port: apiPort },
			{ host: `${host}:${pub.analog}`, port: analogPort },
			{ host: `${host}:${pub.digital}`, port: digitalPort },
			{ host: `${host}:${webPublic}`, port: webPort },
		]
		return {
			scheme,
			token,
			privateDirectory: directory,
			apiOrigin,
			webOrigin,
			analogOrigin,
			digitalOrigin,
			foreignPortOrigin: origin(foreignPublic),
			foreignHostOrigin: `${scheme}://localhost:${webPublic}`,
			apiAuthority,
			apiPort,
			analogPort,
			access,
			bindings,
			browser(documentOrigin = webOrigin, jar = new CookieJar()) {
				return new BrowserClient({ jar, documentOrigin, apiOrigin, bindings })
			},
			close,
		}
	} catch (error) {
		await close()
		throw error
	}
}
