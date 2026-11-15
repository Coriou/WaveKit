/**
 * The digital voice capture harness's logic (tests/integration/dv-capture.ts)
 * without its binaries: the grid and its time budget, the settle-replay
 * variant, the real-time feeder, and one whole point with in-process doubles
 * standing in for wavekit-chan (a carrier detector) and for sox | dsd-fme (a
 * decoder that prints DMR lines from the audio it was fed so far). The run
 * against the real binaries is dv-capture.test.ts (WAVEKIT_DVCAP=1).
 */
import { spawn } from "node:child_process"
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { DV_SCENES } from "../../../scripts/fixtures/dv-plan.mjs"
import type { DvScene } from "../../../scripts/fixtures/dv-plan.mjs"
import {
	AUDIO_RATE_HZ,
	CHUNK_MS,
	DVCAP_CNR_DB,
	DVCAP_READY,
	DVCAP_ERRORS_HZ,
	DVCAP_PHASES,
	DV_GRID_ABORT_STREAK,
	LEAD_MS,
	POINT_FIXED_S,
	POINT_PER_SCENE_S,
	POST_EOF_TIMEOUT_MS,
	QUICK_BUDGET_S,
	QUICK_SCENES,
	SETTLE_FRAME_MS,
	SETTLE_REPEAT_MS,
	STDERR_TAIL_CHARS,
	createShellRunner,
	dockerArgs,
	dvGrid,
	feedRealTime,
	gridSeconds,
	gridTimeoutMs,
	measureDvPoint,
	runDvGrid,
	recordedSceneName,
	recordedSeed,
	settleReplay,
	type DvChannelize,
	type DvPointSpec,
	type DvRunner,
	type DvSpawn,
} from "../../integration/dv-capture.js"
import {
	loadDvCases,
	parseDvSeed,
} from "../../../scripts/bench/scanner-quality/truth-dv.js"

describe("the grid", () => {
	it("is every scene at every CNR, error and phase; quick is DMR at 20 dB, 0 Hz, phase 0", () => {
		const full = dvGrid()
		expect(full).toHaveLength(
			DV_SCENES.length *
				DVCAP_CNR_DB.length *
				DVCAP_ERRORS_HZ.length *
				DVCAP_PHASES.length,
		)
		expect(DVCAP_CNR_DB).toEqual([10, 12, 15, 20, 30])
		expect(DV_SCENES.length * 5 * 3 * 4).toBe(1320)
		// Every point of the full grid has its own noise seed.
		expect(
			new Set(full.map(p => `${p.scene.name}|${p.errorHz}|${p.seed}`)).size,
		).toBe(full.length)
		const quick = dvGrid({ quick: true })
		expect(quick.map(p => p.scene.name)).toEqual(QUICK_SCENES.map(s => s.name))
		expect(quick).toHaveLength(12)
		for (const p of quick)
			expect([p.scene.protocol, p.cnrDb, p.errorHz, p.phase]).toEqual([
				"dmr",
				20,
				0,
				0,
			])
		expect(
			dvGrid({ scenes: ["ysf-gaps"], cnrDb: [15], phases: [0.5] }),
		).toHaveLength(3)
	})

	it("runs the quick subset inside its budget, and not twice its phases", () => {
		expect([POINT_FIXED_S, POINT_PER_SCENE_S]).toEqual([5, 0.35])
		// 12 DMR scenes, 236.1 s of scene + 12 x 0.1 s lead = 237.3 s of IQ, at
		// real time plus 0.35 s per IQ second, + 12 x 5 s: 237.3 x 1.35 + 60 = 380.4 s.
		const quick = gridSeconds(dvGrid({ quick: true }))
		expect(quick).toBeCloseTo(380.4, 0)
		expect(quick).toBeLessThanOrEqual(QUICK_BUDGET_S)
		// Past the bound: a second phase doubles it (761 s > 600 s).
		expect(
			gridSeconds(dvGrid({ quick: true, phases: [0, 0.5] })),
		).toBeGreaterThan(QUICK_BUDGET_S)
		// The full grid: 22 scenes of 60 points, about 13.7 h.
		expect(gridSeconds(dvGrid()) / 3600).toBeCloseTo(13.7, 1)
		// The test's timeout: twice the estimate plus 600 s.
		expect(gridTimeoutMs(dvGrid({ quick: true }))).toBe(
			Math.ceil((2 * quick + 600) * 1000),
		)
	})
})

describe("settle replay", () => {
	/** s16 audio whose sample k holds k mod 32 768. */
	const ramp = (ms: number) => {
		const n = Math.round((ms / 1000) * AUDIO_RATE_HZ)
		const b = Buffer.alloc(2 * n)
		for (let k = 0; k < n; k++) b.writeInt16LE(k % 32_768, 2 * k)
		return b
	}
	const at = (b: Buffer, ms: number) =>
		b.readInt16LE(2 * Math.round((ms / 1000) * AUDIO_RATE_HZ))

	it("repeats whole frames of each over's head before it and shifts the timeline", () => {
		const pcm = ramp(2000)
		const overs = [
			{ startMs: 100, endMs: 600 },
			{ startMs: 1000, endMs: 1200 },
		]
		const r = settleReplay(pcm, overs, 360, 60)
		// The second over is 200 ms: three whole 60 ms frames (180 ms) fit.
		expect(r.repeatsMs).toEqual([360, 180])
		expect(r.pcm.length).toBe(pcm.length + 2 * 48 * (360 + 180))
		// The copy, then the over itself.
		expect(at(r.pcm, 100)).toBe(at(pcm, 100))
		expect(at(r.pcm, 100 + 360)).toBe(at(pcm, 100))
		expect(r.shift(50)).toBe(50)
		expect(r.shift(100)).toBe(460)
		expect(r.shift(1000)).toBe(1000 + 360 + 180)
		expect(at(r.pcm, r.shift(1100))).toBe(at(pcm, 1100))
	})

	it("keeps TDMA slot parity: the DMR repeat is whole 60 ms frames", () => {
		for (const [protocol, repeat] of Object.entries(SETTLE_REPEAT_MS))
			expect(repeat % SETTLE_FRAME_MS[protocol]!, protocol).toBe(0)
		expect(SETTLE_REPEAT_MS["dmr"]! % 60).toBe(0)
		// Every repeat fits the shortest over of its protocol's scenes.
		for (const s of DV_SCENES)
			for (const o of s.overs)
				expect(o.durationMs).toBeGreaterThanOrEqual(
					SETTLE_REPEAT_MS[s.protocol]!,
				)
	})
})

/**
 * A decoder double: reads s16 audio, keyed where the sample is above 1000;
 * prints a DMR voice sync at key-up, the IDs 360 ms after it (one superframe)
 * and a terminator once keyed off for 50 ms, each as soon as that audio has
 * arrived.
 */
const decoderDouble: DvRunner = async (_command, input, onLine) => {
	let sample = 0
	let keyedAt: number | null = null
	let lastOn = 0
	let idsDue: number | null = null
	const ms = (k: number) => (k / AUDIO_RATE_HZ) * 1000
	for await (const chunk of input)
		for (let i = 0; i + 1 < chunk.length; i += 2, sample++) {
			const on = chunk.readInt16LE(i) > 1000
			if (on) lastOn = sample
			if (on && keyedAt === null) {
				keyedAt = sample
				idsDue = sample + 0.36 * AUDIO_RATE_HZ
				onLine("Sync: +DMR  [slot1]  slot2  | Color Code=01 | VC* ")
			}
			if (on && idsDue !== null && sample >= idsDue) {
				onLine(" SLOT 1 TGT=4321 SRC=1234567 Group Call ")
				idsDue = null
			}
			if (!on && keyedAt !== null && ms(sample - lastOn) > 50) {
				onLine("Sync: +DMR  [slot1]  slot2  | Color Code=01 | TLC ")
				onLine(" SLOT 1 TGT=4321 SRC=1234567 Group Call ")
				keyedAt = null
				idsDue = null
			}
		}
}

/**
 * A channelizer double: the carrier's presence per 48 kHz sample (the mean
 * power of the cu8 samples it spans against the midpoint of the extremes), as
 * a 1 kHz tone where present and silence elsewhere. No group delay.
 */
const channelDouble: DvChannelize = async iq => {
	const ratio = 1_024_000 / AUDIO_RATE_HZ
	const n = Math.floor(iq.length / 2 / ratio)
	const power = new Float64Array(n)
	for (let k = 0; k < n; k++) {
		let p = 0
		const a = Math.floor(k * ratio)
		const b = Math.floor((k + 1) * ratio)
		for (let j = a; j < b; j++) {
			const i = iq[2 * j]! - 127.5
			const q = iq[2 * j + 1]! - 127.5
			p += i * i + q * q
		}
		power[k] = p / (b - a)
	}
	let lo = Infinity
	let hi = 0
	for (const p of power) {
		lo = Math.min(lo, p)
		hi = Math.max(hi, p)
	}
	const cf32 = Buffer.alloc(8 * n)
	for (let k = 0; k < n; k++) {
		if (power[k]! < (lo + hi) / 2) continue
		const phase = (2 * Math.PI * 1000 * k) / AUDIO_RATE_HZ
		cf32.writeFloatLE(Math.cos(phase), 8 * k)
		cf32.writeFloatLE(Math.sin(phase), 8 * k + 4)
	}
	return { cf32, groupDelaySamples: 0 }
}

const SCENE: DvScene = {
	name: "double",
	protocol: "dmr",
	dmrMode: "repeater",
	hangMs: 0,
	tailMs: 1000,
	overs: [
		{ startMs: 600, durationMs: 1200 },
		{ startMs: 3000, durationMs: 1800 },
	],
}

describe("feedRealTime", () => {
	it("stamps each line with the audio time it arrived at", async () => {
		// 1 s of silence, 0.5 s keyed, 0.5 s silence.
		const pcm = Buffer.alloc(2 * AUDIO_RATE_HZ * 2)
		for (let k = AUDIO_RATE_HZ; k < 1.5 * AUDIO_RATE_HZ; k++)
			pcm.writeInt16LE(5000, 2 * k)
		const { lines } = await feedRealTime("ignored", pcm, {
			run: decoderDouble,
			speed: 10,
		})
		expect(lines.map(l => l.text.trim().slice(-3))).toEqual([
			"VC*",
			"all",
			"TLC",
			"all",
		])
		// Never before its audio was fed; within a few chunks of it.
		expect(lines[0]!.atMs).toBeGreaterThanOrEqual(1000 - 20)
		expect(lines[0]!.atMs).toBeLessThan(1000 + 200)
		expect(lines[2]!.atMs).toBeGreaterThanOrEqual(1500 - 20)
	})

	it("hands each chunk over at its end time, the last at the end of the audio", async () => {
		// 5 whole chunks and a 10 ms one: due at 20, 40, ... 100 and 110 ms.
		const pcm = Buffer.alloc((2 * ((5 * CHUNK_MS + 10) * AUDIO_RATE_HZ)) / 1000)
		let k = 0
		const stamp: DvRunner = async (_command, input, onLine) => {
			for await (const _chunk of input) onLine(String(k++))
		}
		const { lines } = await feedRealTime("ignored", pcm, { run: stamp })
		const due = [20, 40, 60, 80, 100, 110]
		expect(lines.map(l => l.text)).toEqual(["0", "1", "2", "3", "4", "5"])
		lines.forEach((l, i) => {
			// Never before its end (the feeder waits on performance.now), soon after it.
			expect(l.atMs).toBeGreaterThanOrEqual(due[i]!)
			expect(l.atMs).toBeLessThan(due[i]! + 15)
		})
	})
})

describe("the ready handshake", () => {
	/** 200 ms of silence. */
	const pcm = Buffer.alloc(2 * 0.2 * AUDIO_RATE_HZ)

	it("starts the clock when the runner pulls, not when it starts", async () => {
		// A runner whose command takes 1.5 s to be ready, then prints a line
		// as soon as it reads the first chunk.
		const slow: DvRunner = async (_command, input, onLine) => {
			await new Promise(r => setTimeout(r, 1500))
			for await (const chunk of input) {
				if (chunk.length > 0) onLine("first")
				break
			}
		}
		const { lines } = await feedRealTime("ignored", pcm, { run: slow })
		expect(lines.map(l => l.text)).toEqual(["first"])
		expect(lines[0]!.atMs).toBeGreaterThanOrEqual(0)
		expect(lines[0]!.atMs).toBeLessThan(200)
	}, 10_000)

	/** /bin/sh, after `delay` seconds; records the child. */
	const delayed = (delay: number, kids: { exitCode: number | null }[] = []) =>
		(script => {
			const child = spawn("/bin/sh", ["-c", `sleep ${delay}; ${script}`], {
				stdio: ["pipe", "pipe", "pipe"],
			})
			kids.push(child)
			return child
		}) satisfies DvSpawn

	it("holds the input until the script's marker and drops the marker", async () => {
		const run = createShellRunner({ spawnChild: delayed(1.5) })
		const { lines } = await feedRealTime(
			"sh -c 'head -c 1 >/dev/null; echo first; cat >/dev/null'",
			pcm,
			{ run },
		)
		expect(lines.map(l => l.text)).toEqual(["first"])
		expect(lines.some(l => l.text.includes(DVCAP_READY))).toBe(false)
		// About 0, not the 1 500 ms the container start took.
		expect(lines[0]!.atMs).toBeLessThan(500)
	}, 10_000)

	it("fails a marker later than its wait, and kills the child", async () => {
		const kids: { exitCode: number | null; killed?: boolean }[] = []
		// Within the wait: 0.1 s against 2 s.
		await expect(
			feedRealTime("cat >/dev/null", pcm, {
				run: createShellRunner({
					spawnChild: delayed(0.1),
					readyTimeoutMs: 2000,
				}),
			}),
		).resolves.toEqual({ lines: [] })
		// Past it: 3 s against 300 ms.
		await expect(
			feedRealTime("cat >/dev/null", pcm, {
				run: createShellRunner({
					spawnChild: delayed(3, kids),
					readyTimeoutMs: 300,
				}),
			}),
		).rejects.toThrow(`no ${DVCAP_READY} within 300 ms`)
		expect(kids[0]!.killed).toBe(true)
	}, 10_000)

	it("records a non-zero exit after all the input, with the lines it printed", async () => {
		const run = createShellRunner({ spawnChild: delayed(0) })
		await expect(
			feedRealTime("cat >/dev/null; echo decoded; exit 3", pcm, { run }),
		).resolves.toMatchObject({
			lines: [{ text: "decoded" }],
			exit: "exit 3",
		})
		// Exit 0: nothing recorded.
		await expect(
			feedRealTime("cat >/dev/null; echo decoded", pcm, { run }),
		).resolves.not.toHaveProperty("exit")
	}, 10_000)

	it("fails a non-zero exit before all the input, an exit before the marker and a spawn error, quoting a bounded tail", async () => {
		const run = createShellRunner({ spawnChild: delayed(0) })
		// 2 s of audio (192 kB, more than a pipe holds): the command exits after
		// reading 1 byte, so the rest is never written.
		const long2s = Buffer.alloc(2 * 2 * AUDIO_RATE_HZ)
		await expect(
			feedRealTime("head -c 1 >/dev/null; echo broken; exit 3", long2s, {
				run,
				speed: 20,
			}),
		).rejects.toThrow(
			/exit 3\) before it read all its input.*output tail: broken/s,
		)
		const long = await feedRealTime(
			`head -c 1 >/dev/null; head -c ${4 * STDERR_TAIL_CHARS} /dev/zero | tr '\\0' x; echo; exit 1`,
			long2s,
			{ run, speed: 20 },
		).then(
			() => "",
			(e: unknown) => (e instanceof Error ? e.message : ""),
		)
		expect(long).toMatch(/exit 1/)
		expect(long.length).toBeLessThan(STDERR_TAIL_CHARS + 200)
		await expect(
			feedRealTime("cat", pcm, {
				run: createShellRunner({
					spawnChild: () =>
						spawn("/bin/sh", ["-c", "echo nope >&2; exit 5"], {
							stdio: ["pipe", "pipe", "pipe"],
						}),
				}),
			}),
		).rejects.toThrow(/exited \(5\) before __DVCAP_READY__.*nope/s)
		await expect(
			feedRealTime("cat", pcm, {
				run: createShellRunner({
					spawnChild: () =>
						spawn("/nonexistent/dvcap-binary", [], {
							stdio: ["pipe", "pipe", "pipe"],
						}),
				}),
			}),
		).rejects.toThrow(/ENOENT/)
	}, 10_000)

	it("fails a command that does not exit after EOF, and kills it by its handle", async () => {
		// 10 s: five times a container's stop and removal after EOF.
		expect(POST_EOF_TIMEOUT_MS).toBe(10_000)
		const kids: { exitCode: number | null; killed?: boolean }[] = []
		/** A /bin/sh double that prints the marker, never reads, never exits. */
		const stuck: DvSpawn = () => {
			const child = spawn(
				"/bin/sh",
				["-c", `echo ${DVCAP_READY}; while :; do sleep 0.1; done`],
				{ stdio: ["pipe", "pipe", "pipe"] },
			)
			kids.push(child)
			return child
		}
		const started = performance.now()
		await expect(
			feedRealTime("ignored", pcm, {
				run: createShellRunner({ spawnChild: stuck, postEofTimeoutMs: 300 }),
				speed: 20,
			}),
		).rejects.toThrow(/did not exit within 300 ms after its input ended/)
		expect(kids[0]!.killed).toBe(true)
		// At the bound, not the 10 s default.
		expect(performance.now() - started).toBeLessThan(3000)
		// A command that exits inside the wait passes.
		await expect(
			feedRealTime("cat >/dev/null; sleep 0.1", pcm, {
				run: createShellRunner({
					spawnChild: delayed(0),
					postEofTimeoutMs: 2000,
				}),
			}),
		).resolves.toEqual({ lines: [] })
	}, 10_000)

	it("runs the core image with an init, no network and no tty", () => {
		expect(dockerArgs("img", "echo")).toEqual([
			"run",
			"-i",
			"--init",
			"--rm",
			"--network",
			"none",
			"--entrypoint",
			"/bin/sh",
			"img",
			"-c",
			"echo",
		])
	})

	it("ends stdin and kills the child when the input fails", async () => {
		const kids: { exitCode: number | null; killed?: boolean }[] = []
		const run = createShellRunner({ spawnChild: delayed(0, kids) })
		async function* broken(): AsyncGenerator<Buffer> {
			yield Buffer.alloc(64)
			throw new Error("input failed")
		}
		await expect(
			run("cat >/dev/null; sleep 5", broken(), () => {}),
		).rejects.toThrow("input failed")
		expect(kids[0]!.killed).toBe(true)
	}, 10_000)
})

describe("measureDvPoint with doubles", () => {
	it("maps the plan onto the audio and scores the adapter's calls", async () => {
		const r = await measureDvPoint(
			{
				scene: SCENE,
				variant: "baseline",
				cnrDb: 30,
				errorHz: 0,
				phase: 0,
				seed: 1,
			},
			{ channelize: channelDouble, run: decoderDouble, speed: 10 },
		)
		// Plan ms + fmCu8's 100 ms lead (+ no group delay) = audio ms.
		expect(r.overs[0]!.startMs).toBeCloseTo(600 + 1.7 + LEAD_MS, 0)
		expect(r.rows.map(x => x.calls)).toEqual([1, 1])
		for (const row of r.rows) {
			// The double prints the IDs one superframe in; the call is
			// back-dated to its first voice sync, printed at key-up (call-first).
			expect(row.headCutMs!).toBeGreaterThanOrEqual(-25)
			expect(row.headCutMs!).toBeLessThan(250)
			// And ends at its terminator line, about 50 ms after key-down.
			expect(row.endErrMs!).toBeGreaterThan(0)
			expect(row.endErrMs!).toBeLessThan(400)
			expect(row.framesChecked).toBe(2)
		}
		// The recorded lines are a valid truth scorecard seed.
		const seed = parseDvSeed(
			"recorded.json",
			JSON.stringify(recordedSeed(r, 433_162_500)),
		)
		expect(seed).toMatchObject({
			provisional: false,
			scene: "double-baseline-30db-0hz-p0",
		})
		expect(seed.lines.length).toBe(r.lines.length)
	}, 60_000)

	it("fails a point whose decoder printed no line at all", async () => {
		const mute: DvRunner = async (_command, input) => {
			for await (const _chunk of input) void _chunk
		}
		await expect(
			measureDvPoint(
				{
					scene: SCENE,
					variant: "baseline",
					cnrDb: 30,
					errorHz: 0,
					phase: 0,
					seed: 1,
				},
				{ channelize: channelDouble, run: mute, speed: 20 },
			),
		).rejects.toThrow(/double \(baseline, 30 dB.*no line at all/)
	}, 60_000)

	it("names a recorded seed by its grid point, and the loader refuses two of one name", () => {
		const spec = (over: Partial<DvPointSpec>): DvPointSpec => ({
			scene: SCENE,
			variant: "baseline",
			cnrDb: 20,
			errorHz: 0,
			phase: 0,
			seed: 1,
			...over,
		})
		const names = [
			spec({}),
			spec({ errorHz: -600 }),
			spec({ errorHz: 600 }),
			spec({ phase: 0.25 }),
			spec({ cnrDb: 10 }),
			spec({ variant: "settle-replay" }),
		].map(recordedSceneName)
		expect(names[1]).toBe("double-baseline-20db-m600hz-p0")
		expect(names[3]).toBe("double-baseline-20db-0hz-p25")
		expect(new Set(names).size).toBe(names.length)
		// The longest: every name fits the seed schema's 64 characters.
		const longest = Math.max(
			...DV_SCENES.map(
				s =>
					recordedSceneName(
						spec({
							scene: s,
							variant: "settle-replay",
							errorHz: -600,
							phase: 0.75,
						}),
					).length,
			),
		)
		expect(longest).toBeLessThanOrEqual(64)
		const seed = (scene: string) =>
			JSON.stringify({
				version: 1,
				provisional: false,
				note: "test",
				scene,
				protocol: "dmr",
				frequencyHz: 1,
				overs: [
					{
						index: 0,
						protocol: "dmr",
						slot: 1,
						startMs: 0,
						endMs: 1,
						frames: 1,
						terminator: true,
						clear: true,
						ids: {},
					},
				],
				lines: [],
			})
		const dir = mkdtempSync(join(tmpdir(), "dv-seeds-"))
		try {
			writeFileSync(join(dir, "dv-latency-a.json"), seed(names[0]!))
			writeFileSync(join(dir, "dv-latency-b.json"), seed(names[1]!))
			expect(loadDvCases(dir).map(c => c.name)).toEqual([
				`dv-${names[0]}`,
				`dv-${names[1]}`,
			])
			writeFileSync(join(dir, "dv-latency-c.json"), seed(names[0]!))
			expect(() => loadDvCases(dir)).toThrow(
				/dv-latency-c\.json: case dv-double-baseline-20db-0hz-p0 is already dv-latency-a\.json's/,
			)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("shifts the overs past each settle replay copy", async () => {
		const r = await measureDvPoint(
			{
				scene: SCENE,
				variant: "settle-replay",
				cnrDb: 30,
				errorHz: 0,
				phase: 0,
				seed: 1,
			},
			{ channelize: channelDouble, run: decoderDouble, speed: 10 },
		)
		expect(r.overs[0]!.startMs).toBeCloseTo(600 + 1.7 + LEAD_MS + 360, 0)
		expect(r.overs[1]!.startMs).toBeCloseTo(3000 + 1.7 + LEAD_MS + 720, 0)
		// The copy keys the double up 360 ms early: the call starts at key-up.
		for (const row of r.rows) expect(row.headCutMs!).toBeLessThan(250)
	}, 60_000)

	it("writes the table after every point and keeps a failed point as a row", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dv-grid-"))
		const out = join(dir, "capture.md")
		const linesDir = join(dir, "lines")
		const spec = (cnrDb: number): DvPointSpec => ({
			scene: SCENE,
			variant: "baseline",
			cnrDb,
			errorHz: 0,
			phase: 0,
			seed: cnrDb,
		})
		const seen: string[] = []
		try {
			mkdirSync(linesDir)
			const { points, failed } = await runDvGrid(
				[spec(30), spec(10), spec(20)],
				{
					measure: async s => {
						// The table on disk already holds every earlier point.
						if (s.cnrDb !== 30) seen.push(readFileSync(out, "utf8"))
						if (s.cnrDb === 10) throw new Error("decoder | crashed\nbadly")
						return measureDvPoint(s, {
							channelize: channelDouble,
							run: decoderDouble,
							speed: 20,
						})
					},
					out,
					linesDir,
					frequencyHz: 433_162_500,
				},
			)
			expect(points.map(p => p.error ?? "ok")).toEqual([
				"ok",
				"decoder | crashed\nbadly",
				"ok",
			])
			expect(failed.map(p => p.cnrDb)).toEqual([10])
			expect(seen[0]).toContain("| double | baseline | 30 dB | 0 Hz | 0 | 2 |")
			expect(seen[1]).toContain("failed: decoder \\| crashed badly")
			const final = readFileSync(out, "utf8")
			expect(final).toContain("| double | baseline | 10 dB | 0 Hz | 1 | 0 |")
			expect(final).toContain("| double | baseline | 20 dB | 0 Hz | 0 | 2 |")
			// No temporary file is left; seeds only for the measured points, valid.
			expect(readdirSync(dir).sort()).toEqual(["capture.md", "lines"])
			const seeds = readdirSync(linesDir).sort()
			expect(seeds).toEqual([
				"dv-latency-double-baseline-20db-0hz-p0.json",
				"dv-latency-double-baseline-30db-0hz-p0.json",
			])
			for (const f of seeds)
				parseDvSeed(f, readFileSync(join(linesDir, f), "utf8"))
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	}, 60_000)

	it("stops after DV_GRID_ABORT_STREAK (3) consecutive identical failures, not after other or interrupted ones", async () => {
		expect(DV_GRID_ABORT_STREAK).toBe(3)
		const dir = mkdtempSync(join(tmpdir(), "dv-grid-"))
		const out = join(dir, "capture.md")
		const spec = (cnrDb: number): DvPointSpec => ({
			scene: SCENE,
			variant: "baseline",
			cnrDb,
			errorHz: 0,
			phase: 0,
			seed: cnrDb,
		})
		const grid = [10, 12, 15, 20, 30].map(spec)
		try {
			const same = await runDvGrid(grid, {
				measure: () => Promise.reject(new Error("no image")),
				out,
				frequencyHz: 433_162_500,
			})
			// The third identical failure stops the run: 2 points never ran.
			expect(same.points).toHaveLength(3)
			expect(same.failed).toHaveLength(3)
			expect(same.aborted).toBe("no image")
			// Two alike, then another error, then two alike again: never three in a row.
			const errors = ["a", "a", "b", "a", "a"]
			let k = 0
			const mixed = await runDvGrid(grid, {
				measure: () => Promise.reject(new Error(errors[k++])),
				out,
				frequencyHz: 433_162_500,
			})
			expect(mixed.points).toHaveLength(5)
			expect(mixed.aborted).toBeUndefined()
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("counts a point whose decoder was killed by a signal in the summary row", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dv-grid-"))
		const out = join(dir, "capture.md")
		const at = (cnrDb: number): DvPointSpec => ({
			scene: SCENE,
			variant: "baseline",
			cnrDb: 20,
			errorHz: 0,
			phase: cnrDb,
			seed: cnrDb,
		})
		try {
			const exits = ["SIGSEGV", "exit 3", undefined]
			let k = 0
			await runDvGrid([at(0), at(0.25), at(0.5)], {
				measure: s => {
					const exit = exits[k++]
					return Promise.resolve({
						spec: s,
						rows: [],
						overs: [],
						lines: [],
						...(exit === undefined ? {} : { exit }),
					})
				},
				out,
				frequencyHz: 433_162_500,
			})
			// One of three points signalled; a non-zero exit is not abnormal.
			expect(readFileSync(out, "utf8")).toMatch(
				/^\| double \| baseline \| 20 dB \| 0 Hz \| 0 \|.* \| 1 \|$/m,
			)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("fails a point whose recorded seed the scorecard would refuse", async () => {
		const dir = mkdtempSync(join(tmpdir(), "dv-grid-"))
		try {
			const { failed } = await runDvGrid(
				[
					{
						// A scene name the seed schema refuses (upper case).
						scene: { ...SCENE, name: "Bad" },
						variant: "baseline",
						cnrDb: 30,
						errorHz: 0,
						phase: 0,
						seed: 1,
					},
				],
				{
					measure: s =>
						measureDvPoint(s, {
							channelize: channelDouble,
							run: decoderDouble,
							speed: 20,
						}),
					out: join(dir, "capture.md"),
					linesDir: dir,
					frequencyHz: 433_162_500,
				},
			)
			expect(failed[0]!.error).toMatch(/dv-latency-Bad-baseline.*scene/)
			expect(readdirSync(dir)).toEqual(["capture.md"])
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	}, 60_000)
})
