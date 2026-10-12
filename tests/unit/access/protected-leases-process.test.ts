import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import type { Server } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"
import {
	BrowserClient,
	machinePost,
} from "../../helpers/access-browser/browser-client.js"
import type { BrowserSocket } from "../../helpers/access-browser/browser-client.js"
import { CookieJar } from "../../helpers/access-browser/cookie-jar.js"

// Analog and digital listeners stay down unless a receiver source starts the
// demodulator. Cross-port audio leases are covered in browser-lifecycle.test.ts
// against AudioHttpServer. This file is the compiled process for WebSocket
// leases, persistence failure and the restart-v1 snapshot.

const repository = fileURLToPath(new URL("../../../", import.meta.url))
const sessionSchema = z
	.object({
		deviceId: z.string(),
		expiresAt: z.number(),
		csrfToken: z.string(),
	})
	.strict()
const codeSchema = z
	.object({ code: z.string(), expiresInSeconds: z.number() })
	.strict()

let buildDirectory: string | undefined
let entry = ""
const roots: string[] = []
const processes: RunningCore[] = []
const reservations: Server[] = []

interface RunningCore {
	readonly child: ChildProcess
	readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
	stdout(): string
	stderr(): string
}

beforeAll(async () => {
	const agentsDirectory = join(repository, ".agents")
	await mkdir(agentsDirectory, { recursive: true })
	buildDirectory = await mkdtemp(join(agentsDirectory, "browser-lease-build-"))
	entry = join(buildDirectory, "index.js")
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
}, 60_000)

afterAll(async () => {
	if (buildDirectory) await rm(buildDirectory, { recursive: true, force: true })
})

afterEach(async () => {
	for (const core of processes.splice(0)) {
		if (core.child.exitCode === null && core.child.signalCode === null)
			core.child.kill("SIGKILL")
		await core.exited
	}
	for (const reservation of reservations.splice(0)) {
		if (reservation.listening)
			await new Promise<void>(resolve => reservation.close(() => resolve()))
	}
	for (const root of roots.splice(0)) {
		await chmod(root, 0o700).catch(() => undefined)
		await chmod(join(root, "private-authority"), 0o700).catch(() => undefined)
		await rm(root, { recursive: true, force: true })
	}
})

async function reservePort(): Promise<number> {
	const server = createServer()
	reservations.push(server)
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
	const address = server.address()
	if (!address || typeof address === "string") throw new Error("Missing port")
	return address.port
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "wavekit-browser-leases-"))
	roots.push(root)
	const [api, analog, digital, raw, relay] = await Promise.all([
		reservePort(),
		reservePort(),
		reservePort(),
		reservePort(),
		reservePort(),
	])
	const origin = `http://127.0.0.1:${api}`
	const directory = join(root, "private-authority")
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
	await mkdir(config.stateDir, { mode: 0o700 })
	await writeFile(configFile, JSON.stringify(config))
	const storage = await PrivateAccessStorage.open({
		directory,
		mode: "provision",
		ownership: "single-host-pid-namespace",
	})
	const token = storage.useMachineCredential(value => value)
	await storage.close()
	for (const reservation of reservations.splice(0))
		if (reservation.listening)
			await new Promise<void>(resolve => reservation.close(() => resolve()))
	return { root, directory, configFile, api, origin, token }
}

function run(configFile: string, directory: string): RunningCore {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([name]) => !name.startsWith("WAVEKIT_")),
	)
	env["WAVEKIT_CONFIG"] = configFile
	env["WAVEKIT_ACCESS_PRIVATE_DIRECTORY"] = directory
	const child = spawn(process.execPath, [entry], {
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
	const deadline = Date.now() + 12_000
	while (Date.now() < deadline) {
		if (core.stdout().includes("WaveKit started successfully")) return
		if (core.child.exitCode !== null || core.child.signalCode !== null)
			throw new Error(
				`Built core exited before startup\n${core.stdout()}\n${core.stderr()}`,
			)
		await delay(20)
	}
	throw new Error(
		`Built core startup deadline exceeded\n${core.stdout()}\n${core.stderr()}`,
	)
}

function browserFor(env: { api: number; origin: string }): BrowserClient {
	return new BrowserClient({
		jar: new CookieJar(),
		documentOrigin: env.origin,
		apiOrigin: env.origin,
		bindings: [{ host: `127.0.0.1:${env.api}`, port: env.api }],
	})
}

async function signIn(
	env: { api: number; origin: string; token: string },
	client: BrowserClient,
) {
	const issued = await machinePost(
		{ host: `127.0.0.1:${env.api}`, port: env.api },
		env.token,
		"/api/access/pairing-codes",
	)
	expect(issued.status).toBe(201)
	const code = codeSchema.parse(issued.json()).code
	const paired = await client.fetch(`${env.origin}/api/access/pair`, {
		method: "POST",
		json: { code },
	})
	expect(paired.status).toBe(201)
	const body = sessionSchema.parse(paired.json())
	const status = await client.fetch(`${env.origin}/api/access/session`)
	expect(status.status).toBe(200)
	expect(sessionSchema.parse(status.json())).toEqual(body)
	return body
}

async function expectClosed(socket: BrowserSocket): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<number>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new Error("WebSocket stayed open")),
			1500,
		)
	})
	try {
		expect(await Promise.race([socket.closeCode, timeout])).toBe(1008)
	} finally {
		if (timer) clearTimeout(timer)
	}
}

async function stop(core: RunningCore) {
	core.child.kill("SIGTERM")
	return core.exited
}

describe("compiled protected process browser leases", () => {
	it("closes the live WebSocket on logout, device revoke and revoke-all", async () => {
		const env = await fixture()
		const core = run(env.configFile, env.directory)
		await started(core)
		const client = browserFor(env)
		const bootstrap = await client.fetch(`${env.origin}/api/access/bootstrap`)
		expect(bootstrap.status).toBe(200)
		const anonymous = await client.fetch(`${env.origin}/api/access/session`)
		expect(anonymous.status).toBe(401)
		expect(anonymous.json()).toEqual({ code: "AUTH_REQUIRED" })
		const wsUrl = z
			.object({ webSocketUrl: z.string() })
			.parse(bootstrap.json()).webSocketUrl
		const open = async () => {
			const socket = await client.openSocket(wsUrl)
			expect(socket.opened).toBe(true)
			socket.send(JSON.stringify({ type: "subscribe", channels: ["status"] }))
			return socket
		}
		await signIn(env, client)
		const loggedOut = await open()
		expect(
			(
				await client.fetch(`${env.origin}/api/access/session/logout`, {
					method: "POST",
				})
			).status,
		).toBe(200)
		await expectClosed(loggedOut)
		expect((await client.fetch(`${env.origin}/api/access/session`)).status).toBe(
			401,
		)

		const revoked = await signIn(env, client)
		const revokedSocket = await open()
		expect(
			(
				await client.fetch(`${env.origin}/api/access/devices/revoke`, {
					method: "POST",
					json: { deviceId: revoked.deviceId },
				})
			).json(),
		).toEqual({ revoked: true })
		await expectClosed(revokedSocket)

		await signIn(env, client)
		const all = await open()
		expect(
			(
				await client.fetch(`${env.origin}/api/access/devices/revoke-all`, {
					method: "POST",
				})
			).status,
		).toBe(200)
		await expectClosed(all)
		expect(await stop(core)).toEqual({ code: 0, signal: null })
		expect(core.stdout() + core.stderr()).not.toContain(env.token)
		expect(core.stdout() + core.stderr()).not.toContain(env.directory)
	}, 30_000)

	it("fail-closes the live WebSocket when private persistence breaks", async () => {
		const env = await fixture()
		const core = run(env.configFile, env.directory)
		await started(core)
		const client = browserFor(env)
		const bootstrap = z
			.object({ webSocketUrl: z.string() })
			.parse((await client.fetch(`${env.origin}/api/access/bootstrap`)).json())
		await signIn(env, client)
		const socket = await client.openSocket(bootstrap.webSocketUrl)
		expect(socket.opened).toBe(true)
		await chmod(env.directory, 0o555)
		try {
			const failed = await client.fetch(
				`${env.origin}/api/access/session/refresh`,
				{ method: "POST" },
			)
			expect(failed.status).toBe(503)
			expect(failed.json()).toEqual({ code: "ACCESS_UNAVAILABLE" })
			expect(failed.networkBody).not.toContain(env.directory)
			expect(failed.networkBody).not.toContain(env.token)
			await expectClosed(socket)
			expect(
				(await client.fetch(`${env.origin}/api/access/session`)).status,
			).toBe(503)
		} finally {
			await chmod(env.directory, 0o700)
		}
		expect(await stop(core)).toEqual({ code: 0, signal: null })
	}, 30_000)

	it("keeps a paired browser session across a compiled restart", async () => {
		const env = await fixture()
		const first = run(env.configFile, env.directory)
		await started(first)
		const client = browserFor(env)
		const body = await signIn(env, client)
		const cookie = client.jar.cookieHeader(
			`${env.origin}/api/access/session`,
			env.origin,
		)
		if (!cookie) throw new Error("Missing session cookie")
		expect(await stop(first)).toEqual({ code: 0, signal: null })
		const second = run(env.configFile, env.directory)
		await started(second)
		const returning = new BrowserClient({
			jar: client.jar,
			documentOrigin: env.origin,
			apiOrigin: env.origin,
			bindings: [{ host: `127.0.0.1:${env.api}`, port: env.api }],
		})
		const status = await returning.fetch(`${env.origin}/api/access/session`)
		expect(status.status).toBe(200)
		expect(sessionSchema.parse(status.json())).toEqual(body)
		const snapshot = await readFile(
			join(env.directory, "access-state.json"),
			"utf8",
		)
		expect(snapshot).not.toContain(cookie.split("=")[1])
		expect(await stop(second)).toEqual({ code: 0, signal: null })
	}, 30_000)
})
