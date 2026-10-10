import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import pino from "pino"
import { describe, expect, it } from "vitest"
import type { ScannerCapture } from "@wavekit/api-types"
import {
	CaptureRecorder,
	MAX_CAPTURE_SECONDS,
	type CaptureCloseInfo,
	type CaptureEngineView,
	type CaptureRequest,
} from "../../../../src/core/scanner/evidence/capture-recorder.js"
import { CaptureStore } from "../../../../src/core/scanner/evidence/capture-store.js"
import { DEFAULT_CAPTURE } from "../../../../src/core/scanner/evidence/capture-spec.js"
import { FixtureSchema } from "../../../../src/core/fixtures/manifest-schema.js"
import { IqRing } from "../../../../src/core/spectrum/iq-ring.js"
import type { EngineEpoch } from "../../../../src/core/spectrum/spectrum-engine.js"
import {
	AMBIENT_PAIR_MS,
	type DecodeEvidence,
} from "../../../../src/core/scanner/types.js"

const FS = 64_000

class RingView extends EventEmitter implements CaptureEngineView {
	readonly sourceId = "rtl"
	readonly format = "U8_IQ" as const
	private ring: IqRing
	private edge = 0
	/** The ring's stream; `epoch.stream` may lag it (thread host right after a reconnect). */
	private ringStream = 0
	private readonly taps = new Set<(start: number, bytes: Uint8Array) => void>()
	epoch: EngineEpoch = {
		stream: 0,
		epoch: 1,
		startSample: 0,
		centreHz: 446_100_000,
		sampleRateHz: FS,
		gainKey: "m:296",
		tuningTrust: "commanded",
		settleMode: "marker",
	}
	constructor(private readonly ringSeconds: number) {
		super()
		this.ring = new IqRing({
			bytesPerSample: 2,
			capacitySamples: ringSeconds * FS,
		})
	}
	currentEpoch(): EngineEpoch {
		return { ...this.epoch }
	}
	accounting(): { stream: number } {
		return { stream: this.ringStream }
	}
	liveEdge(): number {
		return this.edge
	}
	oldestSample(): number {
		return this.ring.oldestSample
	}
	readRing(from: number, to: number) {
		return this.ring.read(from, to)
	}
	tap(fn: (start: number, bytes: Uint8Array) => void): () => void {
		this.taps.add(fn)
		return () => this.taps.delete(fn)
	}
	/** CU8 bytes encode the sample index (lo, hi) so windows are checkable. */
	push(samples: number, skip = 0): void {
		this.edge += skip
		const bytes = new Uint8Array(samples * 2)
		for (let i = 0; i < samples; i++) {
			bytes[2 * i] = (this.edge + i) & 255
			bytes[2 * i + 1] = ((this.edge + i) >> 8) & 255
		}
		this.ring.write(this.edge, bytes)
		const start = this.edge
		this.edge += samples
		for (const t of this.taps) t(start, bytes)
	}
	/** A settled retune at the live edge: the next epoch starts there. */
	retune(): number {
		this.epoch = {
			...this.epoch,
			epoch: this.epoch.epoch + 1,
			startSample: this.edge,
		}
		return this.epoch.epoch
	}
	/**
	 * Like SpectrumEngine.beginStream: indices restart at 0 in a new ring, then "stream" fires.
	 * `lagEpoch`: the epoch keeps reporting the old stream (thread host right after a reconnect).
	 */
	restart(lagEpoch = false): void {
		this.ringStream += 1
		this.edge = 0
		this.ring = new IqRing({
			bytesPerSample: 2,
			capacitySamples: this.ringSeconds * FS,
		})
		if (!lagEpoch)
			this.epoch = {
				...this.epoch,
				stream: this.ringStream,
				epoch: this.epoch.epoch + 1,
				startSample: 0,
			}
		this.emit("stream", this.ringStream, "restart")
	}
}

function setup(
	ringSeconds = 2,
	diskOk = true,
	decodeWaitMs: number | null = 5,
) {
	const dir = mkdtempSync(join(tmpdir(), "wk-cap-"))
	const clock = { now: 1_000_000 }
	const store = new CaptureStore({
		dir: join(dir, "captures"),
		logger: pino({ level: "silent" }),
		now: () => clock.now,
	})
	const view = new RingView(ringSeconds)
	const recorder = new CaptureRecorder({
		store,
		engines: () => view,
		diskOk: () => diskOk,
		logger: pino({ level: "silent" }),
		now: () => clock.now,
		...(decodeWaitMs !== null ? { decodeWaitMs } : {}),
	})
	const captured: ScannerCapture[] = []
	const discarded: [string, string][] = []
	recorder.on("captured", (c: ScannerCapture) => captured.push(c))
	recorder.on("discarded", (id: string, reason: string) =>
		discarded.push([id, reason]),
	)
	const close = (id: string, endSample: number, i = info()) =>
		recorder.close(id, endSample, () => i)
	return { dir, store, view, recorder, captured, discarded, clock, close }
}

const req = (over: Partial<CaptureRequest> = {}): CaptureRequest => ({
	observationId: "o1",
	jobId: "j1",
	sourceId: "rtl",
	stream: 0,
	epoch: 1,
	startSample: 60_000,
	targetHz: 446_125_000,
	spec: { ...DEFAULT_CAPTURE, enabled: true, preMs: 500, postMs: 250 },
	...over,
})

const info = (
	metadata: CaptureCloseInfo["metadata"] = {
		talkgroups: ["9"],
		sources: ["2060945"],
		capcodes: [],
		callsigns: [],
		ismModels: [],
	},
): CaptureCloseInfo => ({
	discoveryId: "d_1",
	protocol: "dmr",
	identity: { kind: "dmr-cc", value: "1" },
	metadata,
	encrypted: false,
	tuningTrust: "commanded",
	decoderType: "dsd-fme",
	decoderOptions: { mode: "auto" },
})

const until = async (check: () => boolean, tries = 200) => {
	for (let i = 0; i < tries && !check(); i++)
		await new Promise(r => setTimeout(r, 5))
}

const readCapture = (dir: string, c: ScannerCapture) => ({
	iq: readFileSync(join(dir, "captures", `${c.id}.cu8`)),
	entry: FixtureSchema.parse(
		JSON.parse(readFileSync(join(dir, "captures", `${c.id}.json`), "utf8")),
	),
})

const sampleAt = (iq: Buffer, i: number) => iq[2 * i]! + (iq[2 * i + 1]! << 8)

describe("CaptureRecorder", () => {
	it("writes [start − pre, end + post] with live post-roll and a valid manifest entry", async () => {
		const h = setup()
		await h.store.init()
		h.view.push(64_000)
		expect(h.recorder.open(req())).toBe(true)
		h.view.push(6_000)
		h.recorder.decoded("o1")
		h.close("o1", 70_000)
		h.view.push(20_000)
		await until(() => h.captured.length === 1)
		const c = h.captured[0]!
		expect(c).toMatchObject({
			startSample: 28_000,
			endSample: 86_000,
			preRollClippedMs: 0,
			postTruncated: false,
			sampleRateHz: FS,
			decoded: true,
			mode: "wideband",
		})
		const { iq, entry } = readCapture(h.dir, c)
		expect(iq.length).toBe((86_000 - 28_000) * 2)
		expect([iq[0], iq[1]]).toEqual([28_000 & 255, (28_000 >> 8) & 255])
		const last = 86_000 - 1
		expect([iq.at(-2), iq.at(-1)]).toEqual([last & 255, (last >> 8) & 255])
		expect(entry).toMatchObject({
			id: c.id,
			file: `raw/${c.id}.cu8`,
			sample_rate: FS,
			duration_s: (86_000 - 28_000) / FS,
			role: "tail-golden",
		})
	})

	it("clips the pre-roll at the ring's tail and reports it", async () => {
		const h = setup(0.5)
		await h.store.init()
		h.view.push(100_000)
		h.recorder.open(
			req({
				startSample: 95_000,
				spec: { ...DEFAULT_CAPTURE, enabled: true, preMs: 1000, postMs: 0 },
			}),
		)
		h.recorder.decoded("o1")
		h.close("o1", 100_000)
		await until(() => h.captured.length === 1)
		const oldest = 100_000 - 32_000
		expect(h.captured[0]).toMatchObject({
			startSample: oldest,
			preRollClippedMs: ((oldest - (95_000 - 64_000)) / FS) * 1000,
		})
	})

	it("never reaches before the capture's epoch for its pre-roll (another centre frequency)", async () => {
		const h = setup()
		await h.store.init()
		h.view.push(50_000)
		h.view.retune() // epoch 2 starts at 50 000
		h.view.push(14_000)
		expect(h.recorder.open(req({ epoch: 2 }))).toBe(true)
		h.recorder.decoded("o1")
		h.close("o1", 64_000)
		h.view.push(20_000)
		await until(() => h.captured.length === 1)
		const c = h.captured[0]!
		expect(c).toMatchObject({
			epoch: 2,
			startSample: 50_000,
			preRollClippedMs: ((50_000 - 28_000) / FS) * 1000,
		})
		expect(sampleAt(readCapture(h.dir, c).iq, 0)).toBe(50_000)
	})

	it("discards undecoded captures when onlyDecoded, on gaps and on a retune before close", async () => {
		const h = setup()
		await h.store.init()
		h.view.push(64_000)
		h.recorder.open(req())
		h.close("o1", 64_000)
		h.view.push(20_000)
		await until(() => h.discarded.length === 1)
		h.recorder.open(req({ observationId: "o2", startSample: 84_000 }))
		h.view.push(1_000, 500)
		await until(() => h.discarded.length === 2)
		h.recorder.open(req({ observationId: "o3", startSample: 85_000 }))
		h.recorder.epochChanged("rtl", 2)
		await until(() => h.discarded.length === 3)
		expect(h.discarded.map(d => d[1])).toEqual(["not-decoded", "gap", "epoch"])
		expect(h.captured).toEqual([])
		expect(h.store.list()).toEqual([])
	})

	it("keeps a late decode within the ambient pairing window with this observation's own payload; discards the undecoded one after it", async () => {
		const h = setup(2, true, null) // the real AMBIENT_PAIR_MS
		await h.store.init()
		h.view.push(64_000)
		const spec = { ...DEFAULT_CAPTURE, enabled: true, preMs: 500, postMs: 0 }
		// The discovery-wide metadata names talkgroup 7: another transmission's.
		const stale = info({
			talkgroups: ["7"],
			sources: ["1"],
			capcodes: [],
			callsigns: [],
			ismModels: [],
		})
		expect(h.recorder.open(req({ observationId: "a", spec }))).toBe(true)
		expect(h.recorder.open(req({ observationId: "b", spec }))).toBe(true)
		h.close("a", 64_000, stale)
		h.close("b", 64_000, stale)
		// Both windows are complete: parked, holding no source slot.
		expect(h.recorder.open(req({ observationId: "c", spec }))).toBe(true)
		h.recorder.close("c", 64_000, () => stale)
		await new Promise(r => setTimeout(r, 1000))
		expect(h.discarded).toEqual([])
		const ev: DecodeEvidence = {
			protocol: "dmr",
			identity: { kind: "dmr-cc", value: "1" },
			metadata: { talkgroups: ["9"], sources: ["2060945"] },
			crcClean: true,
			at: h.clock.now,
			epoch: 1,
			origin: "ambient",
		}
		h.recorder.evidence("a", ev)
		h.recorder.decoded("a")
		await until(() => h.captured.length === 1)
		const { entry } = readCapture(h.dir, h.captured[0]!)
		expect(h.captured[0]).toMatchObject({ observationId: "a", decoded: true })
		expect(entry.expected).toMatchObject({
			min_count: 1,
			payloads: [{ talkgroup: 9, source: 2060945 }],
		})
		await until(() => h.discarded.length === 2, 400)
		expect(h.discarded.sort()).toEqual([
			["b", "not-decoded"],
			["c", "not-decoded"],
		])
		expect(AMBIENT_PAIR_MS).toBe(2000)
	}, 10_000)

	it("cuts a closed capture back to its track end when the epoch changes in its post-roll", async () => {
		const h = setup()
		await h.store.init()
		h.view.push(64_000)
		h.recorder.open(req())
		h.view.push(4_000)
		h.recorder.decoded("o1")
		h.close("o1", 66_000) // post-roll to 82 000; 68 000 already written
		h.view.push(2_000)
		h.recorder.epochChanged("rtl", h.view.retune())
		await until(() => h.captured.length === 1)
		const c = h.captured[0]!
		expect(c).toMatchObject({
			startSample: 28_000,
			endSample: 66_000,
			postTruncated: true,
		})
		const { iq, entry } = readCapture(h.dir, c)
		expect(iq.length).toBe((66_000 - 28_000) * 2)
		expect(sampleAt(iq, iq.length / 2 - 1)).toBe(65_999 & 0xffff)
		expect(entry.sha256).toBe(createHash("sha256").update(iq).digest("hex"))
	})

	it("ends on the engine's new stream: aborts an open capture, truncates a closed one, refuses a stale stream", async () => {
		const h = setup()
		await h.store.init()
		h.view.push(64_000)
		expect(h.recorder.open(req())).toBe(true)
		h.view.push(1_000)
		h.view.restart(true)
		await until(() => h.discarded.length === 1)
		expect(h.discarded).toEqual([["o1", "stream"]])
		// The engine epoch still reports stream 0 (it lags the ring): a stream-0 track is refused all the same.
		h.view.push(64_000)
		expect(h.recorder.open(req({ observationId: "o2" }))).toBe(false)
		h.view.epoch = { ...h.view.epoch, stream: 1, epoch: 2 }
		expect(
			h.recorder.open(req({ observationId: "o3", stream: 1, epoch: 2 })),
		).toBe(true)
		h.view.push(1_000)
		h.recorder.decoded("o3")
		h.close("o3", 65_000)
		h.view.restart()
		await until(() => h.captured.length === 1)
		expect(h.captured[0]).toMatchObject({
			observationId: "o3",
			stream: 1,
			startSample: 28_000,
			endSample: 65_000,
			postTruncated: true,
		})
		const { iq } = readCapture(h.dir, h.captured[0]!)
		expect(iq.length).toBe((65_000 - 28_000) * 2)
		// Neither capture listens to the engine any more.
		expect(h.view.listenerCount("stream")).toBe(0)
	})

	it("stops writing at MAX_CAPTURE_SECONDS, frees its slot and budget, and keeps the capped capture at close", async () => {
		const h = setup()
		await h.store.init()
		h.view.push(64_000)
		const spec = {
			...DEFAULT_CAPTURE,
			enabled: true,
			preMs: 0,
			postMs: 0,
			maxPerHour: 1,
		}
		expect(h.recorder.open(req({ startSample: 64_000, spec }))).toBe(true)
		for (let i = 0; i < MAX_CAPTURE_SECONDS + 1; i++) h.view.push(FS)
		h.recorder.decoded("o1")
		expect(h.recorder.activeCount()).toBe(1)
		const edge = h.view.liveEdge()
		// o1 is capped: it no longer counts against the job's hour budget (1) or the source's slots.
		expect(
			h.recorder.open(req({ observationId: "o2", startSample: edge, spec })),
		).toBe(true)
		expect(
			h.recorder.open(req({ observationId: "o3", startSample: edge, spec })),
		).toBe(false)
		h.close("o1", h.view.liveEdge())
		await until(() => h.captured.length === 1)
		expect(h.captured[0]).toMatchObject({
			observationId: "o1",
			startSample: 64_000,
			endSample: 64_000 + MAX_CAPTURE_SECONDS * FS,
			postTruncated: true,
			durationS: MAX_CAPTURE_SECONDS,
		})
	})

	it("limits captures per job per hour and refuses while the disk is low", async () => {
		const h = setup()
		await h.store.init()
		h.view.push(64_000)
		const spec = {
			...DEFAULT_CAPTURE,
			enabled: true,
			preMs: 100,
			postMs: 0,
			maxPerHour: 2,
		}
		for (const id of ["a", "b"]) {
			expect(
				h.recorder.open(
					req({
						observationId: id,
						startSample: h.view.liveEdge() - 1000,
						spec,
					}),
				),
			).toBe(true)
			h.recorder.decoded(id)
			h.close(id, h.view.liveEdge())
		}
		await until(() => h.captured.length === 2)
		expect(
			h.recorder.open(
				req({
					observationId: "c",
					startSample: h.view.liveEdge() - 1000,
					spec,
				}),
			),
		).toBe(false)
		h.clock.now += 3_600_001
		expect(
			h.recorder.open(
				req({
					observationId: "d",
					startSample: h.view.liveEdge() - 1000,
					spec,
				}),
			),
		).toBe(true)
		const low = setup(2, false)
		await low.store.init()
		low.view.push(64_000)
		expect(low.recorder.open(req())).toBe(false)
	})

	// Feature: signal-discovery-scanner, Property 22: Capture sidecars
	// Validates: spec § 8 (P22), § 4.8 (IQ ring)
	it("every kept capture has a manifest-valid sidecar whose sha256 matches the file and whose range was inside the ring", async () => {
		// Weighted so most runs keep captures; retunes, restarts and gaps still come in most runs.
		const command = fc.oneof(
			{
				weight: 6,
				arbitrary: fc.record({
					kind: fc.constant("push" as const),
					samples: fc.integer({ min: 1, max: 8_000 }),
				}),
			},
			{
				weight: 4,
				arbitrary: fc.record({
					kind: fc.constant("open" as const),
					backSamples: fc.integer({ min: 0, max: 40_000 }),
					preMs: fc.integer({ min: 0, max: 1_000 }),
					postMs: fc.integer({ min: 0, max: 300 }),
					mode: fc.constantFrom("wideband" as const, "channel" as const),
					onlyDecoded: fc.boolean(),
				}),
			},
			{
				weight: 4,
				arbitrary: fc.record({
					kind: fc.constant("decoded" as const),
					pick: fc.nat(),
				}),
			},
			{
				weight: 3,
				arbitrary: fc.record({
					kind: fc.constant("close" as const),
					pick: fc.nat(),
					endBack: fc.integer({ min: 0, max: 2_000 }),
				}),
			},
			{
				weight: 1,
				arbitrary: fc.record({ kind: fc.constant("epoch" as const) }),
			},
			{
				weight: 1,
				arbitrary: fc.record({ kind: fc.constant("restart" as const) }),
			},
			{
				weight: 1,
				arbitrary: fc.record({
					kind: fc.constant("gap" as const),
					samples: fc.integer({ min: 1, max: 4_000 }),
					skip: fc.integer({ min: 1, max: 2_000 }),
				}),
			},
		)
		await fc.assert(
			fc.asyncProperty(
				fc.array(command, { minLength: 1, maxLength: 30 }),
				async commands => {
					const h = setup(0.5)
					await h.store.init()
					h.view.push(16_000)
					const opened: string[] = []
					const atOpen = new Map<
						string,
						{ oldest: number; edge: number; epochStart: number }
					>()
					const atCommit = new Map<string, { edge: number; stream: number }>()
					/** Per stream: sample indices where a retune took effect. */
					const boundaries = new Map<number, number[]>()
					h.recorder.on("captured", (c: ScannerCapture) =>
						atCommit.set(c.id, {
							edge: h.view.liveEdge(),
							stream: h.view.accounting().stream,
						}),
					)
					for (const cmd of commands) {
						if (cmd.kind === "push") h.view.push(cmd.samples)
						else if (cmd.kind === "gap") h.view.push(cmd.samples, cmd.skip)
						else if (cmd.kind === "restart") h.view.restart()
						else if (cmd.kind === "epoch") {
							const stream = h.view.accounting().stream
							boundaries.set(stream, [
								...(boundaries.get(stream) ?? []),
								h.view.liveEdge(),
							])
							h.recorder.epochChanged("rtl", h.view.retune())
						} else if (cmd.kind === "open") {
							const observationId = `p${opened.length}`
							const epoch = h.view.currentEpoch()
							const ring = {
								oldest: h.view.oldestSample(),
								edge: h.view.liveEdge(),
								epochStart: epoch.startSample ?? 0,
							}
							const spec = {
								...DEFAULT_CAPTURE,
								enabled: true,
								preMs: cmd.preMs,
								postMs: cmd.postMs,
								mode: cmd.mode,
								onlyDecoded: cmd.onlyDecoded,
								maxPerHour: 60,
							}
							if (
								h.recorder.open(
									req({
										observationId,
										stream: epoch.stream,
										epoch: epoch.epoch,
										startSample: Math.max(
											ring.epochStart,
											ring.edge - cmd.backSamples,
										),
										spec,
									}),
								)
							) {
								opened.push(observationId)
								atOpen.set(observationId, ring)
							}
						} else if (opened.length > 0) {
							const id = opened[cmd.pick % opened.length]!
							if (cmd.kind === "decoded") h.recorder.decoded(id)
							else h.close(id, Math.max(0, h.view.liveEdge() - cmd.endBack))
						}
					}
					for (const id of opened) h.close(id, h.view.liveEdge())
					h.view.push(20_000) // > the longest post-roll (300 ms = 19 200 samples)
					await until(
						() => h.captured.length + h.discarded.length >= opened.length,
						400,
					)
					expect(h.captured.length + h.discarded.length).toBe(opened.length)
					for (const c of h.captured) {
						const { iq, entry } = readCapture(h.dir, c)
						expect(entry.file).toBe(`raw/${c.id}.cu8`)
						expect(entry.sha256).toBe(
							createHash("sha256").update(iq).digest("hex"),
						)
						expect(iq.length).toBe(c.bytes)
						const ring = atOpen.get(c.observationId)!
						// The pre-roll came from the ring as it was at open, inside the capture's epoch.
						expect(c.startSample).toBeGreaterThanOrEqual(ring.oldest)
						expect(c.startSample).toBeGreaterThanOrEqual(ring.epochStart)
						expect(c.startSample).toBeLessThanOrEqual(ring.edge)
						expect(c.endSample).toBeGreaterThan(c.startSample)
						const commit = atCommit.get(c.id)!
						if (commit.stream === c.stream)
							expect(c.endSample).toBeLessThanOrEqual(commit.edge)
						// One epoch: no retune inside the kept range.
						for (const b of boundaries.get(c.stream) ?? [])
							expect(b <= c.startSample || b >= c.endSample).toBe(true)
						if (c.mode === "wideband") {
							expect(iq.length).toBe((c.endSample - c.startSample) * 2)
							expect(sampleAt(iq, 0)).toBe(c.startSample & 0xffff)
							expect(sampleAt(iq, iq.length / 2 - 1)).toBe(
								(c.endSample - 1) & 0xffff,
							)
						}
					}
				},
			),
			{ numRuns: 100 },
		)
	}, 120_000)

	it("retention deletes the oldest captures first and never ones younger than 10 s", async () => {
		const h = setup()
		await h.store.init()
		h.view.push(64_000)
		const ids: string[] = []
		for (const id of ["a", "b", "c"]) {
			h.recorder.open(
				req({
					observationId: id,
					startSample: h.view.liveEdge() - 10_000,
					spec: { ...DEFAULT_CAPTURE, enabled: true, preMs: 0, postMs: 0 },
				}),
			)
			h.recorder.decoded(id)
			h.close(id, h.view.liveEdge())
			await until(() => h.captured.length === ids.length + 1)
			ids.push(h.captured.at(-1)!.id)
			h.clock.now += 60_000
		}
		const size = statSync(join(h.dir, "captures", `${ids[0]}.cu8`)).size
		h.clock.now -= 55_000 // the newest capture is now 5 s old
		const deleted = await h.store.retention(size)
		expect(deleted).toEqual([ids[0], ids[1]])
		expect(h.store.list().map(c => c.id)).toEqual([ids[2]])
		expect(await h.store.retention(0)).toEqual([])
	})
})
