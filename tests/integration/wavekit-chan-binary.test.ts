import { afterAll, afterEach, describe, expect, it } from "vitest"
import { mkdirSync, rmSync } from "node:fs"
import { createConnection, type Socket } from "node:net"
import type { Writable } from "node:stream"
import fc from "fast-check"
import pino from "pino"
import { admitChannel } from "../../src/core/channelizer/admission.js"
import { ChannelizerProcess } from "../../src/core/channelizer/channelizer-process.js"
import type {
	ChannelizerEvent,
	ChannelizerRequest,
} from "../../src/core/channelizer/protocol.js"

// Opt in against a host build of the real process (`make chan-build`):
// WAVEKIT_CHAN_BIN=native/wavekit-chan/target/release/wavekit-chan
const bin = process.env["WAVEKIT_CHAN_BIN"]
const logger = pino({ level: "silent" })
const CENTER = 100e6
const FRACTION = 0.8
const FS = 2_048_000
// Short and under /tmp: macOS caps a Unix socket path at ~104 bytes.
const root = `/tmp/wkc-bin-${process.pid}`

type Ev<T extends ChannelizerEvent["type"]> = Extract<
	ChannelizerEvent,
	{ type: T }
>
const is =
	<T extends ChannelizerEvent["type"]>(type: T, id?: string) =>
	(e: ChannelizerEvent): e is Ev<T> =>
		e.type === type && (id === undefined || ("id" in e && e.id === id))

/** Everything a test spawned or connected, torn down after it whatever the outcome. */
const procs: ChannelizerProcess[] = []
const sockets: Socket[] = []
const protocolErrors: string[] = []
let spawned = 0

afterEach(async () => {
	for (const s of sockets.splice(0)) s.destroy()
	await Promise.all(procs.splice(0).map(p => p.stop()))
	// Property 14 for every test: each line the process wrote parsed with the v1 schema.
	expect(protocolErrors.splice(0)).toEqual([])
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`${what}: not within ${ms} ms`)),
			ms,
		)
		promise.then(
			v => {
				clearTimeout(timer)
				resolve(v)
			},
			(err: unknown) => {
				clearTimeout(timer)
				reject(err instanceof Error ? err : new Error(String(err)))
			},
		)
	})
}

async function until(cond: () => boolean, ms: number, what: string) {
	const deadline = Date.now() + ms
	while (!cond()) {
		if (Date.now() > deadline) throw new Error(`${what}: not within ${ms} ms`)
		await new Promise(r => setTimeout(r, 10))
	}
}

async function spawnChan(fs: number) {
	const socketDir = `${root}/${spawned++}`
	mkdirSync(socketDir, { recursive: true })
	const p = new ChannelizerProcess(
		{
			binaryPath: bin!,
			generation: 1,
			inputRateHz: fs,
			inputCenterHz: CENTER,
			usableFraction: FRACTION,
			blockSamples: 16384,
			socketDir,
			readyTimeoutMs: 5000,
			stopTimeoutMs: 2000,
		},
		logger,
	)
	const events: ChannelizerEvent[] = []
	p.on("event", (e: ChannelizerEvent) => events.push(e))
	p.on("protocol-error", (line: string, error: string) =>
		protocolErrors.push(`${line} -> ${error}`),
	)
	const exit = new Promise<number | null>(resolve =>
		p.once("exit", (code: number | null) => resolve(code)),
	)
	procs.push(p)
	await p.start()
	/** The first event, already received or still to come, that matches. */
	const next = <E extends ChannelizerEvent>(
		match: (e: ChannelizerEvent) => e is E,
		ms = 5000,
	): Promise<E> => {
		const seen = events.find(match)
		if (seen) return Promise.resolve(seen)
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				p.off("event", on)
				reject(new Error(`no matching event within ${ms} ms`))
			}, ms)
			const on = (e: ChannelizerEvent) => {
				if (!match(e)) return
				clearTimeout(timer)
				p.off("event", on)
				resolve(e)
			}
			p.on("event", on)
		})
	}
	return {
		p,
		events,
		next,
		exited: () => within(exit, 5000, "process exit"),
	}
}

function connect(path: string): Socket {
	const s = createConnection(path)
	// A client the process shut down or closed may see EPIPE/ECONNRESET; that is the point of some tests.
	s.on("error", () => {})
	sockets.push(s)
	return s
}

/** Collects a client's bytes; `closed` resolves with all of them once the process closes the socket. */
function collect(s: Socket) {
	const chunks: Buffer[] = []
	s.on("data", (b: Buffer) => chunks.push(b))
	const closed = new Promise<Buffer>(resolve =>
		s.once("close", () => resolve(Buffer.concat(chunks))),
	)
	return {
		bytes: () => chunks.reduce((n, b) => n + b.length, 0),
		closed: () => within(closed, 5000, "client close"),
	}
}

/** Broadband CU8 test input, as in the crate's runtime tests. */
function iq(samples: number, mul: number): Buffer {
	const b = Buffer.alloc(2 * samples)
	for (let k = 0; k < b.length; k++) b[k] = (k * mul) % 256
	return b
}

const open48k = (
	id: string,
	centerHz: number,
	queueBytes: number,
): ChannelizerRequest => ({
	v: 1,
	type: "open",
	id,
	centerHz,
	bandwidthHz: 45_600,
	transitionHz: 1_200,
	outputRateHz: 48_000,
	format: "cf32",
	queueBytes,
})
/** Always `rejected` (channel-outside-capture): answers in control order, so it fences the requests before it. */
const fence = (id: string) => open48k(id, CENTER + 10e6, 96_000)

describe.skipIf(!bin)("wavekit-chan binary", () => {
	// Feature: core-channelizer, Property 1: Admission agreement
	// Validates: addendum §11, §12.1
	it("agrees with admitChannel on random requests", async () => {
		const OUT_RATES = [12_000, 24_000, 48_000, 250_000, 384_000, 1_050_000]
		// A uniform integer rate rarely has a rational split for these outputs (PF5), so a uniform
		// whole-kHz rate is checked too, to see admitted channels open away from the pinned rates.
		const [randomFs = 2_000_000] = fc.sample(
			fc.noBias(fc.integer({ min: 1_800_000, max: 2_800_000 })),
			1,
		)
		const [randomKhz = 2_000] = fc.sample(
			fc.noBias(fc.integer({ min: 1_800, max: 2_800 })),
			1,
		)
		const rates = [
			["2.048", 2_048_000],
			["2.4", 2_400_000],
			["random", randomFs],
			["random-kHz", randomKhz * 1_000],
		] as const
		for (const [kind, fs] of rates) {
			const chan = await spawnChan(fs)
			const tally = { opened: 0, outside: 0, invalid: 0, noFeasibleSplit: 0 }
			const limit = (fs * FRACTION) / 2
			let n = 0
			await fc.assert(
				fc.asyncProperty(
					fc.record({
						off: fc.double({ min: -1.5e6, max: 1.5e6, noNaN: true }),
						// Pins |Δf| + bw/2 + tr within ±2 Hz of the usable half-span.
						edge: fc.option(fc.double({ min: -2, max: 2, noNaN: true }), {
							nil: undefined,
						}),
						out: fc.constantFrom(...OUT_RATES),
						bwF: fc.double({ min: 0.5, max: 0.99, noNaN: true }),
						// PF5: transitions of at least 5% of the output rate.
						trF: fc.double({ min: 0.05, max: 0.2, noNaN: true }),
						// The §2 default passband, bw = out·(1−t), tr = out·t/2, sits on bw/2 + tr = out/2.
						defaultPassband: fc.boolean(),
						format: fc.constantFrom("cu8" as const, "cf32" as const),
					}),
					async c => {
						const id = `p1-${n++}`
						const bandwidthHz = c.defaultPassband
							? c.out * (1 - 2 * c.trF)
							: c.out * c.bwF
						const transitionHz = c.out * c.trF
						const halfOccupied = bandwidthHz / 2 + transitionHz
						const off =
							c.edge === undefined
								? c.off
								: Math.sign(c.off || 1) * (limit - halfOccupied + c.edge)
						const req = {
							centerHz: CENTER + off,
							bandwidthHz,
							transitionHz,
							outputRateHz: c.out,
							format: c.format,
						}
						chan.p.send({ v: 1, type: "open", id, ...req, queueBytes: 1 << 16 })
						const e = await chan.next(
							(x): x is Ev<"opened"> | Ev<"rejected"> =>
								(x.type === "opened" || x.type === "rejected") && x.id === id,
							// Some rates need a long prototype, designed on the process's main thread.
							15_000,
						)
						const verdict = admitChannel(
							req,
							{ sampleRateHz: fs, centerHz: CENTER },
							FRACTION,
						)
						// PF5: away from the two pinned rates the process may find no rational split for an admitted
						// request. Its verdict is final there (the manager suspends the channel), so count it.
						if (
							kind.startsWith("random") &&
							verdict.admitted &&
							e.type === "rejected" &&
							e.detail.includes("no feasible rational split")
						) {
							tally.noFeasibleSplit++
							return
						}
						const expected = verdict.admitted ? "opened" : verdict.reasonCode
						const actual = e.type === "opened" ? "opened" : e.reasonCode
						expect(
							actual,
							`fs=${fs} ${JSON.stringify(req)} ${e.type === "rejected" ? e.detail : ""}`,
						).toBe(expected)
						if (e.type === "rejected") {
							tally[
								e.reasonCode === "channel-outside-capture"
									? "outside"
									: "invalid"
							]++
							return
						}
						tally.opened++
						expect(e).toMatchObject({
							generation: 1,
							outputRateHz: c.out,
							format: c.format,
						})
						chan.p.send({ v: 1, type: "close", id })
						expect(await chan.next(is("closed", id))).toMatchObject({
							reason: "requested",
						})
					},
				),
				{ numRuns: 100 },
			)
			// Agreement stats for the run log (the random rate changes every run).
			process.stdout.write(
				`[Property 1] fs=${fs} (${kind}) ${JSON.stringify(tally)}\n`,
			)
			await chan.p.stop()
		}
	}, 180_000)

	// Feature: core-channelizer, Property 14: Protocol validity
	// Validates: addendum §11, §12.14
	it("answers every malformed request with exactly one rejected and keeps serving", async () => {
		const chan = await spawnChan(FS)
		const control = (chan.p as unknown as { control: Writable }).control
		const good = open48k("m", CENTER, 96_000) as Record<string, unknown>
		const without = (k: string) =>
			Object.fromEntries(Object.entries(good).filter(([key]) => key !== k))
		const malformed: unknown[] = [
			{ ...good, v: 2 },
			{ ...good, v: "1" },
			without("v"),
			{ ...good, type: "explode" },
			{ ...good, id: "bad id!" },
			{ ...good, id: "" },
			{ ...good, id: 7 },
			{ ...good, id: "a".repeat(100) }, // PF7: echoed cut to 64
			{ ...good, extra: 1 },
			without("centerHz"),
			{ ...good, centerHz: "1e8" },
			{ ...good, outputRateHz: 48_000.5 },
			{ ...good, outputRateHz: 4_096_000 },
			{ ...good, bandwidthHz: -1 },
			{ ...good, bandwidthHz: 48_000 },
			{ ...good, centerHz: CENTER + 2e6 },
			{ ...good, format: "cs16" },
			{ ...good, gain: 2 },
			{ ...good, format: "cu8", gain: 0 },
			{ ...good, format: "cu8", gain: 1e7 }, // above MAX_GAIN (protocol.rs)
			{ ...good, format: "cu8", gain: 1e-39 }, // below MIN_GAIN: an f32 subnormal
			{ ...good, queueBytes: 0 },
			{ ...good, queueBytes: 4 }, // below one cf32 sample
			{ ...good, queueBytes: 64 * 1024 * 1024 + 1 },
			{ v: 1, type: "close" },
			{ v: 1, type: "close", id: "m", reason: "x" },
			{ v: 1, type: "mark-gap", atInputByte: -1 },
			{ v: 1, type: "shutdown", id: "m" },
			[1],
			"open",
			null,
			42,
		]
		const line = fc.oneof(
			fc
				.string({ unit: "binary", maxLength: 200 })
				.map(s => Buffer.from(s.replace(/\n/g, " "))),
			fc
				.uint8Array({ maxLength: 200 })
				.map(b => Buffer.from(b.map(x => (x === 0x0a ? 0x20 : x)))),
			fc.constantFrom(...malformed).map(m => Buffer.from(JSON.stringify(m))),
		)
		// The process skips a line that is blank after `str::trim` and rejects one that is not UTF-8.
		const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
		const blank = (bytes: Buffer) => {
			try {
				return /^\p{White_Space}*$/u.test(decoder.decode(bytes))
			} catch {
				return false
			}
		}
		let n = 0
		/** Writes one raw control line, then a fence; returns the event types the line produced before the fence's. */
		const answersTo = async (bytes: Buffer) => {
			const id = `fence-${n++}`
			const from = chan.events.length
			control.write(Buffer.concat([bytes, Buffer.from("\n")]))
			chan.p.send(fence(id))
			await chan.next(is("rejected", id))
			// `stats` arrives every 5 s whatever the control traffic.
			return chan.events
				.slice(from, -1)
				.filter(e => e.type !== "stats")
				.map(e => e.type)
		}
		for (const m of malformed)
			expect(
				await answersTo(Buffer.from(JSON.stringify(m))),
				JSON.stringify(m),
			).toEqual(["rejected"])
		expect(
			chan.events.find(e => e.type === "rejected" && e.id.startsWith("aaaa")),
		).toMatchObject({ id: "a".repeat(64) })
		await fc.assert(
			fc.asyncProperty(line, async bytes => {
				expect(await answersTo(bytes)).toEqual(blank(bytes) ? [] : ["rejected"])
			}),
			{ numRuns: 100 },
		)
		chan.p.send(open48k("alive", CENTER, 96_000))
		await chan.next(is("opened", "alive"))
	}, 60_000)

	// Feature: core-channelizer, Property 13: EOF tail
	// Validates: addendum §11, §12.13
	it("emits input-eof with the odd byte, flushes the channel and exits 0", async () => {
		const cases = [
			{ input: Buffer.from([1, 2, 3]), samples: 1, discarded: 1 },
			{ input: Buffer.alloc(0), samples: 0, discarded: 0 },
			{
				input: Buffer.concat([iq(20_480, 31), Buffer.from([7])]),
				samples: 20_480,
				discarded: 1,
			},
		]
		for (const { input, samples, discarded } of cases) {
			const chan = await spawnChan(FS)
			chan.p.send(open48k("tail", CENTER + 50_000, 1 << 20))
			const client = collect(
				connect((await chan.next(is("opened", "tail"))).socket),
			)
			chan.p.input.end(input)
			expect(await chan.next(is("input-eof"))).toMatchObject({
				inputSamples: samples,
				discardedBytes: discarded,
			})
			expect(await chan.exited()).toBe(0)
			// Exactly ⌊N·out/fs⌋ samples (A12), every one delivered before the socket closed.
			expect((await client.closed()).length).toBe(
				Math.floor((samples * 48_000) / FS) * 8,
			)
		}
	}, 30_000)

	// Feature: core-channelizer, Property 8: Bounded queue (process level)
	// Validates: addendum §6, §12.8
	it("bounds a stalled channel without perturbing the other channel", async () => {
		const total = 2 * 48_000 // 2 s of output
		const input = iq(2 * FS, 31)
		const slowQueue = 8_000
		const run = async (withStalled: boolean) => {
			const chan = await spawnChan(FS)
			chan.p.send(open48k("fast", CENTER + 100_000, 1 << 24))
			if (withStalled) chan.p.send(open48k("slow", CENTER + 100_000, slowQueue))
			const fast = collect(
				connect((await chan.next(is("opened", "fast"))).socket),
			)
			let stalled: Socket | undefined
			let slow: ReturnType<typeof collect> | undefined
			if (withStalled) {
				stalled = connect((await chan.next(is("opened", "slow"))).socket)
				stalled.pause() // explicitly paused: the data listener below does not resume it
				slow = collect(stalled)
			}
			chan.p.input.write(input)
			// The fast channel has every sample once the process has read the whole input.
			await until(() => fast.bytes() === total * 8, 15_000, "fast output")
			if (withStalled) {
				const stats = await chan.next(is("stats"), 8_000)
				const ofSlow = stats.channels.find(c => c.id === "slow")
				const ofFast = stats.channels.find(c => c.id === "fast")
				expect(ofSlow?.queueHighWaterBytes).toBeLessThanOrEqual(slowQueue)
				expect(ofSlow?.droppedSamples).toBeGreaterThan(0)
				expect(ofFast?.droppedSamples).toBe(0)
				stalled?.resume()
			}
			chan.p.input.end()
			await chan.next(is("input-eof"))
			expect(await chan.exited()).toBe(0)
			return {
				events: chan.events,
				fast: await fast.closed(),
				slow: await slow?.closed(),
			}
		}
		const alone = await run(false)
		const loaded = await run(true)
		expect(alone.fast.length).toBe(total * 8)
		expect(loaded.fast.equals(alone.fast)).toBe(true)

		const runs = loaded.events.filter(is("discontinuity"))
		expect(runs.length).toBeGreaterThan(0)
		expect(
			runs.every(d => d.id === "slow" && d.cause === "queue-overflow"),
		).toBe(true)
		// Whole complex samples are dropped and each run reports its gap exactly: the slow client's bytes
		// are the fast channel's (same channel spec) with each reported run cut out.
		const kept: Buffer[] = []
		let at = 0
		for (const d of runs) {
			// Monotonic, and an accepted sample separates consecutive runs (A13).
			expect(d.sampleIndex).toBeGreaterThanOrEqual(
				kept.length === 0 ? 0 : at + 1,
			)
			kept.push(alone.fast.subarray(at * 8, d.sampleIndex * 8))
			at = d.sampleIndex + d.droppedSamples
		}
		kept.push(alone.fast.subarray(at * 8))
		expect(loaded.slow?.equals(Buffer.concat(kept))).toBe(true)
	}, 60_000)

	// Feature: core-channelizer, Property 12: Input-gap marking (process level)
	// Validates: addendum §4, §12.12
	it("marks a gap on every open channel and restarts them fresh after it", async () => {
		const pre = iq(40_960, 31)
		const post = iq(204_800, 17)
		const centers = { g1: CENTER + 10_000, g2: CENTER - 250_000 }
		const run = async (input: Buffer, gapAtByte?: number) => {
			const chan = await spawnChan(FS)
			const clients: Record<string, ReturnType<typeof collect>> = {}
			for (const [id, center] of Object.entries(centers)) {
				chan.p.send(open48k(id, center, 1 << 22))
				clients[id] = collect(
					connect((await chan.next(is("opened", id))).socket),
				)
			}
			if (gapAtByte !== undefined) {
				chan.p.send({
					v: 1,
					type: "mark-gap",
					atInputByte: gapAtByte,
					droppedInputBytes: 512,
				})
				// Control and IQ travel on separate pipes: wait until the mark is queued before any input.
				chan.p.send(fence("sync"))
				await chan.next(is("rejected", "sync"))
			}
			chan.p.input.end(input)
			await chan.next(is("input-eof"))
			expect(await chan.exited()).toBe(0)
			const out: Record<string, Buffer> = {}
			for (const [id, client] of Object.entries(clients))
				out[id] = await client.closed()
			return { events: chan.events, out }
		}
		const gapped = await run(Buffer.concat([pre, post]), pre.length)
		const fresh = await run(post)
		const preOut = (40_960 * 48_000) / FS
		const postOut = (204_800 * 48_000) / FS
		expect(fresh.events.filter(is("discontinuity"))).toEqual([])
		for (const id of Object.keys(centers)) {
			expect(
				gapped.events.filter(is("discontinuity")).filter(d => d.id === id),
			).toEqual([
				expect.objectContaining({
					cause: "input-gap",
					sampleIndex: preOut,
					droppedSamples: Math.floor((256 * 48_000) / FS),
				}),
			])
			const a = gapped.out[id]!
			const b = fresh.out[id]!
			expect(b.length).toBe(postOut * 8)
			expect(a.length).toBe((preOut + postOut) * 8)
			// The reset is total, so everything after the seam equals a fresh start on the post-gap input.
			expect(a.subarray(preOut * 8).equals(b)).toBe(true)
		}
	}, 30_000)

	// Review Focus 7 at process level: the main loop's ClientGone path and close() of a writer blocked in write_all
	it("closes a stalled and a destroyed client promptly while another channel keeps flowing", async () => {
		const chan = await spawnChan(FS)
		for (const id of ["stalled", "gone", "live"])
			chan.p.send(open48k(id, CENTER, 1 << 24))
		const socketOf = async (id: string) =>
			(await chan.next(is("opened", id))).socket
		connect(await socketOf("stalled")).pause() // connected, never reads
		const gone = connect(await socketOf("gone"))
		await within(
			new Promise(r => gone.once("connect", r)),
			5000,
			"gone connect",
		)
		gone.destroy()
		const live = collect(connect(await socketOf("live")))
		const second = Buffer.alloc(2 * FS, 128) // 1 s → 48 000 cf32 samples per channel
		chan.p.input.write(second)
		expect(await chan.next(is("closed", "gone"))).toMatchObject({
			reason: "client-gone",
		})
		await new Promise(r => setTimeout(r, 300)) // the stalled writer is blocked in write_all by now
		const t = Date.now()
		chan.p.send({ v: 1, type: "close", id: "stalled" })
		expect(await chan.next(is("closed", "stalled"))).toMatchObject({
			reason: "requested",
		})
		expect(Date.now() - t).toBeLessThan(2000)
		chan.p.input.end(second)
		await chan.next(is("input-eof"))
		expect(await chan.exited()).toBe(0)
		expect((await live.closed()).length).toBe(2 * 48_000 * 8)
	}, 30_000)
})
