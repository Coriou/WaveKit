import { describe, expect, it } from "vitest"
import { laneOk } from "../../../cli/source/data/freshness.js"
import { reduce } from "../../../cli/source/data/reducers.js"
import { scenarioState } from "../../../cli/source/test/fixtures.js"
import { SCENARIO_NAMES } from "../../../cli/source/test/scenario-types.js"
import { findBanned } from "../../../cli/source/ui/copy-rules.js"
import { cellWidth, lineText } from "../../../cli/source/ui/text.js"
import {
	audioResultText,
	presetConfirm,
	presetNames,
	systemLines,
} from "../../../cli/source/view-models/system.js"

// Module level: the describe body below renders at collection time, before any beforeAll.
process.env["TZ"] = "UTC"

describe("system view-model (spec §6.5)", () => {
	const s = scenarioState("live")
	const text = systemLines(s, 119, 35, true).map(lineText)
	it("renders container, alerts, SDR host, audio and core", () => {
		expect(text).toContain("CONTAINER cgroup v2 · as of 2s ago")
		expect(text).toContain("cpu       240%   throttled —   oom kills 0")
		expect(text).toContain("mem       1.94 GB · no limit")
		expect(text).toContain(
			'alerts    ! container-cpu critical "High CPU usage: 273.5%" · 1× since 18:07 · last 3s ago',
		)
		expect(text).toContain(
			"SDR HOST  pi-iq · http://192.0.2.23:8080 · polled by core 2s ago · uptime 4m 51s",
		)
		expect(text).toContain("rtl_tcp   ● running · pid 58 · 0 restarts")
		expect(text).toContain(
			"rtlmux    ● running · pid 63 · 1 client · 4.2 MB/s · 1.2 GB sent · 0 restarts",
		)
		expect(text.some(l => l.startsWith("sampling"))).toBe(false)
		expect(text).toContain("dongle    RTLSDRBlog Blog V4 · serial —")
		expect(text).toContain(
			"AUDIO     ○ stopped · 0 clients · 127.0.0.1:8081/stream",
		)
		expect(text).toContain(
			"demod     pi-iq at 445.9707 MHz · nfm 12.5 kHz · squelch 0 · gain 10 · 25 kHz s16le",
		)
		expect(text).toContain(
			'CORE      v1.0.0 · uptime 7m 40s · reports "degraded"',
		)
		expect(text).toContain('          api up "API server is responding"')
		expect(text.some(l => l.includes("acarsdec"))).toBe(false)
		for (const l of text) {
			expect(cellWidth(l)).toBeLessThanOrEqual(119)
			expect(findBanned(l)).toEqual([])
		}
	})
	it("stays within width and height, without banned copy, for every scenario and size", () => {
		for (const name of SCENARIO_NAMES) {
			const st = scenarioState(name)
			for (const [w, h] of [
				[59, 12],
				[79, 20],
				[119, 36],
				[199, 46],
			] as const) {
				const lines = systemLines(st, w, h, h > 20).map(lineText)
				expect(lines.length, `${name} ${w}x${h}`).toBeLessThanOrEqual(h)
				for (const l of lines) {
					expect(cellWidth(l), `${name} ${w}: ${l}`).toBeLessThanOrEqual(w)
					expect(findBanned(l), `${name}: ${l}`).toEqual([])
				}
			}
		}
	})
	it("keeps CORE and AUDIO when short, shedding component and dongle rows first", () => {
		const lines = systemLines(s, 59, 11, false).map(lineText)
		expect(lines.some(l => l.startsWith("CORE"))).toBe(true)
		expect(lines.some(l => l.startsWith("AUDIO"))).toBe(true)
		expect(lines.some(l => l.includes("API server is responding"))).toBe(false)
	})
	it("fills the sampling slot only when core surfaces it (request 6)", () => {
		const r = s.resources.value!
		const host = r.sdrHosts[0]!
		const sampling = {
			state: "streaming" as const,
			reason: null,
			timeoutMs: 5000,
			lastSampleAt: null,
			sampleAgeMs: 200,
			upstream: {
				bytesTotal: 1,
				bytesPerSec: 4096000,
				windowMs: 2000,
				expectedBytesPerSec: 4096000,
				rateBasis: "configured" as const,
				rateStatus: "nominal" as const,
			},
			epoch: {
				rtlmuxPid: 63,
				rtlTcpPid: 58,
				startedAt: null,
				resets: 0,
				lastResetReason: null,
			},
			stats: {
				state: "ok" as const,
				observedAt: null,
				ageMs: 200,
				lastError: null,
			},
		}
		const st = {
			...s,
			resources: laneOk(
				{ ...r, sdrHosts: [{ ...host, sampling }] },
				s.now - 2000,
				"rest" as const,
			),
		}
		const lines = systemLines(st, 119, 35, true).map(lineText)
		const i = lines.findIndex(l => l.startsWith("sampling"))
		expect(lines[i]).toBe(
			"sampling  ● streaming · sample age 200 ms · 4.1 MB/s upstream (nominal) · 0 resets",
		)
		expect(lines[i - 1]?.startsWith("rtlmux")).toBe(true)
		expect(lines[i + 1]?.startsWith("dongle")).toBe(true)
	})
	it("marks a Pi the core cannot reach", () => {
		const r = s.resources.value!
		const st = {
			...s,
			resources: laneOk(
				{
					...r,
					sdrHosts: [{ ...r.sdrHosts[0]!, fetchError: "connect ETIMEDOUT" }],
				},
				s.now - 2000,
				"rest" as const,
			),
		}
		expect(systemLines(st, 119, 35, true).map(lineText)).toContain(
			'          × core cannot reach the Pi API · "connect ETIMEDOUT"',
		)
	})
	it("builds preset confirms with the modulation (presets carry only bandwidth/de-emphasis)", () => {
		expect(presetNames(s)).toEqual([
			"nfm",
			"wfm",
			"am",
			"usb",
			"lsb",
			"dsb",
			"cw",
			"raw",
		])
		expect(presetConfirm(s, 1)).toMatchObject({
			kind: "preset",
			prompt: 'apply audio preset "wfm" (wfm 150 kHz)?',
			yes: "apply",
			no: "cancel",
			presetIndex: 1,
			intent: {
				kind: "preset",
				name: "wfm",
				patch: {
					modulation: "wfm",
					bandwidth: 150000,
					deEmphasis: true,
					deEmphasisTau: 50,
				},
			},
		})
		expect(presetConfirm(s, 9)?.presetIndex).toBe(1)
	})
	it("reports audio results for 10 s", () => {
		const t0 = s.now
		const st = reduce(
			s,
			[
				{
					kind: "action:sent",
					id: 1,
					at: t0,
					key: "audio",
					intent: { kind: "audio", op: "start" },
				},
				{
					kind: "action:result",
					id: 1,
					at: t0,
					key: "audio",
					outcomes: [
						{
							label: "start",
							result: {
								ok: false,
								outcome: "failed",
								status: 503,
								message: "source not connected",
							},
							at: t0,
						},
					],
				},
			],
			t0,
		)
		expect(audioResultText(st, t0 + 1000)).toBe(
			'audio start failed · 503 · "source not connected"',
		)
		expect(audioResultText(st, t0 + 11_000)).toBeNull()
	})
	it("reports an audio write without a reply and success in CLI words (R23/R29)", () => {
		const t0 = s.now
		const unknown = reduce(
			s,
			[
				{
					kind: "action:sent",
					id: 1,
					at: t0,
					key: "audio",
					intent: { kind: "audio", op: "stop" },
				},
				{
					kind: "action:result",
					id: 1,
					at: t0 + 10_000,
					key: "audio",
					outcomes: [
						{
							label: "stop",
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
		expect(audioResultText(unknown, t0 + 11_000)).toBe(
			"audio stop sent · no reply in 10s",
		)
		expect(audioResultText(reduce(unknown, [], t0 + 20_000), t0 + 21_000)).toBe(
			"audio stop sent · no reply",
		)
		const ok = reduce(
			s,
			[
				{
					kind: "action:sent",
					id: 1,
					at: t0,
					key: "audio",
					intent: { kind: "audio", op: "start" },
				},
				{
					kind: "action:result",
					id: 1,
					at: t0,
					key: "audio",
					outcomes: [
						{
							label: "start",
							result: {
								ok: true,
								outcome: "ok",
								status: 200,
								message: "started successfully",
							},
							at: t0,
						},
					],
				},
			],
			t0,
		)
		expect(audioResultText(ok, t0 + 1000)).toBe("audio started · 0 clients")
	})
})
