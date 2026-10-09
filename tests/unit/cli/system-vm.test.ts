import { describe, expect, it } from "vitest"
import { laneOk } from "../../../cli/source/data/freshness.js"
import { reduce } from "../../../cli/source/data/reducers.js"
import { scenarioState } from "../../../cli/source/test/fixtures.js"
import { SCENARIO_NAMES } from "../../../cli/source/test/scenario-types.js"
import { findBanned } from "../../../cli/source/ui/copy-rules.js"
import { formatClockShort } from "../../../cli/source/ui/format.js"
import { cellWidth, lineText } from "../../../cli/source/ui/text.js"
import {
	audioResultText,
	presetConfirm,
	presetNames,
	systemLines,
} from "../../../cli/source/view-models/system.js"

describe("system view-model (spec §6.5)", () => {
	const s = scenarioState("live")
	const text = systemLines(s, 119, 35, true).map(lineText)
	it("renders container, alerts, SDR host, audio and core", () => {
		expect(text).toContain("CONTAINER cgroup v2 · as of 2s ago")
		expect(text).toContain("cpu       240%   throttled —   oom kills 0")
		expect(text).toContain("mem       1.9 GB · no limit")
		expect(text).toContain(
			// Clock text from the same local getters as the view (no TZ mutation, M9).
			`alerts    ! container-cpu critical "High CPU usage: 273.5%" · 1× since ${formatClockShort(Date.parse("2026-10-08T18:07:49.000Z"))} · last 3s ago`,
		)
		expect(text).toContain(
			"SDR HOST  pi-iq · http://192.0.2.23:8080 · polled by core 2s ago · uptime 4m",
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
		expect(text).toContain('CORE      v1.0.0 · uptime 7m · reports "degraded"')
		expect(text).toContain('          api "up" · "API server is responding"')
		// The CLI's boundary counters live here, dim, not in the keys box (polish copy sweep).
		expect(text).toContain("cli       frames rejected 0 · items rejected 0")
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
			"sampling  ● streaming · sample age 200ms · 4.1 MB/s upstream (nominal) · 0 resets",
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
			prompt: "audio preset wfm · 150 kHz",
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
	it("says ? for a demod centre core never commanded or observed (R84)", () => {
		const t = s.tuner.value![0]!
		const st = {
			...s,
			tuner: laneOk(
				[{ ...t, unknownFields: ["frequency" as const] }],
				s.now - 1000,
				"rest" as const,
			),
		}
		expect(
			systemLines(st, 119, 35, true)
				.map(lineText)
				.find(l => l.startsWith("demod")),
		).toMatch(/^demod {5}pi-iq at \? · /)
	})
	it("says the demod restarts when a preset hits a running pipeline (S7)", () => {
		const a = s.audio.value!
		const running = {
			...s,
			audio: laneOk({ ...a, running: true }, s.now - 1000, "rest" as const),
		}
		expect(presetConfirm(running, 1)?.prompt).toBe(
			"audio preset wfm · 150 kHz · demod restarts",
		)
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

	describe("C3 fix round 1", () => {
		const live = scenarioState("live")
		const r = live.resources.value!
		const host = r.sdrHosts[0]!
		const at = (st: typeof live, w = 119, h = 35) =>
			systemLines(st, w, h, true).map(lineText)
		const withHosts = (
			hosts: typeof r.sdrHosts,
			receivedAt = live.now - 2000,
		) => ({
			...live,
			resources: laneOk({ ...r, sdrHosts: hosts }, receivedAt, "rest" as const),
		})
		it("keeps CORE and AUDIO with many host warnings and two hosts at 59x12, with markers", () => {
			const warnings = Array.from(
				{ length: 6 },
				(_, i) => `preflight warning ${i}`,
			)
			const st = withHosts([
				{ ...host, warnings },
				{
					...host,
					sourceId: "usb-iq",
					apiUrl: "http://192.0.2.24:8080",
					warnings,
				},
			])
			const lines = systemLines(st, 59, 12, false).map(lineText)
			expect(lines.length).toBeLessThanOrEqual(12)
			expect(lines.some(l => l.startsWith("CORE"))).toBe(true)
			expect(lines.some(l => l.startsWith("AUDIO"))).toBe(true)
			expect(lines.filter(l => l.startsWith("SDR HOST"))).toHaveLength(2)
			expect(lines.some(l => /^ {10}\+\d+ (more|rows? hidden)$/.test(l))).toBe(
				true,
			)
			const roomy = at(st)
			expect(roomy.filter(l => l.startsWith("warning"))).toHaveLength(4)
			expect(roomy.filter(l => l === "          +4 more")).toHaveLength(2)
		})
		it("keeps the alerts marker true after shedding", () => {
			const alert = live.alerts[0]!
			const st = {
				...live,
				alerts: Array.from({ length: 5 }, (_, i) => ({
					...alert,
					key: `k${i}`,
					lastAt: alert.lastAt - i,
				})),
			}
			expect(at(st)).toContain("          +2 more")
			const short = systemLines(st, 79, 12, false).map(lineText)
			const shown = short.filter(l => l.includes("container-cpu")).length
			expect(short).toContain(`          +${5 - shown} more`)
		})
		it("says ? for an old lane's rate, unknown sampling, unknown pid and memory percent (M7, T6)", () => {
			const old = withHosts([host], live.now - 60_000)
			expect(at(old).find(l => l.startsWith("rtlmux"))).toContain("· ? ·")
			const odd = withHosts([
				{
					...host,
					rtlTcp: { ...host.rtlTcp!, pid: null },
					sampling: {
						state: "unknown" as const,
						reason: null,
						timeoutMs: 5000,
						lastSampleAt: null,
						sampleAgeMs: null,
						upstream: {
							bytesTotal: null,
							bytesPerSec: null,
							windowMs: null,
							expectedBytesPerSec: null,
							rateBasis: "configured" as const,
							rateStatus: "unknown" as const,
						},
						epoch: {
							rtlmuxPid: null,
							rtlTcpPid: null,
							startedAt: null,
							resets: 0,
							lastResetReason: null,
						},
						stats: {
							state: "stale" as const,
							observedAt: null,
							ageMs: null,
							lastError: null,
						},
					},
				},
			])
			const lines = at(odd)
			expect(lines.find(l => l.startsWith("rtl_tcp"))).toContain("pid ?")
			expect(lines.find(l => l.startsWith("sampling"))).toMatch(
				/^sampling {2}\? · sample age \?/,
			)
			const limited = {
				...live,
				resources: laneOk(
					{
						...r,
						container: {
							...r.container,
							memoryLimitBytes: 4e9,
							memoryUsagePercent: null,
						},
					},
					live.now - 2000,
					"rest" as const,
				),
			}
			expect(at(limited)).toContain("mem       1.9 GB of 4.0 GB (?)")
		})
		it("dims the SDR HOST header when core cannot reach the Pi (M3)", () => {
			const st = withHosts([{ ...host, fetchError: "connect ETIMEDOUT" }])
			const head = systemLines(st, 119, 35, true).find(l =>
				lineText(l).startsWith("SDR HOST"),
			)
			expect(
				head
					?.slice(1)
					.every(span => span.role === "old" || span.role === "label"),
			).toBe(true)
		})
		it("shows a pending audio write so a second a is not blind (M6)", () => {
			const st = reduce(
				live,
				[
					{
						kind: "action:sent",
						id: 3,
						at: live.now,
						key: "audio",
						intent: { kind: "audio", op: "start" },
					},
				],
				live.now,
			)
			expect(at(st)).toContain("result    audio start sending")
		})
	})

	describe("C3 fix round 2", () => {
		const live = scenarioState("live")
		const r = live.resources.value!
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
		it("sampling upstream rate reads ? on an old lane (T6)", () => {
			const st = {
				...live,
				resources: laneOk(
					{ ...r, sdrHosts: [{ ...host, sampling }] },
					live.now - 60_000,
					"rest" as const,
				),
			}
			const line = systemLines(st, 119, 35, true)
				.map(lineText)
				.find(l => l.startsWith("sampling"))
			expect(line).toContain("· ? upstream (nominal) ·")
		})
	})

	it("says disabled for live audio disabled in config (R72)", () => {
		const live = scenarioState("live")
		const st = {
			...live,
			audio: laneOk(
				{ ...live.audio.value!, enabled: false, running: false },
				live.now - 2000,
				"rest" as const,
			),
		}
		expect(systemLines(st, 119, 35, true).map(lineText)).toContain(
			"AUDIO     ○ disabled · 0 clients · 127.0.0.1:8081/stream",
		)
	})
})
