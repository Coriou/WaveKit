/**
 * Replayed ACARS and VDL2 captures from a decoder-output fixture to a decoded discovery at the
 * raster channel: the line runs through the real adapter's parser, the probe pool (replay
 * transport) and the pool adapter, then into the scanner's replay sink. One CRC-checked block or
 * frame proves; the decode proves the spectrum discovery at the channel, else the channel anchor,
 * and never opens a second discovery beside an anchor. Synthetic channels, identities and text.
 */
import { PassThrough } from "node:stream"
import { rmSync } from "node:fs"
import pino from "pino"
import { describe, expect, it, vi } from "vitest"
import { createPoolReplayProbes } from "../../../../src/core/iq-capture/pool-adapter.js"
import { IQ_REPLAY_QUEUE_HOLDER } from "../../../../src/core/iq-capture/replay-queue.js"
import type {
	IqCaptureView,
	IqReplayResult,
} from "../../../../src/core/scanner/iq-capture-contract.js"
import type { LiveObservation } from "../../../../src/core/scanner/job-runner.js"
import {
	interpretVdl2Replay,
	plausibleVdl2Address,
} from "../../../../src/core/scanner/probes/confirm/vdl2.js"
import { createInterpreterState } from "../../../../src/core/scanner/probes/confirm/double-match.js"
import {
	REPLAY_END_GRACE_MS,
	REPLAY_PROBE_PRIORITY,
	offsetTransport,
} from "../../../../src/core/scanner/probes/probe-pool.js"
import { createReplayTransport } from "../../../../src/core/scanner/probes/replay-transport.js"
import { planReplayTrials } from "../../../../src/core/scanner/replay-plan.js"
import type { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { Identity } from "../../../../src/core/scanner/types.js"
import { createAcarsdecDecoder } from "../../../../src/decoders/builtin/acarsdec.js"
import { createDumpvdl2Decoder } from "../../../../src/decoders/builtin/dumpvdl2.js"
import type { DecoderOutput } from "../../../../src/decoders/types.js"
import { trackOf } from "../../../mocks/scanner/identify-fakes.js"
import { makeObs } from "../../../mocks/scanner/observations.js"
import { flushAsync, poolHarness } from "../../../mocks/scanner/probe-fakes.js"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"

const ACARS_HZ = 130_025_000
const VDL2_HZ = 136_975_000
/** The captured track's centre: 1.5 kHz above its channel (inside the 4 kHz raster snap). */
const OFF = 1_500

const wait = (ms: number): Promise<void> =>
	new Promise(resolve => setTimeout(resolve, ms))

interface Case {
	decoder: "acarsdec" | "dumpvdl2"
	protocol: "acars" | "vdl2"
	channelHz: number
	identity: Identity
	/** What the decoder prints for one clean block or frame, and one that failed its CRC. */
	line: (clean: boolean) => string
}

const CASES: Case[] = [
	{
		decoder: "acarsdec",
		protocol: "acars",
		channelHz: ACARS_HZ,
		identity: { kind: "acars-reg", value: "TEST01" },
		// acarsdec on replay audio reports freq 0 and noise -inf.
		line: clean =>
			`{"timestamp":1793016607.877815,"station_id":"test","channel":0,"freq":0.000,"level":-8.0,"noise":-inf,"error":${clean ? 0 : 2},"mode":"2","label":"H1","block_id":"1","ack":false,"tail":".TEST01","flight":"XX0001","msgno":"M01A","text":"SYNTHETIC","app":{"name":"acarsdec","ver":"test"}}`,
	},
	{
		decoder: "dumpvdl2",
		protocol: "vdl2",
		channelHz: VDL2_HZ,
		identity: { kind: "vdl2-addr", value: "ABC001" },
		// dumpvdl2 reports the channel it was given (the raster channel on replay).
		line: clean =>
			JSON.stringify({
				vdl2: {
					t: { sec: 1793016607, usec: 0 },
					freq: VDL2_HZ,
					sig_level: -20,
					noise_level: -40,
					avlc: {
						src: { addr: "ABC001", type: "Aircraft", status: "Airborne" },
						dst: { addr: "100001", type: "Ground station" },
						cr: "Command",
						frame_type: "I",
						acars: {
							err: false,
							crc_ok: clean,
							reg: ".TEST01",
							mode: "2",
							label: "H1",
							blk_id: "1",
							msg_text: "SYNTHETIC",
						},
					},
				},
			}),
	},
]

function view(c: Case): IqCaptureView {
	return {
		captureId: "cap-1",
		sourceId: "rtl",
		observationId: "o_1",
		epoch: 1,
		rfHz: c.channelHz + OFF,
		tuningTrust: "commanded",
		capturedAtMs: 0,
		durationMs: 1000,
		gapSamples: 0,
	}
}

/** One replay trial through the pool; the decoder is the fake, its lines the real adapter's parse. */
async function replayThroughPool(c: Case, lines: string[]) {
	const input = new PassThrough()
	const openReplay = vi.fn(() => input)
	const h = poolHarness({
		transports: [
			offsetTransport,
			createReplayTransport({
				openReplay,
				replayRateOf: (_id, type) => (type === "dumpvdl2" ? 105_000 : 48_000),
			}),
		],
	})
	const adapter = createPoolReplayProbes(h.pool, {
		priority: REPLAY_PROBE_PRIORITY,
		jobId: IQ_REPLAY_QUEUE_HOLDER,
	})
	const trial = planReplayTrials({
		capture: view(c),
		track: null,
		knownProtocol: c.protocol,
		priors: {},
		narrowRaster: false,
	}).find(t => t.mode.decoderType === c.decoder)
	if (!trial) throw new Error(`no ${c.decoder} trial`)
	const res = adapter.request({
		captureId: "cap-1",
		sourceId: "rtl",
		epoch: 1,
		observationId: "o_1",
		rfHz: c.channelHz + OFF,
		protocol: trial.protocol,
		mode: trial.mode,
	})
	if (!("run" in res)) throw new Error("deferred")
	await flushAsync()
	expect(openReplay).toHaveBeenCalledWith("cap-1", c.decoder)
	const [id, fake] = [...h.decoders.created.entries()][0]!
	const logger = pino({ level: "silent" })
	const adapterDecoder =
		c.decoder === "acarsdec"
			? createAcarsdecDecoder(fake.config, logger)
			: createDumpvdl2Decoder(fake.config, logger)
	if (c.decoder === "dumpvdl2") {
		const argv = (
			adapterDecoder as unknown as { getArgs(): string[] }
		).getArgs()
		// the capture centre at DC, the raster channel decoded
		expect(argv[1]).toBe(
			`dumpvdl2 --iq-file - --sample-format U8 --oversample 1 --centerfreq ${c.channelHz + OFF} --output decoded:json:file:path=- ${c.channelHz}`,
		)
	}
	input.end(Buffer.alloc(64))
	await flushAsync()
	const parse = (l: string): DecoderOutput | null =>
		(
			adapterDecoder as unknown as {
				parseOutput(l: string): DecoderOutput | null
			}
		).parseOutput(l)
	for (const l of lines) {
		const out = parse(l)
		if (out) h.decoders.emitOutput(id, out)
	}
	fake.emit("exit", 0, null)
	await wait(REPLAY_END_GRACE_MS + 150)
	const answer = await res.run.result
	adapter.dispose()
	return { answer, evidence: h.evidence }
}

async function scanner(
	c: Case,
	trust: "commanded" | "unverified" = "commanded",
) {
	const h = serviceHarness({
		centreHz: c.channelHz - 100_000,
		patch: s => {
			s.passive.enabled = false
		},
	})
	await h.service.start()
	const internal = h.service as unknown as {
		deps: { iqCapture?: unknown }
		store: DiscoveryStore
		live: Map<string, LiveObservation>
		recent: LiveObservation[]
		classify(t: unknown, s: string): LiveObservation["classification"]
		ingest(l: LiveObservation, t: unknown, endReason?: string): void
	}
	internal.deps.iqCapture = {
		view: () => ({ ...view(c), tuningTrust: trust, capturedAtMs: 50_000 }),
	}
	const discoveries = () => internal.store.snapshot().discoveries
	const apply = (over: Partial<IqReplayResult>) =>
		h.service.applyReplayResult({
			captureId: "cap-1",
			sourceId: "rtl",
			observationId: "o_gone",
			epoch: 1,
			rfHz: c.channelHz + OFF,
			trials: [
				{
					protocol: c.protocol,
					decoderType: c.decoder,
					known: true,
					outcome: "decoded",
				},
			],
			decoded: { protocol: c.protocol, identity: c.identity },
			...over,
		})
	const stop = async () => {
		await h.service.stop()
		rmSync(h.dir, { recursive: true, force: true })
	}
	return { h, internal, discoveries, apply, stop }
}

describe("interpretVdl2Replay", () => {
	const out = (data: Record<string, unknown>) => ({
		type: "vdl2",
		data: { frequency: VDL2_HZ, fromaddr: "ABC001", ...data },
		timestamp: new Date(1_000),
	})
	const run = (data: Record<string, unknown>, channelHz = VDL2_HZ) =>
		interpretVdl2Replay(
			out(data),
			createInterpreterState({ epoch: 1, origin: "probe", decoderId: "p" }),
			channelHz,
		)
	const IDENTITY = { kind: "vdl2-addr", value: "ABC001" }

	it("one clean frame is the identity at the channel", () => {
		expect(run({})).toEqual([
			expect.objectContaining({
				protocol: "vdl2",
				crcClean: true,
				identity: IDENTITY,
			}),
		])
		expect(run({})[0]).not.toHaveProperty("hz")
		// dumpvdl2 writes 0 for a missing freq: the replay's channel then
		expect(run({ frequency: 0 })[0]?.identity).toEqual(IDENTITY)
		expect(run({ fromaddr: 0xabc001 })[0]?.identity).toEqual(IDENTITY)
	})

	it("a frame that failed an embedded CRC, or an implausible address, is output without identity", () => {
		const unclean = run({ acars: { crcOk: false } })
		expect(unclean).toHaveLength(1)
		expect(unclean[0]).toMatchObject({ crcClean: false })
		expect(unclean[0]).not.toHaveProperty("identity")
		for (const fromaddr of ["000000", "FFFFFF", "XYZ", ""]) {
			const ev = run({ fromaddr })
			expect(ev).toHaveLength(1)
			expect(ev[0]).not.toHaveProperty("identity")
		}
		expect(plausibleVdl2Address("ABC001")).toBe(true)
		expect(plausibleVdl2Address("abc001")).toBe(false)
	})

	it("a frame at another channel, or a bad channel, is nothing", () => {
		// the 1 kHz ambient target tolerance: 1 000 Hz off still matches, 1 001 Hz does not
		expect(run({ frequency: VDL2_HZ + 1_000 })).toHaveLength(1)
		expect(run({ frequency: VDL2_HZ + 1_001 })).toEqual([])
		expect(run({ frequency: VDL2_HZ + 25_000 })).toEqual([])
		expect(run({}, 0)).toEqual([])
		expect(run({}, Number.NaN)).toEqual([])
	})
})

describe.each(CASES)("$decoder replay to a decoded discovery", c => {
	it("ONE CRC-clean line decodes at the raster channel; a CRC failure never does", async () => {
		const clean = await replayThroughPool(c, [c.line(true)])
		expect(clean.answer).toEqual({
			outcome: "decoded",
			decoded: { protocol: c.protocol, identity: c.identity },
		})
		const bad = await replayThroughPool(c, [c.line(false), c.line(false)])
		expect(bad.answer.decoded).toBeNull()
	})

	it("with no discovery of its own, the decode opens one decoded channel anchor whose proof cites the identity", async () => {
		const r = await scanner(c)
		try {
			r.apply({})
			const all = r.discoveries()
			expect(all).toHaveLength(1)
			const d = r.internal.store.get(all[0]!.id)!
			expect(d).toMatchObject({
				anchor: "decode",
				frequencyHz: c.channelHz,
				protocol: c.protocol,
				confidence: "decoded",
				proof: {
					kind: "decoded",
					protocol: c.protocol,
					transport: "replay",
					identity: c.identity,
				},
			})
			expect(d.proof!.summary).toContain(c.identity.value)
			// a later replay of the channel attaches to it: still one discovery
			r.apply({ captureId: "cap-2", observationId: "o_gone_2" })
			expect(r.discoveries()).toHaveLength(1)
		} finally {
			await r.stop()
		}
	})

	it("a live observation without a discovery attaches to the channel's anchor instead of opening a second", async () => {
		const r = await scanner(c)
		try {
			r.apply({})
			expect(r.discoveries()).toHaveLength(1)
			const track = trackOf({
				trackId: "t2",
				centreHz: c.channelHz + OFF,
				obwHz: 9_000,
				epoch: 1,
			})
			r.internal.live.set("t2", {
				observationId: "o_live",
				sourceId: "rtl",
				trackId: "t2",
				epoch: 1,
				jobIds: [],
				discoveryId: null,
				startedAt: 40_000,
				classification: r.internal.classify(track, "rtl"),
				probeIds: new Set(),
				lastActivityAt: 40_000,
				lastIngestAt: 40_000,
				lastTrack: track,
				decoded: false,
				encrypted: false,
			} as unknown as LiveObservation)
			const applyEvidence = vi.spyOn(
				r.h.service as unknown as {
					applyEvidence(l: LiveObservation, ev: unknown): boolean
				},
				"applyEvidence",
			)
			r.apply({ captureId: "cap-3", observationId: "o_live" })
			expect(applyEvidence).not.toHaveBeenCalled()
			expect(r.discoveries()).toHaveLength(1)
		} finally {
			await r.stop()
		}
	})

	it("the live observation a replay anchored stays with the anchor through further ingests and its close", async () => {
		const r = await scanner(c)
		try {
			const job = await r.h.service.createJob({
				sourceId: "rtl",
				mode: "in-window",
				signalsOnly: true,
			})
			r.apply({})
			const anchorId = r.discoveries()[0]!.id
			const track = trackOf({
				trackId: "t2",
				centreHz: c.channelHz + OFF,
				obwHz: 9_000,
				epoch: 1,
			})
			const live = {
				observationId: "o_live",
				sourceId: "rtl",
				trackId: "t2",
				epoch: 1,
				jobIds: [job.id],
				discoveryId: null,
				startedAt: 40_000,
				classification: r.internal.classify(track, "rtl"),
				probeIds: new Set(),
				lastActivityAt: 40_000,
				lastIngestAt: 40_000,
				lastTrack: track,
				decoded: false,
				encrypted: false,
			} as unknown as LiveObservation
			r.internal.live.set("t2", live)
			// The first replay's observation ("o_gone") is not tracked: nothing was held for it.
			expect(r.internal.store.anchorHeldCount()).toBe(0)
			r.apply({ captureId: "cap-3", observationId: "o_live" })
			expect(r.internal.store.anchorHeldCount()).toBe(1)
			r.internal.ingest(live, track)
			r.internal.ingest(live, { ...track, blocks: 40 })
			expect(r.discoveries().map(d => d.id)).toEqual([anchorId])
			r.internal.ingest(live, { ...track, blocks: 60 }, "quiet")
			expect(r.discoveries().map(d => d.id)).toEqual([anchorId])
			expect(live.discoveryId).toBeNull()
			expect(r.internal.store.discoveryIdOf("o_live")).toBeUndefined()
			// The close released the hold.
			expect(r.internal.store.anchorHeldCount()).toBe(0)
		} finally {
			await r.stop()
		}
	})

	it("a replay landing after its observation closed holds nothing", async () => {
		const r = await scanner(c)
		try {
			const job = await r.h.service.createJob({
				sourceId: "rtl",
				mode: "in-window",
				signalsOnly: true,
			})
			r.apply({})
			const anchorId = r.discoveries()[0]!.id
			const track = trackOf({
				trackId: "t3",
				centreHz: c.channelHz + OFF,
				obwHz: 9_000,
				epoch: 1,
			})
			// Closed and kept in recent, as the service leaves an observation after its close.
			const closed = {
				observationId: "o_closed",
				sourceId: "rtl",
				trackId: "t3",
				epoch: 1,
				jobIds: [job.id],
				discoveryId: null,
				startedAt: 40_000,
				endedAt: 45_000,
				endReason: "quiet",
				classification: r.internal.classify(track, "rtl"),
				probeIds: new Set(),
				lastActivityAt: 45_000,
				lastIngestAt: 45_000,
				lastTrack: track,
				decoded: false,
				encrypted: false,
			} as unknown as LiveObservation
			r.internal.recent.push(closed)
			r.apply({ captureId: "cap-4", observationId: "o_closed" })
			// The anchor still took the decode; no hold was spent on an observation that never ingests again.
			expect(r.discoveries().map(d => d.id)).toEqual([anchorId])
			expect(r.internal.store.anchorHeldCount()).toBe(0)
		} finally {
			await r.stop()
		}
	})

	it("a stored spectrum discovery at the channel is proven; no anchor opens beside it", async () => {
		const r = await scanner(c)
		try {
			const id = r.internal.store.ingest(
				makeObs({
					id: "o_spec",
					centreHz: c.channelHz + OFF,
					startedAt: 40_000,
					blocks: 2,
					sourceId: "rtl",
					open: true,
				}),
			).discoveryId
			if (id === null) throw new Error("spectrum did not surface")
			r.apply({})
			const all = r.discoveries()
			expect(all).toHaveLength(1)
			expect(r.internal.store.get(id)).toMatchObject({
				confidence: "decoded",
				protocol: c.protocol,
				proof: {
					kind: "decoded",
					protocol: c.protocol,
					transport: "replay",
					identity: c.identity,
				},
			})
		} finally {
			await r.stop()
		}
	})

	it("an untrusted capture never anchors", async () => {
		const r = await scanner(c, "unverified")
		try {
			r.apply({})
			expect(r.discoveries()).toHaveLength(0)
		} finally {
			await r.stop()
		}
	})
})
