/**
 * WaveKit mock core for CLI development and validation (spec §13.3).
 * Run: node cli/source/test/mock-api/server.ts [--port 9100] [--scenario live]
 * Write actions in CLI validation go ONLY to this mock, never to a live core.
 * Self-contained on purpose: Node type stripping cannot import sibling .ts
 * files under cli/tsconfig.json, so the scenario resolver in ../scenarios.ts
 * is duplicated here. Keep the two in step.
 *
 * Fixture times are shifted so the scenario's `now` maps to the moment it was
 * loaded; ages then grow in real time. Counters (fanout, source bytes, decoder
 * uptime) advance from the scenario values at the scenario's rates.
 */
import { readFileSync } from "node:fs"
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http"
import type { AddressInfo } from "node:net"
import { fileURLToPath } from "node:url"
import { WebSocketServer, type RawData, type WebSocket } from "ws"

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj =>
	typeof v === "object" && v !== null && !Array.isArray(v)
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

const SCENARIO_DIR = fileURLToPath(
	new URL("../../../tools/mock-api/scenarios/", import.meta.url),
)
const DELETE = "$delete"
const FANOUT_REST = "$fanoutRest"
const NEW_DECODER_FIELDS = [
	"sourceId",
	"deviceSerial",
	"targetFrequenciesHz",
	"lastError",
	"idleTimeoutMs",
]
const NEW_EVENTS = new Set(["source:status", "decoder:status"])
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
/** Bytes per dropped chunk in the scenarios (684 MB / 13 680 chunks). */
const CHUNK_BYTES = 50_000
const DEFAULT_RATE_KIB = 3994

// ---------- scenario resolver (mirror of ../scenarios.ts) ----------

function deepMerge(base: unknown, patch: unknown): unknown {
	if (!isObj(base) || !isObj(patch)) return patch
	const out: Obj = { ...base }
	for (const [k, v] of Object.entries(patch)) {
		if (v === DELETE) delete out[k]
		else out[k] = deepMerge(base[k], v)
	}
	return out
}

function mergeById(body: unknown, merge: Obj): unknown {
	if (!Array.isArray(body)) return deepMerge(body, merge)
	return body.map((item: unknown) => {
		if (!isObj(item)) return item
		const key = typeof item["id"] === "string" ? item["id"] : item["sourceId"]
		return typeof key === "string" && merge[key] !== undefined
			? deepMerge(item, merge[key])
			: item
	})
}

function restBody(sc: Obj, path: string): unknown {
	const rest = isObj(sc["rest"]) ? sc["rest"] : {}
	const r = rest[path]
	return isObj(r) ? r["body"] : undefined
}

function applyLegacy(sc: Obj): void {
	for (const s of list(restBody(sc, "/api/sources")))
		if (isObj(s)) delete s["activity"]
	const status = restBody(sc, "/api/status")
	const decoders = [
		...list(restBody(sc, "/api/decoders")),
		...(isObj(status) ? list(status["decoders"]) : []),
	]
	for (const d of decoders)
		if (isObj(d)) for (const k of NEW_DECODER_FIELDS) delete d[k]
	sc["ws"] = list(sc["ws"]).filter(
		f => !(isObj(f) && NEW_EVENTS.has(String(f["type"]))),
	)
	// Fanout offered counters are dropped when served (fanoutSnapshot), so drop ratios survive.
}

function resolve(name: string): Obj {
	const own: unknown = JSON.parse(
		readFileSync(`${SCENARIO_DIR}${name}.json`, "utf8"),
	)
	if (!isObj(own)) throw new Error(`scenario ${name} is not an object`)
	const parent = own["extends"]
	const sc = structuredClone(
		typeof parent === "string"
			? (deepMerge(resolve(parent), { ...own, extends: DELETE }) as Obj)
			: own,
	)
	const rest = isObj(sc["rest"]) ? sc["rest"] : {}
	const patch = isObj(own["restPatch"]) ? own["restPatch"] : {}
	for (const [path, m] of Object.entries(patch)) {
		const r = rest[path]
		if (isObj(r) && isObj(m)) r["body"] = mergeById(r["body"], m)
	}
	const t = isObj(own["transform"]) ? own["transform"] : {}
	const inherited = list(sc["ws"])
	const kept =
		t["noOutputs"] === true
			? inherited.filter(f => !(isObj(f) && f["type"] === "decoder:output"))
			: inherited
	sc["ws"] = [...kept, ...list(own["wsAppend"])]
	const fanout = restBody(sc, "/api/telemetry/fanout")
	sc["ws"] = list(sc["ws"]).map((fr: unknown) =>
		isObj(fr) && fr["data"] === FANOUT_REST
			? { ...fr, data: structuredClone(fanout) }
			: fr,
	)
	// The mock evolves fanout itself; the transform only fixes the ratio it evolves with.
	if (typeof t["dropPercent"] === "number") sc["dropPercent"] = t["dropPercent"]
	if (t["legacy"] === true) {
		sc["legacy"] = true
		applyLegacy(sc)
	}
	delete sc["restPatch"]
	delete sc["transform"]
	delete sc["wsAppend"]
	delete sc["extends"]
	sc["name"] = name
	return sc
}

/** Moves every ISO timestamp (and Unix-ms `timestamp`) by `delta` ms. */
function shiftTimes(v: unknown, delta: number, key = ""): unknown {
	if (typeof v === "string")
		return ISO.test(v) ? new Date(Date.parse(v) + delta).toISOString() : v
	if (typeof v === "number")
		return key === "timestamp" && v > 1e12 ? v + delta : v
	if (Array.isArray(v)) return v.map(x => shiftTimes(x, delta))
	if (isObj(v)) {
		const out: Obj = {}
		for (const [k, x] of Object.entries(v)) out[k] = shiftTimes(x, delta, k)
		return out
	}
	return v
}

// ---------- live state ----------

type RestMode = "ok" | "fail" | "hang" | "500"
type WsMode = "up" | "drop" | "refuse"

interface Branch {
	id: string
	decoderId?: string
	offered: number
	dropped: number
	baseDropped: number
	baseChunks: number
	/** Δdropped/Δoffered taken from the scenario's two newest snapshots. */
	ratio: number
	base: Obj
}

interface Call {
	at: string
	method: string
	path: string
	body: unknown
}

interface State {
	name: string
	sc: Obj
	legacy: boolean
	loadedAt: number
	rest: RestMode
	ws: WsMode
	dropPercent: number | null
	calls: Call[]
	branches: Branch[]
	decoders: Obj[]
	decoderUptimeAt: Map<string, number>
	sources: Obj[]
	tuner: Obj[]
	audio: Obj
	lastTick: number
	burst: NodeJS.Timeout | null
}

function initBranches(sc: Obj): Branch[] {
	const body = restBody(sc, "/api/telemetry/fanout")
	const frames = list(sc["ws"])
		.filter(
			(f): f is Obj =>
				isObj(f) && f["type"] === "fanout:snapshot" && isObj(f["data"]),
		)
		.sort((a, b) => Number(a["offsetMs"]) - Number(b["offsetMs"]))
	const first = frames[0]?.["data"]
	const firstById = new Map<string, Obj>()
	if (isObj(first))
		for (const b of list(first["branches"]))
			if (isObj(b)) firstById.set(String(b["id"]), b)
	const out: Branch[] = []
	for (const b of isObj(body) ? list(body["branches"]) : []) {
		if (!isObj(b)) continue
		const id = String(b["id"])
		const b0 = firstById.get(id)
		const dO =
			Number(b["totalBytesWritten"] ?? 0) -
			Number(b0?.["totalBytesWritten"] ?? 0)
		const dD =
			Number(b["droppedBytesTotal"] ?? 0) -
			Number(b0?.["droppedBytesTotal"] ?? 0)
		const dropped = Number(b["droppedBytesTotal"] ?? 0)
		out.push({
			id,
			...(typeof b["decoderId"] === "string"
				? { decoderId: b["decoderId"] }
				: {}),
			// A branch without offered still advances; legacy hides the counter when served.
			offered: Number(b["totalBytesWritten"] ?? 1_900_000_000),
			dropped,
			baseDropped: dropped,
			baseChunks: Number(b["droppedChunksTotal"] ?? 0),
			ratio: b0 && dO > 0 ? dD / dO : 0,
			base: b,
		})
	}
	return out
}

function connModes(sc: Obj): { rest: RestMode; ws: WsMode } {
	const c = isObj(sc["conn"]) ? sc["conn"] : {}
	return {
		rest:
			c["rest"] === "down"
				? c["restError"] === "timeout"
					? "hang"
					: "fail"
				: "ok",
		ws: c["ws"] === "closed" ? "refuse" : "up",
	}
}

function loadState(name: string, prev?: State): State {
	const now = Date.now()
	const raw = resolve(name)
	const sc = shiftTimes(raw, now - Date.parse(String(raw["now"]))) as Obj
	const arr = (path: string): Obj[] =>
		list(structuredClone(restBody(sc, path))).filter(isObj)
	const audio = restBody(sc, "/api/live-audio/status")
	const modes = connModes(sc)
	return {
		name,
		sc,
		legacy: sc["legacy"] === true,
		loadedAt: now,
		rest: modes.rest,
		ws: modes.ws,
		dropPercent:
			typeof sc["dropPercent"] === "number" ? sc["dropPercent"] : null,
		calls: prev?.calls ?? [],
		branches: initBranches(sc),
		decoders: arr("/api/decoders"),
		decoderUptimeAt: new Map(),
		sources: arr("/api/sources"),
		tuner: arr("/api/tuner"),
		audio: isObj(audio) ? structuredClone(audio) : {},
		lastTick: now,
		burst: null,
	}
}

function sourceRateBytes(s: Obj): number {
	return (
		(typeof s["dataRate"] === "number" ? s["dataRate"] : DEFAULT_RATE_KIB) *
		1024
	)
}

/** Advances byte counters to now. Called by every REST read and WS tick. */
function tick(st: State): void {
	const now = Date.now()
	const dt = (now - st.lastTick) / 1000
	if (dt <= 0) return
	st.lastTick = now
	const rate = st.sources[0]
		? sourceRateBytes(st.sources[0])
		: DEFAULT_RATE_KIB * 1024
	for (const s of st.sources)
		if (s["connected"] === true)
			s["bytesReceived"] = Math.round(
				Number(s["bytesReceived"] ?? 0) + sourceRateBytes(s) * dt,
			)
	for (const b of st.branches) {
		const delta = rate * dt
		b.offered += delta
		b.dropped += delta * branchRatio(st, b)
	}
}

function branchRatio(st: State, b: Branch): number {
	return b.decoderId !== undefined && st.dropPercent !== null
		? st.dropPercent / 100
		: b.ratio
}

function branchActive(st: State, b: Branch): boolean {
	if (b.decoderId === undefined) return false
	return st.dropPercent !== null
		? st.dropPercent > 0
		: b.base["backpressureActive"] === true
}

function fanoutSnapshot(st: State): Obj {
	tick(st)
	const nowIso = new Date().toISOString()
	let offered = 0
	let dropped = 0
	let chunks = 0
	let bp = 0
	const branches = st.branches.map(b => {
		const active = branchActive(st, b)
		const d = Math.round(b.dropped)
		const c = b.baseChunks + Math.floor((d - b.baseDropped) / CHUNK_BYTES)
		offered += Math.round(b.offered)
		dropped += d
		chunks += c
		if (active) bp++
		const out: Obj = {
			...b.base,
			backpressureActive: active,
			droppedBytesTotal: d,
			droppedChunksTotal: c,
		}
		if (!active) delete out["backpressureSince"]
		else if (out["backpressureSince"] === undefined)
			out["backpressureSince"] = nowIso
		if (st.legacy) delete out["totalBytesWritten"]
		else out["totalBytesWritten"] = Math.round(b.offered)
		return out
	})
	const snap: Obj = {
		timestamp: nowIso,
		branches,
		backpressureActiveCount: bp,
		droppedBytesTotal: dropped,
		droppedChunksTotal: chunks,
	}
	if (!st.legacy) snap["totalBytesWritten"] = offered
	return snap
}

function sourcesNow(st: State): Obj[] {
	tick(st)
	const now = Date.now()
	return st.sources.map(s => {
		const a = s["activity"]
		if (!isObj(a) || a["state"] !== "streaming") return s
		const age = typeof a["sampleAgeMs"] === "number" ? a["sampleAgeMs"] : 4
		return {
			...s,
			activity: { ...a, lastSampleAt: new Date(now - age).toISOString() },
		}
	})
}

function decodersNow(st: State): Obj[] {
	const now = Date.now()
	return st.decoders.map(d => {
		if (d["running"] !== true) return d
		const since = st.decoderUptimeAt.get(String(d["id"]))
		const uptime =
			since !== undefined
				? (now - since) / 1000
				: Number(d["uptime"] ?? 0) + (now - st.loadedAt) / 1000
		return { ...d, uptime: Math.floor(uptime) }
	})
}

function resourcesNow(st: State): unknown {
	const r = restBody(st.sc, "/api/resources")
	if (!isObj(r)) return r
	const nowIso = new Date().toISOString()
	return {
		...r,
		timestamp: nowIso,
		sdrHosts: list(r["sdrHosts"]).map(h =>
			isObj(h) && h["lastFetchedAt"] !== null
				? { ...h, lastFetchedAt: nowIso }
				: h,
		),
		sourceBackpressure: list(r["sourceBackpressure"]).map(b =>
			isObj(b) ? { ...b, lastCheckedAt: nowIso } : b,
		),
	}
}

// ---------- HTTP helpers ----------

function textOf(d: RawData): string {
	if (Array.isArray(d)) return Buffer.concat(d).toString("utf8")
	return Buffer.isBuffer(d)
		? d.toString("utf8")
		: Buffer.from(d).toString("utf8")
}

function readBody(req: IncomingMessage): Promise<unknown> {
	return new Promise(resolveBody => {
		const chunks: Buffer[] = []
		req.on("data", (c: Buffer) => chunks.push(c))
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8")
			if (text === "") {
				resolveBody(undefined)
				return
			}
			try {
				resolveBody(JSON.parse(text))
			} catch {
				resolveBody(undefined)
			}
		})
		req.on("error", () => resolveBody(undefined))
	})
}

function send(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" })
	res.end(JSON.stringify(body))
}

// ---------- writes ----------

type FieldKind = "integer" | "boolean" | readonly string[]

/** route setting → [TunerState field, body key, body value kind] (src/api/routes/tuner.ts). */
const TUNER_FIELDS: Readonly<
	Record<string, readonly [string, string, FieldKind]>
> = {
	frequency: ["frequency", "hz", "integer"],
	gain: ["gain", "tenthsDb", "integer"],
	"gain-mode": ["gainMode", "mode", ["manual", "agc"]],
	"sample-rate": ["sampleRate", "hz", "integer"],
	ppm: ["ppm", "ppm", "integer"],
	agc: ["agcMode", "enabled", "boolean"],
	"bias-tee": ["biasTee", "enabled", "boolean"],
	"offset-tuning": ["offsetTuning", "enabled", "boolean"],
	"direct-sampling": ["directSampling", "mode", ["off", "i", "q"]],
	"tuner-gain-index": ["tunerGainIndex", "index", "integer"],
	"control-mode": ["controlMode", "mode", ["internal", "external"]],
}

function validField(v: unknown, kind: FieldKind): boolean {
	if (kind === "integer") return Number.isInteger(v)
	if (kind === "boolean") return typeof v === "boolean"
	return typeof v === "string" && kind.includes(v)
}

const BURST_TEXT =
	"MAINTENANCE PAGE \u001b[31mRED\u001b[0m BELL\u0007 TAB\tEND 🚀 "

function burstFrame(i: number): Obj {
	const t = new Date().toISOString()
	switch (i % 4) {
		case 0:
			return {
				decoderId: "readsb",
				output: {
					type: "aircraft",
					decoder: "readsb",
					timestamp: t,
					data: {
						hex: (0x4ca9d2 + (i % 50)).toString(16),
						flight: `RYR${i % 900} `,
						alt_baro: 30000 + (i % 80) * 100,
						baro_rate: (i % 3) * 600 - 600,
						gs: 420 + (i % 40),
						track: (i * 7) % 360,
						lat: 51 + (i % 100) / 100,
						lon: -0.5 + (i % 50) / 100,
						squawk: i % 97 === 0 ? "7700" : "2000",
					},
				},
			}
		case 1:
			return {
				decoderId: "ais-catcher",
				output: {
					type: "ais",
					decoder: "ais-catcher",
					timestamp: t,
					data: {
						mmsi: 235000000 + i,
						shipname: `VESSEL ${i} OF THE EXTREMELY LONG NAMED FLEET`,
						shiptype_text: "cargo",
						lat: 51.4,
						lon: 0.2,
						speed: 8 + (i % 10),
					},
				},
			}
		case 2:
			return {
				decoderId: "multimon-ng",
				output: {
					type: "pocsag",
					decoder: "multimon-ng",
					timestamp: t,
					data: {
						protocol: "POCSAG1200",
						address: 1000000 + i,
						function: i % 4,
						messageType: "Alpha",
						message: BURST_TEXT.repeat(1 + (i % 6)),
					},
				},
			}
		default:
			return {
				decoderId: "dsd-fme",
				output: {
					type: "call_end",
					decoder: "dsd-fme",
					timestamp: t,
					data: {
						protocol: "dmr",
						talkgroup: 2350 + (i % 5),
						source: 2340000 + i,
						slot: 1 + (i % 2),
						duration: 1000 + (i % 20) * 300,
						dmr: { cc: 1 },
						quality: { crcErrs: i % 5, fecErrs: 0 },
					},
				},
			}
	}
}

// ---------- server ----------

export async function startMockServer(opts: {
	port: number
	scenario: string
}): Promise<{ port: number; close(): Promise<void> }> {
	let st = loadState(opts.scenario)
	const clients = new Map<WebSocket, Set<string>>()
	const hanging = new Set<ServerResponse>()
	const timers = new Set<NodeJS.Timeout>()

	const later = (ms: number, fn: () => void): void => {
		const t = setTimeout(() => {
			timers.delete(t)
			fn()
		}, ms)
		timers.add(t)
	}
	const sendTo = (
		ws: WebSocket,
		channel: string,
		type: string,
		data: unknown,
	): void => {
		ws.send(JSON.stringify({ type, channel, data }))
	}
	const broadcast = (channel: string, type: string, data: unknown): void => {
		for (const [ws, chans] of clients)
			if (chans.has(channel)) sendTo(ws, channel, type, data)
	}
	const dropClients = (): void => {
		for (const ws of clients.keys()) ws.terminate()
		clients.clear()
	}
	const releaseHanging = (): void => {
		for (const r of hanging) r.destroy()
		hanging.clear()
	}
	const decoderStatus = (id: string): void => {
		if (st.legacy) return
		const d = decodersNow(st).find(x => x["id"] === id)
		if (d) broadcast("decoders", "decoder:status", d)
	}
	const sourceSnapshot = (): void => {
		if (st.legacy) return
		for (const s of sourcesNow(st)) broadcast("sources", "source:status", s)
	}
	const canned = (key: string): Obj | undefined => {
		const actions = isObj(st.sc["actions"]) ? st.sc["actions"] : {}
		const a = actions[key]
		return isObj(a) ? a : undefined
	}

	function handleControl(path: string, b: Obj, res: ServerResponse): void {
		if (path === "/__mock/calls") return send(res, 200, st.calls)
		if (path === "/__mock/reset") {
			st.calls = []
			return send(res, 200, { calls: 0 })
		}
		if (path === "/__mock/scenario" && typeof b["name"] === "string") {
			let next: State
			try {
				next = loadState(b["name"], st)
			} catch {
				return send(res, 404, {
					error: "Not Found",
					code: "MOCK_SCENARIO",
					message: `unknown scenario ${b["name"]}`,
				})
			}
			if (st.burst) clearInterval(st.burst)
			st = next
			if (st.ws !== "up") dropClients()
			if (st.rest === "ok") releaseHanging()
			sourceSnapshot()
			return send(res, 200, { scenario: st.name, rest: st.rest, ws: st.ws })
		}
		if (
			path === "/__mock/rest" &&
			["ok", "fail", "hang", "500"].includes(String(b["mode"]))
		) {
			st.rest = b["mode"] as RestMode
			if (st.rest !== "hang") releaseHanging()
			return send(res, 200, { rest: st.rest })
		}
		if (
			path === "/__mock/ws" &&
			["up", "drop", "refuse"].includes(String(b["mode"]))
		) {
			st.ws = b["mode"] as WsMode
			if (st.ws === "drop") dropClients()
			return send(res, 200, { ws: st.ws })
		}
		if (path === "/__mock/fanout") {
			tick(st)
			st.dropPercent =
				typeof b["dropPercent"] === "number" ? b["dropPercent"] : null
			return send(res, 200, { dropPercent: st.dropPercent })
		}
		if (path === "/__mock/burst") {
			const perSecond = typeof b["perSecond"] === "number" ? b["perSecond"] : 50
			const seconds = typeof b["seconds"] === "number" ? b["seconds"] : 60
			if (st.burst) clearInterval(st.burst)
			let i = 0
			let carry = 0
			const until = Date.now() + seconds * 1000
			const owner = st
			owner.burst = setInterval(() => {
				if (Date.now() > until || st !== owner) {
					if (owner.burst) clearInterval(owner.burst)
					owner.burst = null
					return
				}
				carry += perSecond / 10
				for (; carry >= 1; carry--) {
					const frame = burstFrame(i++)
					const d = owner.decoders.find(x => x["id"] === frame["decoderId"])
					if (d) {
						const stats = isObj(d["stats"]) ? d["stats"] : {}
						d["stats"] = {
							...stats,
							eventsOut: Number(stats["eventsOut"] ?? 0) + 1,
						}
						d["lastOutputAt"] = new Date().toISOString()
					}
					broadcast("decoders", "decoder:output", frame)
				}
			}, 100)
			return send(res, 200, { perSecond, seconds })
		}
		return send(res, 404, {
			error: "Not Found",
			code: "NOT_FOUND",
			message: `mock route ${path} not found`,
		})
	}

	function handleGet(path: string, res: ServerResponse): void {
		if (path === "/health")
			return send(res, 200, {
				status: "ok",
				timestamp: new Date().toISOString(),
			})
		if (path === "/api/decoders") return send(res, 200, decodersNow(st))
		const one = /^\/api\/decoders\/([^/]+)$/.exec(path)
		if (one) {
			const d = decodersNow(st).find(
				x => x["id"] === decodeURIComponent(one[1] ?? ""),
			)
			return d
				? send(res, 200, d)
				: send(res, 404, {
						error: "NotFound",
						code: "DECODER_NOT_FOUND",
						message: `Decoder with id '${one[1] ?? ""}' not found`,
					})
		}
		if (path === "/api/sources") return send(res, 200, sourcesNow(st))
		if (path === "/api/tuner") return send(res, 200, st.tuner)
		if (path === "/api/live-audio/status") return send(res, 200, st.audio)
		if (path === "/api/telemetry/fanout")
			return send(res, 200, fanoutSnapshot(st))
		if (path === "/api/resources") return send(res, 200, resourcesNow(st))
		const body = restBody(st.sc, path)
		if (body !== undefined) return send(res, 200, body)
		return send(res, 404, {
			message: `Route GET:${path} not found`,
			error: "Not Found",
			statusCode: 404,
		})
	}

	function handleDecoderWrite(
		id: string,
		op: string,
		res: ServerResponse,
	): void {
		const d = st.decoders.find(x => x["id"] === id)
		if (!d)
			return send(res, 404, {
				error: "NotFound",
				code: "DECODER_NOT_FOUND",
				message: `Decoder with id '${id}' not found`,
			})
		if (op === "start" && d["running"] === true) {
			return send(res, 409, {
				error: "Conflict",
				code: "DECODER_ALREADY_RUNNING",
				message: `Decoder '${id}' is already running`,
			})
		}
		if (op === "stop" && d["running"] !== true) {
			return send(res, 409, {
				error: "Conflict",
				code: "DECODER_NOT_RUNNING",
				message: `Decoder '${id}' is not running`,
			})
		}
		if (op === "stop") {
			d["running"] = false
			d["uptime"] = 0
			delete d["pid"]
			st.decoderUptimeAt.delete(id)
		} else {
			// An explicit start/restart resets restartCount and clears lastError (docs/API.md).
			d["running"] = true
			d["health"] = "running"
			d["pid"] = 2000 + Math.floor(Math.random() * 8000)
			d["restartCount"] = 0
			delete d["lastError"]
			st.decoderUptimeAt.set(id, Date.now())
		}
		const verb =
			op === "stop" ? "stopped" : op === "start" ? "started" : "restarted"
		const owner = st
		later(300, () => {
			if (st !== owner) return
			if (op === "restart")
				broadcast("decoders", "decoder:stopped", { decoderId: id })
			broadcast(
				"decoders",
				op === "stop" ? "decoder:stopped" : "decoder:started",
				{ decoderId: id },
			)
			decoderStatus(id)
		})
		return send(res, 200, {
			message: `Decoder '${id}' ${verb} successfully`,
			decoder: decodersNow(st).find(x => x["id"] === id),
		})
	}

	function handleTunerWrite(
		sourceId: string,
		setting: string,
		body: unknown,
		res: ServerResponse,
	): void {
		const t = st.tuner.find(x => x["sourceId"] === sourceId)
		const field = TUNER_FIELDS[setting]
		if (!field)
			return send(res, 404, {
				message: `Route POST:/api/tuner/${sourceId}/${setting} not found`,
				error: "Not Found",
				statusCode: 404,
			})
		const [key, bodyKey, kind] = field
		const value = isObj(body) ? body[bodyKey] : undefined
		if (!validField(value, kind)) {
			return send(res, 400, {
				statusCode: 400,
				code: "FST_ERR_VALIDATION",
				error: "Bad Request",
				message: `body/${bodyKey} is missing or has the wrong type`,
			})
		}
		if (!t)
			return send(res, 404, {
				error: "TunerSourceNotFoundError",
				code: "TUNER_SOURCE_NOT_FOUND",
				message: `Tuner source not found: ${sourceId}`,
			})
		if (setting !== "control-mode" && t["controlMode"] === "external") {
			return send(res, 409, {
				error: "TunerControlModeError",
				code: "TUNER_CONTROL_EXTERNAL",
				message: `Cannot send commands: control released to external tuner for ${sourceId}`,
			})
		}
		if (
			setting === "sample-rate" &&
			(Number(value) < 225_001 || Number(value) > 3_200_000)
		) {
			return send(res, 400, {
				error: "TunerValidationError",
				code: "TUNER_VALIDATION_ERROR",
				message: `Sample rate out of range: ${String(value)}`,
			})
		}
		t[key] = value
		t["commandCount"] = Number(t["commandCount"] ?? 0) + 1
		t["lastCommandAt"] = new Date().toISOString()
		if (setting === "control-mode")
			broadcast("tuner", "tuner:control-mode-changed", {
				sourceId,
				mode: value,
			})
		else
			broadcast("tuner", "tuner:command-sent", {
				sourceId,
				command: setting,
				value,
			})
		broadcast("tuner", "tuner:state-changed", { sourceId, state: t })
		if (setting === "frequency" || setting === "sample-rate") {
			const s = st.sources.find(x => x["id"] === sourceId)
			if (s && isObj(s["caps"])) {
				s["caps"] = {
					...s["caps"],
					...(setting === "frequency"
						? { centerFreq: value }
						: { sampleRate: value }),
				}
				broadcast("sources", "source:caps-changed", {
					sourceId,
					caps: s["caps"],
				})
				sourceSnapshot()
			}
		}
		return send(res, 200, t)
	}

	function handleAudioWrite(
		method: string,
		path: string,
		body: unknown,
		res: ServerResponse,
	): void {
		if (
			method === "POST" &&
			(path === "/api/live-audio/start" || path === "/api/live-audio/stop")
		) {
			const start = path.endsWith("start")
			st.audio["running"] = start
			st.audio["pipelineHealth"] = start ? "running" : "stopped"
			broadcast(
				"live-audio",
				start ? "live-audio:started" : "live-audio:stopped",
				{},
			)
			broadcast("live-audio", "live-audio:status", st.audio)
			return send(res, 200, { success: true })
		}
		if (method === "PATCH" && path === "/api/live-audio/config") {
			if (!isObj(body))
				return send(res, 400, {
					statusCode: 400,
					code: "FST_ERR_VALIDATION",
					error: "Bad Request",
					message: "body must be object",
				})
			st.audio["config"] = {
				...(isObj(st.audio["config"]) ? st.audio["config"] : {}),
				...body,
			}
			broadcast("live-audio", "live-audio:config", st.audio["config"])
			return send(res, 200, st.audio)
		}
		return send(res, 404, {
			message: `Route ${method}:${path} not found`,
			error: "Not Found",
			statusCode: 404,
		})
	}

	async function handle(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const url = new URL(req.url ?? "/", "http://mock")
		const path = url.pathname
		const method = req.method ?? "GET"
		if (path.startsWith("/__mock/")) {
			const body = await readBody(req)
			return handleControl(path, isObj(body) ? body : {}, res)
		}
		if (st.rest === "fail") {
			req.socket.destroy()
			return
		}
		if (st.rest === "hang") {
			hanging.add(res)
			res.on("close", () => hanging.delete(res))
			return
		}
		if (st.rest === "500")
			return send(res, 500, {
				error: "InternalServerError",
				code: "MOCK_FAILURE",
				message: "mock failure",
			})
		if (method === "GET") return handleGet(path, res)
		const body = await readBody(req)
		st.calls.push({ at: new Date().toISOString(), method, path, body })
		const dec = /^\/api\/decoders\/([^/]+)\/(start|stop|restart)$/.exec(path)
		const tun = /^\/api\/tuner\/([^/]+)\/([a-z-]+)$/.exec(path)
		const key = dec
			? `${method} /api/decoders/:id/${dec[2] ?? ""}`
			: tun
				? `${method} /api/tuner/:sourceId/${tun[2] ?? ""}`
				: `${method} ${path}`
		const c = canned(key)
		if (c)
			return send(
				res,
				typeof c["status"] === "number" ? c["status"] : 200,
				c["body"] ?? {},
			)
		if (method === "POST" && dec)
			return handleDecoderWrite(
				decodeURIComponent(dec[1] ?? ""),
				dec[2] ?? "",
				res,
			)
		if (method === "POST" && tun)
			return handleTunerWrite(
				decodeURIComponent(tun[1] ?? ""),
				tun[2] ?? "",
				body,
				res,
			)
		return handleAudioWrite(method, path, body, res)
	}

	const server = createServer((req, res) => {
		void handle(req, res)
	})
	const wss = new WebSocketServer({ noServer: true })
	server.on("upgrade", (req, socket, head) => {
		socket.on("error", () => socket.destroy())
		if (new URL(req.url ?? "/", "http://mock").pathname !== "/ws") {
			socket.destroy()
			return
		}
		if (st.ws !== "up") {
			socket.end(
				"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
			)
			return
		}
		wss.handleUpgrade(req, socket, head, ws => {
			clients.set(ws, new Set())
			ws.on("error", () => clients.delete(ws))
			ws.on("close", () => clients.delete(ws))
			ws.on("message", (data: RawData) => {
				let msg: unknown
				try {
					msg = JSON.parse(textOf(data))
				} catch {
					ws.send(
						JSON.stringify({
							type: "error",
							data: { message: "Invalid JSON" },
						}),
					)
					return
				}
				if (!isObj(msg) || !Array.isArray(msg["channels"])) return
				const chans = clients.get(ws) ?? new Set<string>()
				const requested = msg["channels"].filter(
					(c): c is string => typeof c === "string",
				)
				if (msg["type"] === "unsubscribe") {
					for (const c of requested) chans.delete(c)
					ws.send(
						JSON.stringify({
							type: "unsubscribed",
							data: { channels: [...chans] },
						}),
					)
					return
				}
				if (msg["type"] !== "subscribe") return
				const fresh = requested.filter(c => !chans.has(c))
				for (const c of requested) chans.add(c)
				clients.set(ws, chans)
				ws.send(
					JSON.stringify({
						type: "subscribed",
						data: { channels: [...chans] },
					}),
				)
				// Replay the scenario's recorded frames, oldest first; fanout and metrics are generated live.
				const frames = list(st.sc["ws"])
					.filter(isObj)
					.filter(
						f =>
							f["type"] !== "fanout:snapshot" &&
							f["type"] !== "metrics" &&
							fresh.includes(String(f["channel"])),
					)
					.sort((a, b) => Number(a["offsetMs"]) - Number(b["offsetMs"]))
				for (const f of frames)
					sendTo(ws, String(f["channel"]), String(f["type"]), f["data"])
				if (fresh.includes("sources")) sourceSnapshot()
			})
		})
	})

	const fanoutTimer = setInterval(
		() => broadcast("fanout", "fanout:snapshot", fanoutSnapshot(st)),
		1000,
	)
	const metricsTimer = setInterval(() => {
		for (const s of sourcesNow(st)) {
			broadcast("metrics", "metrics", {
				sourceId: s["id"],
				bytesReceived: s["bytesReceived"],
				dataRate: s["dataRate"],
			})
		}
		const r = resourcesNow(st)
		if (r !== undefined) broadcast("resources", "resources:snapshot", r)
	}, 5000)
	const heartbeatTimer = setInterval(sourceSnapshot, 10_000)

	await new Promise<void>(r => server.listen(opts.port, "127.0.0.1", () => r()))
	const port = (server.address() as AddressInfo).port
	return {
		port,
		close: () =>
			new Promise<void>(r => {
				clearInterval(fanoutTimer)
				clearInterval(metricsTimer)
				clearInterval(heartbeatTimer)
				for (const t of timers) clearTimeout(t)
				if (st.burst) clearInterval(st.burst)
				dropClients()
				releaseHanging()
				wss.close()
				server.closeAllConnections()
				server.close(() => r())
			}),
	}
}

function arg(name: string, fallback: string): string {
	const i = process.argv.indexOf(name)
	return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const scenario = arg("--scenario", "live")
	void startMockServer({ port: Number(arg("--port", "9100")), scenario }).then(
		s => {
			process.stdout.write(
				`wavekit mock core on http://127.0.0.1:${s.port} (scenario ${scenario})\n`,
			)
			const stop = (): void => {
				void s.close().then(() => process.exit(0))
			}
			process.on("SIGINT", stop)
			process.on("SIGTERM", stop)
		},
	)
}
