import { describe, expect, it } from "vitest"
import { laneOk } from "../../../cli/source/data/freshness.js"
import { reduce } from "../../../cli/source/data/reducers.js"
import type { AppState } from "../../../cli/source/data/types.js"
import { scenarioState } from "../../../cli/source/test/fixtures.js"
import { SCENARIO_NAMES } from "../../../cli/source/test/scenario-types.js"
import { findBanned } from "../../../cli/source/ui/copy-rules.js"
import { cellWidth, lineText } from "../../../cli/source/ui/text.js"
import { applyEditKey, startEdit } from "../../../cli/source/ui/tuner-edit.js"
import type { EditKey } from "../../../cli/source/ui/actions.js"
import { initialUi } from "../../../cli/source/ui/ui-state.js"
import {
	controlConfirm,
	receiverLines,
	tunerConfirm,
	tunerResultText,
} from "../../../cli/source/view-models/receiver.js"

// Module level: the describe body below renders at collection time, before any beforeAll.
process.env["TZ"] = "UTC"

function internal(s: AppState): AppState {
	const t = s.tuner.value![0]!
	return {
		...s,
		tuner: laneOk([{ ...t, controlMode: "internal" }], s.now - 1000, "rest"),
	}
}

function editAfter(s: AppState, keys: EditKey[]) {
	let edit = startEdit(s.tuner.value![0]!)
	for (const k of keys) edit = applyEditKey(edit, k)
	return edit
}

describe("receiver view-model (spec §6.4)", () => {
	const s = scenarioState("live")
	const text = receiverLines(s, initialUi("receiver"), 119, 35, true).map(
		lineText,
	)
	it("renders SOURCE, TUNER, RELAY, FANOUT and upstream rows", () => {
		expect(text).toContain(
			"SOURCE    pi-iq · rtl_tcp 192.0.2.23:5555   ● connected   ● streaming · sample age 4 ms · timeout 10 s",
		)
		expect(text).toContain(
			"rate      4.1 MB/s (2.048 MS/s U8 IQ)   received 1.2 GB   reconnects 0   last error —   assigned 9 decoders",
		)
		expect(text.find(l => l.startsWith("TUNER"))).toMatch(
			/^TUNER {5}external control · relay client-3 192\.0\.2\.1:59430 · 42 commands · last set-frequency 6m 32s ago$/,
		)
		expect(text).toContain(
			"frequency 445 970 700 Hz   window 444.947–446.995 MHz   sample rate 2 048 000 S/s   ppm 0",
		)
		expect(text).toContain(
			"gain      manual · index 11 (R828D)   rtl agc off   bias-t off   direct sampling off   offset tuning off",
		)
		expect(text).toContain("in window dsd-fme, multimon-ng (tuned)")
		expect(text).toContain(
			"out       rtl433, readsb, acarsdec, ais-catcher, dumpvdl2, direwolf, lora-meshtastic",
		)
		expect(text.find(l => l.startsWith("RELAY"))).toBe(
			"RELAY     listening :4713 · 1 of 4 clients · 545.5 MB sent · exclusive control · last error —",
		)
		expect(
			text.some(l =>
				/^18:01:20 {2}client-3 192\.0\.2\.1:59430 {2}set-frequency +445 970 700$/.test(
					l,
				),
			),
		).toBe(true)
		expect(text.find(l => l.startsWith("FANOUT"))).toBe(
			"FANOUT    decoder branches: 21% of offered IQ dropped now · 4 of 8 in backpressure · 4.1 MB/s offered each",
		)
		expect(text.find(l => l.startsWith("upstream"))).toBe(
			"upstream  Pi rtlmux → core: 3.5 MB dropped lifetime (0.29%) · 0 B/s now · checked 2s ago",
		)
		for (const l of text) {
			expect(cellWidth(l)).toBeLessThanOrEqual(119)
			expect(findBanned(l)).toEqual([])
		}
	})
	it("never exceeds the height and drops relay history first", () => {
		const lines = receiverLines(s, initialUi("receiver"), 79, 18, false)
		expect(lines.length).toBeLessThanOrEqual(18)
		expect(lines.map(lineText).some(l => l.startsWith("FANOUT"))).toBe(true)
	})
	it("stays within width and height, without banned copy, for every scenario and size", () => {
		for (const name of SCENARIO_NAMES) {
			const st = scenarioState(name)
			for (const [w, h] of [
				[59, 13],
				[79, 20],
				[119, 36],
				[199, 46],
			] as const) {
				const lines = receiverLines(
					st,
					initialUi("receiver"),
					w,
					h,
					h > 20,
				).map(lineText)
				expect(lines.length, `${name} ${w}x${h}`).toBeLessThanOrEqual(h)
				for (const l of lines) {
					expect(cellWidth(l), `${name} ${w}: ${l}`).toBeLessThanOrEqual(w)
					expect(findBanned(l), `${name}: ${l}`).toEqual([])
				}
			}
		}
	})
	it("says why drop now is unknown (older core without offered bytes)", () => {
		const legacy = receiverLines(
			scenarioState("legacy"),
			initialUi("receiver"),
			119,
			35,
			true,
		).map(lineText)
		expect(legacy.find(l => l.startsWith("FANOUT"))).toContain(
			"drop now ? · core reports no offered bytes",
		)
		const stale = receiverLines(
			scenarioState("iq-stale"),
			initialUi("receiver"),
			119,
			35,
			true,
		).map(lineText)
		expect(stale.find(l => l.startsWith("FANOUT"))).toContain("drop now ?")
		expect(stale.find(l => l.startsWith("SOURCE"))).toContain("× no samples")
	})
	it("shows a disconnected source with its error quoted", () => {
		const d = receiverLines(
			scenarioState("iq-disconnected"),
			initialUi("receiver"),
			119,
			35,
			true,
		).map(lineText)
		expect(d.find(l => l.startsWith("SOURCE"))).toContain("× disconnected")
		expect(d.find(l => l.startsWith("rate"))).toContain(
			'last error "connect ECONNREFUSED 192.0.2.23:5555"',
		)
	})
	it("renders edit mode with a digit cursor, pending changes and the affected decoders", () => {
		const st = internal(s)
		const edit = editAfter(st, [
			...Array<EditKey>(29).fill("up"),
			"right",
			"up",
			"up",
			"up",
			"tab",
			"tab",
			...Array<EditKey>(207).fill("up"),
		])
		const ui = { ...initialUi("receiver"), edit }
		const lines = receiverLines(st, ui, 119, 35, true).map(lineText)
		expect(lines).toContain(
			"TUNER     EDIT · wavekit control · nothing sent until confirmed",
		)
		expect(lines.find(l => l.startsWith("frequency"))).toMatch(
			/^frequency 446 000 ▏000 Hz {3}window 444\.976–447\.024 MHz/,
		)
		expect(lines).toContain(
			"pending   frequency 445 970 700 → 446 000 000 · gain 0.0 → 20.7 dB",
		)
		expect(lines).toContain(
			"affects   dsd-fme, multimon-ng (tuned) · no decoder enters or leaves the window",
		)
		expect(tunerConfirm(edit)).toMatchObject({
			kind: "tuner",
			prompt:
				"send 2 commands to pi-iq: frequency 446 000 000 Hz (+29.3 kHz), gain 20.7 dB",
			yes: "send",
			no: "back",
			intent: {
				kind: "tuner",
				sourceId: "pi-iq",
				commands: [
					{ setting: "frequency", body: { hz: 446000000 } },
					{ setting: "gain", body: { tenthsDb: 207 } },
				],
			},
		})
	})
	it("names decoders a retune moves into or out of the window", () => {
		const st = internal(s)
		// 100 MHz digit up ×4: 845.97 MHz, where no listed band lies.
		const edit = editAfter(st, [
			"left",
			"left",
			"left",
			"left",
			"left",
			"up",
			"up",
			"up",
			"up",
		])
		const affects = receiverLines(
			st,
			{ ...initialUi("receiver"), edit },
			119,
			35,
			true,
		)
			.map(lineText)
			.find(l => l.startsWith("affects"))
		expect(affects).toBe(
			"affects   dsd-fme, multimon-ng (tuned) · no decoder enters or leaves the window",
		)
		const toLora = editAfter(st, [
			...Array<EditKey>(5).fill("left"),
			"8",
			"6",
			"9",
			"5",
			"2",
			"5",
		])
		const lines = receiverLines(
			st,
			{ ...initialUi("receiver"), edit: toLora },
			119,
			35,
			true,
		).map(lineText)
		expect(lines.find(l => l.startsWith("affects"))).toBe(
			"affects   dsd-fme, multimon-ng (tuned) · lora-meshtastic enters",
		)
	})
	it("holds the review while the frequency is out of range and marks it", () => {
		const st = internal(s)
		const edit = editAfter(st, [...Array<EditKey>(6).fill("left"), "up", "up"])
		const ui = { ...initialUi("receiver"), edit }
		const pending = receiverLines(st, ui, 119, 35, true).find(l =>
			lineText(l).startsWith("pending"),
		)
		expect(lineText(pending ?? [])).toContain(
			"frequency 445 970 700 → 2 445 970 700 (outside 24–1 900 MHz)",
		)
		expect(pending?.some(sp => sp.role === "attention")).toBe(true)
		expect(tunerConfirm(edit)).toBeNull()
	})
	it("says what is known when the current window is unknown", () => {
		const st = internal(s)
		const noWindow: AppState = {
			...st,
			sources: laneOk(
				st.sources.value!.map(x => ({
					...x,
					caps: { ...x.caps, sampleRate: 0 },
				})),
				st.now - 1000,
				"rest",
			),
		}
		const tuners = noWindow.tuner.value!.map(t => ({ ...t, sampleRate: 0 }))
		const s2: AppState = {
			...noWindow,
			tuner: laneOk(tuners, st.now - 1000, "rest"),
		}
		const edit = editAfter(st, ["up"])
		const affects = receiverLines(
			s2,
			{ ...initialUi("receiver"), edit },
			119,
			35,
			true,
		)
			.map(lineText)
			.find(l => l.startsWith("affects"))
		expect(affects).not.toContain("no decoder enters or leaves")
		expect(affects).toContain("dsd-fme, multimon-ng (tuned)")
		expect(affects).toContain("window now ?")
	})
	it("warns when bias-t is turned on and confirms control changes", () => {
		const edit = editAfter(internal(s), [
			"tab",
			"tab",
			"tab",
			"tab",
			"tab",
			"tab",
			"space",
		])
		expect(tunerConfirm(edit)?.extra).toBe(
			"bias-t supplies DC on the antenna port",
		)
		expect(controlConfirm(s)).toMatchObject({
			kind: "control",
			prompt:
				"take tuner control from relay client-3 192.0.2.1? its next tuning command is refused",
			yes: "take",
			intent: {
				commands: [{ setting: "control-mode", body: { mode: "internal" } }],
			},
		})
		expect(controlConfirm(internal(s))).toMatchObject({
			prompt: "release tuner control to external clients?",
			yes: "release",
		})
	})
	it("reports tuner results for 10 s", () => {
		const t0 = s.now
		const st = reduce(
			s,
			[
				{
					kind: "action:sent",
					at: t0,
					key: "tuner:pi-iq",
					intent: { kind: "tuner", sourceId: "pi-iq", commands: [] },
				},
				{
					kind: "action:result",
					at: t0,
					key: "tuner:pi-iq",
					outcomes: [
						{
							label: "frequency",
							result: {
								ok: false,
								outcome: "failed",
								status: 409,
								code: "TUNER_CONTROL_EXTERNAL",
								message: "device busy",
							},
							at: t0,
						},
						{ label: "gain", result: null, at: null },
					],
				},
			],
			t0,
		)
		expect(tunerResultText(st, "pi-iq", t0 + 1000)).toBe(
			'frequency failed · 409 · "device busy" · gain not sent',
		)
		expect(tunerResultText(st, "pi-iq", t0 + 11_000)).toBeNull()
	})
	it("reports a sent command without a reply in its own words (R23/R29)", () => {
		const t0 = s.now
		const st = reduce(
			s,
			[
				{
					kind: "action:sent",
					at: t0,
					key: "tuner:pi-iq",
					intent: { kind: "tuner", sourceId: "pi-iq", commands: [] },
				},
				{
					kind: "action:result",
					at: t0 + 10_000,
					key: "tuner:pi-iq",
					outcomes: [
						{
							label: "frequency",
							result: {
								ok: false,
								outcome: "unknown",
								status: null,
								message: "sent · no reply in 10s",
							},
							at: t0 + 10_000,
						},
					],
				},
			],
			t0 + 10_000,
		)
		expect(tunerResultText(st, "pi-iq", t0 + 11_000)).toBe(
			"frequency sent · no reply in 10s",
		)
		const ok = reduce(
			s,
			[
				{
					kind: "action:sent",
					at: t0,
					key: "tuner:pi-iq",
					intent: { kind: "tuner", sourceId: "pi-iq", commands: [] },
				},
				{
					kind: "action:result",
					at: t0,
					key: "tuner:pi-iq",
					outcomes: [
						{
							label: "frequency",
							result: {
								ok: true,
								outcome: "ok",
								status: 200,
								message: "Decoder stopped successfully",
							},
							at: t0,
						},
					],
				},
			],
			t0,
		)
		expect(tunerResultText(ok, "pi-iq", t0 + 1000)).toBe(
			"sent · frequency ok 18:07:52",
		)
	})
})
