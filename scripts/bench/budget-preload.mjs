// Preload for a scratch core under the main-thread budget harness (node --import).
// Measurement only: it never changes what the core does, it only counts.
//
// Inert unless BUDGET_OUT names a directory and this process's entry script matches
// BUDGET_CORE_MATCH (a regex, default: ends in dist/index.js), so other node processes that
// inherit NODE_OPTIONS (a container's exec'd tools) stay untouched.
//
// Main thread: each SIGUSR2 opens or closes a window (window 0, 1, ...). At close it writes
// window-<n>.json with deltas over the window: main-thread CPU (process.threadCpuUsage),
// process CPU (process.cpuUsage), event-loop utilisation, event-loop delay (1 ms resolution),
// GC count and ms by kind, context switches (process.resourceUsage, whole process), socket
// write calls and bytes by handle kind (pipe = child stdio and Unix sockets, tcp, other),
// structuredClone calls, IQ source chunks (`data` events on the TCP socket whose remote port is
// BUDGET_SOURCE_PORT), and on Linux the main thread's run-queue wait (/proc/thread-self/schedstat)
// and every thread's utime + stime and wait (/proc/self/task/*). Every 10 s inside a window it
// appends the same figures for those 10 s, plus os.loadavg(), to ticks-<n>.jsonl.
//
// Workers: on Node 24 an --import preload also runs in every worker_threads Worker started from
// a file (not in `eval: true` workers). A worker records its own process.threadCpuUsage between
// the main thread's open and close (sent on a BroadcastChannel) and writes
// window-<n>-worker-<threadId>.json, or at its exit if it ends inside the window.
import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import { join } from "node:path"
import {
	constants as perfConstants,
	monitorEventLoopDelay,
	PerformanceObserver,
	performance,
} from "node:perf_hooks"
import process from "node:process"
import { pathToFileURL } from "node:url"
import { isMainThread, threadId, threadName } from "node:worker_threads"

// === pure helpers (exported for the harness tools and the tests) ===

/**
 * Ports a harness tool never binds or connects to: the receiver's, the relay's, the live
 * core's and the development servers'. 5173 is not here: inside the isolated tier B container
 * the production config binds its API there (tier A refuses it for everything it binds).
 */
export const TOOL_REFUSED_PORTS = new Set([
	1234, 4713, 5555, 5556, 8080, 8081, 8082, 9000, 15555, 15556, 18080,
])

/** Why a harness tool must not connect to `host:port`, or null when it may (loopback only). */
export function toolTargetRefusal(host, port) {
	const h = String(host ?? "").toLowerCase()
	if (h !== "127.0.0.1" && h !== "[::1]" && h !== "::1" && h !== "localhost")
		return `refused host ${String(host)} (loopback only: 127.0.0.1, [::1], localhost)`
	const p = Number(port)
	if (!Number.isInteger(p) || p < 1 || p > 65535)
		return `refused port ${String(port)}`
	if (TOOL_REFUSED_PORTS.has(p)) return `refused port ${p} (a shared port)`
	return null
}

/** `HOST:PORT` or `[::1]:PORT` as { host, port }, or null. */
export function splitHostPort(text) {
	const m = /^(\[[^\]]+\]|[^:[\]]+):(\d+)$/.exec(String(text ?? ""))
	return m ? { host: m[1], port: Number(m[2]) } : null
}

/**
 * One `/proc/<pid>/stat` (or task stat) line: pid, comm (which may hold spaces and
 * parentheses: it runs to the LAST `)`), ppid, utime and stime in clock ticks. Null when the
 * line does not parse.
 */
export function parseProcStat(text) {
	const s = String(text ?? "")
	const open = s.indexOf("(")
	const close = s.lastIndexOf(")")
	if (open < 0 || close < open) return null
	const pid = Number(s.slice(0, open).trim())
	const f = s
		.slice(close + 2)
		.trim()
		.split(/\s+/)
	// After the comm: f[0] is field 3 (state), f[1] field 4 (ppid), utime field 14, stime 15.
	const ppid = Number(f[1])
	const utime = Number(f[11])
	const stime = Number(f[12])
	if (![pid, ppid, utime, stime].every(Number.isInteger)) return null
	return {
		pid,
		comm: s.slice(open + 1, close),
		ppid,
		utime,
		stime,
		ticks: utime + stime,
	}
}

const out = process.env.BUDGET_OUT
const CHANNEL = "wavekit-budget-window"
const TICK_MS = 10_000
/** USER_HZ: 100 on every Linux ABI Node supports. */
const CLK_TCK = 100

function entryMatches() {
	let rx
	try {
		rx = new RegExp(
			process.env.BUDGET_CORE_MATCH || "[\\\\/]dist[\\\\/]index\\.js$",
		)
	} catch {
		return false
	}
	return rx.test(process.argv[1] ?? "")
}

function writeJson(name, value) {
	try {
		writeFileSync(join(out, name), JSON.stringify(value))
	} catch {
		// measurement must never take the core down
	}
}

function appendJson(name, value) {
	try {
		writeFileSync(join(out, name), `${JSON.stringify(value)}\n`, { flag: "a" })
	} catch {
		// as above
	}
}

if (out && isMainThread && entryMatches()) {
	process.env.BUDGET_ACTIVE_PID = String(process.pid)
	startMain()
} else if (
	out &&
	!isMainThread &&
	process.env.BUDGET_ACTIVE_PID === String(process.pid)
) {
	startWorker()
}

function startWorker() {
	let open = null
	const name =
		typeof threadName === "string" && threadName !== "" ? threadName : null
	const record = (n, status) => {
		if (open === null || open.n !== n) return
		const cpu = process.threadCpuUsage(open.cpu0)
		writeJson(`window-${n}-worker-${threadId}.json`, {
			n,
			threadId,
			name,
			status,
			startedInWindow: open.startedInWindow,
			cpuUs: cpu.user + cpu.system,
			wallMs: performance.now() - open.t0,
		})
		open = null
	}
	let bc
	try {
		bc = new BroadcastChannel(CHANNEL)
		bc.unref?.()
	} catch {
		return
	}
	// A worker started inside a window counts from its own start.
	let current = null
	try {
		const raw = readFileSync(join(out, "window-open.json"), "utf8")
		const state = JSON.parse(raw)
		if (state && typeof state.n === "number" && state.open === true)
			current = state.n
	} catch {
		current = null
	}
	if (current !== null)
		open = {
			n: current,
			cpu0: { user: 0, system: 0 },
			t0: performance.now(),
			startedInWindow: true,
		}
	bc.onmessage = ev => {
		const msg = ev.data
		if (!msg || typeof msg.n !== "number") return
		if (msg.cmd === "open")
			open = {
				n: msg.n,
				cpu0: process.threadCpuUsage(),
				t0: performance.now(),
				startedInWindow: false,
			}
		else if (msg.cmd === "close") record(msg.n, "closed")
	}
	process.on("exit", () => {
		if (open !== null) record(open.n, "exited")
	})
}

function readTasks() {
	if (process.platform !== "linux") return null
	try {
		const tasks = []
		for (const tid of readdirSync("/proc/self/task")) {
			let stat
			try {
				stat = readFileSync(`/proc/self/task/${tid}/stat`, "utf8")
			} catch {
				continue
			}
			const parsed = parseProcStat(stat)
			if (parsed === null) continue
			let waitNs = null
			try {
				const s = readFileSync(`/proc/self/task/${tid}/schedstat`, "utf8")
					.trim()
					.split(/\s+/)
				waitNs = Number(s[1])
			} catch {
				waitNs = null
			}
			tasks.push({
				tid: Number(tid),
				comm: parsed.comm,
				cpuMs: (parsed.ticks / CLK_TCK) * 1000,
				waitNs,
			})
		}
		return tasks
	} catch {
		return null
	}
}

function readSchedstat() {
	if (process.platform !== "linux") return null
	try {
		const s = readFileSync("/proc/thread-self/schedstat", "utf8")
			.trim()
			.split(/\s+/)
		const runNs = Number(s[0])
		const waitNs = Number(s[1])
		return Number.isFinite(runNs) && Number.isFinite(waitNs)
			? { runNs, waitNs }
			: null
	} catch {
		return null
	}
}

function startMain() {
	const gcNames = new Map([
		[perfConstants.NODE_PERFORMANCE_GC_MAJOR, "major"],
		[perfConstants.NODE_PERFORMANCE_GC_MINOR, "minor"],
		[perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL, "incremental"],
		[perfConstants.NODE_PERFORMANCE_GC_WEAKCB, "weakcb"],
	])
	// Cumulative counters, read at window and tick edges.
	const counters = {
		writes: {
			pipe: { count: 0, bytes: 0 },
			tcp: { count: 0, bytes: 0 },
			other: { count: 0, bytes: 0 },
		},
		clones: 0,
		chunks: 0,
		chunkBytes: 0,
		gc: {},
	}
	const sourcePort = Number(process.env.BUDGET_SOURCE_PORT)
	const proto = net.Socket.prototype
	const originalWrite = proto.write
	proto.write = function write(chunk) {
		const name = this._handle?.constructor?.name
		const c =
			name === "Pipe"
				? counters.writes.pipe
				: name === "TCP"
					? counters.writes.tcp
					: counters.writes.other
		c.count++
		if (typeof chunk === "string")
			c.bytes += Buffer.byteLength(
				chunk,
				typeof arguments[1] === "string" ? arguments[1] : "utf8",
			)
		else if (chunk && typeof chunk.byteLength === "number")
			c.bytes += chunk.byteLength
		return originalWrite.apply(this, arguments)
	}
	if (Number.isInteger(sourcePort) && sourcePort > 0) {
		const IS_SOURCE = Symbol("budgetSource")
		const originalEmit = proto.emit
		proto.emit = function emit(event, data) {
			if (event === "data") {
				let is = this[IS_SOURCE]
				if (is === undefined) {
					is = this.remotePort === sourcePort
					this[IS_SOURCE] = is
				}
				if (is) {
					counters.chunks++
					counters.chunkBytes += data?.length ?? 0
				}
			}
			return originalEmit.apply(this, arguments)
		}
	}
	const originalClone = globalThis.structuredClone
	if (typeof originalClone === "function")
		globalThis.structuredClone = function structuredClone(value, options) {
			counters.clones++
			return originalClone(value, options)
		}
	const gcObserver = new PerformanceObserver(list => {
		for (const e of list.getEntries()) {
			const kind = gcNames.get(e.detail?.kind) ?? "other"
			const g = (counters.gc[kind] ??= { count: 0, ms: 0 })
			g.count++
			g.ms += e.duration
		}
	})
	gcObserver.observe({ entryTypes: ["gc"] })

	const bc = (() => {
		try {
			const c = new BroadcastChannel(CHANNEL)
			c.unref?.()
			return c
		} catch {
			return null
		}
	})()

	const snapshot = () => ({
		t: performance.now(),
		wall: Date.now(),
		thread: process.threadCpuUsage(),
		proc: process.cpuUsage(),
		elu: performance.eventLoopUtilization(),
		ru: process.resourceUsage(),
		writes: structuredCloneSafe(counters.writes),
		gc: structuredCloneSafe(counters.gc),
		clones: counters.clones,
		chunks: counters.chunks,
		chunkBytes: counters.chunkBytes,
		sched: readSchedstat(),
	})
	// The counters hold only numbers: a JSON round trip copies them without calling the
	// (counted) structuredClone.
	function structuredCloneSafe(v) {
		return JSON.parse(JSON.stringify(v))
	}
	const delta = (a, b, h) => {
		const kinds = (x, y) => {
			const o = {}
			for (const k of new Set([...Object.keys(x), ...Object.keys(y)]))
				o[k] = {
					count: (y[k]?.count ?? 0) - (x[k]?.count ?? 0),
					...("bytes" in (y[k] ?? x[k] ?? {})
						? { bytes: (y[k]?.bytes ?? 0) - (x[k]?.bytes ?? 0) }
						: {}),
					...("ms" in (y[k] ?? x[k] ?? {})
						? { ms: (y[k]?.ms ?? 0) - (x[k]?.ms ?? 0) }
						: {}),
				}
			return o
		}
		const elu = performance.eventLoopUtilization(b.elu, a.elu)
		const wallMs = b.t - a.t
		const sched =
			a.sched && b.sched
				? {
						runNs: b.sched.runNs - a.sched.runNs,
						waitNs: b.sched.waitNs - a.sched.waitNs,
						waitShare:
							wallMs > 0
								? (b.sched.waitNs - a.sched.waitNs) / (wallMs * 1e6)
								: null,
					}
				: null
		return {
			wallMs,
			mainCpuUs:
				b.thread.user - a.thread.user + (b.thread.system - a.thread.system),
			processCpuUs: b.proc.user - a.proc.user + (b.proc.system - a.proc.system),
			elu: {
				utilization: elu.utilization,
				activeMs: elu.active,
				idleMs: elu.idle,
			},
			loopDelayMs: h
				? {
						p50: h.percentile(50) / 1e6,
						p99: h.percentile(99) / 1e6,
						max: h.max / 1e6,
						mean: h.mean / 1e6,
					}
				: null,
			gc: kinds(a.gc, b.gc),
			contextSwitches: {
				voluntary:
					b.ru.voluntaryContextSwitches - a.ru.voluntaryContextSwitches,
				involuntary:
					b.ru.involuntaryContextSwitches - a.ru.involuntaryContextSwitches,
			},
			writes: kinds(a.writes, b.writes),
			structuredClone: b.clones - a.clones,
			sourceChunks:
				Number.isInteger(sourcePort) && sourcePort > 0
					? b.chunks - a.chunks
					: null,
			sourceBytes:
				Number.isInteger(sourcePort) && sourcePort > 0
					? b.chunkBytes - a.chunkBytes
					: null,
			schedstat: sched,
		}
	}

	// The window at 1 ms resolution, the 10 s ticks at 10 ms: each enabled monitor is a timer on
	// this thread, so together they add about 1,100 wake-ups per second while a window is open.
	const windowH = monitorEventLoopDelay({ resolution: 1 })
	const tickH = monitorEventLoopDelay({ resolution: 10 })
	let n = -1
	let open = null
	let ticker = null

	writeJson("preload.json", {
		pid: process.pid,
		platform: process.platform,
		node: process.version,
		threadCpuUsage: typeof process.threadCpuUsage === "function",
		sourcePort: Number.isInteger(sourcePort) ? sourcePort : null,
		schedstat: readSchedstat() !== null,
		tasks: readTasks() !== null,
	})
	writeJson("core.pid", process.pid)

	const tick = () => {
		if (open === null) return
		const now = snapshot()
		appendJson(`ticks-${open.n}.jsonl`, {
			n: open.n,
			atUtc: new Date(now.wall).toISOString(),
			loadavg: os.loadavg(),
			...delta(open.last, now, tickH),
		})
		tickH.reset()
		open.last = now
	}

	const close = () => {
		if (open === null) return
		clearInterval(ticker)
		const end = snapshot()
		// The last partial tick, when it holds at least 2 s.
		if (end.t - open.last.t >= 2000) {
			appendJson(`ticks-${open.n}.jsonl`, {
				n: open.n,
				atUtc: new Date(end.wall).toISOString(),
				loadavg: os.loadavg(),
				partial: true,
				...delta(open.last, end, tickH),
			})
		}
		windowH.disable()
		tickH.disable()
		const tasksEnd = readTasks()
		let tasks = null
		if (open.tasks && tasksEnd) {
			const before = new Map(open.tasks.map(t => [t.tid, t]))
			tasks = tasksEnd.map(t => {
				const b = before.get(t.tid)
				return {
					tid: t.tid,
					comm: t.comm,
					main: t.tid === process.pid,
					startedInWindow: b === undefined,
					cpuMs: t.cpuMs - (b?.cpuMs ?? 0),
					waitNs:
						t.waitNs !== null && b?.waitNs != null ? t.waitNs - b.waitNs : null,
				}
			})
		}
		writeJson(`window-${open.n}.json`, {
			n: open.n,
			pid: process.pid,
			platform: process.platform,
			startUtc: new Date(open.start.wall).toISOString(),
			endUtc: new Date(end.wall).toISOString(),
			...delta(open.start, end, windowH),
			tasks,
		})
		bc?.postMessage({ cmd: "close", n: open.n })
		writeJson("window-open.json", { n: open.n, open: false })
		open = null
	}

	process.on("SIGUSR2", () => {
		if (open !== null) {
			close()
			return
		}
		n++
		windowH.reset()
		tickH.reset()
		windowH.enable()
		tickH.enable()
		const start = snapshot()
		open = { n, start, last: start, tasks: readTasks() }
		writeJson("window-open.json", { n, open: true })
		bc?.postMessage({ cmd: "open", n })
		ticker = setInterval(tick, TICK_MS)
		ticker.unref()
	})
	process.on("exit", () => {
		close()
	})
}

// === collector mode ===
//
//   node budget-preload.mjs collect profile|coverage HOST:PORT SECONDS OUTFILE
//
// Run as a script (not a preload), it talks to the core's inspector at HOST:PORT (loopback
// only, never a shared port: toolTargetRefusal). `profile` samples the main thread at 1 ms for
// SECONDS and writes the .cpuprofile. `coverage` starts precise coverage with call counts,
// takes it once to reset the counters, waits SECONDS and writes { seconds, result } with the
// counts of that window. Prints `started` once the profiler or coverage runs. OUTFILE is
// written under a temporary name and renamed when complete, so it exists only whole.
async function collect(mode, hostPort, seconds, outFile) {
	const target0 = splitHostPort(hostPort)
	if (target0 === null) throw new Error("inspector must be HOST:PORT")
	const refusal = toolTargetRefusal(target0.host, target0.port)
	if (refusal !== null) throw new Error(refusal)
	if (mode !== "profile" && mode !== "coverage")
		throw new Error(`unknown mode ${mode}`)
	if (!(seconds > 0) || !outFile)
		throw new Error("usage: collect MODE HOST:PORT SECONDS OUTFILE")
	const wait = ms => new Promise(r => setTimeout(r, ms))
	// An inspector opened on demand (SIGUSR1) needs a moment to listen.
	let list = null
	for (let attempt = 0; attempt < 40 && list === null; attempt++) {
		try {
			list = await (await fetch(`http://${hostPort}/json/list`)).json()
		} catch {
			await wait(250)
		}
	}
	const target = Array.isArray(list)
		? list.find(t => typeof t?.webSocketDebuggerUrl === "string")
		: null
	if (!target) throw new Error("no inspector target")
	const ws = new WebSocket(target.webSocketDebuggerUrl)
	let id = 0
	const pending = new Map()
	ws.addEventListener("message", ev => {
		const m = JSON.parse(String(ev.data))
		const p = m.id !== undefined ? pending.get(m.id) : undefined
		if (!p) return
		pending.delete(m.id)
		if (m.error) p.reject(new Error(JSON.stringify(m.error)))
		else p.resolve(m.result)
	})
	await new Promise((res, rej) => {
		ws.addEventListener("open", res, { once: true })
		ws.addEventListener(
			"error",
			() => rej(new Error("inspector socket error")),
			{ once: true },
		)
	})
	const call = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const i = ++id
			pending.set(i, { resolve, reject })
			ws.send(JSON.stringify({ id: i, method, params }))
		})
	const writeWhole = text => {
		const tmp = `${outFile}.partial`
		writeFileSync(tmp, text)
		renameSync(tmp, outFile)
	}
	await call("Profiler.enable")
	if (mode === "profile") {
		await call("Profiler.setSamplingInterval", { interval: 1000 })
		await call("Profiler.start")
		process.stdout.write("started\n")
		await wait(seconds * 1000)
		const { profile } = await call("Profiler.stop")
		writeWhole(JSON.stringify(profile))
	} else {
		await call("Profiler.startPreciseCoverage", {
			callCount: true,
			detailed: false,
		})
		await call("Profiler.takePreciseCoverage")
		const t0 = performance.now()
		process.stdout.write("started\n")
		await wait(seconds * 1000)
		const { result } = await call("Profiler.takePreciseCoverage")
		const took = (performance.now() - t0) / 1000
		await call("Profiler.stopPreciseCoverage")
		writeWhole(JSON.stringify({ seconds: took, result }))
	}
	await call("Profiler.disable")
	ws.close()
}

// === procstat mode (Linux) ===
//
//   node budget-preload.mjs procstat ROOTPID
//
// Prints `pid ppid comm ticks` (utime + stime, clock ticks of 10 ms) for ROOTPID and every
// process under it, found by walking parent links over /proc/<pid>/stat (never by name). A
// comm's white space is printed as `_`.
function procstat(rootPid) {
	if (!Number.isInteger(rootPid) || rootPid < 1)
		throw new Error("usage: procstat ROOTPID")
	const rows = []
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) continue
		let text
		try {
			text = readFileSync(`/proc/${name}/stat`, "utf8")
		} catch {
			continue
		}
		const r = parseProcStat(text)
		if (r !== null) rows.push(r)
	}
	const kids = new Map()
	for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r])
	const lines = []
	const seen = new Set()
	const queue = rows.filter(r => r.pid === rootPid)
	while (queue.length > 0) {
		const r = queue.shift()
		if (seen.has(r.pid)) continue
		seen.add(r.pid)
		lines.push(`${r.pid} ${r.ppid} ${r.comm.replace(/\s/g, "_")} ${r.ticks}`)
		for (const c of kids.get(r.pid) ?? []) queue.push(c)
	}
	process.stdout.write(lines.length > 0 ? `${lines.join("\n")}\n` : "")
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	if (process.argv[2] === "collect") {
		const [, , , mode, hostPort, secs, outFile] = process.argv
		collect(mode, hostPort, Number(secs), outFile).then(
			() => process.exit(0),
			err => {
				process.stderr.write(
					`collect failed: ${err instanceof Error ? err.message : String(err)}\n`,
				)
				process.exit(1)
			},
		)
	} else if (process.argv[2] === "procstat") {
		try {
			procstat(Number(process.argv[3]))
		} catch (err) {
			process.stderr.write(
				`procstat failed: ${err instanceof Error ? err.message : String(err)}\n`,
			)
			process.exitCode = 1
		}
	}
}
