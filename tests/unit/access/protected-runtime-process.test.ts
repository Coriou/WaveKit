import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises"
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
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"

const repository = fileURLToPath(new URL("../../../", import.meta.url))
let buildDirectory: string | undefined
let entry: string
let failedScannerEntry: string
const roots: string[] = []
const processes: RunningCore[] = []
const reservations: Server[] = []
const sockets: WebSocket[] = []

// Build these exact current sources in a repository-local ignored directory so
// Node resolves the same external dependencies without accepting stale dist/.
beforeAll(async () => {
	const agentsDirectory = join(repository, ".agents")
	await mkdir(agentsDirectory, { recursive: true })
	buildDirectory = await mkdtemp(
		join(agentsDirectory, "protected-process-build-"),
	)
	entry = join(buildDirectory, "index.js")
	await build({
		absWorkingDir: repository,
		entryPoints: [
			{ in: "src/index.ts", out: "index" },
			{ in: "src/core/spectrum/spectrum-worker.ts", out: "spectrum-worker" },
		],
		bundle: true,
		outdir: buildDirectory,
		platform: "node",
		format: "esm",
		packages: "external",
	})
	const failureDirectory = join(buildDirectory, "failed-scanner")
	failedScannerEntry = join(failureDirectory, "index.js")
	await build({
		absWorkingDir: repository,
		entryPoints: [{ in: "src/index.ts", out: "index" }],
		bundle: true,
		outdir: failureDirectory,
		platform: "node",
		format: "esm",
		packages: "external",
		plugins: [
			{
				name: "failed-partial-scanner-cleanup",
				setup(builder) {
					builder.onLoad({ filter: /[/\\]scanner-service\.ts$/ }, () => ({
						loader: "js",
						contents: `export class ScannerService {
						started = false
						async start() {
							this.started = true
							throw new Error("Scanner fixture startup failed")
						}
						async stop() {
							if (!this.started) {
								process.stdout.write("scanner-stop-noop\\n")
								return
							}
							this.started = false
							process.stdout.write("scanner-stop-real\\n")
							await Promise.resolve()
							throw new Error("Scanner fixture cleanup failed")
						}
					}`,
					}))
				},
			},
		],
	})
}, 30_000)

afterAll(async () => {
	if (buildDirectory) await rm(buildDirectory, { recursive: true, force: true })
})

interface RunningCore {
	child: ChildProcess
	exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
	stdout(): string
	stderr(): string
}

afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.terminate()
	for (const core of processes.splice(0)) {
		if (core.child.exitCode === null && core.child.signalCode === null)
			core.child.kill("SIGKILL")
		await core.exited
	}
	for (const reservation of reservations.splice(0)) {
		if (reservation.listening)
			await new Promise<void>(resolve => reservation.close(() => resolve()))
	}
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true })
})

async function fixture() {
	// Compilation and missing fresh output fail this suite, never skip it.
	await access(entry)
	const root = await mkdtemp(join(tmpdir(), "wavekit-protected-process-"))
	roots.push(root)
	const ports: number[] = []
	const held: Server[] = []
	for (let index = 0; index < 5; index++) {
		const server = createServer()
		reservations.push(server)
		held.push(server)
		await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
		const address = server.address()
		if (!address || typeof address === "string")
			throw new Error("Missing reserved port")
		ports.push(address.port)
	}
	const [api, analog, digital, raw, relay] = ports as [
		number,
		number,
		number,
		number,
		number,
	]
	const origin = `http://127.0.0.1:${api}`
	const directory = join(root, "SECRET-private-authority")
	const configFile = join(root, "config.yaml")
	const config = {
		sources: [],
		decoders: [],
		stateDir: join(root, "state"),
		scanner: { enabled: false },
		resources: { enabled: false },
		channelizer: { enabled: false },
		api: { host: "127.0.0.1", port: api },
		audio: { tcpPort: raw },
		tunerRelay: { enabled: false, host: "127.0.0.1", port: relay },
		liveDemod: { enabled: false, httpPort: analog },
		digitalVoice: { enabled: false, httpPort: digital },
		logging: { level: "info" },
		access: {
			mode: "protected",
			listenerScheme: "http",
			exposure: "local-http",
			allowedAuthorities: [`127.0.0.1:${api}`],
			allowedOrigins: [origin],
			audio: {
				analog: {
					allowedAuthorities: [`127.0.0.1:${analog}`],
					bindHost: "127.0.0.1",
				},
				digital: {
					allowedAuthorities: [`127.0.0.1:${digital}`],
					bindHost: "127.0.0.1",
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
	await writeFile(configFile, JSON.stringify(config))
	const releasePorts = async (keepApi = false) => {
		for (const server of keepApi ? held.slice(1) : held)
			if (server.listening)
				await new Promise<void>(resolve => server.close(() => resolve()))
	}
	return {
		root,
		directory,
		configFile,
		config,
		api,
		analog,
		digital,
		raw,
		relay,
		origin,
		releasePorts,
	}
}

function run(
	configFile: string,
	directory?: string,
	executable = entry,
): RunningCore {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			([name]) => !name.startsWith("WAVEKIT_"),
		),
	)
	env["WAVEKIT_CONFIG"] = configFile
	if (directory !== undefined)
		env["WAVEKIT_ACCESS_PRIVATE_DIRECTORY"] = directory
	const child = spawn(process.execPath, [executable], {
		cwd: repository,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	})
	let stdout = ""
	let stderr = ""
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString()
	})
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString()
	})
	const exited = new Promise<{
		code: number | null
		signal: NodeJS.Signals | null
	}>((resolve, reject) => {
		child.once("error", reject)
		child.once("close", (code, signal) => resolve({ code, signal }))
	})
	const core = { child, exited, stdout: () => stdout, stderr: () => stderr }
	processes.push(core)
	return core
}

async function started(core: RunningCore): Promise<void> {
	const deadline = Date.now() + 8000
	while (Date.now() < deadline) {
		if (core.stdout().includes("WaveKit started successfully")) return
		if (core.child.exitCode !== null || core.child.signalCode !== null)
			throw new Error("Built core exited before startup completed")
		await delay(20)
	}
	throw new Error("Built core startup deadline exceeded")
}

async function http(
	port: number,
	path: string,
	headers: Record<string, string> = {},
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
				host: "127.0.0.1",
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
				response.on("data", (chunk: Buffer) => {
					text += chunk.toString()
				})
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
		req.setTimeout(2000, () =>
			req.destroy(new Error("Loopback request timed out")),
		)
		req.on("error", reject)
		req.end(encoded)
	})
}

async function listening(port: number): Promise<boolean> {
	return new Promise(resolve => {
		const socket = connect({ host: "127.0.0.1", port })
		const finish = (value: boolean) => {
			socket.destroy()
			resolve(value)
		}
		socket.once("connect", () => finish(true))
		socket.once("error", () => finish(false))
		socket.setTimeout(500, () => finish(false))
	})
}

async function websocket(port: number, headers: Record<string, string>) {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers })
	sockets.push(socket)
	await new Promise<void>((resolve, reject) => {
		socket.once("open", resolve)
		socket.once("error", reject)
	})
	const closed = new Promise<void>(resolve =>
		socket.once("close", () => resolve()),
	)
	return { socket, closed }
}

async function stop(core: RunningCore) {
	core.child.kill("SIGTERM")
	return core.exited
}

describe("built protected runtime process", () => {
	it("mounts admission, disables raw listeners and drains SIGTERM before a durable browser restart", async () => {
		const env = await fixture()
		const storage = await PrivateAccessStorage.open({
			directory: env.directory,
			mode: "provision",
			ownership: "single-host-pid-namespace",
		})
		const token = storage.useMachineCredential(value => value)
		await storage.close()
		await env.releasePorts()
		const first = run(env.configFile, env.directory)
		await started(first)
		expect((await http(env.api, "/health")).status).toBe(200)
		expect((await http(env.api, "/api/status")).status).toBe(401)
		const machine = { Authorization: `Bearer ${token}` }
		expect((await http(env.api, "/api/status", machine)).status).toBe(200)
		for (const port of [env.raw, env.relay, env.analog, env.digital])
			expect(await listening(port)).toBe(false)
		const issued = await http(env.api, "/api/access/pairing-codes", machine, {})
		expect(issued.status).toBe(201)
		const { code } = z
			.object({ code: z.string() })
			.parse(JSON.parse(issued.body))
		const paired = await http(
			env.api,
			"/api/access/pair",
			{ Origin: env.origin },
			{ code },
		)
		expect(paired.status).toBe(201)
		const cookieHeader = paired.headers["set-cookie"]?.[0]
		expect(cookieHeader).toContain("HttpOnly")
		if (!cookieHeader) throw new Error("Missing remembered-browser cookie")
		const browser = { Cookie: cookieHeader.split(";")[0]!, Origin: env.origin }
		const before = await http(env.api, "/api/access/session", browser)
		expect(before.status).toBe(200)
		const identity = z
			.object({ deviceId: z.string(), csrfToken: z.string() })
			.parse(JSON.parse(before.body))
		const browserWs = await websocket(env.api, browser)
		const machineWs = await websocket(env.api, machine)
		expect(await stop(first)).toEqual({ code: 0, signal: null })
		await Promise.all([browserWs.closed, machineWs.closed])
		expect(await listening(env.api)).toBe(false)
		expect(
			(await readdir(env.directory)).filter(name => name.startsWith("owner-")),
		).toEqual([])
		const second = run(env.configFile, env.directory)
		await started(second)
		const remembered = await http(env.api, "/api/access/session", browser)
		expect(remembered.status).toBe(200)
		expect(
			z
				.object({ deviceId: z.string(), csrfToken: z.string() })
				.parse(JSON.parse(remembered.body)),
		).toEqual(identity)
		expect((await http(env.api, "/api/status", machine)).status).toBe(200)
		expect(await stop(second)).toEqual({ code: 0, signal: null })
		for (const core of [first, second]) {
			expect(core.stdout() + core.stderr()).not.toContain(token)
			expect(core.stdout() + core.stderr()).not.toContain(env.directory)
			expect(core.stdout() + core.stderr()).not.toContain(
				cookieHeader.split(";")[0],
			)
		}
		const snapshot = await readFile(
			join(env.directory, "access-state.json"),
			"utf8",
		)
		expect(snapshot).not.toContain(cookieHeader.split("=")[1]?.split(";")[0])
	}, 30_000)

	it("releases private ownership after a later API bind failure and settles earlier resources", async () => {
		const env = await fixture()
		const provision = await PrivateAccessStorage.open({
			directory: env.directory,
			mode: "provision",
			ownership: "single-host-pid-namespace",
		})
		await provision.close()
		// Keep the test's actual API-port listener to force EADDRINUSE after
		// protected state and core services have been constructed.
		await env.releasePorts(true)
		const core = run(env.configFile, env.directory)
		expect(await core.exited).toEqual({ code: 1, signal: null })
		expect(core.stderr()).toBe("WaveKit startup failed\n")
		expect(core.stdout()).not.toContain("WaveKit started successfully")
		expect(core.stdout() + core.stderr()).not.toContain(env.directory)
		expect(core.stdout() + core.stderr()).toContain(
			"Failed to start API server",
		)
		expect(
			(await readdir(env.directory)).filter(name => name.startsWith("owner-")),
		).toEqual([])
		const reopened = await PrivateAccessStorage.open({
			directory: env.directory,
			mode: "load",
			ownership: "single-host-pid-namespace",
		})
		await reopened.close()
		for (const port of [env.raw, env.relay, env.analog, env.digital])
			expect(await listening(port)).toBe(false)
		// API remains held by this test, and is deliberately excluded above.
	}, 15_000)

	it("retains failed partial scanner cleanup even when a repeated stop would resolve", async () => {
		const env = await fixture()
		const provision = await PrivateAccessStorage.open({
			directory: env.directory,
			mode: "provision",
			ownership: "single-host-pid-namespace",
		})
		await provision.close()
		await env.releasePorts()
		const core = run(env.configFile, env.directory, failedScannerEntry)
		expect(await core.exited).toEqual({ code: 1, signal: null })
		expect(core.stderr()).toBe("WaveKit startup failed\n")
		expect(core.stdout()).not.toContain("WaveKit started successfully")
		expect(core.stdout().match(/scanner-stop-real/g)).toHaveLength(1)
		expect(core.stdout()).not.toContain("scanner-stop-noop")
		// Shutdown still attempts other constructed resources after that rejection.
		expect(core.stdout()).toContain("Destroying DecoderManager")
		// Retaining this file proves close() never released access ownership.
		expect(
			(await readdir(env.directory)).filter(name => name.startsWith("owner-")),
		).toHaveLength(1)
		for (const port of [env.api, env.raw, env.relay, env.analog, env.digital])
			expect(await listening(port)).toBe(false)
	}, 15_000)

	it("preserves legacy startup fallback after the same partial scanner cleanup failure", async () => {
		const env = await fixture()
		await writeFile(
			env.configFile,
			JSON.stringify({ ...env.config, access: { mode: "legacy" } }),
		)
		await env.releasePorts()
		const core = run(env.configFile, undefined, failedScannerEntry)
		await started(core)
		expect(core.stdout()).toContain(
			"Stopping the partially started scanner failed",
		)
		expect(core.stdout().match(/scanner-stop-real/g)).toHaveLength(1)
		expect(await listening(env.api)).toBe(true)
		expect(await listening(env.raw)).toBe(true)
		core.child.kill("SIGTERM")
		expect(await core.exited).toEqual({ code: 0, signal: null })
	}, 15_000)

	it.each([
		"implicit relay",
		"missing private authority",
		"private config secret",
	] as const)(
		"fails %s before API availability with a fixed fatal message",
		async kind => {
			const env = await fixture()
			if (kind === "implicit relay") env.config.tunerRelay.enabled = true
			const input =
				kind === "private config secret"
					? {
							...env.config,
							access: {
								...env.config.access,
								machineToken: "SECRET-config-credential",
							},
						}
					: env.config
			await writeFile(env.configFile, JSON.stringify(input))
			await env.releasePorts()
			const core = run(env.configFile)
			const result = await core.exited
			expect(result).toEqual({ code: 1, signal: null })
			expect(core.stderr()).toBe("WaveKit startup failed\n")
			expect(core.stdout()).not.toContain("WaveKit started successfully")
			expect(core.stdout() + core.stderr()).not.toContain("SECRET")
			for (const port of [env.api, env.raw, env.relay])
				expect(await listening(port)).toBe(false)
		},
		15_000,
	)
})
