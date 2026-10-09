import { beforeAll, describe, expect, it } from "vitest"
import { laneOk } from "../../../cli/source/data/freshness.js"
import {
	isFailing,
	procRole,
	processState,
} from "../../../cli/source/data/decoder-state.js"
import type { DecoderRow } from "../../../cli/source/data/types.js"
import { scenarioState } from "../../../cli/source/test/fixtures.js"
import { findBanned } from "../../../cli/source/ui/copy-rules.js"
import { lineText } from "../../../cli/source/ui/text.js"
import {
	decoderCells,
	decoderFacts,
} from "../../../cli/source/view-models/decoder-rows.js"
import { decoderDetail } from "../../../cli/source/view-models/decoders.js"
import { receiverLines } from "../../../cli/source/view-models/receiver.js"
import { initialUi } from "../../../cli/source/ui/ui-state.js"

beforeAll(() => {
	process.env["TZ"] = "UTC"
})

const NOW = Date.parse("2026-10-08T18:07:52Z")
const row = (over: Partial<DecoderRow> = {}): DecoderRow => ({
	id: "acarsdec",
	type: "acarsdec",
	running: true,
	health: "running",
	uptime: 51,
	stats: { bytesIn: 1, eventsOut: 3, errors: 0 },
	restartCount: 0,
	...over,
})
const iso = (ms: number) => new Date(ms).toISOString()

describe("R70 processState", () => {
	it("uses core's restarting health, with the inference kept for older cores", () => {
		expect(
			processState(
				row({
					running: false,
					health: "restarting",
					restartCount: 3,
					desiredRunning: true,
				}),
				0,
				false,
				NOW,
			),
		).toBe("restarting")
		// Older core (no desiredRunning): inferred from restartCount.
		expect(
			processState(
				row({ running: false, health: "running", restartCount: 3 }),
				0,
				false,
				NOW,
			),
		).toBe("restarting")
		// New core: an explicitly stopped restarting decoder reports running + running:false.
		expect(
			processState(
				row({
					running: false,
					health: "running",
					restartCount: 3,
					desiredRunning: false,
				}),
				0,
				false,
				NOW,
			),
		).toBe("stopped")
		expect(
			processState(
				row({
					running: false,
					health: "running",
					restartCount: 3,
					desiredRunning: true,
				}),
				0,
				false,
				NOW,
			),
		).toBe("down")
	})
	it("separates terminal faults from retrying ones", () => {
		expect(
			processState(
				row({ running: false, health: "faulted", restartCount: 13 }),
				0,
				false,
				NOW,
			),
		).toBe("faulted")
		expect(
			processState(
				row({
					running: false,
					health: "faulted",
					restartCount: 13,
					nextRestartAt: iso(NOW + 30_000),
				}),
				0,
				false,
				NOW,
			),
		).toBe("faulted-retry")
		expect(
			processState(
				row({ running: true, health: "faulted", restartCount: 13 }),
				0,
				false,
				NOW,
			),
		).toBe("faulted-retrying")
		expect(procRole("faulted")).toBe("fault")
		expect(procRole("faulted-retry")).toBe("fault")
		expect(procRole("faulted-retrying")).toBe("attention")
		expect(isFailing("faulted-retrying")).toBe(false)
	})
	it("renders suspended ahead of health; a long suspending transition is attention", () => {
		const susp = {
			suspended: true,
			desiredRunning: true,
			suspension: {
				reasonCode: "insufficient-sample-rate",
				since: iso(NOW - 60_000),
			},
		}
		expect(
			processState(
				row({ running: false, health: "faulted", ...susp }),
				0,
				false,
				NOW,
			),
		).toBe("suspended")
		expect(procRole("suspended")).toBe("neutral")
		expect(
			processState(
				row({ running: true, ...susp, transition: "suspending" }),
				0,
				false,
				NOW,
				NOW - 60_000,
			),
		).toBe("suspend-pending")
		expect(procRole("suspend-pending")).toBe("attention")
		const fresh = {
			...susp,
			suspension: { ...susp.suspension, since: iso(NOW - 2_000) },
		}
		expect(
			processState(
				row({ running: true, ...fresh, transition: "suspending" }),
				0,
				false,
				NOW,
				NOW - 2_000,
			),
		).toBe("suspended")
	})
	it("an unknown health is never up", () => {
		expect(processState(row({ health: "unknown" }), 0, false, NOW)).toBe(
			"unknown",
		)
		expect(procRole("unknown")).toBe("unknown")
		expect(
			processState(row({ health: "unknown", running: false }), 0, false, NOW),
		).toBe("unknown")
		expect(
			processState(row({ health: "unknown", running: false }), 0, true, NOW),
		).toBe("stopped")
	})
})

/** `suspendingSince`: local first sight of "suspending" for every row (M-b). */
function stateWith(rows: DecoderRow[], suspendingSince?: number) {
	const s = scenarioState("live")
	const session =
		suspendingSince === undefined
			? s.session
			: Object.fromEntries(
					rows.map(r => [r.id, { ...s.session["dsd-fme"]!, suspendingSince }]),
				)
	return { ...s, now: NOW, decoders: laneOk(rows, NOW - 1000, "rest"), session }
}
const processVariants = (r: DecoderRow) => {
	const st = stateWith(
		[r],
		r.transition === "suspending" ? NOW - 60_000 : undefined,
	)
	const f = decoderFacts(st)[0]!
	return (decoderCells(f, st.now)["process"]?.variants ?? []).map(lineText)
}

describe("R70 process cells", () => {
	it("restarting counts down to nextRestartAt", () => {
		const v = processVariants(
			row({
				running: false,
				health: "restarting",
				restartCount: 13,
				desiredRunning: true,
				nextRestartAt: iso(NOW + 12_000),
			}),
		)
		expect(v).toEqual([
			"restarting",
			"restarting in 12s",
			"restarting in 12s · 13 restarts",
		])
	})
	it("faulted terminal, retrying later, and retrying now", () => {
		expect(
			processVariants(
				row({ running: false, health: "faulted", restartCount: 13 }),
			).at(-1),
		).toBe("faulted · 13 restarts")
		expect(
			processVariants(
				row({
					running: false,
					health: "faulted",
					restartCount: 13,
					nextRestartAt: iso(NOW + 30_000),
				}),
			),
		).toContain("faulted · retry in 30s")
		expect(
			processVariants(
				row({ running: true, health: "faulted", restartCount: 13 }),
			),
		).toContain("faulted · retrying")
	})
	it("final review MUST 4: a retrying fault never reads like the terminal one", () => {
		const retry = processVariants(
			row({
				running: false,
				health: "faulted",
				restartCount: 13,
				nextRestartAt: iso(NOW + 12_000),
			}),
		)
		expect(retry.slice(0, 3)).toEqual([
			"retry",
			"faulted · retry",
			"faulted · retry in 12s",
		])
		expect(
			processVariants(
				row({ running: true, health: "faulted", restartCount: 13 }),
			)[0],
		).toBe("retrying")
		expect(
			processVariants(
				row({ running: false, health: "faulted", restartCount: 13 }),
			)[0],
		).toBe("faulted")
	})
	it("suspended and a pending suspension", () => {
		const susp = {
			suspended: true,
			desiredRunning: true,
			suspension: {
				reasonCode: "insufficient-sample-rate",
				since: iso(NOW - 60_000),
			},
		}
		expect(processVariants(row({ running: false, ...susp }))).toEqual([
			"suspended",
			"suspended · rate",
		])
		expect(
			processVariants(
				row({ running: true, ...susp, transition: "suspending" }),
			),
		).toEqual(["suspending", "suspending (stop pending)"])
	})
	it("unknown health reads ?", () => {
		expect(processVariants(row({ health: "unknown" }))).toEqual(["?"])
	})
	it("never uses banned copy", () => {
		for (const r of [
			row({
				running: false,
				health: "restarting",
				restartCount: 2,
				desiredRunning: true,
				nextRestartAt: iso(NOW + 5000),
			}),
			row({ running: true, health: "faulted", restartCount: 9 }),
			row({
				running: false,
				suspended: true,
				suspension: { reasonCode: "x", since: iso(NOW) },
			}),
		])
			for (const t of processVariants(r)) expect(findBanned(t)).toEqual([])
	})
})

describe("R70 decoder detail", () => {
	const detail = (r: DecoderRow) => {
		const st = stateWith([r])
		return decoderDetail(st, decoderFacts(st)[0]!, 100, st.now)
			.map(lineText)
			.join("\n")
	}
	it("explains a suspension in plain words, with the time it began", () => {
		const text = detail(
			row({
				running: false,
				suspended: true,
				desiredRunning: true,
				suspension: {
					reasonCode: "insufficient-sample-rate",
					since: "2026-10-08T18:00:00.000Z",
				},
			}),
		)
		expect(text).toMatch(/suspended since 18:00:00 · sample rate too low/)
	})
	it("quotes an unknown reason code", () => {
		const text = detail(
			row({
				running: false,
				suspended: true,
				suspension: {
					reasonCode: "solar-flare",
					since: "2026-10-08T18:00:00.000Z",
				},
			}),
		)
		expect(text).toContain('suspended since 18:00:00 · "solar-flare"')
	})
	it("shows ? for an unknown server health", () => {
		expect(detail(row({ health: "unknown" }))).toContain("health ?")
	})
})

describe("R70 source reservation in the Receiver", () => {
	const recv = (st: ReturnType<typeof scenarioState>) =>
		receiverLines(st, initialUi("receiver"), 119, 35, true)
			.map(lineText)
			.join("\n")
	it("names the suspended decoder that holds the source", () => {
		const s = scenarioState("live")
		const src = s.sources.value![0]!
		const rows = s.decoders.value!.map(d =>
			d.id === "dsd-fme"
				? {
						...d,
						running: false,
						suspended: true,
						desiredRunning: true,
						sourceId: src.id,
						suspension: {
							reasonCode: "insufficient-sample-rate",
							since: iso(s.now - 60_000),
						},
					}
				: d,
		)
		const st = { ...s, decoders: { ...s.decoders, value: rows } }
		expect(recv(st)).toContain("held by suspended dsd-fme")
		expect(recv(s)).not.toContain("held by suspended")
	})
})

describe("R70 readsb with its own rtl_tcp (caps.input external)", () => {
	it("has no window (—), not in or out", () => {
		const s = scenarioState("live")
		const rows = s.decoders.value!.map(d => {
			if (d.id !== "readsb") return d
			const { sourceId: _s, ...rest } = d
			return {
				...rest,
				caps: {
					input: "external" as const,
					output: "beast" as const,
					integrationPattern: "network_producer" as const,
				},
			}
		})
		const sources = s.sources.value!.map(x => ({
			...x,
			assignments: x.assignments.filter(a => a.decoderId !== "readsb"),
		}))
		const st = {
			...s,
			decoders: { ...s.decoders, value: rows },
			sources: { ...s.sources, value: sources },
		}
		const f = decoderFacts(st).find(x => x.row.id === "readsb")!
		expect(f.membership).toBe("—")
		expect(
			(decoderCells(f, st.now)["window"]?.variants ?? []).map(lineText),
		).toEqual(["—"])
	})
})

describe("A8 fix 1: I-A detail lines and M-a/M-c/M-d countdowns", () => {
	const detailOf = (st: ReturnType<typeof stateWith>) =>
		decoderDetail(st, decoderFacts(st)[0]!, 100, st.now)
			.map(lineText)
			.join("\n")
	it("I-A: the detail distinguishes each process state", () => {
		const cases: Array<[Partial<DecoderRow>, RegExp]> = [
			[
				{ running: false, health: "faulted", restartCount: 13 },
				/process +faulted · 13 restarts/,
			],
			[
				{
					running: false,
					health: "faulted",
					restartCount: 13,
					nextRestartAt: iso(NOW + 30_000),
				},
				/process +faulted · retry in 30s · 13 restarts/,
			],
			[
				{ running: true, health: "faulted", restartCount: 13 },
				/process +faulted · retrying · 13 restarts/,
			],
			[
				{
					running: false,
					health: "restarting",
					restartCount: 13,
					desiredRunning: true,
					nextRestartAt: iso(NOW + 12_000),
				},
				/process +restarting in 12s · 13 restarts/,
			],
			[
				{
					running: true,
					suspended: true,
					transition: "suspending",
					suspension: {
						reasonCode: "insufficient-sample-rate",
						since: iso(NOW - 60_000),
					},
				},
				/process +suspending \(stop pending\)/,
			],
		]
		for (const [over, re] of cases)
			expect(
				detailOf(
					stateWith(
						[row(over)],
						over.transition === "suspending" ? NOW - 60_000 : undefined,
					),
				),
			).toMatch(re)
	})
	it("M-a: countdowns use the server clock, not the local one", () => {
		const SERVER = NOW - 3_600_000
		const st = stateWith([
			row({
				running: false,
				health: "restarting",
				restartCount: 2,
				desiredRunning: true,
				nextRestartAt: iso(SERVER + 12_000),
			}),
		])
		const snap = { ...st.fanout.value!, timestamp: iso(SERVER) }
		// One server, one clock: both server-timestamped lanes are an hour behind.
		const res = { ...st.resources.value!, timestamp: iso(SERVER) }
		const skewed = {
			...st,
			fanout: laneOk(snap, NOW, "ws"),
			resources: laneOk(res, NOW, "ws"),
		}
		const f = decoderFacts(skewed)[0]!
		expect(
			(decoderCells(f, skewed.now)["process"]?.variants ?? []).map(lineText),
		).toContain("restarting in 12s")
	})
	it("M-a: without a server clock there is no countdown", () => {
		const st = stateWith([
			row({
				running: false,
				health: "restarting",
				restartCount: 2,
				desiredRunning: true,
				nextRestartAt: iso(NOW + 12_000),
			}),
		])
		const noClock = {
			...st,
			fanout: { ...st.fanout, value: undefined },
			resources: { ...st.resources, value: undefined },
		}
		const f = decoderFacts(noClock)[0]!
		expect(
			(decoderCells(f, noClock.now)["process"]?.variants ?? []).map(lineText),
		).toEqual(["restarting", "restarting ×2", "restarting · 2 restarts"])
	})
	it("M-c: a passed nextRestartAt reads plain restarting", () => {
		const v = processVariants(
			row({
				running: false,
				health: "restarting",
				restartCount: 2,
				desiredRunning: true,
				nextRestartAt: iso(NOW - 5_000),
			}),
		)
		expect(v.join(" ")).not.toMatch(/in <1s|in \d/)
		expect(v[0]).toBe("restarting")
	})
	it("M-d: faulted with an unparseable retry time reads retry pending", () => {
		const v = processVariants(
			row({
				running: false,
				health: "faulted",
				restartCount: 3,
				nextRestartAt: "soon",
			}),
		)
		expect(v).toContain("faulted · retry pending")
	})
})

describe("A8 fix 1: M-b suspend-pending timed from first sight", () => {
	it("a long-standing suspension that only now shows suspending is not pending yet", () => {
		const old = {
			suspended: true,
			transition: "suspending" as const,
			suspension: { reasonCode: "x", since: iso(NOW - 3_600_000) },
		}
		expect(
			processState(row({ running: true, ...old }), 0, false, NOW, NOW - 1_000),
		).toBe("suspended")
		expect(
			processState(row({ running: true, ...old }), 0, false, NOW, NOW - 11_000),
		).toBe("suspend-pending")
		expect(processState(row({ running: true, ...old }), 0, false, NOW)).toBe(
			"suspended",
		)
	})
	it("the reducer records when it first saw suspending and clears it after", async () => {
		const { initialState, reduce } =
			await import("../../../cli/source/data/reducers.js")
		const T = NOW
		const rest = (at: number, transition?: "suspending") => ({
			kind: "rest" as const,
			endpoint: "decoders" as const,
			at,
			outcome: {
				ok: true as const,
				rejected: 0,
				value: [
					row({
						running: true,
						suspended: true,
						...(transition ? { transition } : {}),
					}),
				],
			},
		})
		let st = reduce(initialState(T), [rest(T, "suspending")], T)
		expect(st.session["acarsdec"]?.suspendingSince).toBe(T)
		st = reduce(st, [rest(T + 5_000, "suspending")], T + 5_000)
		expect(st.session["acarsdec"]?.suspendingSince).toBe(T)
		st = reduce(st, [rest(T + 12_000, "suspending")], T + 12_000)
		expect(decoderFacts(st)[0]?.proc).toBe("suspend-pending")
		st = reduce(st, [rest(T + 15_000)], T + 15_000)
		expect(st.session["acarsdec"]?.suspendingSince).toBeUndefined()
	})
})
