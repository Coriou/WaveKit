/**
 * The real core for the spectrum contract test and the browser smoke: src/index.ts bundled with
 * esbuild (the production composition: SourceManager, SpectrumService, the Fastify server and its
 * `/ws` broadcaster) and run as a child process, fed by an rtl_tcp fake in this process.
 *
 * Isolation: the fake listens on 127.0.0.1, ephemeral port (0). The core's config has no port 0,
 * so its ports are probed in 24000–29999 (outside the OS ephemeral range), and every listener it
 * has binds 127.0.0.1 (`api.host`, `audio.host`; the relay, live-audio and digital-voice servers
 * are disabled). After startup and again at stop the child's listening sockets are read from the OS
 * (assertLoopbackListeners): one on any other address fails the run. Every port is checked against
 * FORBIDDEN_PORTS, the child gets an explicit environment (no inherited WAVEKIT_* or DOTENV_*), its
 * cwd and state dir are fresh temp dirs, and any source endpoint it logs other than the fake kills
 * it. The temp root (bundle, state, config) is deleted on stop, on a failed start, and at process
 * exit if the run ends first; the child is killed at process exit too.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process"
import {
	existsSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	rmSync,
} from "node:fs"
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
import { promisify } from "node:util"
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
	/**
	 * The share of the commanded rate actually sent (1: all of it). Below 1 the link loses samples,
	 * as an overloaded receiver host or network does.
	 */
	setDelivery(fraction: number): void
	/** Moves the tone a quarter of the rate above ("upper", the default) or below the centre. */
	setToneSide(side: "upper" | "lower"): void
	close(): Promise<void>
}

function iqBlock(samples: number, phase0: number, side: 1 | -1 = 1): Buffer {
	const out = Buffer.alloc(samples * 2)
	for (let i = 0; i < samples; i++) {
		const phase = phase0 + (side * i * Math.PI) / 2
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

export async function startFakeRtlTcp(
	initialRate: number = RATE,
): Promise<FakeRtlTcp> {
	let accepted = 0
	let delivery = 1
	const sockets = new Set<net.Socket>()
	// One pre-built second of samples, cycled: the tone's phase is continuous at the block edges.
	const upper = iqBlock(4_000_000 / 2, 0)
	const lower = iqBlock(4_000_000 / 2, 0, -1)
	let second = upper
	const server = net.createServer(socket => {
		accepted++
		sockets.add(socket)
		let rate = initialRate
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
			const bytes = Math.floor(((now - last) * rate * delivery) / 1000) * 2
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
		setToneSide: side => {
			second = side === "upper" ? upper : lower
		},
		setDelivery: fraction => {
			delivery = Math.max(0, Math.min(1, fraction))
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

/**
 * Provisions a private access directory with the core's own storage code (bundled like the core,
 * run as a child) and returns the machine token it issued.
 */
async function provisionAccess(
	buildDir: string,
	directory: string,
	env: NodeJS.ProcessEnv,
): Promise<string> {
	const require = createRequire(join(repository, "package.json"))
	const { build } = require("esbuild") as typeof Esbuild
	const outfile = join(buildDir, "provision.js")
	await build({
		absWorkingDir: repository,
		stdin: {
			contents: `import { PrivateAccessStorage } from "./src/access/private-storage.ts"
const storage = await PrivateAccessStorage.open({
	directory: process.argv[2],
	mode: "provision",
	ownership: "single-host-pid-namespace",
})
process.stdout.write(storage.useMachineCredential(value => value))
await storage.close()
`,
			resolveDir: repository,
			loader: "ts",
		},
		bundle: true,
		outfile,
		platform: "node",
		format: "esm",
		packages: "external",
		logLevel: "silent",
	})
	const { stdout } = await promisify(execFile)(
		process.execPath,
		[outfile, directory],
		{ env, timeout: 30_000 },
	)
	const token = stdout.trim()
	if (!/^[A-Za-z0-9_-]{43}$/.test(token))
		throw new Error("Provisioning returned no machine token")
	return token
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
	/** A protected core's one-time browser pairing code; rejects on a legacy core. */
	pairingCode(): Promise<string>
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

/** Listening TCP addresses of `pid` ("host:port"), from lsof, or /proc on Linux without it. */
async function listeningAddresses(pid: number): Promise<string[]> {
	try {
		const { stdout } = await promisify(execFile)(
			"lsof",
			["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"],
			{ timeout: 10_000 },
		)
		return stdout
			.split("\n")
			.filter(line => line.startsWith("n"))
			.map(line => line.slice(1))
	} catch (err) {
		// lsof exits 1 when the process has no listener at all
		const code = (err as { code?: unknown }).code
		if (code === 1) return []
		if (code !== "ENOENT") throw err
	}
	const fdDir = `/proc/${pid}/fd`
	if (!existsSync(fdDir))
		throw new Error("Cannot list the core's listeners: no lsof and no /proc")
	const inodes = new Set<string>()
	for (const fd of readdirSync(fdDir)) {
		try {
			const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(join(fdDir, fd)))
			if (m?.[1]) inodes.add(m[1])
		} catch {
			// closed meanwhile
		}
	}
	const out: string[] = []
	for (const table of ["tcp", "tcp6"]) {
		const file = `/proc/${pid}/net/${table}`
		if (!existsSync(file)) continue
		for (const line of readFileSync(file, "utf8").split("\n").slice(1)) {
			const f = line.trim().split(/\s+/)
			// local_address, st (0A = LISTEN), inode
			if (f.length < 10 || f[3] !== "0A" || !inodes.has(f[9] ?? "")) continue
			const [hex = "", portHex = "0"] = (f[1] ?? "").split(":")
			const port = parseInt(portHex, 16)
			out.push(`${procAddress(hex)}:${port}`)
		}
	}
	return out
}

/** A /proc/net/tcp{,6} address (little-endian 32-bit words) as text: 127.0.0.1, ::1, 0.0.0.0, :: or the hex. */
function procAddress(hex: string): string {
	if (hex.length === 8) {
		const b = Buffer.from(hex, "hex").reverse()
		return [...b].join(".")
	}
	if (hex === "00000000000000000000000001000000") return "[::1]"
	if (/^0+$/.test(hex)) return "[::]"
	return `[${hex}]`
}

/** Fails unless every TCP listener of `pid` is on 127.0.0.1 or ::1. */
export async function assertLoopbackListeners(pid: number): Promise<void> {
	const addresses = await listeningAddresses(pid)
	const outside = addresses.filter(
		a => !a.startsWith(`${LOOPBACK}:`) && !a.startsWith("[::1]:"),
	)
	if (outside.length > 0)
		throw new Error(`The test core listens off loopback: ${outside.join(", ")}`)
}

export interface RealCoreOptions {
	/** Run the scanner (its jobs hold the spectrum engine, as on a production core). Default false. */
	scanner?: boolean
	/**
	 * Protected access over local HTTP: the page origins (http://127.0.0.1:<port>) the core accepts
	 * beside its own. The only Host it accepts is its own 127.0.0.1:<api port>, so a proxy in front
	 * sends that. get(), post() and subscribers() then carry the machine token. Default: legacy.
	 */
	protectedOrigins?: readonly string[]
	/** The source's sample rate (U8 IQ). Default RATE. */
	sampleRate?: number
}

export async function startRealCore(
	options: RealCoreOptions = {},
): Promise<RealCore> {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "wavekit-web-core-")),
	)
	// Recorded before anything else can fail: a run that ends before stop() still removes it.
	const removeRoot = () => rmSync(root, { recursive: true, force: true })
	process.once("exit", removeRoot)
	let upstream: FakeRtlTcp | null = null
	const cleanup = async () => {
		await upstream?.close()
		await rm(root, { recursive: true, force: true })
		process.off("exit", removeRoot)
	}
	try {
		upstream = await startFakeRtlTcp(options.sampleRate ?? RATE)
		return await launch(root, upstream, options, cleanup)
	} catch (err) {
		await cleanup()
		throw err
	}
}

async function launch(
	root: string,
	upstream: FakeRtlTcp,
	options: RealCoreOptions,
	cleanup: () => Promise<void>,
): Promise<RealCore> {
	const buildDir = join(root, "build")
	await mkdir(buildDir)
	const entry = await buildCore(buildDir)
	const stateDir = join(root, "state")
	await mkdir(stateDir, { mode: 0o700 })
	await writeFile(join(root, "empty.env"), "")
	const configFile = join(root, "config.yaml")
	const baseEnv: NodeJS.ProcessEnv = {
		PATH: process.env["PATH"] ?? "",
		HOME: root,
		NODE_ENV: "test",
		DOTENV_CONFIG_PATH: join(root, "empty.env"),
		DOTENV_CONFIG_QUIET: "true",
	}
	const tmp = process.env["TMPDIR"]
	if (tmp !== undefined) baseEnv["TMPDIR"] = tmp
	const pageOrigins = options.protectedOrigins
	const accessDir = join(root, "access")
	const token =
		pageOrigins === undefined
			? null
			: await provisionAccess(buildDir, accessDir, baseEnv)
	const auth: Record<string, string> =
		token === null ? {} : { authorization: `Bearer ${token}` }

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
						sampleRate: options.sampleRate ?? RATE,
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
			audio: { tcpPort: ports.audio, host: LOOPBACK },
			tunerRelay: { enabled: false, port: ports.relay },
			liveDemod: { enabled: false, httpPort: ports.liveDemod },
			digitalVoice: { enabled: false, httpPort: ports.digitalVoice },
			logging: { level: "info" },
			access:
				pageOrigins === undefined
					? { mode: "legacy" }
					: {
							mode: "protected",
							listenerScheme: "http",
							exposure: "local-http",
							allowedAuthorities: [`${LOOPBACK}:${api}`],
							allowedOrigins: [`http://${LOOPBACK}:${api}`, ...pageOrigins],
							audio: {
								analog: {
									allowedAuthorities: [`${LOOPBACK}:${ports.liveDemod}`],
									bindHost: LOOPBACK,
								},
								digital: {
									allowedAuthorities: [`${LOOPBACK}:${ports.digitalVoice}`],
									bindHost: LOOPBACK,
								},
							},
							publicOrigins: {
								api: `http://${LOOPBACK}:${api}`,
								analogAudio: `http://${LOOPBACK}:${ports.liveDemod}`,
								digitalAudio: `http://${LOOPBACK}:${ports.digitalVoice}`,
							},
							healthProbe: {
								target: `http://${LOOPBACK}:${api}`,
								host: `${LOOPBACK}:${api}`,
							},
						},
		}
		for (const port of [upstream.port, api, ...Object.values(ports)])
			assertAllowedPort(port)
		await writeFile(configFile, JSON.stringify(config))
		const env: NodeJS.ProcessEnv = { ...baseEnv, WAVEKIT_CONFIG: configFile }
		if (token !== null) env["WAVEKIT_ACCESS_PRIVATE_DIRECTORY"] = accessDir
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
			if (violation !== null || !out.includes("EADDRINUSE") || attempt >= 3)
				throw new Error(
					violation ?? `The core did not start:\n${out.slice(-2000)}`,
				)
			continue
		}
		const pid = child.pid
		const killChild = async () => {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL")
				await exited
			}
		}
		if (pid === undefined) {
			await killChild()
			throw new Error("The core has no pid")
		}
		try {
			await assertLoopbackListeners(pid)
		} catch (err) {
			await killChild()
			throw err
		}
		const base = `http://${LOOPBACK}:${api}`
		const get = async (path: string): Promise<unknown> => {
			const res = await fetch(base + path, { cache: "no-store", headers: auth })
			return (await res.json()) as unknown
		}
		const post = async (
			path: string,
			body?: unknown,
		): Promise<{ status: number; body: unknown }> => {
			const res = await fetch(base + path, {
				method: "POST",
				headers:
					body === undefined
						? auth
						: { ...auth, "content-type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			})
			const text = await res.text()
			return {
				status: res.status,
				body: text ? (JSON.parse(text) as unknown) : null,
			}
		}
		return {
			base,
			apiPort: api,
			upstream,
			get,
			post,
			subscribers: async () => {
				const body = (await get("/api/spectrum")) as { subscribers?: unknown }
				return typeof body.subscribers === "number" ? body.subscribers : 0
			},
			pairingCode: async () => {
				const issued = await post("/api/access/pairing-codes", {})
				const code = (issued.body as { code?: unknown } | null)?.code
				if (issued.status !== 201 || typeof code !== "string")
					throw new Error(`No pairing code: HTTP ${issued.status}`)
				return code
			},
			output: () => out,
			stop: async () => {
				// listeners opened after startup (a lazy server) count too
				let offLoopback: unknown = null
				if (child.exitCode === null && child.signalCode === null) {
					try {
						await assertLoopbackListeners(pid)
					} catch (err) {
						offLoopback = err
					}
					child.kill("SIGTERM")
					const killer = setTimeout(() => child.kill("SIGKILL"), 10_000)
					await exited
					clearTimeout(killer)
				}
				// rm removes the node_modules link itself, never the checkout's packages behind it
				await cleanup()
				if (offLoopback !== null) throw offLoopback
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
	/**
	 * Sends `text` to the core as a client WebSocket text frame (masked, as a browser sends it) on
	 * every open /ws connection, as if the page had sent it: e.g. an unsubscribe, so the core drops
	 * the page's subscription while its socket stays open. Returns the connections written to.
	 */
	injectClientText(text: string): number
	close(): Promise<void>
}

/** One masked, unfragmented client text frame (RFC 6455 5.2). */
function clientTextFrame(text: string): Buffer {
	const payload = Buffer.from(text, "utf8")
	const mask = Buffer.from([0x5a, 0x17, 0xc3, 0x2e])
	const len = payload.length
	const head =
		len < 126
			? Buffer.from([0x81, 0x80 | len])
			: Buffer.from([0x81, 0x80 | 126, len >> 8, len & 0xff])
	if (len > 0xffff) throw new Error("frame too long for the test proxy")
	const body = Buffer.alloc(len)
	for (let i = 0; i < len; i++) body[i] = payload[i]! ^ mask[i % 4]!
	return Buffer.concat([head, mask, body])
}

export async function startDropProxy(targetPort: number): Promise<DropProxy> {
	assertAllowedPort(targetPort)
	const pairs = new Set<net.Socket>()
	/** Outbound sockets of connections that upgraded to /ws. */
	const wsOut = new Set<net.Socket>()
	const server = net.createServer(inbound => {
		const outbound = net.connect(targetPort, LOOPBACK)
		pairs.add(inbound)
		pairs.add(outbound)
		inbound.once("data", (first: Buffer) => {
			if (first.toString("latin1", 0, 8) === "GET /ws ") wsOut.add(outbound)
		})
		const end = () => {
			inbound.destroy()
			outbound.destroy()
			pairs.delete(inbound)
			pairs.delete(outbound)
			wsOut.delete(outbound)
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
			wsOut.clear()
		},
		injectClientText: text => {
			const frame = clientTextFrame(text)
			let n = 0
			for (const out of wsOut)
				if (!out.destroyed && out.writable) {
					out.write(frame)
					n++
				}
			return n
		},
		close: () =>
			new Promise<void>(resolve => {
				for (const s of pairs) s.destroy()
				server.close(() => resolve())
			}),
	}
}
