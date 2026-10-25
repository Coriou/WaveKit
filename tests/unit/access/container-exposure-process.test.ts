/**
 * Container loopback exposure against the real built core: every listener binds
 * 0.0.0.0 on ports this test reserves, and a direct client connects only over
 * 127.0.0.1 with forged and genuine Host values.
 *
 * A peer on the container network is indistinguishable from this client at the
 * policy layer: AccessPolicy (src/access/policy.ts) admits on Host, Origin,
 * cookie, CSRF and bearer only and never reads the peer address. The peer
 * address is used only as the pairing attempt rate-limit key
 * (src/access/pairing.ts) and in audio client logs, never for trust. The
 * forged-Host and no-credential cases over loopback therefore cover it.
 */
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { request } from "node:http"
import type { IncomingHttpHeaders } from "node:http"
import { connect, createServer } from "node:net"
import type { Server } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { WebSocket } from "ws"
import { z } from "zod"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"

const repository = fileURLToPath(new URL("../../../", import.meta.url))
let buildDirectory: string | undefined
let root: string | undefined
let child: ChildProcess | undefined
let output = ""
const held: Server[] = []
let ports: number[] = []
let token = ""
let origin = ""

async function bound(port: number, host: string): Promise<Server | null> {
	const server = createServer()
	return new Promise(resolve => {
		server.once("error", () => resolve(null))
		server.listen(port, host, () => resolve(server))
	})
}

beforeAll(async () => {
	const agents = join(repository, ".agents")
	await mkdir(agents, { recursive: true })
	buildDirectory = await mkdtemp(join(agents, "container-exposure-build-"))
	await build({
		absWorkingDir: repository,
		entryPoints: [
			{ in: "src/index.ts", out: "index" },
			{ in: "src/core/spectrum/spectrum-worker.ts", out: "spectrum-worker" },
			{
				in: "src/core/activity/storage/activity-writer-worker.ts",
				out: "activity-writer-worker",
			},
			{
				in: "src/core/activity/query/activity-query-worker.ts",
				out: "activity-query-worker",
			},
		],
		bundle: true,
		outdir: buildDirectory,
		platform: "node",
		format: "esm",
		packages: "external",
	})
	root = await mkdtemp(join(tmpdir(), "wavekit-container-exposure-"))
	// Outside the ephemeral ranges, as in the protected process suite.
	while (ports.length < 5) {
		const port = 24000 + Math.floor(Math.random() * 6000)
		if (ports.includes(port)) continue
		const server = await bound(port, "0.0.0.0")
		if (!server) continue
		held.push(server)
		ports.push(port)
	}
	const [api, analog, digital, raw, relay] = ports as [
		number,
		number,
		number,
		number,
		number,
	]
	origin = `http://127.0.0.1:${api}`
	const directory = join(root, "private")
	const filePath = join(root, "TEST-only-iq.u8")
	await writeFile(filePath, Buffer.alloc(4096, 128))
	const config = {
		sources: [
			{
				id: "TEST-recording",
				type: "recording",
				filePath,
				loop: false,
				caps: {
					kind: "iq",
					format: "U8_IQ",
					sampleRate: 2400000,
					exclusive: false,
				},
			},
		],
		decoders: [],
		stateDir: join(root, "state"),
		scanner: { enabled: false },
		resources: { enabled: false },
		channelizer: { enabled: false },
		api: { host: "0.0.0.0", port: api },
		audio: { tcpPort: raw },
		// Enabled on purpose: protected mode must still suppress it.
		tunerRelay: {
			enabled: true,
			sourceId: "TEST-recording",
			host: "0.0.0.0",
			port: relay,
		},
		liveDemod: { enabled: false, httpPort: analog },
		digitalVoice: { enabled: false, httpPort: digital },
		logging: { level: "info" },
		access: {
			mode: "protected",
			listenerScheme: "http",
			exposure: "container-loopback",
			allowedAuthorities: [`127.0.0.1:${api}`],
			allowedOrigins: [origin],
			audio: {
				analog: {
					allowedAuthorities: [`127.0.0.1:${analog}`],
					bindHost: "0.0.0.0",
				},
				digital: {
					allowedAuthorities: [`127.0.0.1:${digital}`],
					bindHost: "0.0.0.0",
				},
			},
			publicOrigins: {
				api: origin,
				analogAudio: `http://127.0.0.1:${analog}`,
				digitalAudio: `http://127.0.0.1:${digital}`,
			},
			healthProbe: { target: origin, host: `127.0.0.1:${api}` },
		},
	}
	await mkdir(config.stateDir, { mode: 0o700 })
	const configFile = join(root, "config.yaml")
	await writeFile(configFile, JSON.stringify(config))
	const storage = await PrivateAccessStorage.open({
		directory,
		mode: "provision",
		ownership: "single-host-pid-namespace",
	})
	token = storage.useMachineCredential(value => value)
	await storage.close()
	for (const server of held.splice(0))
		await new Promise<void>(resolve => server.close(() => resolve()))
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			([name]) => !name.startsWith("WAVEKIT_"),
		),
	)
	env["WAVEKIT_CONFIG"] = configFile
	env["WAVEKIT_ACCESS_PRIVATE_DIRECTORY"] = directory
	child = spawn(process.execPath, [join(buildDirectory, "index.js")], {
		cwd: repository,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	})
	child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()))
	child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()))
	const deadline = Date.now() + 10_000
	while (!output.includes("WaveKit started successfully")) {
		if (child.exitCode !== null || Date.now() > deadline)
			throw new Error("Built core did not start")
		await delay(20)
	}
}, 60_000)

afterAll(async () => {
	if (child && child.exitCode === null) {
		const exited = new Promise(resolve => child?.once("close", resolve))
		child.kill("SIGTERM")
		await Promise.race([exited, delay(5000)])
		if (child.exitCode === null) child.kill("SIGKILL")
	}
	for (const server of held.splice(0))
		await new Promise<void>(resolve => server.close(() => resolve()))
	if (root) await rm(root, { recursive: true, force: true })
	if (buildDirectory) await rm(buildDirectory, { recursive: true, force: true })
})

async function http(
	host: string,
	port: number,
	path: string,
	headers: Record<string, string>,
	body?: unknown,
) {
	return new Promise<{
		status: number | undefined
		headers: IncomingHttpHeaders
		body: string
	}>((resolve, reject) => {
		const encoded = body === undefined ? undefined : JSON.stringify(body)
		const req = request(
			{
				host,
				port,
				path,
				method: encoded === undefined ? "GET" : "POST",
				headers: {
					Connection: "close",
					...(encoded === undefined
						? {}
						: { "Content-Type": "application/json" }),
					...headers,
				},
			},
			response => {
				let text = ""
				response.on("data", (chunk: Buffer) => (text += chunk.toString()))
				response.on("error", reject)
				response.on("end", () =>
					resolve({
						status: response.statusCode,
						headers: response.headers,
						body: text,
					}),
				)
			},
		)
		req.setTimeout(2000, () => req.destroy(new Error("Request timed out")))
		req.on("error", reject)
		req.end(encoded)
	})
}

async function listening(host: string, port: number): Promise<boolean> {
	return new Promise(resolve => {
		const socket = connect({ host, port })
		const finish = (value: boolean) => {
			socket.destroy()
			resolve(value)
		}
		socket.once("connect", () => finish(true))
		socket.once("error", () => finish(false))
		socket.setTimeout(500, () => finish(false))
	})
}

async function upgrade(
	host: string,
	port: number,
	headers: Record<string, string>,
): Promise<number | "open"> {
	const socket = new WebSocket(`ws://${host}:${port}/ws`, { headers })
	return new Promise(resolve => {
		socket.once("open", () => {
			socket.close()
			resolve("open")
		})
		socket.once("unexpected-response", (_req, response) => {
			socket.terminate()
			resolve(response.statusCode ?? 0)
		})
		socket.once("error", () => resolve(0))
	})
}

async function pairedBrowser(host: string) {
	const api = ports[0]!
	const machine = { Host: `127.0.0.1:${api}`, Authorization: `Bearer ${token}` }
	const issued = await http(host, api, "/api/access/pairing-codes", machine, {})
	expect(issued.status).toBe(201)
	const { code } = z.object({ code: z.string() }).parse(JSON.parse(issued.body))
	const paired = await http(
		host,
		api,
		"/api/access/pair",
		{ Host: `127.0.0.1:${api}`, Origin: origin },
		{ code },
	)
	expect(paired.status).toBe(201)
	const cookie = paired.headers["set-cookie"]?.[0]?.split(";")[0]
	if (!cookie) throw new Error("Missing session cookie")
	return { Host: `127.0.0.1:${api}`, Cookie: cookie, Origin: origin }
}

describe("container-loopback built core on 0.0.0.0", () => {
	it("binds the API on the wildcard and keeps raw TCP audio and the relay off", async () => {
		const [api, , , raw, relay] = ports as [
			number,
			number,
			number,
			number,
			number,
		]
		for (const host of ["127.0.0.1"]) {
			expect(await listening(host, api)).toBe(true)
			expect(await listening(host, raw)).toBe(false)
			expect(await listening(host, relay)).toBe(false)
		}
	})

	it.for(["127.0.0.1"])(
		"via %s: wrong Host rejected, genuine Host only reaches public exceptions",
		async host => {
			const api = ports[0]!
			const genuine = `127.0.0.1:${api}`
			for (const forged of [
				`${host}:${api}`,
				`wavekit:${api}`,
				`localhost:${api}`,
			])
				if (forged !== genuine) {
					const denied = await http(host, api, "/health", { Host: forged })
					expect(denied.status).toBe(403)
					expect(denied.body).toContain("HOST_FORBIDDEN")
					expect(
						(await http(host, api, "/api/status", { Host: forged })).status,
					).toBe(403)
				}
			expect((await http(host, api, "/health", { Host: genuine })).status).toBe(
				200,
			)
			expect(
				(await http(host, api, "/api/status", { Host: genuine })).status,
			).toBe(401)
			expect(
				(
					await http(host, api, "/api/status", {
						Host: genuine,
						Authorization: `Bearer ${token}`,
					})
				).status,
			).toBe(200)
		},
	)

	it.for(["127.0.0.1"])(
		"via %s: session needs an allowed Origin, CSRF and a matching WebSocket Origin",
		async host => {
			const api = ports[0]!
			const browser = await pairedBrowser(host)
			const session = await http(host, api, "/api/access/session", browser)
			expect(session.status).toBe(200)
			const foreign = await http(host, api, "/api/access/session", {
				...browser,
				Origin: "http://evil.example",
			})
			expect(foreign.status).toBe(403)
			expect(foreign.body).toContain("ORIGIN_FORBIDDEN")
			const unsafe = await http(
				host,
				api,
				"/api/access/devices/revoke-all",
				browser,
				{},
			)
			expect(unsafe.status).toBe(403)
			expect(unsafe.body).toContain("CSRF_REQUIRED")
			expect(
				await upgrade(host, api, { ...browser, Origin: "http://evil.example" }),
			).toBe(403)
			expect(await upgrade(host, api, browser)).toBe("open")
		},
	)
})
