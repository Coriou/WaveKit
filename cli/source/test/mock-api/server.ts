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
 * uptime) advance from the scenario values at the scenario's rates while IQ is
 * streaming. A scenario's /api/decoders restHistory replays on a compressed
 * timer, and decoders that restart during it keep restarting (crash loop).
 */
import { readFileSync, readdirSync } from "node:fs"
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
const SOURCE_STATUS = "$sourceStatus:"
const DECODER_STATUS = "$decoderStatus:"
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
const REST_MODES = ["ok", "fail", "hang", "500"] as const
const WS_MODES = ["up", "drop", "refuse"] as const
const SOURCE_STATES = ["streaming", "stale", "disconnected", "waiting"] as const
type RestMode = (typeof REST_MODES)[number]
type WsMode = (typeof WS_MODES)[number]
type SourceState = (typeof SOURCE_STATES)[number]

/** Scenario names are the JSON files in SCENARIO_DIR; nothing else is ever read. */
export function scenarioNames(): string[] {
	return readdirSync(SCENARIO_DIR)
		.filter(f => /^[a-z0-9-]+\.json$/.test(f))
		.map(f => f.slice(0, -".json".length))
		.sort()
}

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

function expandMacros(sc: Obj): void {
	const item = (path: string, id: string): unknown =>
		list(restBody(sc, path)).find(x => isObj(x) && x["id"] === id)
	const expand = (data: unknown): unknown => {
		if (data === FANOUT_REST) return restBody(sc, "/api/telemetry/fanout")
		if (typeof data !== "string") return data
		if (data.startsWith(SOURCE_STATUS))
			return item("/api/sources", data.slice(SOURCE_STATUS.length))
		if (data.startsWith(DECODER_STATUS))
			return item("/api/decoders", data.slice(DECODER_STATUS.length))
		return data
	}
	sc["ws"] = list(sc["ws"]).map((fr: unknown) => {
		if (!isObj(fr)) return fr
		const data = expand(fr["data"])
		if (data === undefined)
			throw new Error(`scenario macro ${String(fr["data"])} has no target`)
		return data === fr["data"] ? fr : { ...fr, data: structuredClone(data) }
	})
}

const restAgo = (c: Obj): number =>
	typeof c["restAgoMs"] === "number" ? c["restAgoMs"] : 2000
const wsAgo = (c: Obj): number =>
	typeof c["wsAgoMs"] === "number" ? c["wsAgoMs"] : restAgo(c)

/** R58: bodies and frames move back with the scenario's older REST success / WS base. */
function anchorTimes(sc: Obj, authored: Obj): void {
	const conn = isObj(sc["conn"]) ? sc["conn"] : {}
	const restDelta = restAgo(authored) - restAgo(conn)
	const wsDelta = wsAgo(authored) - wsAgo(conn)
	const rest = isObj(sc["rest"]) ? sc["rest"] : {}
	for (const r of Object.values(rest))
		if (isObj(r) && r["body"] !== undefined && restDelta !== 0)
			r["body"] = shiftTimes(r["body"], restDelta)
	if (wsDelta !== 0)
		sc["ws"] = list(sc["ws"]).map(f =>
			isObj(f) ? { ...f, data: shiftTimes(f["data"], wsDelta) } : f,
		)
}

function compose(name: string): {
	sc: Obj
	transforms: Obj[]
	authored: Obj
} {
	const own: unknown = JSON.parse(
		readFileSync(`${SCENARIO_DIR}${name}.json`, "utf8"),
	)
	if (!isObj(own)) throw new Error(`scenario ${name} is not an object`)
	const parentName = own["extends"]
	const parent = typeof parentName === "string" ? compose(parentName) : null
	const sc = structuredClone(
		parent ? (deepMerge(parent.sc, { ...own, extends: DELETE }) as Obj) : own,
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
	delete sc["restPatch"]
	delete sc["transform"]
	delete sc["wsAppend"]
	delete sc["extends"]
	const authored = parent?.authored ?? (isObj(own["conn"]) ? own["conn"] : {})
	return { sc, transforms: [...(parent?.transforms ?? []), t], authored }
}

function resolve(name: string): Obj {
	const { sc, transforms, authored } = compose(name)
	expandMacros(sc)
	anchorTimes(sc, authored)
	// The mock evolves fanout itself: dropPercent only fixes the ratio it evolves with,
	// and stallIq follows from the source's activity state (no IQ unless streaming).
	for (const t of transforms) {
		if (typeof t["dropPercent"] === "number")
			sc["dropPercent"] = t["dropPercent"]
		if (t["legacy"] === true) sc["legacy"] = true
	}
	if (sc["legacy"] === true) applyLegacy(sc)
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

interface Branch {
	id: string
	decoderId?: string
	offered: number
	dropped: number
	baseDropped: number
	baseChunks: number
	/** Δdropped/Δoffered taken from the scenario's oldest WS snapshot and the REST body. */
	ratio: number
	base: Obj
}

interface Call {
	at: string
	method: string
	path: string
	body: unknown
}

/** /api/decoders restHistory replayed one step per `historyStepMs`, then a crash loop for `crashIds`. */
interface Timeline {
	/** Per-step merges, oldest first; the last restores the scenario's current values. */
	steps: Obj[]
	idx: number
	crashIds: string[]
	nextCrashAt: number
}

interface State {
	name: string
	sc: Obj
	legacy: boolean
	loadedAt: number
	rest: RestMode
	ws: WsMode
	/** Replay recorded frames to new subscribers; off after a WS drop until the next scenario load. */
	replay: boolean
	dropPercent: number | null
	calls: Call[]
	branches: Branch[]
	decoders: Obj[]
	decoderUptimeAt: Map<string, number>
	sources: Obj[]
	/** KiB/s each source streams at, kept while its reported dataRate is 0 (not streaming). */
	baseRates: Map<string, number>
	tuner: Obj[]
	audio: Obj
	timeline: Timeline | null
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

/** The base values at the paths `shape` names; absent values become $delete. */
function pickPaths(base: unknown, shape: unknown): unknown {
	if (!isObj(shape)) return base === undefined ? DELETE : structuredClone(base)
	const out: Obj = {}
	for (const k of Object.keys(shape))
		out[k] = pickPaths(isObj(base) ? base[k] : undefined, shape[k])
	return out
}

function initTimeline(sc: Obj, decoders: Obj[], now: number): Timeline | null {
	const hist = list(sc["restHistory"])
		.filter(
			(h): h is Obj =>
				isObj(h) && h["path"] === "/api/decoders" && isObj(h["merge"]),
		)
		.sort((a, b) => Number(a["offsetMs"]) - Number(b["offsetMs"]))
	if (hist.length === 0) return null
	const merges = hist.map(h => h["merge"] as Obj)
	const shape = merges.reduce<Obj>((acc, m) => deepMerge(acc, m) as Obj, {})
	const restore: Obj = {}
	for (const id of Object.keys(shape)) {
		const d = decoders.find(x => x["id"] === id)
		restore[id] = pickPaths(d, shape[id])
	}
	// Each step is the scenario's value at that time for every path any step touches.
	const steps = [...merges, restore].map(m => {
		const full: Obj = {}
		for (const id of Object.keys(shape)) {
			const d = decoders.find(x => x["id"] === id)
			full[id] = pickPaths(deepMerge(d, m[id] ?? {}), shape[id])
		}
		return full
	})
	const restarts = (step: Obj | undefined, id: string): number => {
		const v = isObj(step?.[id]) ? (step[id] as Obj)["restartCount"] : undefined
		return typeof v === "number" ? v : Number.NaN
	}
	const crashIds = Object.keys(shape).filter(
		id => restarts(steps[steps.length - 1], id) > restarts(steps[0], id),
	)
	if (crashIds.length === 0) return null
	// Only crash-looping decoders replay their history; every other decoder starts at
	// the scenario's "now" values, so captures match the fixtures' scenarioState at once.
	const only = (step: Obj): Obj =>
		Object.fromEntries(crashIds.map(id => [id, step[id]]))
	return { steps: steps.map(only), idx: 0, crashIds, nextCrashAt: now }
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
	if (!scenarioNames().includes(name))
		throw new Error(`unknown scenario "${name}"`)
	const now = Date.now()
	const raw = resolve(name)
	const sc = shiftTimes(raw, now - Date.parse(String(raw["now"]))) as Obj
	const arr = (path: string): Obj[] =>
		list(structuredClone(restBody(sc, path))).filter(isObj)
	const audio = restBody(sc, "/api/live-audio/status")
	const modes = connModes(sc)
	const decoders = arr("/api/decoders")
	const timeline = initTimeline(sc, decoders, now)
	const sources = arr("/api/sources")
	return {
		name,
		sc,
		legacy: sc["legacy"] === true,
		loadedAt: now,
		rest: modes.rest,
		ws: modes.ws,
		replay: modes.ws === "up",
		dropPercent:
			typeof sc["dropPercent"] === "number" ? sc["dropPercent"] : null,
		calls: prev?.calls ?? [],
		branches: initBranches(sc),
		decoders: timeline
			? (mergeById(decoders, timeline.steps[0] ?? {}) as Obj[])
			: decoders,
		decoderUptimeAt: new Map(),
		sources,
		baseRates: new Map(
			sources.map(s => [
				String(s["id"]),
				typeof s["dataRate"] === "number" && s["dataRate"] > 0
					? s["dataRate"]
					: DEFAULT_RATE_KIB,
			]),
		),
		tuner: arr("/api/tuner"),
		audio: isObj(audio) ? structuredClone(audio) : {},
		timeline,
		lastTick: now,
		burst: null,
	}
}

/** IQ flows while the (first) source is connected and, when it reports activity, streaming. */
function iqFlowing(st: State): boolean {
	const s = st.sources[0]
	if (!s) return true
	if (s["connected"] !== true) return false
	const a = s["activity"]
	return !isObj(a) || a["state"] === "streaming"
}

function rateBytes(st: State, s: Obj | undefined): number {
	return (
		(s
			? (st.baseRates.get(String(s["id"])) ?? DEFAULT_RATE_KIB)
			: DEFAULT_RATE_KIB) * 1024
	)
}

/** Advances byte counters to now. Called by every REST read and WS tick. */
function tick(st: State): void {
	const now = Date.now()
	const dt = (now - st.lastTick) / 1000
	if (dt <= 0) return
	st.lastTick = now
	if (!iqFlowing(st)) return
	for (const s of st.sources)
		s["bytesReceived"] = Math.round(
			Number(s["bytesReceived"] ?? 0) + rateBytes(st, s) * dt,
		)
	const delta = rateBytes(st, st.sources[0]) * dt
	for (const b of st.branches) {
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
	if (b.decoderId === undefined || !iqFlowing(st)) return false
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
		if (!isObj(a)) return s
		if (a["state"] === "streaming") {
			const age = typeof a["sampleAgeMs"] === "number" ? a["sampleAgeMs"] : 4
			return {
				...s,
				activity: { ...a, lastSampleAt: new Date(now - age).toISOString() },
			}
		}
		const last =
			typeof a["lastSampleAt"] === "string"
				? Date.parse(a["lastSampleAt"])
				: NaN
		return Number.isNaN(last)
			? s
			: { ...s, activity: { ...a, sampleAgeMs: Math.max(0, now - last) } }
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
	if (res.headersSent || res.destroyed) return
	res.writeHead(status, { "content-type": "application/json" })
	res.end(JSON.stringify(body))
}

function badRequest(res: ServerResponse, message: string): void {
	send(res, 400, { error: "Bad Request", code: "MOCK_BAD_REQUEST", message })
}

const isOneOf = <T extends string>(values: readonly T[], v: unknown): v is T =>
	typeof v === "string" && (values as readonly string[]).includes(v)

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

const bit = (v: unknown): number => (v === true ? 1 : 0)
/** rtl_tcp command name and numeric value core emits in tuner:command-sent (src/core/tuner-controller.ts). */
const RTL_COMMANDS: Readonly<
	Record<string, readonly [string, (v: unknown) => number]>
> = {
	frequency: ["set-frequency", Number],
	"sample-rate": ["set-sample-rate", Number],
	"gain-mode": ["set-gain-mode", v => (v === "manual" ? 1 : 0)],
	gain: ["set-gain", Number],
	ppm: [
		"set-freq-correction",
		v => (Number(v) < 0 ? 0xffffffff + Number(v) + 1 : Number(v)),
	],
	agc: ["set-agc-mode", bit],
	"bias-tee": ["set-bias-tee", bit],
	"offset-tuning": ["set-offset-tuning", bit],
	"direct-sampling": [
		"set-direct-sampling",
		v => (v === "i" ? 1 : v === "q" ? 2 : 0),
	],
	"tuner-gain-index": ["set-tuner-gain-index", Number],
}

function validField(v: unknown, kind: FieldKind): boolean {
	if (kind === "integer") return Number.isInteger(v)
	if (kind === "boolean") return typeof v === "boolean"
	return typeof v === "string" && kind.includes(v)
}

const BURST_TEXT =
	"MAINTENANCE PAGE \u001b[31mRED\u001b[0m BELL\u0007 TAB\tEND 🚀 "

/** One decoder:output per call in the core wire shape of src/decoders/builtin/*, rotating protocols. */
function burstFrame(i: number): Obj {
	const t = new Date().toISOString()
	const frame = (decoderId: string, type: string, data: unknown): Obj => ({
		decoderId,
		output: { type, decoder: decoderId, timestamp: t, data },
	})
	switch (i % 8) {
		case 0:
			return frame("readsb", "aircraft", {
				icao: (0x4ca9d2 + (i % 50)).toString(16).toUpperCase(),
				callsign: `RYR${i % 900}`,
				altitude: 30000 + (i % 80) * 100,
				groundSpeed: 420 + (i % 40),
				track: (i * 7) % 360,
				lat: 51 + (i % 100) / 100,
				lon: -0.5 + (i % 50) / 100,
				verticalRate: (i % 3) * 600 - 600,
				squawk: i % 97 === 0 ? "7700" : "2000",
				lastSeen: t,
				messageCount: 1 + i,
			})
		case 1:
			return frame("ais-catcher", "ship", {
				mmsi: String(235000000 + (i % 1000)).padStart(9, "0"),
				name: `VESSEL ${i} OF THE EXTREMELY LONG NAMED FLEET`,
				callsign: "MXYZ7",
				shipType: 70,
				destination: "ROTTERDAM",
				lastSeen: t,
				messageType: 5,
			})
		case 2:
			return frame("multimon-ng", "message", {
				protocol: "POCSAG1200",
				address: 1000000 + i,
				function: i % 4,
				messageType: "alpha",
				message: BURST_TEXT.repeat(1 + (i % 6)),
			})
		case 3:
			return frame("dsd-fme", "call_end", {
				protocol: "dmr",
				talkgroup: 2350 + (i % 5),
				source: 2340000 + i,
				slot: 1 + (i % 2),
				duration: 1000 + (i % 20) * 300,
				dmr: { cc: 1 },
				quality: { crcErrs: i % 5, fecErrs: 0 },
				flags: {
					encrypted: i % 7 === 0,
					timeout: false,
					badSignal: false,
					falsePositiveSuppressed: false,
				},
			})
		case 4:
			return frame("direwolf", "aprs", {
				timestamp: t,
				source: `G4ABC-${i % 16}`,
				destination: "APDW16",
				path: ["WIDE1-1", "WIDE2-1"],
				dataType: "Status",
				comment: `burst ${i}`,
				raw: `>burst ${i}`,
			})
		case 5:
			return frame("dumpvdl2", "vdl2", {
				timestamp: t,
				frequency: 136975000,
				icao: "4CA9D2",
				toaddr: "10A0E1",
				fromaddr: "4CA9D2",
				msgType: "acars",
				acars: {
					timestamp: t,
					frequency: 136975000,
					channel: 0,
					level: -21.3,
					error: 0,
					mode: "2",
					label: "H1",
					tail: ".EI-DCL",
					flight: "FR4KT",
					text: `MSG ${i}`,
				},
				level: -21.3,
				noiseFloor: -48.1,
				frameType: "I",
			})
		case 6:
			return frame("rtl433", "signal", {
				time: t.slice(0, 19).replace("T", " "),
				model: "Acurite-Tower",
				id: 12345 + (i % 3),
				channel: "A",
				battery_ok: 1,
				temperature_C: 18 + (i % 5) / 10,
				humidity: 60 + (i % 10),
			})
		default:
			return frame("lora-meshtastic", "meshtastic", {
				from: 305419896 + (i % 4),
				to: 4294967295,
				id: 2882400000 + i,
				channel: 8,
				hopLimit: 3,
				hopStart: 3,
				wantAck: false,
				portnum: 1,
				payloadB64: "aGVsbG8gbWVzaA==",
				payloadLen: 10,
				rxRssi: -92,
				rxSnr: 6.5,
				rxTime: t,
				frequency: 869525000,
				bw: 250000,
				sf: 11,
				cr: 5,
			})
	}
}

// ---------- server ----------

export interface MockServerOptions {
	port: number
	scenario: string
	/** restHistory step interval (default 5000 ms, the CLI's poll cadence). */
	historyStepMs?: number
	/** Restart interval of a crash-looping decoder once its history has played (default 30000 ms). */
	crashEveryMs?: number
}

export async function startMockServer(
	opts: MockServerOptions,
): Promise<{ port: number; close(): Promise<void> }> {
	if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535)
		throw new Error(`invalid port ${String(opts.port)}`)
	const historyStepMs = opts.historyStepMs ?? 5000
	const crashEveryMs = opts.crashEveryMs ?? 30_000
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
	/** The scenario's recorded frames for `channels`, oldest first; fanout and metrics are generated live. */
	const replayTo = (ws: WebSocket, channels: readonly string[]): void => {
		const frames = list(st.sc["ws"])
			.filter(isObj)
			.filter(
				f =>
					f["type"] !== "fanout:snapshot" &&
					f["type"] !== "metrics" &&
					channels.includes(String(f["channel"])),
			)
			.sort((a, b) => Number(a["offsetMs"]) - Number(b["offsetMs"]))
		// Status frames carry the live state for their id, so an animated history cannot be contradicted.
		const current = (f: Obj): unknown => {
			const id = isObj(f["data"]) ? f["data"]["id"] : undefined
			if (f["type"] === "decoder:status")
				return decodersNow(st).find(d => d["id"] === id) ?? f["data"]
			if (f["type"] === "source:status")
				return sourcesNow(st).find(s => s["id"] === id) ?? f["data"]
			return f["data"]
		}
		for (const f of frames)
			sendTo(ws, String(f["channel"]), String(f["type"]), current(f))
	}
	const canned = (key: string): Obj | undefined => {
		const actions = isObj(st.sc["actions"]) ? st.sc["actions"] : {}
		const a = actions[key]
		return isObj(a) ? a : undefined
	}
	const restartDecoder = (id: string): void => {
		const d = st.decoders.find(x => x["id"] === id)
		if (!d) return
		d["restartCount"] = Number(d["restartCount"] ?? 0) + 1
		if (isObj(d["lastError"]))
			d["lastError"] = { ...d["lastError"], at: new Date().toISOString() }
		decoderStatus(id)
	}

	function stepTimeline(): void {
		const tl = st.timeline
		if (!tl) return
		if (tl.idx < tl.steps.length - 1) {
			tl.idx++
			const step = tl.steps[tl.idx] ?? {}
			const before = new Map(
				st.decoders.map(d => [String(d["id"]), Number(d["restartCount"] ?? 0)]),
			)
			st.decoders = mergeById(st.decoders, step) as Obj[]
			for (const id of Object.keys(step)) {
				const d = st.decoders.find(x => x["id"] === id)
				const prevRestarts = before.get(id) ?? 0
				if (
					d &&
					Number(d["restartCount"] ?? 0) > prevRestarts &&
					isObj(d["lastError"])
				)
					d["lastError"] = { ...d["lastError"], at: new Date().toISOString() }
				decoderStatus(id)
			}
			tl.nextCrashAt = Date.now() + crashEveryMs
			return
		}
		if (tl.crashIds.length > 0 && Date.now() >= tl.nextCrashAt) {
			for (const id of tl.crashIds) restartDecoder(id)
			tl.nextCrashAt = Date.now() + crashEveryMs
		}
	}

	function loadScenario(name: string): void {
		const next = loadState(name, st)
		if (st.burst) clearInterval(st.burst)
		st = next
		if (st.ws !== "up") dropClients()
		if (st.rest === "ok") releaseHanging()
		// Connected clients get the new scenario's frames, as if core had just sent them.
		for (const [ws, chans] of clients) replayTo(ws, [...chans])
		sourceSnapshot()
	}

	function setSourceState(state: SourceState): void {
		tick(st)
		const nowIso = new Date().toISOString()
		for (const s of st.sources) {
			const id = String(s["id"])
			const wasConnected = s["connected"] === true
			const a = s["activity"]
			if (isObj(a)) {
				if (a["state"] === "streaming" && state !== "streaming")
					a["lastSampleAt"] = nowIso
				a["state"] = state
				if (state === "waiting") {
					a["lastSampleAt"] = null
					a["sampleAgeMs"] = null
				}
			}
			s["connected"] = state !== "disconnected"
			s["dataRate"] = state === "streaming" ? (st.baseRates.get(id) ?? 0) : 0
			if (wasConnected && state === "disconnected") {
				s["reconnectAttempts"] = Number(s["reconnectAttempts"] ?? 0) + 1
				s["lastError"] = `connect ECONNREFUSED ${String(s["url"] ?? id)}`
				broadcast("sources", "source:disconnected", {
					sourceId: id,
					error: s["lastError"],
				})
			}
			if (!wasConnected && state !== "disconnected") {
				s["reconnectAttempts"] = 0
				delete s["lastError"]
				broadcast("sources", "source:connected", { sourceId: id })
			}
		}
		sourceSnapshot()
	}

	function handleControl(path: string, b: Obj, res: ServerResponse): void {
		if (path === "/__mock/calls") return send(res, 200, st.calls)
		if (path === "/__mock/reset") {
			st.calls = []
			return send(res, 200, { calls: 0 })
		}
		if (path === "/__mock/scenario") {
			const name = b["name"]
			if (typeof name !== "string" || !scenarioNames().includes(name))
				return badRequest(
					res,
					`unknown scenario ${JSON.stringify(name)}; known: ${scenarioNames().join(", ")}`,
				)
			loadScenario(name)
			return send(res, 200, { scenario: st.name, rest: st.rest, ws: st.ws })
		}
		if (path === "/__mock/rest") {
			if (!isOneOf(REST_MODES, b["mode"]))
				return badRequest(res, `mode must be one of ${REST_MODES.join("|")}`)
			st.rest = b["mode"]
			if (st.rest !== "hang") releaseHanging()
			return send(res, 200, { rest: st.rest })
		}
		if (path === "/__mock/ws") {
			if (!isOneOf(WS_MODES, b["mode"]))
				return badRequest(res, `mode must be one of ${WS_MODES.join("|")}`)
			st.ws = b["mode"]
			// A real core never replays history to a reconnecting client.
			if (st.ws !== "up") st.replay = false
			if (st.ws === "drop") dropClients()
			return send(res, 200, { ws: st.ws })
		}
		if (path === "/__mock/fanout") {
			const pct = b["dropPercent"]
			if (
				pct !== null &&
				pct !== undefined &&
				!(typeof pct === "number" && pct >= 0 && pct <= 100)
			)
				return badRequest(res, "dropPercent must be 0-100 or null")
			tick(st)
			st.dropPercent = typeof pct === "number" ? pct : null
			return send(res, 200, { dropPercent: st.dropPercent })
		}
		if (path === "/__mock/source") {
			if (!isOneOf(SOURCE_STATES, b["state"]))
				return badRequest(
					res,
					`state must be one of ${SOURCE_STATES.join("|")}`,
				)
			setSourceState(b["state"])
			return send(res, 200, { state: b["state"] })
		}
		if (path === "/__mock/burst") {
			const perSecond = b["perSecond"] ?? 50
			const seconds = b["seconds"] ?? 60
			if (
				typeof perSecond !== "number" ||
				!(perSecond > 0 && perSecond <= 5000) ||
				typeof seconds !== "number" ||
				!(seconds > 0 && seconds <= 3600)
			)
				return badRequest(res, "perSecond must be 1-5000 and seconds 1-3600")
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
			const id = decodeURIComponent(one[1] ?? "")
			const d = decodersNow(st).find(x => x["id"] === id)
			return d
				? send(res, 200, d)
				: send(res, 404, {
						error: "NotFound",
						code: "DECODER_NOT_FOUND",
						message: `Decoder with id '${id}' not found`,
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
		// An operator start/stop ends a scripted crash loop for that decoder, including
		// the history steps still to come (else restartCount 0 → 11 → 12 → 13).
		if (st.timeline) {
			const tl = st.timeline
			tl.crashIds = tl.crashIds.filter(x => x !== id)
			tl.steps = tl.steps.map((step, i) => {
				if (i <= tl.idx) return step
				const rest = { ...step }
				delete rest[id]
				return rest
			})
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
		t["lastCommandAt"] = new Date().toISOString()
		const rtl = RTL_COMMANDS[setting]
		if (setting === "control-mode") {
			broadcast("tuner", "tuner:control-mode-changed", {
				sourceId,
				mode: value,
			})
		} else if (rtl) {
			t["commandCount"] = Number(t["commandCount"] ?? 0) + 1
			broadcast("tuner", "tuner:command-sent", {
				sourceId,
				command: rtl[0],
				value: rtl[1](value),
			})
		}
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
		// Writes are recorded even when the REST mode then fails them.
		const body = method === "GET" ? undefined : await readBody(req)
		if (method !== "GET")
			st.calls.push({ at: new Date().toISOString(), method, path, body })
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
		handle(req, res).catch((err: unknown) => {
			// A malformed %-escape is the client's fault (Fastify answers FST_ERR_BAD_URL).
			if (err instanceof URIError)
				send(res, 400, {
					statusCode: 400,
					code: "FST_ERR_BAD_URL",
					error: "Bad Request",
					message: `'${req.url ?? ""}' is not a valid url component`,
				})
			else
				send(res, 500, {
					error: "InternalServerError",
					code: "MOCK_INTERNAL",
					message: err instanceof Error ? err.message : String(err),
				})
		})
	})
	const wss = new WebSocketServer({ noServer: true })
	server.on("upgrade", (req, socket, head) => {
		socket.on("error", () => socket.destroy())
		let pathname = ""
		try {
			pathname = new URL(req.url ?? "/", "http://mock").pathname
		} catch {
			// An unparsable request target is refused like any non-/ws upgrade.
		}
		if (pathname !== "/ws") {
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
				if (st.replay) replayTo(ws, fresh)
				if (fresh.includes("sources")) sourceSnapshot()
			})
		})
	})

	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen)
		server.listen(opts.port, "127.0.0.1", () => {
			server.off("error", rejectListen)
			resolveListen()
		})
	})
	const port = (server.address() as AddressInfo).port

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
	const historyTimer = setInterval(
		stepTimeline,
		Math.min(historyStepMs, crashEveryMs),
	)

	return {
		port,
		close: () =>
			new Promise<void>(r => {
				clearInterval(fanoutTimer)
				clearInterval(metricsTimer)
				clearInterval(heartbeatTimer)
				clearInterval(historyTimer)
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
	startMockServer({ port: Number(arg("--port", "9100")), scenario })
		.then(s => {
			process.stdout.write(
				`wavekit mock core on http://127.0.0.1:${s.port} (scenario ${scenario})\n`,
			)
			const stop = (): void => {
				void s.close().then(() => process.exit(0))
			}
			process.on("SIGINT", stop)
			process.on("SIGTERM", stop)
		})
		.catch((err: unknown) => {
			process.stderr.write(
				`wavekit mock core: ${err instanceof Error ? err.message : String(err)}\n`,
			)
			process.exit(1)
		})
}
