import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { Scenario, ScenarioFrame, ScenarioName } from "./scenario-types.js"

/** Scenario JSON lives outside source/ (read with fs, never imported, so rootDir stays ./source). */
export const SCENARIO_DIR = fileURLToPath(
	new URL("../../tools/mock-api/scenarios/", import.meta.url),
)
export const DELETE = "$delete"
const FANOUT_REST = "$fanoutRest"
const SOURCE_STATUS = "$sourceStatus:"
const DECODER_STATUS = "$decoderStatus:"

/** DecoderStatus fields an older core does not send (CLI-COORDINATION requests 1-4). */
const NEW_DECODER_FIELDS = [
	"sourceId",
	"deviceSerial",
	"targetFrequenciesHz",
	"lastError",
	"idleTimeoutMs",
]
/** WS events an older core does not send. */
const NEW_EVENTS = new Set(["source:status", "decoder:status"])

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj =>
	typeof v === "object" && v !== null && !Array.isArray(v)
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

export function deepMerge(base: unknown, patch: unknown): unknown {
	if (!isObj(base) || !isObj(patch)) return patch
	const out: Obj = { ...base }
	for (const [k, v] of Object.entries(patch)) {
		if (v === DELETE) delete out[k]
		else out[k] = deepMerge(base[k], v)
	}
	return out
}

export function mergeById(
	body: unknown,
	merge: Record<string, unknown>,
): unknown {
	if (!Array.isArray(body)) return deepMerge(body, merge)
	return body.map((item: unknown) => {
		if (!isObj(item)) return item
		const key = typeof item["id"] === "string" ? item["id"] : item["sourceId"]
		return typeof key === "string" && merge[key] !== undefined
			? deepMerge(item, merge[key])
			: item
	})
}

function readRaw(name: string): Obj {
	const raw: unknown = JSON.parse(
		readFileSync(`${SCENARIO_DIR}${name}.json`, "utf8"),
	)
	if (!isObj(raw)) throw new Error(`scenario ${name} is not an object`)
	return raw
}

function restBody(sc: Obj, path: string): unknown {
	const rest = isObj(sc["rest"]) ? sc["rest"] : {}
	const r = rest[path]
	return isObj(r) ? r["body"] : undefined
}

function fanoutBodies(sc: Obj): Obj[] {
	const out: Obj[] = []
	const body = restBody(sc, "/api/telemetry/fanout")
	if (isObj(body)) out.push(body)
	for (const fr of list(sc["ws"])) {
		if (isObj(fr) && fr["type"] === "fanout:snapshot" && isObj(fr["data"]))
			out.push(fr["data"])
	}
	return out
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
	for (const body of fanoutBodies(sc)) {
		delete body["totalBytesWritten"]
		for (const b of list(body["branches"]))
			if (isObj(b)) delete b["totalBytesWritten"]
	}
}

/** Rewrite decoder branches so Δdropped = pct % of Δoffered relative to the oldest WS fanout snapshot. */
function applyDropPercent(sc: Obj, pct: number): void {
	const frames = list(sc["ws"])
		.filter(
			(f): f is Obj =>
				isObj(f) && f["type"] === "fanout:snapshot" && isObj(f["data"]),
		)
		.sort((a, b) => Number(a["offsetMs"]) - Number(b["offsetMs"]))
	const first = frames[0]?.["data"]
	if (!isObj(first)) return
	const base = new Map<string, { offered: number; dropped: number }>()
	for (const b of list(first["branches"])) {
		if (isObj(b) && typeof b["id"] === "string") {
			base.set(b["id"], {
				offered: Number(b["totalBytesWritten"] ?? 0),
				dropped: Number(b["droppedBytesTotal"] ?? 0),
			})
		}
	}
	for (const body of fanoutBodies(sc)) {
		let total = 0
		let active = 0
		for (const b of list(body["branches"])) {
			if (!isObj(b) || typeof b["id"] !== "string") continue
			const b0 = base.get(b["id"])
			if (b0 && b["decoderId"] !== undefined) {
				b["droppedBytesTotal"] =
					b0.dropped +
					Math.round(
						(pct / 100) * (Number(b["totalBytesWritten"] ?? 0) - b0.offered),
					)
				b["backpressureActive"] = pct > 0
				if (pct <= 0) delete b["backpressureSince"]
			}
			if (b["backpressureActive"] === true) active++
			total += Number(b["droppedBytesTotal"] ?? 0)
		}
		body["droppedBytesTotal"] = total
		body["backpressureActiveCount"] = active
	}
}

/**
 * Frame-data macros, expanded once at the top level so a child's restPatch reaches the copies:
 * "$fanoutRest" is the REST fanout body, "$sourceStatus:<id>" and "$decoderStatus:<id>" are the
 * REST /api/sources and /api/decoders items with that id (the source:status/decoder:status payloads).
 */
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

/** No IQ arrives: every fanout snapshot and metrics frame carries the REST counters, so nothing moves. */
function applyStallIq(sc: Obj): void {
	const rest = restBody(sc, "/api/telemetry/fanout")
	if (!isObj(rest)) return
	const byId = new Map<string, Obj>()
	for (const b of list(rest["branches"]))
		if (isObj(b)) byId.set(String(b["id"]), b)
	for (const b of byId.values()) {
		b["backpressureActive"] = false
		delete b["backpressureSince"]
	}
	rest["backpressureActiveCount"] = 0
	for (const fr of list(sc["ws"])) {
		const data = isObj(fr) ? fr["data"] : undefined
		if (!isObj(fr) || !isObj(data)) continue
		if (fr["type"] === "fanout:snapshot") {
			for (const k of [
				"totalBytesWritten",
				"droppedBytesTotal",
				"droppedChunksTotal",
				"backpressureActiveCount",
			]) {
				if (rest[k] !== undefined) data[k] = rest[k]
			}
			data["branches"] = list(data["branches"]).map(b =>
				isObj(b) && byId.has(String(b["id"]))
					? structuredClone(byId.get(String(b["id"])))
					: b,
			)
		}
		if (fr["type"] === "metrics") {
			const src = list(restBody(sc, "/api/sources")).find(
				x => isObj(x) && x["id"] === data["sourceId"],
			)
			if (isObj(src))
				fr["data"] = {
					...data,
					bytesReceived: src["bytesReceived"],
					dataRate: 0,
				}
		}
	}
}

interface Composed {
	sc: Obj
	transforms: Obj[]
}

/** extends, restPatch, noOutputs (inherited outputs only) and wsAppend, level by level; transforms are collected. */
function compose(name: string): Composed {
	const own = readRaw(name)
	const parentName = own["extends"]
	const parent = typeof parentName === "string" ? compose(parentName) : null
	const sc = structuredClone(
		parent ? (deepMerge(parent.sc, { ...own, extends: DELETE }) as Obj) : own,
	)
	const patch = isObj(own["restPatch"]) ? own["restPatch"] : {}
	const rest = isObj(sc["rest"]) ? sc["rest"] : {}
	for (const [path, merge] of Object.entries(patch)) {
		const r = rest[path]
		if (isObj(r) && isObj(merge)) r["body"] = mergeById(r["body"], merge)
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
	return { sc, transforms: [...(parent?.transforms ?? []), t] }
}

function resolve(name: string): Obj {
	const { sc, transforms } = compose(name)
	expandMacros(sc)
	const last = <T>(pick: (t: Obj) => T | undefined): T | undefined =>
		transforms.reduce<T | undefined>((acc, t) => pick(t) ?? acc, undefined)
	const pct = last(t =>
		typeof t["dropPercent"] === "number" ? t["dropPercent"] : undefined,
	)
	if (last(t => (t["stallIq"] === true ? true : undefined))) applyStallIq(sc)
	else if (pct !== undefined) applyDropPercent(sc, pct)
	if (last(t => (t["legacy"] === true ? true : undefined))) applyLegacy(sc)
	sc["name"] = name
	return sc
}

/**
 * Scenarios beyond SCENARIO_NAMES (spec §9 copy rows): IQ stale, IQ disconnected, a faulted decoder.
 * Proposed for SCENARIO_NAMES; until then they load by name here and in the mock core.
 */
export const EXTRA_SCENARIO_NAMES = [
	"iq-stale",
	"iq-disconnected",
	"decoder-faulted",
] as const
export type ExtraScenarioName = (typeof EXTRA_SCENARIO_NAMES)[number]

/** Fully resolved scenario (extends, restPatch, wsAppend, macros and transforms applied). */
export function loadScenario(name: ScenarioName | ExtraScenarioName): Scenario {
	return resolve(name) as unknown as Scenario
}

export type { ScenarioFrame }
