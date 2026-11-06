/**
 * The real wavekit-chan under the real ChannelizerManager and FanoutManager, with tones that identify each centre.
 * tests/unit/core/channelizer/recenter.test.ts fakes the process and tests/process.rs runs the binary alone; only here
 * do the two meet. Nothing connects anywhere: the IQ comes from this file.
 *
 * Skipped unless WAVEKIT_CHAN_BIN names a build of native/wavekit-chan:
 *
 *   CARGO_TARGET_DIR=/tmp/chan cargo build --release --locked --manifest-path native/wavekit-chan/Cargo.toml
 *   WAVEKIT_CHAN_BIN=/tmp/chan/release/wavekit-chan \
 *     pnpm exec vitest run --maxWorkers=1 tests/integration/channelizer-recenter-real-binary.test.ts
 *
 * WAVEKIT_CHAN_OLD_BIN additionally names a build older than the `recenter` capability, for the mismatch case; the
 * same case with a test double is always run in recenter.test.ts. Times here are waits for output to arrive, each with
 * a long limit: every verdict is on the bytes.
 */
import { spawn } from "node:child_process"
import { EventEmitter, once } from "node:events"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import type { Readable } from "node:stream"
import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ChannelizerConfigSchema, type SourceCaps } from "../../src/config.js"
import {
	recenterSettleBytes,
	type ChannelizerManagerDeps,
} from "../../src/core/channelizer/channelizer-manager.js"
import { ChannelizerManager } from "../../src/core/channelizer/channelizer-manager.js"
import { parseEventLine } from "../../src/core/channelizer/protocol.js"
import { FanoutManager } from "../../src/core/fanout-manager.js"
import { parseDemodEventLine } from "../../src/core/live-demod/rust-protocol.js"

const bin = process.env["WAVEKIT_CHAN_BIN"]
const oldBin = process.env["WAVEKIT_CHAN_OLD_BIN"]
const RATE = 2_048_000
const OUTPUT_RATE = 48_000
const OFFSET = -200_000
const ARRIVAL = { timeout: 20_000, interval: 10 }

const request = (rf: number) => ({
	centerHz: rf,
	bandwidthHz: 45_600,
	transitionHz: 1200,
	outputRateHz: OUTPUT_RATE,
	format: "cf32" as const,
})

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

function rig(
	binaryPath: string,
	linkBurst?: NonNullable<ChannelizerManagerDeps["routing"]["linkBurst"]>,
) {
	let caps: SourceCaps = {
		kind: "iq",
		format: "U8_IQ",
		sampleRate: RATE,
		centerFreq: 162e6,
		exclusive: false,
	}
	const logged: string[] = []
	const logger = pino(
		{ level: "warn" },
		{
			write: (line: string) => {
				logged.push((JSON.parse(line) as { msg: string }).msg)
			},
		},
	)
	const sources = Object.assign(new EventEmitter(), { getCaps: () => caps })
	const fanout = new FanoutManager(pino({ level: "silent" }))
	const dir = mkdtempSync("/tmp/wkc-rc-")
	const manager = new ChannelizerManager({
		sourceManager:
			sources as unknown as ChannelizerManagerDeps["sourceManager"],
		routing: {
			getFanout: () => fanout,
			releaseUnused: () => {},
			...(linkBurst ? { linkBurst } : {}),
		},
		logger,
		config: ChannelizerConfigSchema.parse({
			enabled: true,
			socketDir: dir,
			binaryPath,
		}),
	})
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
	cleanup.push(() => fanout.destroy())
	cleanup.push(() => manager.destroy())
	return {
		fanout,
		manager,
		logged,
		move(centerFreq: number) {
			caps = { ...caps, centerFreq }
			sources.emit("caps-changed", "s", caps)
		},
		request: (id: string, rf: number) =>
			manager.requestChannel("s", id, request(rf), caps),
	}
}

/** A phase-continuous cu8 tone at `hz` from the capture centre. */
class Tone {
	private phase = 0
	constructor(private readonly hz: number) {}
	chunk(samples: number): Buffer {
		const out = Buffer.allocUnsafe(samples * 2)
		const step = (2 * Math.PI * this.hz) / RATE
		for (let i = 0; i < samples; i++) {
			out[2 * i] = Math.round(127.5 + 100 * Math.cos(this.phase))
			out[2 * i + 1] = Math.round(127.5 + 100 * Math.sin(this.phase))
			this.phase += step
		}
		return out
	}
}

/** The output, cf32: tone per 64-sample block for each block with signal. */
function sink(stream: Readable) {
	const parts: Buffer[] = []
	stream.on("data", (d: Buffer) => parts.push(d))
	stream.on("error", () => {})
	return {
		samples: () => parts.reduce((sum, p) => sum + p.length, 0) >> 3,
		tones() {
			const buf = Buffer.concat(parts)
			const n = Math.floor(buf.length / 8)
			const blocks = new Map<number, number>()
			for (let k = 0; k + 64 <= n; k += 64) {
				let re = 0
				let im = 0
				let power = 0
				for (let i = k + 1; i < k + 64; i++) {
					const a = buf.readFloatLE(8 * i)
					const b = buf.readFloatLE(8 * i + 4)
					const c = buf.readFloatLE(8 * (i - 1))
					const d = buf.readFloatLE(8 * (i - 1) + 4)
					re += a * c + b * d
					im += b * c - a * d
					power += a * a + b * b
				}
				if (power / 63 < 0.05) continue
				const hz =
					Math.round(
						((Math.atan2(im, re) / (2 * Math.PI)) * OUTPUT_RATE) / 100,
					) * 100
				blocks.set(hz, (blocks.get(hz) ?? 0) + 1)
			}
			return [...blocks.entries()]
		},
	}
}

const sleep = (ms: number) =>
	new Promise<void>(resolve => {
		setTimeout(resolve, ms)
	})
/** The channel's baseband tone that identifies hop `k`. */
const hopTone = (k: number) => 2_500 * ((k % 7) - 3) + 1_000
const others = (tones: [number, number][], hz: number) =>
	tones.filter(([seen]) => Math.abs(seen - hz) > 200)

/** A slow reader's queue overflow is ordinary here; a move that was not taken is not. */
const moveFailures = (logged: string[]) =>
	logged.filter(msg => /centre move|recenter/i.test(msg))

/** Feeds `tone` until stopped: a source keeps delivering while a test waits. */
function pump(fanout: FanoutManager, tone: Tone) {
	let running = true
	const done = (async () => {
		while (running) {
			fanout.distribute(tone.chunk(4096))
			await sleep(2)
		}
	})()
	return async () => {
		running = false
		await done
	}
}

describe.skipIf(!bin || !existsSync(bin))(
	"wavekit-chan under the manager",
	() => {
		const path = bin ?? ""

		it("its `ready` offers recenter, and both parents of this binary accept that line", async () => {
			const child = spawn(
				path,
				[
					...["--generation", "1", "--input-format", "cu8"],
					...["--input-rate", String(RATE), "--input-center", "100000000"],
					...["--usable-fraction", "0.8", "--block-samples", "16384"],
					...["--socket-dir", "/tmp", "--control-fd", "3"],
				],
				{ stdio: ["pipe", "pipe", "ignore", "pipe"] },
			)
			cleanup.push(() => {
				child.kill()
			})
			if (!child.stdout) throw new Error("no stdout")
			const [chunk] = (await once(child.stdout, "data")) as [Buffer]
			const line = chunk.toString().split("\n")[0] ?? ""
			const parsed = parseEventLine(line)
			expect(parsed).toMatchObject({
				ok: true,
				event: { type: "ready", recenter: true },
			})
			// Live demod reads the same binary with its own strict schema, and a line it cannot parse fails its start.
			expect(parseDemodEventLine(line)).toMatchObject({
				ok: true,
				event: { type: "ready" },
			})
		}, 30_000)

		it("one hop with an IQ backlog: nothing of the old centre reaches the reopened channel", async () => {
			const r = rig(path)
			const first = await r.request("d", 162e6 + OFFSET)
			if (!first.ok) throw new Error(first.detail)
			sink(first.stream)
			const old = new Tone(OFFSET + hopTone(0))
			// 1.3 MB of old-centre IQ pushed at once, just before the move.
			for (let i = 0; i < 40; i++) r.fanout.distribute(old.chunk(16_384))
			r.move(162.5e6)
			const stop = pump(r.fanout, new Tone(OFFSET + hopTone(1)))
			const second = await r.request("d", 162.5e6 + OFFSET)
			if (!second.ok) throw new Error(second.detail)
			const out = sink(second.stream)
			await vi.waitFor(
				() => expect(out.samples()).toBeGreaterThan(4800),
				ARRIVAL,
			)
			await stop()
			expect(second.generation).toBe(first.generation)
			expect(others(out.tones(), hopTone(1))).toEqual([])
			expect(out.tones().length).toBeGreaterThan(0)
			expect(moveFailures(r.logged)).toEqual([])
		}, 60_000)

		it("reopen cycles on one id and generation: never deaf, never the wrong tone", async () => {
			const r = rig(path)
			let centre = 162e6
			let hop = 0
			let tone = new Tone(OFFSET + hopTone(hop))
			let running = true
			const feeding = (async () => {
				while (running) {
					r.fanout.distribute(tone.chunk(4096))
					await sleep(2)
				}
			})()
			for (; hop < 30; hop++) {
				const grant = await r.request("d", centre + OFFSET)
				if (!grant.ok) throw new Error(grant.detail)
				const out = sink(grant.stream)
				if (hop % 3 !== 0) {
					await vi.waitFor(
						() => expect(out.samples()).toBeGreaterThan(640),
						ARRIVAL,
					)
					expect(others(out.tones(), hopTone(hop))).toEqual([])
				}
				centre += 100_000
				tone = new Tone(OFFSET + hopTone(hop + 1))
				r.move(centre)
			}
			running = false
			await feeding
			expect(r.manager.currentGeneration("s")).toBe(1)
			expect(moveFailures(r.logged)).toEqual([])
		}, 120_000)

		it("a hop storm faster than a block, then settled: only the last hop's tone", async () => {
			const r = rig(path)
			const first = await r.request("d", 162e6 + OFFSET)
			if (!first.ok) throw new Error(first.detail)
			let hop = 0
			let centre = 162e6
			const raced: Promise<{ ok: boolean; race?: boolean }>[] = []
			for (; hop < 300; hop++) {
				const chunk = new Tone(OFFSET + hopTone(hop)).chunk(256)
				// An odd byte split on some hops.
				if (hop % 5 === 0) {
					r.fanout.distribute(chunk.subarray(0, 101))
					r.fanout.distribute(chunk.subarray(101))
				} else r.fanout.distribute(chunk)
				centre += 25_000
				r.move(centre)
				if (hop % 20 === 0) raced.push(r.request(`d${hop}`, centre + OFFSET))
				if (hop % 10 === 0) await sleep(0)
			}
			const stop = pump(r.fanout, new Tone(OFFSET + hopTone(hop)))
			const grant = await r.request("final", centre + OFFSET)
			if (!grant.ok) throw new Error(grant.detail)
			const out = sink(grant.stream)
			await vi.waitFor(
				() => expect(out.samples()).toBeGreaterThan(4800),
				ARRIVAL,
			)
			await stop()
			expect(others(out.tones(), hopTone(hop))).toEqual([])
			for (const result of await Promise.all(raced))
				if (!result.ok) expect(result.race).toBe(true)
			expect(grant.generation).toBe(first.generation)
			expect(moveFailures(r.logged)).toEqual([])
		}, 60_000)

		it("real drops before the move: the position stays honest", async () => {
			const r = rig(path)
			const first = await r.request("d", 162e6 + OFFSET)
			if (!first.ok) throw new Error(first.detail)
			sink(first.stream)
			const old = new Tone(OFFSET + hopTone(0)).chunk(32_768)
			for (let i = 0; i < 3000; i++) r.fanout.distribute(old)
			const id = r.fanout.getBranchIds()[0]!
			expect(
				r.fanout.getBranchTelemetry(id)!.droppedBytesTotal,
			).toBeGreaterThan(0)
			r.move(163e6)
			await Promise.resolve()
			const stop = pump(r.fanout, new Tone(OFFSET + hopTone(1)))
			const second = await r.request("d", 163e6 + OFFSET)
			if (!second.ok) throw new Error(second.detail)
			const out = sink(second.stream)
			await vi.waitFor(() => expect(out.samples()).toBeGreaterThan(4800), {
				...ARRIVAL,
				timeout: 40_000,
			})
			await stop()
			expect(others(out.tones(), hopTone(1))).toEqual([])
		}, 90_000)

		it("more moves than the process may hold pending: it refuses, and the next request starts a new generation", async () => {
			const r = rig(path)
			const first = await r.request("d", 162e6 + OFFSET)
			if (!first.ok) throw new Error(first.detail)
			sink(first.stream)
			// No input follows: every position, in the settle margin past the last byte, stays ahead of the input.
			r.fanout.distribute(new Tone(OFFSET).chunk(4096))
			let centre = 162e6
			for (let k = 0; k < 600; k++) {
				centre += 10_000
				r.move(centre)
			}
			await vi.waitFor(
				() =>
					expect(r.logged).toContain(
						"wavekit-chan refused a centre move; retiring it",
					),
				ARRIVAL,
			)
			const grant = await r.request("d", centre + OFFSET)
			if (!grant.ok) throw new Error(grant.detail)
			expect(grant.generation).toBe(first.generation + 1)
		}, 60_000)

		describe("the settle margin, old-centre IQ still arriving after the caps event", () => {
			const SETTLE_SAMPLES = recenterSettleBytes(RATE) / 2
			const OLD_TONE = 6_000
			const NEW_TONE = -6_000
			/** `late` samples of the old centre after the move, then the new: counted in samples, so no clock decides it. */
			const trial = async (late: number) => {
				const r = rig(path)
				const first = await r.request("d", 162e6 + OFFSET)
				if (!first.ok) throw new Error(first.detail)
				sink(first.stream)
				r.fanout.distribute(new Tone(OFFSET + OLD_TONE).chunk(4096))
				r.move(162.5e6)
				const pendingGrant = r.request("d", 162.5e6 + OFFSET)
				const grant = await pendingGrant
				if (!grant.ok) throw new Error(grant.detail)
				const out = sink(grant.stream)
				const old = new Tone(OFFSET + OLD_TONE)
				for (let left = late; left > 0; left -= 4096)
					r.fanout.distribute(old.chunk(Math.min(4096, left)))
				const stop = pump(r.fanout, new Tone(OFFSET + NEW_TONE))
				await vi.waitFor(
					() => expect(out.samples()).toBeGreaterThan(4800),
					ARRIVAL,
				)
				await stop()
				const blocks = (centre: number) =>
					out
						.tones()
						.filter(([hz]) => Math.abs(hz - centre) < 1500)
						.reduce((sum, [, count]) => sum + count, 0)
				return {
					oldMs: (blocks(OLD_TONE) * 64 * 1000) / OUTPUT_RATE,
					newMs: (blocks(NEW_TONE) * 64 * 1000) / OUTPUT_RATE,
				}
			}

			it("hides 20 ms of late IQ, and all of the 35 ms it allows", async () => {
				for (const late of [
					Math.floor((RATE * 20) / 1000),
					SETTLE_SAMPLES - 8192,
					SETTLE_SAMPLES,
				]) {
					const { oldMs, newMs } = await trial(late)
					expect(oldMs).toBe(0)
					expect(newMs).toBeGreaterThan(0)
				}
			}, 90_000)

			it("past it, leaks no more than the excess: 65 ms for 100 ms late, less the filter's blur", async () => {
				const { oldMs, newMs } = await trial(Math.floor((RATE * 100) / 1000))
				expect(oldMs).toBeGreaterThan(0)
				expect(oldMs).toBeLessThanOrEqual(65 + (64 * 1000) / OUTPUT_RATE)
				expect(newMs).toBeGreaterThan(0)
			}, 60_000)
		})

		it("IQ an absorber holds when the generation starts is not given to the first channel", async () => {
			const held = 262_144
			const counters = { heldBytes: held }
			const burst = {
				absorber: { counters: () => counters },
			} as unknown as ReturnType<
				NonNullable<ChannelizerManagerDeps["routing"]["linkBurst"]>
			>
			const r = rig(path, () => burst)
			const grant = await r.request("d", 162e6 + OFFSET)
			if (!grant.ok) throw new Error(grant.detail)
			const out = sink(grant.stream)
			const old = new Tone(OFFSET + hopTone(0))
			// The absorber releases what it held to the new branch, then the live input follows.
			for (let left = held / 2; left > 0; left -= 8192) {
				counters.heldBytes -= 16_384
				r.fanout.distribute(old.chunk(8192))
			}
			const stop = pump(r.fanout, new Tone(OFFSET + hopTone(1)))
			await vi.waitFor(
				() => expect(out.samples()).toBeGreaterThan(4800),
				ARRIVAL,
			)
			await stop()
			expect(others(out.tones(), hopTone(1))).toEqual([])
			expect(moveFailures(r.logged)).toEqual([])
		}, 60_000)

		it("a source stall leaves partial input flowing (coalesced reads)", async () => {
			const r = rig(path)
			const first = await r.request("d", 162e6 + OFFSET)
			if (!first.ok) throw new Error(first.detail)
			const out = sink(first.stream)
			// Far less than a block, then silence.
			r.fanout.distribute(new Tone(OFFSET + hopTone(0)).chunk(2_000))
			await vi.waitFor(() => expect(out.samples()).toBeGreaterThan(0), ARRIVAL)
		}, 30_000)

		it.skipIf(!oldBin || !existsSync(oldBin))(
			"a binary older than the capability is restarted, so the new hop's tone is the one delivered",
			async () => {
				const r = rig(oldBin ?? "")
				const first = await r.request("d", 162e6 + OFFSET)
				if (!first.ok) throw new Error(first.detail)
				sink(first.stream)
				// A small hop: the wanted RF stays inside what the old binary still takes for the capture.
				r.move(162.1e6)
				const stop = pump(r.fanout, new Tone(OFFSET + hopTone(2)))
				const second = await r.request("d", 162.1e6 + OFFSET)
				if (!second.ok) throw new Error(second.detail)
				const out = sink(second.stream)
				await vi.waitFor(
					() => expect(out.samples()).toBeGreaterThan(4800),
					ARRIVAL,
				)
				await stop()
				expect(second.generation).toBe(first.generation + 1)
				expect(others(out.tones(), hopTone(2))).toEqual([])
				expect(out.tones().length).toBeGreaterThan(0)
				expect(r.logged.join("\n")).toContain("does not take recenter")
			},
			60_000,
		)
	},
)
