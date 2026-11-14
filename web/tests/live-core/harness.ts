/**
 * The real core for the spectrum contract test and the browser smoke: src/index.ts bundled with
 * esbuild (the production composition: SourceManager, SpectrumService, the Fastify server and its
 * `/ws` broadcaster) and run as a child process, fed by an rtl_tcp fake in this process.
 *
 * Isolation: everything is on 127.0.0.1. The fake listens on an ephemeral port (0); the core's
 * config has no port 0, so its ports are probed in 24000–29999 (outside the OS ephemeral range).
 * Every port is checked against FORBIDDEN_PORTS, the child gets an explicit environment (no
 * inherited WAVEKIT_* or DOTENV_*), its cwd and state dir are fresh temp dirs, and any source
 * endpoint it logs other than the fake kills it. The bundle and the dirs are deleted on stop.
 */
import { spawn, type ChildProcess } from "node:child_process"
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises"
import { createRequire } from "node:module"
import * as net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import type * as Esbuild from "esbuild"

export const LOOPBACK = "127.0.0.1"
/** The live receiver's and dev tools' ports: a test core never listens on or connects to one. */
export const FORBIDDEN_PORTS: ReadonlySet<number> = new Set([
	1234, 4713, 5555, 5556, 8080, 8081, 8082, 9000, 5173, 15555, 15556, 18080,
])

const repository = fileURLToPath(new URL("../../../", import.meta.url))

export function assertAllowedPort(port: number): void {
	if (FORBIDDEN_PORTS.has(port))
		throw new Error(`Refusing a forbidden port ${port}`)
}

/** The source's declared rate (U8 IQ): 250 ksps, 500 kB/s from the fake. */
export const RATE = 250_000
export const CENTRE_HZ = 100_000_000
const SET_SAMPLE_RATE = 0x02
/** Pace of the fake's writes. */
const TICK_MS = 20

/**
 * rtl_tcp-like on an ephemeral loopback port: the 12-byte header on accept, then U8 IQ at the
 * commanded rate (RATE until a SET_SAMPLE_RATE): noise plus a tone a quarter of the rate above the
 * centre, so the spectrum is not flat.
 */
export interface FakeRtlTcp {
	port: number
	/** Connections accepted so far. */
	connections(): number
	/** Connections open now. */
	open(): number
	/** Drops every connection (a receiver restart): the core reconnects by itself. */
	dropConnections(): void
	close(): Promise<void>
}

function iqBlock(samples: number, phase0: number): Buffer {
	const out = Buffer.alloc(samples * 2)
	for (let i = 0; i < samples; i++) {
		const phase = phase0 + (i * Math.PI) / 2
		const noiseI = (Math.random() - 0.5) * 12
		const noiseQ = (Math.random() - 0.5) * 12
		out[2 * i] = Math.max(
			0,
			Math.min(255, Math.round(127.5 + 40 * Math.cos(phase) + noiseI)),
		)
		out[2 * i + 1] = Math.max(
			0,
			Math.min(255, Math.round(127.5 + 40 * Math.sin(phase) + noiseQ)),
		)
	}
	return out
}

export async function startFakeRtlTcp(): Promise<FakeRtlTcp> {
	let accepted = 0
	const sockets = new Set<net.Socket>()
	// One pre-built second of samples, cycled: the tone's phase is continuous at the block edges.
	const second = iqBlock(4_000_000 / 2, 0)
	const server = net.createServer(socket => {
		accepted++
		sockets.add(socket)
		let rate = RATE
		let offset = 0
		let pending = Buffer.alloc(0)
		socket.on("error", () => undefined)
		socket.on("data", (chunk: Buffer) => {
			pending = Buffer.concat([pending, chunk])
			while (pending.length >= 5) {
				const cmd = pending[0]
				const value = pending.readUInt32BE(1)
				pending = pending.subarray(5)
				if (cmd === SET_SAMPLE_RATE && value >= 225_001 && value <= 3_200_000)
					rate = value
			}
		})
		const header = Buffer.alloc(12)
		header.write("RTL0", 0, "ascii")
		header.writeUInt32BE(5, 4)
		header.writeUInt32BE(29, 8)
		socket.write(header)
		let last = Date.now()
		const timer = setInterval(() => {
			if (socket.destroyed || !socket.writable) return
			const now = Date.now()
			const bytes = Math.floor(((now - last) * rate) / 1000) * 2
			last = now
			if (bytes <= 0 || socket.writableLength > 4 * rate) return
			let left = bytes
			while (left > 0) {
				const n = Math.min(left, second.length - offset)
				socket.write(second.subarray(offset, offset + n))
				offset = (offset + n) % second.length
				left -= n
			}
		}, TICK_MS)
		socket.on("close", () => {
			clearInterval(timer)
			sockets.delete(socket)
		})
	})
	await new Promise<void>(resolve => server.listen(0, LOOPBACK, resolve))
	const port = (server.address() as net.AddressInfo).port
	assertAllowedPort(port)
	return {
		port,
		connections: () => accepted,
		open: () => sockets.size,
		dropConnections: () => {
			for (const s of sockets) s.destroy()
		},
		close: () =>
			new Promise<void>(resolve => {
				for (const s of sockets) s.destroy()
				server.close(() => resolve())
			}),
	}
}

/** A port in 24000–29999 that was free when probed, not forbidden and not in `taken` (joins it). */
async function freePort(taken: Set<number>): Promise<number> {
	for (;;) {
		const port = 24000 + Math.floor(Math.random() * 6000)
		if (taken.has(port) || FORBIDDEN_PORTS.has(port)) continue
		const probe = net.createServer()
		const ok = await new Promise<boolean>(resolve => {
			probe.once("error", () => resolve(false))
			probe.listen(port, LOOPBACK, () => resolve(true))
		})
		if (ok) {
			await new Promise<void>(resolve => probe.close(() => resolve()))
			taken.add(port)
			return port
		}
	}
}

/** Bundles src/index.ts and its worker entries (packages stay external, linked to the checkout's). */
async function buildCore(dir: string): Promise<string> {
	await symlink(
		join(repository, "node_modules"),
		join(dir, "node_modules"),
		"dir",
	)
	// esbuild is the root package's dependency, not the web app's.
	const require = createRequire(join(repository, "package.json"))
	const { build } = require("esbuild") as typeof Esbuild
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
			{
				in: "src/core/scanner/store/snapshot-worker.ts",
				out: "snapshot-worker",
			},
			{
				in: "src/services/aircraft-info/aircraft-db-worker.ts",
				out: "aircraft-db-worker",
			},
		],
		bundle: true,
		outdir: dir,
		platform: "node",
		format: "esm",
		packages: "external",
		logLevel: "silent",
	})
	return join(dir, "index.js")
}

export interface RealCore {
	/** http://127.0.0.1:<port> */
	readonly base: string
	readonly apiPort: number
	readonly upstream: FakeRtlTcp
	get(path: string): Promise<unknown>
	/** POST with an optional JSON body. */
	post(path: string, body?: unknown): Promise<{ status: number; body: unknown }>
	/** GET /api/spectrum `subscribers`. */
	subscribers(): Promise<number>
	output(): string
	stop(): Promise<void>
}

/** Kills the child when it logs a source endpoint other than the fake (sourceId with host or port). */
function guardLine(line: string, upstreamPort: number): string | null {
	let record: unknown
	try {
		record = JSON.parse(line)
	} catch {
		return null
	}
	if (typeof record !== "object" || record === null) return null
	const r = record as Record<string, unknown>
	if (!("sourceId" in r) || (!("host" in r) && !("port" in r))) return null
	if (r["host"] === LOOPBACK && r["port"] === upstreamPort) return null
	return `The core logged a source endpoint other than the fake: ${String(r["host"])}:${String(r["port"])}`
}

export interface RealCoreOptions {
	/** Run the scanner (its jobs hold the spectrum engine, as on a production core). Default false. */
	scanner?: boolean
}

export async function startRealCore(
	options: RealCoreOptions = {},
): Promise<RealCore> {
	const upstream = await startFakeRtlTcp()
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "wavekit-web-core-")),
	)
	const buildDir = join(root, "build")
	let entry: string
	try {
		await mkdir(buildDir)
		entry = await buildCore(buildDir)
	} catch (err) {
		await upstream.close()
		await rm(root, { recursive: true, force: true })
		throw err
	}
	const stateDir = join(root, "state")
	await mkdir(stateDir, { mode: 0o700 })
	await writeFile(join(root, "empty.env"), "")
	const configFile = join(root, "config.yaml")

	for (let attempt = 1; ; attempt++) {
		const taken = new Set<number>([upstream.port])
		const api = await freePort(taken)
		const ports = {
			audio: await freePort(taken),
			relay: await freePort(taken),
			liveDemod: await freePort(taken),
			digitalVoice: await freePort(taken),
		}
		const config = {
			sources: [
				{
					id: "rtl",
					type: "rtl_tcp",
					host: LOOPBACK,
					port: upstream.port,
					caps: {
						kind: "iq",
						format: "U8_IQ",
						sampleRate: RATE,
						centerFreq: CENTRE_HZ,
						exclusive: false,
					},
				},
			],
			decoders: [],
			decoderPolicy: { catalogue: false },
			stateDir,
			scanner: { enabled: options.scanner === true },
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
		for (const port of [upstream.port, api, ...Object.values(ports)])
			assertAllowedPort(port)
		await writeFile(configFile, JSON.stringify(config))
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
		const child: ChildProcess = spawn(process.execPath, [entry], {
			cwd: root,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		})
		let out = ""
		let pending = ""
		let violation: string | null = null
		child.stdout?.on("data", (c: Buffer) => {
			const text = c.toString()
			out += text
			pending += text
			const lines = pending.split("\n")
			pending = lines.pop() ?? ""
			for (const line of lines) {
				const why = guardLine(line, upstream.port)
				if (why !== null && violation === null) {
					violation = why
					child.kill("SIGKILL")
				}
			}
		})
		child.stderr?.on("data", (c: Buffer) => (out += c.toString()))
		const exited = new Promise<void>(resolve =>
			child.once("close", () => resolve()),
		)
		// A run that ends before stop() (a hook timeout) must not leave this child behind.
		const killOnExit = () => child.kill("SIGKILL")
		process.once("exit", killOnExit)
		void exited.then(() => process.off("exit", killOnExit))
		const deadline = Date.now() + 30_000
		while (
			!out.includes("WaveKit started successfully") &&
			violation === null &&
			child.exitCode === null &&
			child.signalCode === null
		) {
			if (Date.now() > deadline) break
			await delay(20)
		}
		const up =
			out.includes("WaveKit started successfully") && violation === null
		if (!up) {
			if (child.exitCode === null && child.signalCode === null)
				child.kill("SIGKILL")
			await exited
			if (violation !== null || !out.includes("EADDRINUSE") || attempt >= 3) {
				await upstream.close()
				await rm(root, { recursive: true, force: true })
				throw new Error(
					violation ?? `The core did not start:\n${out.slice(-2000)}`,
				)
			}
			continue
		}
		const base = `http://${LOOPBACK}:${api}`
		const get = async (path: string): Promise<unknown> => {
			const res = await fetch(base + path, { cache: "no-store" })
			return (await res.json()) as unknown
		}
		return {
			base,
			apiPort: api,
			upstream,
			get,
			post: async (path, body) => {
				const res = await fetch(base + path, {
					method: "POST",
					...(body === undefined
						? {}
						: {
								headers: { "content-type": "application/json" },
								body: JSON.stringify(body),
							}),
				})
				const text = await res.text()
				return {
					status: res.status,
					body: text ? (JSON.parse(text) as unknown) : null,
				}
			},
			subscribers: async () => {
				const body = (await get("/api/spectrum")) as { subscribers?: unknown }
				return typeof body.subscribers === "number" ? body.subscribers : 0
			},
			output: () => out,
			stop: async () => {
				if (child.exitCode === null && child.signalCode === null) {
					child.kill("SIGTERM")
					const killer = setTimeout(() => child.kill("SIGKILL"), 10_000)
					await exited
					clearTimeout(killer)
				}
				await upstream.close()
				// rm removes the node_modules link itself, never the checkout's packages behind it
				await rm(root, { recursive: true, force: true })
			},
		}
	}
}

/** Polls `check` every 50 ms until it is true or `ms` pass; false on timeout. */
export async function within(
	ms: number,
	check: () => boolean | Promise<boolean>,
): Promise<boolean> {
	const end = Date.now() + ms
	for (;;) {
		if (await check()) return true
		if (Date.now() > end) return false
		await delay(50)
	}
}

/** A loopback TCP proxy to the core (ephemeral port): drops every connection on demand, like a lost network or a frozen tab. */
export interface DropProxy {
	readonly base: string
	dropAll(): void
	close(): Promise<void>
}

export async function startDropProxy(targetPort: number): Promise<DropProxy> {
	assertAllowedPort(targetPort)
	const pairs = new Set<net.Socket>()
	const server = net.createServer(inbound => {
		const outbound = net.connect(targetPort, LOOPBACK)
		pairs.add(inbound)
		pairs.add(outbound)
		const end = () => {
			inbound.destroy()
			outbound.destroy()
			pairs.delete(inbound)
			pairs.delete(outbound)
		}
		inbound.on("error", end)
		outbound.on("error", end)
		inbound.on("close", end)
		outbound.on("close", end)
		inbound.pipe(outbound)
		outbound.pipe(inbound)
	})
	await new Promise<void>(resolve => server.listen(0, LOOPBACK, resolve))
	const port = (server.address() as net.AddressInfo).port
	assertAllowedPort(port)
	return {
		base: `http://${LOOPBACK}:${port}`,
		dropAll: () => {
			for (const s of pairs) s.destroy()
			pairs.clear()
		},
		close: () =>
			new Promise<void>(resolve => {
				for (const s of pairs) s.destroy()
				server.close(() => resolve())
			}),
	}
}
