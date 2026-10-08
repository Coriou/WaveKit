import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { Scenario, ScenarioFrame, ScenarioName } from "./scenario-types.js"

/** Scenario JSON lives outside source/ (read with fs, never imported, so rootDir stays ./source). */
export const SCENARIO_DIR = fileURLToPath(
	new URL("../../tools/mock-api/scenarios/", import.meta.url),
)
export const DELETE = "$delete"
const FANOUT_REST = "$fanoutRest"

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

/** A frame whose data is "$fanoutRest" carries a copy of the REST fanout body, so the two cannot drift. */
function expandMacros(sc: Obj): void {
	const body = restBody(sc, "/api/telemetry/fanout")
	sc["ws"] = list(sc["ws"]).map((fr: unknown) =>
		isObj(fr) && fr["data"] === FANOUT_REST
			? { ...fr, data: structuredClone(body) }
			: fr,
	)
}

function resolve(name: string): Obj {
	const own = readRaw(name)
	const parentName = own["extends"]
	const sc = structuredClone(
		typeof parentName === "string"
			? (deepMerge(resolve(parentName), { ...own, extends: DELETE }) as Obj)
			: own,
	)
	const patch = isObj(own["restPatch"]) ? own["restPatch"] : {}
	const rest = isObj(sc["rest"]) ? sc["rest"] : {}
	for (const [path, merge] of Object.entries(patch)) {
		const r = rest[path]
		if (isObj(r) && isObj(merge)) r["body"] = mergeById(r["body"], merge)
	}
	const t = isObj(own["transform"]) ? own["transform"] : {}
	// noOutputs removes inherited outputs only; frames this scenario appends are kept.
	const inherited = list(sc["ws"])
	const kept =
		t["noOutputs"] === true
			? inherited.filter(f => !(isObj(f) && f["type"] === "decoder:output"))
			: inherited
	sc["ws"] = [...kept, ...list(own["wsAppend"])]
	expandMacros(sc)
	if (typeof t["dropPercent"] === "number")
		applyDropPercent(sc, t["dropPercent"])
	if (t["legacy"] === true) applyLegacy(sc)
	delete sc["restPatch"]
	delete sc["transform"]
	delete sc["wsAppend"]
	delete sc["extends"]
	sc["name"] = name
	return sc
}

/** Fully resolved scenario (extends, restPatch, wsAppend, macros and transforms applied). */
export function loadScenario(name: ScenarioName): Scenario {
	return resolve(name) as unknown as Scenario
}

export type { ScenarioFrame }
