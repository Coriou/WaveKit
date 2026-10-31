/**
 * Startup path of a paused receiver feed: the real core entry (src/index.ts, bundled as in
 * tests/unit/access/legacy-port-conflict.test.ts) pauses its source, shuts down, and comes up
 * paused on the same state dir: no connect to the upstream, the boot log says paused, the
 * status feed reads paused and /health counts the pause as intentional. Resume reconnects.
 *
 * main() is not exported and the config schema has no API port 0, so the core runs as a child
 * process on reserved ports outside the ephemeral range. The upstream is an in-process fake
 * rtl_tcp on an ephemeral loopback port; nothing else is contacted.
 */
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
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

beforeAll(async () => {
	const agents = join(repository, ".agents")
	await mkdir(agents, { recursive: true })
	buildDirectory = await mkdtemp(join(agents, "source-feed-restart-build-"))
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
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
	return {
		port: (server.address() as net.AddressInfo).port,
		connections: () => accepted,
	}
}

// Outside the OS ephemeral range, as in legacy-port-conflict.test.ts.
async function freePort(host?: string): Promise<number> {
	for (;;) {
		const port = 24000 + Math.floor(Math.random() * 6000)
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
			return port
		}
	}
}

interface Core {
	child: ChildProcess
	stdout: () => string
	exited: Promise<number | null>
}

function runCore(configFile: string): Core {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([n]) => !n.startsWith("WAVEKIT_")),
	)
	env["WAVEKIT_CONFIG"] = configFile
	const child = spawn(process.execPath, [entry], {
		cwd: repository,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	})
	children.push(child)
	let stdout = ""
	child.stdout?.on("data", (c: Buffer) => (stdout += c.toString()))
	child.stderr?.on("data", () => undefined)
	const exited = new Promise<number | null>(resolve =>
		child.once("close", code => resolve(code)),
	)
	return { child, stdout: () => stdout, exited }
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
			core.child.exitCode !== null,
		"core startup",
	)
	if (core.child.exitCode !== null)
		throw new Error("The core exited before startup completed")
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
		const api = await freePort("127.0.0.1")
		const configFile = join(root, "config.yaml")
		await writeFile(
			configFile,
			JSON.stringify({
				sources: [
					{
						id: "rtl",
						type: "rtl_tcp",
						host: "127.0.0.1",
						port: upstream.port,
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
				api: { host: "127.0.0.1", port: api },
				audio: { tcpPort: await freePort() },
				tunerRelay: { enabled: false, port: await freePort("127.0.0.1") },
				liveDemod: {
					enabled: false,
					httpPort: await freePort("127.0.0.1"),
				},
				digitalVoice: {
					enabled: false,
					httpPort: await freePort("127.0.0.1"),
				},
				logging: { level: "info" },
				access: { mode: "legacy" },
			}),
		)

		// First run: connects, then the operator pauses the feed.
		const first = runCore(configFile)
		await started(first)
		expect(first.stdout()).toContain("Connected to source")
		await until(() => upstream.connections() === 1, "first connect")
		const paused = await http(api, "POST", "/api/sources/rtl/pause")
		expect(paused.status).toBe(200)
		expect(paused.body).toMatchObject({
			id: "rtl",
			feed: { state: "paused" },
			changed: true,
			persisted: true,
		})
		expect(await stop(first)).toBe(0)

		// Second run on the same state dir: paused from boot, no connection made.
		const second = runCore(configFile)
		await started(second)
		// Boot connects (or not) before "started": the count is final here.
		expect(upstream.connections()).toBe(1)
		expect(second.stdout()).toContain(
			"Source feed paused; not connecting until resumed",
		)
		expect(second.stdout()).not.toContain("Connected to source")
		const listed = await http(api, "GET", "/api/sources")
		expect(listed.status).toBe(200)
		expect(feedOf(listed.body, "rtl")).toBe("paused")
		const status = await http(api, "GET", "/api/status")
		expect(status.body).toMatchObject({
			status: "healthy",
			health: {
				components: { source: { status: "up", metrics: { paused: 1 } } },
			},
		})
		expect((await http(api, "GET", "/health/ready")).status).toBe(200)

		const resumed = await http(api, "POST", "/api/sources/rtl/resume")
		expect(resumed.status).toBe(200)
		expect(resumed.body).toMatchObject({ feed: { state: "live" } })
		await until(() => upstream.connections() === 2, "resume connect")
		expect(feedOf((await http(api, "GET", "/api/sources")).body, "rtl")).toBe(
			"live",
		)
		expect(await stop(second)).toBe(0)
	}, 60_000)
})
