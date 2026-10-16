/**
 * scripts/rf-window (WG7 MA.4): the pure helpers (argument parsing, statistics, PCM noise
 * tails, tone matching, restore plans, retune sequences), their parity with the frozen
 * contract, and each script's dry run (no network) and usage errors.
 */
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	DCS_STANDARD_CODES,
	LIVE_AUDIO_NOISE_QUIETING_DB,
	LIVE_AUDIO_SQUELCH_MODES,
	type AnalogTransmissionDcs,
	type AnalogTransmissionTone,
	type LiveAudioConfig,
	type LiveAudioToneSquelch,
} from "@wavekit/api-types"
import { CTCSS_HZ } from "../../../src/core/audio-tones/ctcss.js"
import { dcsTwin } from "../../../src/core/audio-tones/dcs.js"

interface Summary {
	count: number
	min: number | null
	p50: number | null
	p90: number | null
	p99: number | null
	max: number | null
	mean: number | null
}
interface Tail {
	atSec: number
	tailMs: number
	after: "audio" | "muted" | "start"
}
/** scripts/rf-window/lib.mjs (plain JS, no declarations). */
interface RfLib {
	CTCSS_HZ: readonly number[]
	SQUELCH_MODES: readonly string[]
	LIVE_AUDIO_ABSENT_DEFAULTS: Record<string, unknown>
	UsageError: new (message: string) => Error
	parseArgs(
		argv: string[],
		spec: Record<string, Record<string, unknown>>,
	): Record<string, unknown>
	apiBaseUrl(host: string): string
	wsUrl(base: string): string
	audioStreamUrl(base: string, port: number): string
	percentile(sorted: number[], p: number): number | null
	summarize(values: number[]): Summary
	decodePcm(buffer: Buffer, format: string): Float32Array
	classifyBlocks(
		samples: Float32Array,
		rate: number,
	): { blockSize: number; blockMs: number; classes: string[] }
	findNoiseTails(samples: Float32Array, rate: number): Tail[]
	tailBoundMs(backChainMs: number): number
	dcsSameStream(a: AnalogTransmissionDcs, b: AnalogTransmissionDcs): boolean
	parseTone(text: string): LiveAudioToneSquelch
	formatTone(tone: LiveAudioToneSquelch | undefined): string
	classifyTone(
		expected: LiveAudioToneSquelch,
		tone: AnalogTransmissionTone | undefined,
	): string
	summarizeTones(
		expected: LiveAudioToneSquelch,
		events: { tone?: AnalogTransmissionTone }[],
	): Record<string, unknown>
	restorePatch(
		previous: Partial<LiveAudioConfig>,
		applied: Record<string, unknown>,
	): { body: Record<string, unknown>; unrestorable: string[] }
	liveAudioPatchProblems(
		config: Partial<LiveAudioConfig>,
		patch: Partial<LiveAudioConfig>,
	): string[]
	retuneTargets(center: number, step: number, count: number): number[]
	frameAtCentre(frame: unknown, sourceId: string, hz: number): boolean
}

const scriptUrl = (name: string) =>
	new URL(`../../../scripts/rf-window/${name}`, import.meta.url)
const lib = (await import(scriptUrl("lib.mjs").href)) as RfLib
const execFileAsync = promisify(execFile)

/** Runs a script with no network: dry runs and usage errors only. */
async function runScript(
	name: string,
	args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const { stdout, stderr } = await execFileAsync(
			process.execPath,
			[fileURLToPath(scriptUrl(name)), ...args],
			{ timeout: 20_000 },
		)
		return { code: 0, stdout, stderr }
	} catch (err) {
		const e = err as { code?: number; stdout?: string; stderr?: string }
		return {
			code: e.code ?? -1,
			stdout: e.stdout ?? "",
			stderr: e.stderr ?? "",
		}
	}
}

/** Deterministic white noise in [-amp, amp]. */
function noise(n: number, amp: number, seed = 1): Float32Array {
	const out = new Float32Array(n)
	let s = seed
	for (let i = 0; i < n; i++) {
		s = (s * 1103515245 + 12345) & 0x7fffffff
		out[i] = ((s / 0x7fffffff) * 2 - 1) * amp
	}
	return out
}
function tone(n: number, hz: number, rate: number, amp: number): Float32Array {
	const out = new Float32Array(n)
	for (let i = 0; i < n; i++)
		out[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate)
	return out
}
function concat(...parts: Float32Array[]): Float32Array {
	const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0))
	let at = 0
	for (const p of parts) {
		out.set(p, at)
		at += p.length
	}
	return out
}

describe("rf-window lib: parity with the frozen contract", () => {
	it("CTCSS tones, squelch modes and the noise default match the core", () => {
		expect([...lib.CTCSS_HZ]).toEqual([...CTCSS_HZ])
		expect([...lib.SQUELCH_MODES]).toEqual([...LIVE_AUDIO_SQUELCH_MODES])
		expect(lib.LIVE_AUDIO_ABSENT_DEFAULTS["noiseQuietingDb"]).toBe(
			LIVE_AUDIO_NOISE_QUIETING_DB.default,
		)
	})

	it("dcsSameStream agrees with the core's dcsTwin for every standard code", () => {
		for (const code of DCS_STANDARD_CODES) {
			for (const polarity of ["normal", "inverted"] as const) {
				const reading = { code, polarity }
				const twin = dcsTwin(reading)
				expect(lib.dcsSameStream(reading, reading)).toBe(true)
				expect(lib.dcsSameStream(reading, twin)).toBe(true)
				expect(lib.dcsSameStream(twin, reading)).toBe(true)
				const flipped = {
					code,
					polarity: polarity === "normal" ? "inverted" : "normal",
				} as const
				expect(lib.dcsSameStream(reading, flipped)).toBe(false)
			}
		}
		expect(
			lib.dcsSameStream(
				{ code: "023", polarity: "normal" },
				{ code: "047", polarity: "inverted" },
			),
		).toBe(true)
	})

	it("dcsSameStream is symmetric over all 3-digit octal codes", () => {
		const reading = fc.record({
			code: fc
				.integer({ min: 0, max: 511 })
				.map(n => n.toString(8).padStart(3, "0")),
			polarity: fc.constantFrom("normal" as const, "inverted" as const),
		})
		fc.assert(
			fc.property(reading, reading, (a, b) => {
				expect(lib.dcsSameStream(a, b)).toBe(lib.dcsSameStream(b, a))
			}),
			{ numRuns: 200 },
		)
	})
})

describe("rf-window lib: arguments and URLs", () => {
	const spec = { seconds: { type: "number", default: 60, min: 10, max: 100 } }

	it("requires --host and defaults to a dry run", () => {
		expect(() => lib.parseArgs([], spec)).toThrow(/--host is required/)
		expect(lib.parseArgs(["--host", "pi"], spec)).toMatchObject({
			host: "pi",
			mode: "dry-run",
			seconds: 60,
			apply: false,
		})
		expect(lib.parseArgs(["--host=pi", "--run"], spec)["mode"]).toBe("run")
		expect(
			lib.parseArgs(["--host", "pi", "--run", "--apply"], spec)["mode"],
		).toBe("apply")
		expect(lib.parseArgs(["--help"], spec)["help"]).toBe(true)
	})

	it("refuses unknown options, missing values and out-of-range numbers", () => {
		expect(() => lib.parseArgs(["--host", "pi", "--nope"], spec)).toThrow(
			/Unknown option/,
		)
		expect(() => lib.parseArgs(["--host"], spec)).toThrow(/needs a value/)
		expect(() =>
			lib.parseArgs(["--host", "pi", "--seconds", "5"], spec),
		).toThrow(/at least 10/)
		expect(() =>
			lib.parseArgs(["--host", "pi", "--seconds", "x"], spec),
		).toThrow(/number/)
		expect(() => lib.parseArgs(["--host", "pi", "--apply=1"], spec)).toThrow(
			/no value/,
		)
		expect(() => lib.parseArgs(["pi"], spec)).toThrow(/Unexpected/)
	})

	it("builds API, WebSocket and audio URLs from a host", () => {
		expect(lib.apiBaseUrl("pi.local")).toBe("http://pi.local:9000")
		expect(lib.apiBaseUrl("10.0.0.5:9100")).toBe("http://10.0.0.5:9100")
		expect(lib.apiBaseUrl("https://wk.example:8443")).toBe(
			"https://wk.example:8443",
		)
		expect(() => lib.apiBaseUrl("http://u:p@pi")).toThrow(/credentials/)
		expect(() => lib.apiBaseUrl("pi/api")).toThrow(/path/)
		expect(lib.wsUrl("http://pi.local:9000")).toBe("ws://pi.local:9000/ws")
		expect(lib.wsUrl("https://wk.example:8443")).toBe(
			"wss://wk.example:8443/ws",
		)
		expect(lib.audioStreamUrl("http://pi.local:9000", 8081)).toBe(
			"http://pi.local:8081/stream",
		)
	})
})

describe("rf-window lib: statistics", () => {
	it("nearest-rank percentiles and summaries", () => {
		const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
		expect(lib.percentile(sorted, 50)).toBe(5)
		expect(lib.percentile(sorted, 90)).toBe(9)
		expect(lib.percentile(sorted, 100)).toBe(10)
		expect(lib.percentile(sorted, 0)).toBe(1)
		expect(lib.percentile([], 50)).toBeNull()
		expect(lib.summarize([3, Number.NaN, 1, 2])).toEqual({
			count: 3,
			min: 1,
			p50: 2,
			p90: 3,
			p99: 3,
			max: 3,
			mean: 2,
		})
		expect(lib.summarize([]).count).toBe(0)
	})

	it("percentiles are ordered and inside the range", () => {
		fc.assert(
			fc.property(
				fc.array(fc.double({ min: -1e6, max: 1e6, noNaN: true }), {
					minLength: 1,
				}),
				values => {
					const s = lib.summarize(values)
					expect(s.count).toBe(values.length)
					expect(s.min!).toBeLessThanOrEqual(s.p50!)
					expect(s.p50!).toBeLessThanOrEqual(s.p90!)
					expect(s.p90!).toBeLessThanOrEqual(s.p99!)
					expect(s.p99!).toBeLessThanOrEqual(s.max!)
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("rf-window lib: PCM and noise tails", () => {
	const rate = 8_000
	const block = 80 // 10 ms

	it("decodes s16le and f32le", () => {
		const s16 = Buffer.alloc(4)
		s16.writeInt16LE(16384, 0)
		s16.writeInt16LE(-32768, 2)
		expect([...lib.decodePcm(s16, "s16le")]).toEqual([0.5, -1])
		const f32 = Buffer.alloc(8)
		f32.writeFloatLE(0.25, 0)
		f32.writeFloatLE(-0.5, 4)
		expect([...lib.decodePcm(f32, "f32le")]).toEqual([0.25, -0.5])
		expect(() => lib.decodePcm(Buffer.alloc(2), "u8")).toThrow(/Unsupported/)
	})

	it("classifies muted, broadband noise and voice-band audio blocks", () => {
		const samples = concat(
			new Float32Array(block),
			noise(block, 0.5),
			tone(block, 400, rate, 0.5),
		)
		expect(lib.classifyBlocks(samples, rate).classes).toEqual([
			"muted",
			"noise",
			"audio",
		])
	})

	it("measures the noise between carrier audio and the mute onset", () => {
		// 1 s carrier with a 400 Hz tone, 300 ms noise tail, 500 ms muted; twice.
		const release = () =>
			concat(
				tone(rate, 400, rate, 0.3),
				noise(30 * block, 0.5, 7),
				new Float32Array(50 * block),
			)
		const tails = lib.findNoiseTails(concat(release(), release()), rate)
		expect(tails).toHaveLength(2)
		for (const t of tails) {
			expect(t.after).toBe("audio")
			expect(t.tailMs).toBeCloseTo(300, 6)
		}
		expect(tails[0]!.atSec).toBeCloseTo(1.3, 6)
	})

	it("reports a direct mute as tail 0, a noise-only open as after muted, and ignores short gaps", () => {
		const samples = concat(
			tone(rate / 2, 400, rate, 0.3),
			new Float32Array(30 * block), // direct mute: tail 0
			noise(10 * block, 0.5, 3),
			new Float32Array(30 * block), // noise-only open
			tone(rate / 2, 400, rate, 0.3),
			new Float32Array(5 * block), // short gap: ignored
			tone(rate / 2, 400, rate, 0.3),
		)
		const tails = lib.findNoiseTails(samples, rate)
		expect(tails.map(t => [t.after, Math.round(t.tailMs)])).toEqual([
			["audio", 0],
			["muted", 100],
		])
	})

	it("states the req 4.1 bound: hang + one block + back-chain", () => {
		expect(lib.tailBoundMs(0)).toBe(260)
		expect(lib.tailBoundMs(120)).toBe(380)
	})
})

describe("rf-window lib: tones", () => {
	it("parses CTCSS, DCS and none to the frozen toneSquelch shape", () => {
		expect(lib.parseTone("ctcss:100.0")).toEqual({
			kind: "ctcss",
			frequencyTenthsHz: 1000,
		})
		expect(lib.parseTone("ctcss:67")).toEqual({
			kind: "ctcss",
			frequencyTenthsHz: 670,
		})
		expect(lib.parseTone("dcs:023")).toEqual({
			kind: "dcs",
			code: "023",
			polarity: "normal",
		})
		expect(lib.parseTone("dcs:047i")).toEqual({
			kind: "dcs",
			code: "047",
			polarity: "inverted",
		})
		expect(lib.parseTone("none")).toEqual({ kind: "none" })
		expect(() => lib.parseTone("ctcss:100.1")).toThrow(/not a standard/)
		expect(() => lib.parseTone("dcs:089")).toThrow(/Tone must be/)
		for (const t of ["ctcss:254.1", "dcs:754I", "none"])
			expect(lib.formatTone(lib.parseTone(t))).toBe(
				t === "none" ? "none" : t.replace(/^ctcss:(\d+)$/, "ctcss:$1.0"),
			)
	})

	it("classifies a closed transmission's tone against the expected one", () => {
		const ctcss = lib.parseTone("ctcss:100.0")
		expect(lib.classifyTone(ctcss, { ctcssHz: 100, dtmf: null })).toBe("match")
		expect(lib.classifyTone(ctcss, { ctcssHz: 103.5, dtmf: null })).toBe(
			"wrong",
		)
		expect(lib.classifyTone(ctcss, { ctcssHz: null, dtmf: null })).toBe("none")
		expect(lib.classifyTone(ctcss, undefined)).toBe("no-tone-field")
		const dcs = lib.parseTone("dcs:023N")
		const reading = (code: string, polarity: "normal" | "inverted") => ({
			ctcssHz: null,
			dtmf: null,
			dcs: { code, polarity },
		})
		expect(lib.classifyTone(dcs, reading("023", "normal"))).toBe("match")
		expect(lib.classifyTone(dcs, reading("047", "inverted"))).toBe("match")
		expect(lib.classifyTone(dcs, reading("025", "normal"))).toBe("wrong")
		expect(
			lib.classifyTone(dcs, { ctcssHz: null, dtmf: null, dcs: null }),
		).toBe("none")
		const summary = lib.summarizeTones(dcs, [
			{ tone: reading("023", "normal") },
			{ tone: reading("025", "normal") },
			{ tone: { ctcssHz: null, dtmf: null, dcs: null } },
		])
		expect(summary).toMatchObject({
			total: 3,
			match: 1,
			wrong: 1,
			none: 1,
			wrongReadings: { "dcs:025N": 1 },
		})
	})
})

describe("rf-window lib: restore plans and config refusals", () => {
	it("restores previous values, absent keys to their defaults", () => {
		expect(
			lib.restorePatch(
				{
					squelchMode: "auto",
					toneSquelch: { kind: "ctcss", frequencyTenthsHz: 885 },
				},
				{ squelchMode: "noise", toneSquelch: { kind: "none" } },
			),
		).toEqual({
			body: {
				squelchMode: "auto",
				toneSquelch: { kind: "ctcss", frequencyTenthsHz: 885 },
			},
			unrestorable: [],
		})
		expect(
			lib.restorePatch(
				{},
				{ squelchMode: true, toneSquelch: true, offsetHz: 1 },
			),
		).toEqual({
			body: { squelchMode: "manual", toneSquelch: { kind: "none" } },
			unrestorable: ["offsetHz"],
		})
	})

	it("mirrors the frozen FM-only rules for noise and tone squelch", () => {
		const nfm = { modulation: "nfm" as const }
		const am = { modulation: "am" as const }
		const ctcss = { kind: "ctcss" as const, frequencyTenthsHz: 1000 }
		expect(lib.liveAudioPatchProblems(nfm, { squelchMode: "noise" })).toEqual(
			[],
		)
		expect(
			lib.liveAudioPatchProblems(
				{ modulation: "wfm" },
				{ squelchMode: "noise" },
			),
		).toEqual([])
		expect(
			lib.liveAudioPatchProblems(am, { squelchMode: "noise" }),
		).toHaveLength(1)
		expect(lib.liveAudioPatchProblems(nfm, { toneSquelch: ctcss })).toEqual([])
		expect(
			lib.liveAudioPatchProblems({ modulation: "wfm" }, { toneSquelch: ctcss }),
		).toHaveLength(1)
		expect(
			lib.liveAudioPatchProblems(am, { toneSquelch: { kind: "none" } }),
		).toEqual([])
	})
})

describe("rf-window lib: retunes", () => {
	it("alternates around the centre and stays within one step", () => {
		expect(lib.retuneTargets(446_000_000, 100_000, 4)).toEqual([
			446_100_000, 445_900_000, 446_100_000, 445_900_000,
		])
		fc.assert(
			fc.property(
				fc.integer({ min: 24_000_000, max: 1_700_000_000 }),
				fc.integer({ min: 1_000, max: 5_000_000 }),
				fc.integer({ min: 1, max: 200 }),
				(centre, step, count) => {
					const targets = lib.retuneTargets(centre, step, count)
					expect(targets).toHaveLength(count)
					let prev = centre
					for (const t of targets) {
						expect(Math.abs(t - centre)).toBe(step)
						expect(t).not.toBe(prev)
						prev = t
					}
				},
			),
			{ numRuns: 100 },
		)
	})

	it("matches a live frame at the new centre, never a snapshot or another source", () => {
		const frame = { sourceId: "rtl", centerHz: 446_100_000 }
		expect(lib.frameAtCentre(frame, "rtl", 446_100_000)).toBe(true)
		expect(
			lib.frameAtCentre({ ...frame, snapshot: true }, "rtl", 446_100_000),
		).toBe(false)
		expect(lib.frameAtCentre(frame, "other", 446_100_000)).toBe(false)
		expect(lib.frameAtCentre(frame, "rtl", 446_000_000)).toBe(false)
		expect(lib.frameAtCentre(null, "rtl", 446_100_000)).toBe(false)
	})
})

describe("rf-window scripts: dry runs and usage (no network)", () => {
	const scripts: [string, string[]][] = [
		["squelch-tail.mjs", ["--modes", "manual,noise"]],
		["tone-squelch.mjs", ["--tone", "ctcss:100.0"]],
		["dcs-ctcss-capture.mjs", ["--expect", "dcs:023N"]],
		["tune-latency.mjs", ["--source", "rtl"]],
	]

	it.each(scripts)(
		"%s prints a plan and sends nothing by default",
		async (name, extra) => {
			// 192.0.2.1 is TEST-NET-1: a dry run that tried to connect would hang or fail.
			const result = await runScript(name, ["--host", "192.0.2.1", ...extra])
			expect(result.code).toBe(0)
			const plan = JSON.parse(result.stdout.trim()) as Record<string, unknown>
			expect(plan["kind"]).toBe("plan")
			expect(plan["api"]).toBe("http://192.0.2.1:9000")
			expect(String(plan["note"])).toMatch(/dry run: nothing was sent/)
		},
	)

	it.each(scripts)("%s exits 2 without --host", async name => {
		const result = await runScript(name, [])
		expect(result.code).toBe(2)
		expect(result.stderr).toMatch(/--host is required/)
		expect(result.stderr).toMatch(/Usage:/)
	})

	it("refuses writes without --apply and --apply where nothing is written", async () => {
		const tail = await runScript("squelch-tail.mjs", [
			"--host",
			"192.0.2.1",
			"--run",
			"--modes",
			"noise",
		])
		expect(tail.code).toBe(2)
		expect(tail.stderr).toMatch(/needs --apply/)
		const toneRun = await runScript("tone-squelch.mjs", [
			"--host",
			"192.0.2.1",
			"--run",
			"--tone",
			"ctcss:100.0",
		])
		expect(toneRun.code).toBe(2)
		const toneApply = await runScript("tone-squelch.mjs", [
			"--host",
			"192.0.2.1",
			"--apply",
		])
		expect(toneApply.code).toBe(2)
		expect(toneApply.stderr).toMatch(/needs --tone/)
		const capture = await runScript("dcs-ctcss-capture.mjs", [
			"--host",
			"192.0.2.1",
			"--apply",
			"--expect",
			"none",
		])
		expect(capture.code).toBe(2)
		expect(capture.stderr).toMatch(/read-only/)
	})
})
