/**
 * Main-thread profile of an isolated scratch core (measurement only, never a CI gate).
 *
 *   pnpm run build && node scripts/profile-spectrum-build.mjs
 *   node output/bench/profile-spectrum-main.mjs [--seconds 45] [--warmup 15] [--no-prof]
 *
 * This process opens a fake rtl_tcp on 127.0.0.1:0 that streams seeded synthetic
 * CU8 (profile-spectrum-iq.ts) paced at 2.4 Msps, picks ephemeral loopback ports
 * for the API, audio, live-demod and digital-voice listeners (refusing the shared
 * ports), writes a config into a fresh tmp dir (also the state dir) and runs
 * `nice -n 10 node --cpu-prof dist/index.js` against it. One WebSocket client then
 * subscribes like the web app (spectrum at 25 Hz with backfill, aircraft, activity
 * and the status channels). No decoder binaries and no live demod (csdr) run:
 * decoders are empty, so aircraft and activity carry no traffic. Output: per-thread top self time from the
 * core's .cpuprofile files, main-thread event-loop delay (preload), WS rates.
 * Everything lives under the tmp dir, which is removed at the end unless --keep.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import net from "node:net"
import os from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { WaveKitError } from "../src/utils/errors.js"
import { synthesizeCu8 } from "./profile-spectrum-iq.js"

const RATE = 2_400_000
const CENTRE_HZ = 1_000_000_000
const CHUNK_BYTES = 32 * 1024
const BANNED_PORTS = new Set([
	9000, 5173, 8080, 8081, 8082, 15555, 15556, 18080,
])
const SOURCE_ID = "bench0"

function num(name: string, fallback: number): number {
	const i = process.argv.indexOf(`--${name}`)
	const v = i >= 0 ? Number(process.argv[i + 1]) : Number.NaN
	return Number.isFinite(v) && v > 0 ? v : fallback
}

const SECONDS = num("seconds", 45)
const WARMUP = num("warmup", 15)
const PROF = !process.argv.includes("--no-prof")
const KEEP = process.argv.includes("--keep")
const root = fileURLToPath(new URL("../../", import.meta.url))

const log = (line: string): void => {
	process.stderr.write(`${line}\n`)
}

const sleep = (ms: number): Promise<void> =>
	new Promise(resolve => {
		setTimeout(resolve, ms)
	})

async function listenEphemeral(server: net.Server): Promise<number> {
	for (let attempt = 0; attempt < 8; attempt++) {
		const port = await new Promise<number>((resolve, reject) => {
			server.once("error", reject)
			server.listen(0, "127.0.0.1", () => {
				const addr = server.address()
				if (addr === null || typeof addr === "string")
					reject(new WaveKitError("no TCP port", "PROFILE_PORT"))
				else resolve(addr.port)
			})
		})
		if (!BANNED_PORTS.has(port)) return port
		await new Promise<void>(resolve => server.close(() => resolve()))
	}
	throw new WaveKitError("no ephemeral port", "PROFILE_PORT")
}

/** A free loopback port for the core to bind (closed again before the core starts). */
async function freePort(): Promise<number> {
	const server = net.createServer()
	const port = await listenEphemeral(server)
	await new Promise<void>(resolve => server.close(() => resolve()))
	return port
}

interface FakeRtl {
	port: number
	commands: () => number
	bytes: () => number
	close: () => Promise<void>
}

async function startFake(iq: Uint8Array): Promise<FakeRtl> {
	const chunkMs = (CHUNK_BYTES / (RATE * 2)) * 1000
	let commands = 0
	let sent = 0
	const sockets = new Set<net.Socket>()
	const server = net.createServer(socket => {
		sockets.add(socket)
		socket.on("error", () => undefined)
		const header = Buffer.alloc(12)
		header.write("RTL0", 0, "ascii")
		header.writeUInt32BE(5, 4)
		header.writeUInt32BE(29, 8)
		socket.write(header)
		let pending = 0
		socket.on("data", (d: Buffer) => {
			pending += d.length
			commands += Math.floor(pending / 5)
			pending %= 5
		})
		let offset = 0
		let nextAt = performance.now()
		let timer: NodeJS.Timeout | null = null
		const pump = (): void => {
			if (socket.destroyed) return
			const now = performance.now()
			while (nextAt <= now) {
				if (socket.writableNeedDrain) break
				let chunk: Uint8Array
				if (offset + CHUNK_BYTES <= iq.length) {
					chunk = iq.subarray(offset, offset + CHUNK_BYTES)
					offset = (offset + CHUNK_BYTES) % iq.length
				} else {
					chunk = new Uint8Array(CHUNK_BYTES)
					const first = iq.subarray(offset)
					chunk.set(first)
					chunk.set(iq.subarray(0, CHUNK_BYTES - first.length), first.length)
					offset = CHUNK_BYTES - first.length
				}
				socket.write(chunk)
				sent += CHUNK_BYTES
				nextAt += chunkMs
			}
			if (nextAt < now - 200) nextAt = now
			timer = setTimeout(pump, Math.max(1, nextAt - performance.now()))
		}
		socket.on("drain", pump)
		socket.on("close", () => {
			if (timer) clearTimeout(timer)
			sockets.delete(socket)
		})
		pump()
	})
	const port = await listenEphemeral(server)
	return {
		port,
		commands: () => commands,
		bytes: () => sent,
		close: () =>
			new Promise(resolve => {
				for (const s of sockets) s.destroy()
				server.close(() => resolve())
			}),
	}
}

async function waitHttp(
	url: string,
	timeoutMs: number,
	signal: AbortSignal,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline && !signal.aborted) {
		try {
			const res = await fetch(url, { signal })
			if (res.ok) return true
		} catch {
			// not up yet
		}
		await sleep(250)
	}
	return false
}

interface WsStats {
	byType: Map<string, { n: number; bytes: number }>
	reset: () => void
	close: () => void
}

function openClient(apiPort: number): Promise<WsStats> {
	const byType = new Map<string, { n: number; bytes: number }>()
	const ws = new WebSocket(`ws://127.0.0.1:${apiPort}/ws`)
	return new Promise((resolve, reject) => {
		ws.addEventListener("error", () =>
			reject(new WaveKitError("ws error", "PROFILE_WS")),
		)
		ws.addEventListener("message", ev => {
			const text = typeof ev.data === "string" ? ev.data : ""
			let type = "binary"
			if (text) {
				try {
					const msg = JSON.parse(text) as { type?: unknown }
					type = typeof msg.type === "string" ? msg.type : "unknown"
				} catch {
					type = "unparsed"
				}
			}
			const e = byType.get(type) ?? { n: 0, bytes: 0 }
			e.n++
			e.bytes += text.length
			byType.set(type, e)
		})
		ws.addEventListener("open", () => {
			// What a web app tab on the spectrum view subscribes to (web/src/data/*-store.ts).
			ws.send(
				JSON.stringify({
					type: "subscribe",
					channels: [
						"decoders",
						"resources",
						"scanner",
						"bandplans",
						"tuner",
						"sources",
						"live-audio",
						"digital-voice",
						"operator-data",
						"aircraft",
						"vessels",
						"aprs",
						"mesh",
					],
				}),
			)
			ws.send(
				JSON.stringify({
					type: "subscribe",
					channels: ["spectrum"],
					options: {
						spectrum: {
							sourceId: SOURCE_ID,
							hz: 25,
							bins: 1024,
							backfillMs: 10_000,
						},
					},
				}),
			)
			ws.send(
				JSON.stringify({ type: "activity:subscribe", id: "a1", query: {} }),
			)
			resolve({
				byType,
				reset: () => byType.clear(),
				close: () => ws.close(),
			})
		})
	})
}

function loadavg(): string {
	return os
		.loadavg()
		.map(v => v.toFixed(1))
		.join(" ")
}

/** What a run holds, torn down once by cleanup() from finally or a signal. */
const held: {
	fake: FakeRtl | null
	dir: string | null
	child: ChildProcess | null
	exited: Promise<unknown>
	ws: WsStats | null
	logChunks: Buffer[]
} = {
	fake: null,
	dir: null,
	child: null,
	exited: Promise.resolve(),
	ws: null,
	logChunks: [],
}
let cleaning: Promise<void> | null = null

/** Idempotent: close the client, kill and await the scratch core, close the fake, drop the tmp dir. */
function cleanup(): Promise<void> {
	cleaning ??= (async () => {
		held.ws?.close()
		held.ws = null
		const child = held.child
		if (child && child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL")
			await Promise.race([held.exited, sleep(5000)])
		}
		const dir = held.dir
		if (dir !== null) {
			try {
				writeFileSync(join(dir, "core.log"), Buffer.concat(held.logChunks))
			} catch {
				// the dir may never have been fully set up
			}
		}
		await held.fake?.close()
		held.fake = null
		if (dir !== null) {
			if (KEEP) log(`kept ${dir}`)
			else rmSync(dir, { recursive: true, force: true })
		}
	})()
	return cleaning
}

for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.once(signal, () => {
		log(`${signal}: cleaning up`)
		void cleanup()
			.catch((err: unknown) => {
				log(
					`cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
				)
			})
			.finally(() => process.exit(signal === "SIGINT" ? 130 : 143))
	})

async function main(): Promise<void> {
	try {
		const iq = synthesizeCu8(RATE, 4)
		const fake = await startFake(iq)
		held.fake = fake
		const ports = {
			api: await freePort(),
			audio: await freePort(),
			live: await freePort(),
			voice: await freePort(),
		}
		const dir = mkdtempSync(join(os.tmpdir(), "wk-profile-main-"))
		held.dir = dir
		const profDir = join(dir, "prof")
		const config = {
			access: { mode: "legacy" },
			stateDir: join(dir, "state"),
			sources: [
				{
					id: SOURCE_ID,
					type: "rtl_tcp",
					host: "127.0.0.1",
					port: fake.port,
					stallTimeoutMs: 0,
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
			api: { host: "127.0.0.1", port: ports.api },
			audio: { tcpPort: ports.audio, monitoring: false },
			tunerRelay: { enabled: false },
			// csdr is not on a dev Mac: live demod would only crash-loop.
			liveDemod: { enabled: false, httpPort: ports.live },
			digitalVoice: { enabled: false, httpPort: ports.voice },
			resources: {
				containerMonitor: { enabled: false },
				sdrHostPoller: { enabled: false },
			},
			aircraftInfo: { online: false, localDb: { enabled: false } },
			logging: { level: "warn" },
		}
		const configPath = join(dir, "config.yaml")
		writeFileSync(configPath, JSON.stringify(config, null, 2))
		const env: NodeJS.ProcessEnv = {}
		for (const [k, v] of Object.entries(process.env))
			if (!k.startsWith("WAVEKIT_")) env[k] = v
		env["WAVEKIT_CONFIG"] = configPath
		env["PROFILE_ELD_OUT"] = join(dir, "eld.json")
		const nodeArgs = [
			...(PROF ? ["--cpu-prof", `--cpu-prof-dir=${profDir}`] : []),
			"--import",
			join(root, "scripts/profile-eld-preload.mjs"),
			join(root, "dist/index.js"),
		]
		const loadStart = loadavg()
		const spawnedAt = performance.now()
		const child = spawn("nice", ["-n", "10", process.execPath, ...nodeArgs], {
			cwd: dir,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		})
		held.child = child
		// A spawn failure (no `nice` on PATH) emits error and maybe never exit.
		const spawnFailed = new Promise<never>((_, reject) => {
			child.once("error", err => {
				reject(
					new WaveKitError(
						`scratch core spawn failed: ${err.message}`,
						"PROFILE_SPAWN",
					),
				)
			})
		})
		spawnFailed.catch(() => undefined)
		const exited = new Promise<number | null>(resolve => {
			child.once("exit", code => resolve(code))
			child.once("error", () => resolve(null))
		})
		held.exited = exited
		child.stdout.on("data", (d: Buffer) => held.logChunks.push(d))
		child.stderr.on("data", (d: Buffer) => held.logChunks.push(d))
		// Stop the readiness poll whichever side of the race wins.
		const polling = new AbortController()
		const up = await Promise.race([
			waitHttp(
				`http://127.0.0.1:${ports.api}/api/status`,
				60_000,
				polling.signal,
			),
			spawnFailed,
			exited.then(code => {
				throw new WaveKitError(
					`scratch core exited (${code}) before coming up`,
					"PROFILE_UP",
				)
			}),
		]).finally(() => polling.abort())
		if (!up)
			throw new WaveKitError("scratch core did not come up", "PROFILE_UP")
		const ws = await openClient(ports.api)
		held.ws = ws
		log(`core up, warmup ${WARMUP} s, load ${loadavg()}`)
		await sleep(WARMUP * 1000)
		ws.reset()
		const bytes0 = fake.bytes()
		const t0 = performance.now()
		const fromS = (t0 - spawnedAt) / 1000
		child.kill("SIGUSR2") // preload: start the event-loop window
		await sleep(SECONDS * 1000)
		child.kill("SIGUSR2") // preload: write the window
		const wallS = (performance.now() - t0) / 1000
		const iqS = (fake.bytes() - bytes0) / (RATE * 2) / wallS
		const counts = new Map(ws.byType)
		await sleep(500)
		const loadEnd = loadavg()
		const status = await fetch(`http://127.0.0.1:${ports.api}/api/status`)
			.then(r => r.json() as Promise<unknown>)
			.catch(() => null)
		const rows = [...counts.entries()].sort((a, b) => b[1].bytes - a[1].bytes)
		process.stdout.write(
			`scratch core ${SECONDS} s measured after ${WARMUP} s warmup, fake rtl_tcp paced ${((iqS * RATE) / 1e6).toFixed(3)} Msps (${iqS.toFixed(3)}x), ${fake.commands()} rtl commands, load ${loadStart} -> ${loadEnd}\n`,
		)
		process.stdout.write("WS messages to the one client (per s):\n")
		for (const [type, e] of rows)
			process.stdout.write(
				`  ${type.padEnd(28)} ${(e.n / wallS).toFixed(2).padStart(8)} msg/s ${(e.bytes / wallS / 1024).toFixed(1).padStart(8)} KiB/s\n`,
			)
		writeFileSync(join(dir, "status.json"), JSON.stringify(status))
		ws.close()
		held.ws = null
		child.kill("SIGINT")
		const code = await Promise.race([exited, sleep(20_000).then(() => -1)])
		if (code === -1) {
			child.kill("SIGKILL")
			log("core did not exit in 20 s; killed")
		}
		const eld = JSON.parse(readFileSync(join(dir, "eld.json"), "utf8")) as {
			windowMs: number
			elu: number
			processCpu: number
			delayMs: Record<string, number>
		}
		process.stdout.write(
			`main thread over ${(eld.windowMs / 1000).toFixed(1)} s: ELU ${(eld.elu * 100).toFixed(1)} %, process CPU (all threads) ${(eld.processCpu * 100).toFixed(1)} % of a core, event-loop delay (1 ms timer, value includes it) p50 ${eld.delayMs["p50"]?.toFixed(2)} p90 ${eld.delayMs["p90"]?.toFixed(2)} p99 ${eld.delayMs["p99"]?.toFixed(2)} p99.9 ${eld.delayMs["p999"]?.toFixed(2)} max ${eld.delayMs["max"]?.toFixed(1)} mean ${eld.delayMs["mean"]?.toFixed(1)} ms\n`,
		)
		if (PROF) {
			for (const f of readdirSync(profDir).sort()) {
				const r = spawnSync(
					process.execPath,
					[
						join(root, "scripts/profile-cpuprof-top.mjs"),
						join(profDir, f),
						"--top",
						"15",
						"--from-s",
						fromS.toFixed(1),
						"--to-s",
						(fromS + wallS).toFixed(1),
					],
					{ encoding: "utf8" },
				)
				process.stdout.write(`\n${r.stdout}`)
			}
		}
	} catch (err) {
		log(`failed: ${err instanceof Error ? err.message : String(err)}`)
		log(Buffer.concat(held.logChunks).toString("utf8").slice(-4000))
		process.exitCode = 1
	} finally {
		await cleanup()
	}
}

void main().catch((err: unknown) => {
	log(err instanceof Error ? (err.stack ?? err.message) : String(err))
	process.exitCode = 1
})
