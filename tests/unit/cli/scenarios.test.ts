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

/** Like dropNow, but a branch with Δoffered ≤ 0 is unknown (null), as spec §10.6 says. */
function dropNowOrNull(sc: Scenario): Record<string, number | null> {
	const frames = fanoutFrames(sc)
	const first = new Map(
		(frames[0]?.["branches"] as Obj[]).map(b => [b["id"], b]),
	)
	const out: Record<string, number | null> = {}
	for (const b of frames[frames.length - 1]?.["branches"] as Obj[]) {
		const b0 = first.get(b["id"])
		if (typeof b["decoderId"] !== "string" || !b0) continue
		const dO = Number(b["totalBytesWritten"]) - Number(b0["totalBytesWritten"])
		out[b["decoderId"]] =
			dO > 0
				? (Number(b["droppedBytesTotal"]) - Number(b0["droppedBytesTotal"])) /
					dO
				: null
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
			// Control characters are committed only as JSON escapes (\u001b, \u009b), never raw.
			expect(text, file).not.toMatch(
				/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/,
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
		expect(new Set(outputs)).toEqual(
			new Set([
				"readsb",
				"ais-catcher",
				"direwolf",
				"dsd-fme",
				"dumpvdl2",
				"rtl433",
				"lora-meshtastic",
			]),
		)
		const status = sc.ws.find(f => f.type === "source:status")?.data as Obj
		expect((status["caps"] as Obj)["centerFreq"]).toBe(1090000000)
	})
	it("crash-loop keeps live's REST and replaces its history", () => {
		const sc = loadScenario("crash-loop")
		expect(sc.restHistory?.map(h => h.offsetMs)).toEqual([
			-240000, -120000, -60000,
		])
		expect(sc.conn).toEqual(loadScenario("live").conn)
	})

	it("live carries one source:status and one decoder:status equal to their REST items", () => {
		const sc = loadScenario("live")
		const source = sc.ws.filter(f => f.type === "source:status")
		const decoder = sc.ws.filter(f => f.type === "decoder:status")
		expect(source).toHaveLength(1)
		expect(decoder).toHaveLength(1)
		expect(source[0]?.data).toEqual((sc.rest["/api/sources"]?.body as Obj[])[0])
		expect(decoder[0]?.data).toEqual(
			(sc.rest["/api/decoders"]?.body as Obj[]).find(
				d => d["id"] === "acarsdec",
			),
		)
	})
	it("decoder outputs use the core wire shapes (src/decoders/builtin, R33)", () => {
		const TYPES: Record<string, string[]> = {
			"dsd-fme": ["call_start", "call_end"],
			"multimon-ng": ["message", "decode"],
			rtl433: ["signal"],
			readsb: ["aircraft"],
			acarsdec: ["acars"],
			"ais-catcher": ["ship"],
			dumpvdl2: ["vdl2"],
			direwolf: ["aprs"],
			"lora-meshtastic": ["meshtastic"],
		}
		const has = (o: Obj, keys: string[]) => keys.every(k => o[k] !== undefined)
		let checked = 0
		for (const name of SCENARIO_NAMES) {
			for (const f of loadScenario(name).ws) {
				if (f.type !== "decoder:output") continue
				const { decoderId, output } = f.data as {
					decoderId: string
					output: Obj
				}
				const allowed = TYPES[decoderId]
				if (allowed === undefined) continue // long-text's synthetic over-long id
				checked++
				const where = `${name} ${decoderId} ${String(output["type"])}`
				expect(allowed, where).toContain(output["type"])
				expect(output["decoder"], where).toBe(decoderId)
				expect(
					Number.isNaN(Date.parse(String(output["timestamp"]))),
					where,
				).toBe(false)
				const d = output["data"] as Obj
				switch (output["type"]) {
					case "call_start":
					case "call_end":
						expect(has(d, ["protocol", "talkgroup", "source"]), where).toBe(
							true,
						)
						if (output["type"] === "call_end")
							expect(has(d, ["duration", "quality", "flags"]), where).toBe(true)
						break
					case "message":
						expect(String(d["protocol"]), where).toMatch(
							/^(POCSAG\d+|FLEX|EAS)$/,
						)
						if (String(d["protocol"]).startsWith("POCSAG"))
							expect(
								["alpha", "numeric", "tone only", "unknown"],
								where,
							).toContain(d["messageType"])
						break
					case "ship":
						expect(d["mmsi"], where).toMatch(/^\d{9}$/)
						if (d["shipType"] !== undefined)
							expect(typeof d["shipType"], where).toBe("number")
						break
					case "aircraft":
						expect(d["icao"], where).toMatch(/^[0-9A-F]{6}$/)
						expect(has(d, ["lastSeen", "messageCount"]), where).toBe(true)
						break
					case "vdl2":
						expect(d["frequency"] as number, where).toBeGreaterThan(100_000_000)
						break
					case "aprs":
						expect(
							Array.isArray(d["path"]) &&
								has(d, ["source", "destination", "dataType"]),
							where,
						).toBe(true)
						break
					case "signal":
						expect(has(d, ["model"]), where).toBe(true)
						break
					case "meshtastic":
						expect(
							has(d, [
								"from",
								"to",
								"portnum",
								"payloadB64",
								"rxTime",
								"frequency",
								"sf",
							]),
							where,
						).toBe(true)
						break
				}
			}
		}
		expect(checked).toBeGreaterThan(20)
	})
	it("extra scenarios cover stale IQ, a disconnected source and a faulted decoder", () => {
		const stale = loadScenario("iq-stale")
		const src = (stale.rest["/api/sources"]?.body as Obj[])[0] as Obj
		expect((src["activity"] as Obj)["state"]).toBe("stale")
		for (const pct of Object.values(dropNowOrNull(stale)))
			expect(pct).toBeNull()
		const fanout = stale.rest["/api/telemetry/fanout"]?.body as Obj
		expect(fanout["backpressureActiveCount"]).toBe(0)
		const disc = loadScenario("iq-disconnected")
		const dsrc = (disc.rest["/api/sources"]?.body as Obj[])[0] as Obj
		expect(dsrc["connected"]).toBe(false)
		expect((dsrc["activity"] as Obj)["state"]).toBe("disconnected")
		expect(
			(disc.ws.find(f => f.type === "source:status")?.data as Obj)["connected"],
		).toBe(false)
		const faulted = loadScenario("decoder-faulted")
		const acars = (faulted.rest["/api/decoders"]?.body as Obj[]).find(
			d => d["id"] === "acarsdec",
		) as Obj
		expect(acars["health"]).toBe("faulted")
		expect(
			(faulted.ws.find(f => f.type === "decoder:status")?.data as Obj)[
				"health"
			],
		).toBe("faulted")
		for (const name of [
			"iq-stale",
			"iq-disconnected",
			"decoder-faulted",
		] as const)
			expect(readdirSync(SCENARIO_DIR)).toContain(`${name}.json`)
	})
})
