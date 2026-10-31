/**
 * Startup path of a paused receiver feed: the real core entry (src/index.ts, bundled as in
 * tests/unit/access/legacy-port-conflict.test.ts) pauses its source, shuts down, and comes up
 * paused on the same state dir: no connect to the upstream, the boot log says paused, the
 * status feed reads paused and /health counts the pause as intentional. Resume reconnects.
 *
 * main() is not exported and the config schema has no API port 0, so the core runs as a child
 * process on reserved ports outside the ephemeral range. The upstream is an in-process fake
 * rtl_tcp on an ephemeral loopback port; nothing else is contacted.
 *
 * Isolation: the bundle lives in an OS temp dir (deleted after the run), and the child runs with
 * its cwd in a fresh temp dir and an explicit environment only: no inherited WAVEKIT_* or DOTENV_*
 * variable, DOTENV_CONFIG_PATH on an empty file there (src/bootstrap.ts loads dotenv/config), so
 * neither a checkout .env nor the caller's shell can point it elsewhere. Every port is checked
 * against the live receiver's ports before the child starts, and every source endpoint the child
 * logs must be the fake upstream, or the child is killed and the test fails.
 */
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises"
import { request } from "node:http"
import * as net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

const repository = fileURLToPath(new URL("../../../", import.meta.url))
let buildDirectory = ""
let entry = ""
const roots: string[] = []
const children: ChildProcess[] = []
const servers: net.Server[] = []

/** The live receiver's and dev tools' ports: a test core never listens on or connects to one. */
const FORBIDDEN_PORTS: ReadonlySet<number> = new Set([
	15555, 15556, 18080, 9000, 5173, 8081, 8082,
])
const LOOPBACK = "127.0.0.1"

beforeAll(async () => {
	// the real path: src/index.ts runs main() only when argv[1] is its own resolved URL, and the
	// macOS temp dir sits behind the /var -> /private/var link
	buildDirectory = await realpath(
		await mkdtemp(join(tmpdir(), "wavekit-feed-restart-build-")),
	)
	entry = join(buildDirectory, "index.js")
	// packages stay external: the bundle resolves them through this link to the checkout's
	await symlink(
		join(repository, "node_modules"),
		join(buildDirectory, "node_modules"),
		"dir",
	)
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

afterEach(async () => {
	for (const child of children.splice(0))
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL")
			await new Promise(resolve => child.once("close", resolve))
		}
	for (const server of servers.splice(0))
		if (server.listening)
			await new Promise<void>(resolve => server.close(() => resolve()))
})

afterAll(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true })
	// rm removes the node_modules link itself, never the checkout's packages behind it
	if (buildDirectory) await rm(buildDirectory, { recursive: true, force: true })
})

/** rtl_tcp-like on an ephemeral loopback port: header on accept, then IQ every 20 ms. */
async function fakeRtlTcp(): Promise<{
	port: number
	connections: () => number
}> {
	let accepted = 0
	const sockets = new Set<net.Socket>()
	const server = net.createServer(socket => {
		accepted++
		sockets.add(socket)
		socket.on("error", () => undefined)
		socket.on("end", () => socket.end())
		const header = Buffer.alloc(12)
		header.write("RTL0", 0, "ascii")
		header.writeUInt32BE(5, 4)
		header.writeUInt32BE(29, 8)
		socket.write(header)
		const iq = setInterval(() => {
			if (!socket.destroyed && socket.writable)
				socket.write(Buffer.alloc(512, 127))
		}, 20)
		socket.on("close", () => {
			clearInterval(iq)
			sockets.delete(socket)
		})
	})
	server.on("close", () => {
		for (const s of sockets) s.destroy()
	})
	servers.push(server)
	await new Promise<void>(resolve => server.listen(0, LOOPBACK, resolve))
	const port = (server.address() as net.AddressInfo).port
	if (FORBIDDEN_PORTS.has(port))
		throw new Error(`The fake upstream landed on a forbidden port ${port}`)
	return { port, connections: () => accepted }
}

/**
 * A port in 24000–29999 (outside the OS ephemeral range and every forbidden port, as in
 * legacy-port-conflict.test.ts) that was free when probed and is not in `taken`; it joins `taken`,
 * so one core's ports are distinct. Another process may still take it before the core binds:
 * bootCore retries the startup for that.
 */
async function freePort(taken: Set<number>, host?: string): Promise<number> {
	for (;;) {
		const port = 24000 + Math.floor(Math.random() * 6000)
		if (taken.has(port) || FORBIDDEN_PORTS.has(port)) continue
		const probe = net.createServer()
		const error = await new Promise<string | null>(resolve => {
			probe.once("error", (e: NodeJS.ErrnoException) =>
				resolve(e.code ?? "unknown"),
			)
			const done = () => resolve(null)
			if (host) probe.listen(port, host, done)
			else probe.listen(port, done)
		})
		if (error === null) {
			await new Promise<void>(resolve => probe.close(() => resolve()))
			taken.add(port)
			return port
		}
	}
}

interface Core {
	child: ChildProcess
	stdout: () => string
	/** Output on either stream, for telling a port clash from another startup failure. */
	output: () => string
	/** Why the endpoint guard killed the child, or null. */
	violation: () => string | null
	exited: Promise<number | null>
}

/**
 * The child's whole environment: nothing inherited but PATH (and TMPDIR, for os.tmpdir()), so no
 * WAVEKIT_* override, DOTENV_* setting or NODE_OPTIONS reaches it. HOME is the scratch root.
 */
function childEnv(root: string, configFile: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		PATH: process.env["PATH"] ?? "",
		HOME: root,
		NODE_ENV: "test",
		WAVEKIT_CONFIG: configFile,
		DOTENV_CONFIG_PATH: join(root, "empty.env"),
		DOTENV_CONFIG_QUIET: "true",
	}
	const tmp = process.env["TMPDIR"]
	if (tmp !== undefined) env["TMPDIR"] = tmp
	return env
}

/**
 * Kills the child as soon as it logs a source endpoint (a line with sourceId and host or port,
 * as the boot log's "Connected to source" / paused line) other than the fake upstream.
 */
function guardEndpoints(
	core: { child: ChildProcess; flag: (why: string) => void },
	line: string,
	upstreamPort: number,
): void {
	let record: unknown
	try {
		record = JSON.parse(line)
	} catch {
		return
	}
	if (typeof record !== "object" || record === null) return
	const r = record as Record<string, unknown>
	if (!("sourceId" in r) || (!("host" in r) && !("port" in r))) return
	if (r["host"] === LOOPBACK && r["port"] === upstreamPort) return
	core.flag(
		`The core logged a source endpoint other than the fake upstream: ${String(r["host"])}:${String(r["port"])}`,
	)
	core.child.kill("SIGKILL")
}

function runCore(root: string, configFile: string, upstreamPort: number): Core {
	const env = childEnv(root, configFile)
	for (const name of Object.keys(env))
		if (
			(name.startsWith("WAVEKIT_") && name !== "WAVEKIT_CONFIG") ||
			(name.startsWith("DOTENV_") &&
				name !== "DOTENV_CONFIG_PATH" &&
				name !== "DOTENV_CONFIG_QUIET")
		)
			throw new Error(`Unexpected ${name} in the child environment`)
	const child = spawn(process.execPath, [entry], {
		cwd: root,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	})
	children.push(child)
	let stdout = ""
	let stderr = ""
	let pending = ""
	let violation: string | null = null
	const flag = (why: string) => (violation ??= why)
	child.stdout?.on("data", (c: Buffer) => {
		const text = c.toString()
		stdout += text
		pending += text
		const lines = pending.split("\n")
		pending = lines.pop() ?? ""
		for (const line of lines)
			guardEndpoints({ child, flag }, line, upstreamPort)
	})
	child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()))
	const exited = new Promise<number | null>(resolve =>
		child.once("close", code => resolve(code)),
	)
	return {
		child,
		stdout: () => stdout,
		output: () => stdout + stderr,
		violation: () => violation,
		exited,
	}
}

/** Startup attempts per core: 5 probed ports from 6000 rarely clash, three in a row means a real fault. */
const STARTUP_ATTEMPTS = 3

/**
 * Writes the config with freshly probed, distinct ports and starts the core, again with new ports
 * (up to STARTUP_ATTEMPTS in all) when a listener lost its port to another process (EADDRINUSE).
 */
async function bootCore(
	root: string,
	upstreamPort: number,
	stateDir: string,
): Promise<{ core: Core; api: number }> {
	const configFile = join(root, "config.yaml")
	for (let attempt = 1; ; attempt++) {
		const taken = new Set<number>([upstreamPort])
		const api = await freePort(taken, LOOPBACK)
		const ports = {
			audio: await freePort(taken),
			relay: await freePort(taken, LOOPBACK),
			liveDemod: await freePort(taken, LOOPBACK),
			digitalVoice: await freePort(taken, LOOPBACK),
		}
		const config = {
			sources: [
				{
					id: "rtl",
					type: "rtl_tcp",
					host: LOOPBACK,
					port: upstreamPort,
					caps: {
						kind: "iq",
						format: "U8_IQ",
						sampleRate: 2_048_000,
						centerFreq: 100_000_000,
						exclusive: false,
					},
				},
			],
			decoders: [],
			decoderPolicy: { catalogue: false },
			stateDir,
			scanner: { enabled: false },
			resources: { enabled: false },
			channelizer: { enabled: false },
			api: { host: LOOPBACK, port: api },
			audio: { tcpPort: ports.audio },
			tunerRelay: { enabled: false, port: ports.relay },
			liveDemod: { enabled: false, httpPort: ports.liveDemod },
			digitalVoice: { enabled: false, httpPort: ports.digitalVoice },
			logging: { level: "info" },
			access: { mode: "legacy" },
		}
		const source = config.sources[0]
		if (source?.host !== LOOPBACK || source.port !== upstreamPort)
			throw new Error("The config's source is not the fake upstream")
		for (const port of [upstreamPort, api, ...Object.values(ports)])
			if (FORBIDDEN_PORTS.has(port))
				throw new Error(`Refusing a forbidden port ${port}`)
		await writeFile(configFile, JSON.stringify(config))
		await writeFile(join(root, "empty.env"), "")

		const core = runCore(root, configFile, upstreamPort)
		try {
			await started(core)
			return { core, api }
		} catch (error) {
			if (core.violation() !== null) throw error
			if (core.child.exitCode === null && core.child.signalCode === null) {
				core.child.kill("SIGKILL")
				await core.exited
			} else await core.exited
			if (!core.output().includes("EADDRINUSE") || attempt >= STARTUP_ATTEMPTS)
				throw error
		}
	}
}

async function until(check: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 15_000
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting: ${what}`)
		await delay(20)
	}
}

async function started(core: Core): Promise<void> {
	await until(
		() =>
			core.stdout().includes("WaveKit started successfully") ||
			core.violation() !== null ||
			core.child.exitCode !== null ||
			core.child.signalCode !== null,
		"core startup",
	)
	const violation = core.violation()
	if (violation !== null) throw new Error(violation)
	if (core.child.exitCode !== null || core.child.signalCode !== null)
		throw new Error(
			`The core exited before startup completed: ${core.output().slice(-1500)}`,
		)
}

async function http(
	port: number,
	method: "GET" | "POST",
	path: string,
): Promise<{ status: number | undefined; body: unknown }> {
	return new Promise((resolve, reject) => {
		const req = request(
			{
				host: "127.0.0.1",
				port,
				path,
				method,
				headers: { Connection: "close" },
			},
			response => {
				let text = ""
				response.on("data", (c: Buffer) => (text += c.toString()))
				response.on("error", reject)
				response.on("end", () =>
					resolve({
						status: response.statusCode,
						body: text ? (JSON.parse(text) as unknown) : null,
					}),
				)
			},
		)
		req.setTimeout(5000, () => req.destroy(new Error("Request timed out")))
		req.on("error", reject)
		req.end()
	})
}

const feedOf = (body: unknown, id: string) =>
	(body as Array<{ id: string; feed?: { state: string } }>).find(
		s => s.id === id,
	)?.feed?.state

/** How the boot log records the source endpoint (src/index.ts logs sourceId, host, port). */
const endpoint = (port: number) =>
	`"sourceId":"rtl","host":"${LOOPBACK}","port":${port}`

async function stop(core: Core): Promise<number | null> {
	core.child.kill("SIGTERM")
	return core.exited
}

describe("paused receiver feed across a core restart", () => {
	it("comes up paused on the same state dir without connecting, then resumes", async () => {
		const upstream = await fakeRtlTcp()
		const root = await mkdtemp(join(tmpdir(), "wavekit-feed-restart-"))
		roots.push(root)
		const stateDir = join(root, "state")
		await mkdir(stateDir, { mode: 0o700 })
		// First run: connects, then the operator pauses the feed.
		const { core: first, api: firstApi } = await bootCore(
			root,
			upstream.port,
			stateDir,
		)
		expect(first.stdout()).toContain("Connected to source")
		expect(first.stdout()).toContain(endpoint(upstream.port))
		// A startup retried after a port clash may have connected before failing: count from here.
		await until(() => upstream.connections() >= 1, "first connect")
		const connects = upstream.connections()
		const paused = await http(firstApi, "POST", "/api/sources/rtl/pause")
		expect(paused.status).toBe(200)
		expect(paused.body).toMatchObject({
			id: "rtl",
			feed: { state: "paused" },
			changed: true,
			persisted: true,
		})
		expect(await stop(first)).toBe(0)

		// Second run on the same state dir: paused from boot, no connection made.
		const { core: second, api: secondApi } = await bootCore(
			root,
			upstream.port,
			stateDir,
		)
		// Boot connects (or not) before "started": the count is final here.
		expect(upstream.connections()).toBe(connects)
		expect(second.stdout()).toContain(
			"Source feed paused; not connecting until resumed",
		)
		expect(second.stdout()).not.toContain("Connected to source")
		expect(second.stdout()).toContain(endpoint(upstream.port))
		const listed = await http(secondApi, "GET", "/api/sources")
		expect(listed.status).toBe(200)
		expect(feedOf(listed.body, "rtl")).toBe("paused")
		const status = await http(secondApi, "GET", "/api/status")
		expect(status.body).toMatchObject({
			status: "healthy",
			health: {
				components: { source: { status: "up", metrics: { paused: 1 } } },
			},
		})
		// /api/status carries the feed too (its response schema must not strip it).
		expect(feedOf((status.body as { sources: unknown }).sources, "rtl")).toBe(
			"paused",
		)
		expect((await http(secondApi, "GET", "/health/ready")).status).toBe(200)

		const resumed = await http(secondApi, "POST", "/api/sources/rtl/resume")
		expect(resumed.status).toBe(200)
		expect(resumed.body).toMatchObject({ feed: { state: "live" } })
		await until(() => upstream.connections() === connects + 1, "resume connect")
		expect(
			feedOf((await http(secondApi, "GET", "/api/sources")).body, "rtl"),
		).toBe("live")
		expect(await stop(second)).toBe(0)
	}, 60_000)
})
