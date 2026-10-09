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

function stateWith(rows: DecoderRow[]) {
	const s = scenarioState("live")
	return { ...s, now: NOW, decoders: laneOk(rows, NOW - 1000, "rest") }
}
const processVariants = (r: DecoderRow) => {
	const st = stateWith([r])
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
		expect(detail(row({ health: "unknown" }))).toContain("server health ?")
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
