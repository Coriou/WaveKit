import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
	SCENARIO_DIR,
	deepMerge,
	loadScenario,
	mergeById,
} from "../../../cli/source/test/scenarios.js"
import { SCENARIO_NAMES } from "../../../cli/source/test/scenario-types.js"
import type { Scenario } from "../../../cli/source/test/scenario-types.js"

type Obj = Record<string, unknown>

function fanoutFrames(sc: Scenario): Obj[] {
	return sc.ws
		.filter(f => f.type === "fanout:snapshot")
		.sort((a, b) => a.offsetMs - b.offsetMs)
		.map(f => f.data as Obj)
}

/** Per decoder branch Δdropped/Δoffered between the first and last WS fanout snapshots, in %. */
function dropNow(sc: Scenario): Record<string, number> {
	const frames = fanoutFrames(sc)
	const first = new Map(
		(frames[0]?.["branches"] as Obj[]).map(b => [b["id"], b]),
	)
	const out: Record<string, number> = {}
	for (const b of frames[frames.length - 1]?.["branches"] as Obj[]) {
		const b0 = first.get(b["id"])
		if (typeof b["decoderId"] !== "string" || !b0) continue
		const dO = Number(b["totalBytesWritten"]) - Number(b0["totalBytesWritten"])
		const dD = Number(b["droppedBytesTotal"]) - Number(b0["droppedBytesTotal"])
		out[b["decoderId"]] = Math.round((dD / dO) * 1000) / 10
	}
	return out
}

describe("scenario loader", () => {
	it("loads and resolves every scenario", () => {
		for (const name of SCENARIO_NAMES) {
			const sc = loadScenario(name)
			expect(sc.name).toBe(name)
			expect(sc.extends).toBeUndefined()
			expect(sc.restPatch).toBeUndefined()
			expect(Array.isArray(sc.ws)).toBe(true)
		}
	})
	it("merges objects, replaces arrays and honours $delete", () => {
		expect(
			deepMerge(
				{ a: 1, b: { c: 2, d: 3 }, e: [1] },
				{ b: { c: 9, d: "$delete" }, e: [2] },
			),
		).toEqual({ a: 1, b: { c: 9 }, e: [2] })
		expect(
			mergeById(
				[
					{ id: "x", v: 1 },
					{ sourceId: "y", v: 1 },
				],
				{ y: { v: 2 } },
			),
		).toEqual([
			{ id: "x", v: 1 },
			{ sourceId: "y", v: 2 },
		])
	})
	it("applies transforms", () => {
		const legacy = loadScenario("legacy")
		const sources = legacy.rest["/api/sources"]?.body as Array<
			Record<string, unknown>
		>
		expect(sources[0]?.["activity"]).toBeUndefined()
		expect(JSON.stringify(legacy)).not.toContain("totalBytesWritten")
		expect(loadScenario("idle").ws.some(f => f.type === "decoder:output")).toBe(
			false,
		)
	})
	it("contains only documentation or loopback addresses and no credentials", () => {
		for (const file of readdirSync(SCENARIO_DIR)) {
			const text = readFileSync(join(SCENARIO_DIR, file), "utf8")
			for (const ip of text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []) {
				expect(
					ip.startsWith("192.0.2.") || ip === "127.0.0.1" || ip === "0.0.0.0",
					`${file}: ${ip}`,
				).toBe(true)
			}
			expect(text).not.toMatch(
				/password|secret|token|apikey|\.local\b|\.lan\b/i,
			)
		}
	})

	it("live: per-branch drop now matches the mockups and the newest WS snapshot equals REST", () => {
		const live = loadScenario("live")
		expect(dropNow(live)).toEqual({
			"dsd-fme": 12,
			"multimon-ng": 14,
			rtl433: 15,
			readsb: 38,
			"ais-catcher": 31,
			dumpvdl2: 40,
			direwolf: 11,
			"lora-meshtastic": 9,
		})
		const frames = fanoutFrames(live)
		expect(frames[frames.length - 1]).toEqual(
			live.rest["/api/telemetry/fanout"]?.body,
		)
		expect(live.ws.some(f => typeof f.data === "string")).toBe(false)
	})
	it("live carries the optional status fields that legacy strips (R15)", () => {
		const optional = [
			"sourceId",
			"idleTimeoutMs",
			"targetFrequenciesHz",
			"lastError",
			"deviceSerial",
		]
		const liveDecoders = loadScenario("live").rest["/api/decoders"]
			?.body as Obj[]
		const acarsdec = liveDecoders.find(d => d["id"] === "acarsdec")
		expect(acarsdec?.["lastError"]).toMatchObject({ kind: "exit" })
		expect(acarsdec?.["targetFrequenciesHz"]).toBeDefined()
		expect(liveDecoders.every(d => d["idleTimeoutMs"] === 30000)).toBe(true)
		const legacy = loadScenario("legacy")
		for (const d of legacy.rest["/api/decoders"]?.body as Obj[])
			for (const k of optional)
				expect(d[k], `${String(d["id"])}.${k}`).toBeUndefined()
		expect(
			legacy.ws.some(
				f => f.type === "source:status" || f.type === "decoder:status",
			),
		).toBe(false)
	})
	it("dropping rewrites every decoder branch to 60 % now and marks it in backpressure", () => {
		const sc = loadScenario("dropping")
		for (const pct of Object.values(dropNow(sc))) expect(pct).toBe(60)
		const rest = sc.rest["/api/telemetry/fanout"]?.body as Obj
		expect(rest["backpressureActiveCount"]).toBe(8)
		const branches = rest["branches"] as Obj[]
		expect(rest["droppedBytesTotal"]).toBe(
			branches.reduce((s, b) => s + Number(b["droppedBytesTotal"]), 0),
		)
	})
	it("burst retunes to 1090 MHz with no drops now and keeps only its own outputs", () => {
		const sc = loadScenario("burst")
		expect((sc.rest["/api/tuner"]?.body as Obj[])[0]?.["frequency"]).toBe(
			1090000000,
		)
		expect(
			((sc.rest["/api/sources"]?.body as Obj[])[0]?.["caps"] as Obj)[
				"centerFreq"
			],
		).toBe(1090000000)
		for (const pct of Object.values(dropNow(sc))) expect(pct).toBe(0)
		const outputs = sc.ws
			.filter(f => f.type === "decoder:output")
			.map(f => (f.data as Obj)["decoderId"])
		expect(new Set(outputs)).toEqual(new Set(["readsb", "ais-catcher"]))
	})
	it("crash-loop keeps live's REST and replaces its history", () => {
		const sc = loadScenario("crash-loop")
		expect(sc.restHistory?.map(h => h.offsetMs)).toEqual([
			-240000, -120000, -60000,
		])
		expect(sc.conn).toEqual(loadScenario("live").conn)
	})
})
