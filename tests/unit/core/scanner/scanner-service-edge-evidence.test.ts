// DQ 1.4e: edge tracks write no PSD evidence, and a capture whose track turns edge after it
// opened is neither replayed nor kept.
import { EventEmitter } from "node:events"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ScannerCapture } from "@wavekit/api-types"
import { CaptureRecorder } from "../../../../src/core/scanner/evidence/capture-recorder.js"
import type { CaptureEngineView } from "../../../../src/core/scanner/evidence/capture-recorder.js"
import { DEFAULT_CAPTURE } from "../../../../src/core/scanner/evidence/capture-spec.js"
import { CaptureStore } from "../../../../src/core/scanner/evidence/capture-store.js"
import type { IqCaptureView } from "../../../../src/core/scanner/iq-capture-contract.js"
import type { LiveObservation } from "../../../../src/core/scanner/job-runner.js"
import { planReplayTrials } from "../../../../src/core/scanner/replay-plan.js"
import type { ScannerServiceDeps } from "../../../../src/core/scanner/scanner-service.js"
import type { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type {
	BlockSummary,
	TrackSnapshot,
} from "../../../../src/core/spectrum/types.js"
import { TARGET_HZ, trackOf } from "../../../mocks/scanner/identify-fakes.js"
import { makeObs, makeTrack } from "../../../mocks/scanner/observations.js"
import { CENTRE, serviceHarness } from "../../../mocks/scanner/service-fakes.js"

interface Internal {
	deps: ScannerServiceDeps
	storageDir: string
	store: DiscoveryStore
	live: Map<string, LiveObservation>
	onBlockSummary(sourceId: string, summary: BlockSummary): void
	writePsdEvidence(live: LiveObservation): Promise<void>
	requestIqCapture(live: LiveObservation, track: TrackSnapshot): void
	onTrack(
		sourceId: string,
		ev:
			| { kind: "track-update"; track: TrackSnapshot }
			| { kind: "track-close"; track: TrackSnapshot; endReason: "quiet" },
	): void
}

const harnesses: ReturnType<typeof serviceHarness>[] = []

afterEach(async () => {
	vi.restoreAllMocks()
	for (const h of harnesses.splice(0)) {
		await h.service.stop()
		await rm(h.dir, { recursive: true, force: true })
	}
})

async function boot(evidence: { psd: boolean; iq: boolean }) {
	const h = serviceHarness({ patch: s => void (s.passive.enabled = false) })
	harnesses.push(h)
	await h.service.start()
	const job = await h.service.createJob({
		sourceId: "rtl",
		mode: "in-window",
		ranges: [{ startHz: 446_000_000, endHz: 446_100_000 }],
		capture: { enabled: true, preMs: 200, postMs: 100 },
		evidence,
	})
	return { h, job, internal: h.service as unknown as Internal }
}

function liveOf(
	track: TrackSnapshot,
	jobId: string,
	discoveryId: string | null,
): LiveObservation {
	return {
		observationId: `o_${track.trackId}`,
		sourceId: "rtl",
		trackId: track.trackId,
		epoch: track.epoch,
		jobIds: [jobId],
		discoveryId,
		startedAt: 0,
		classification: { class: "unknown", hypotheses: [], tier: "spectral" },
		probeIds: new Set(),
		lastActivityAt: 0,
		lastIngestAt: 0,
		lastTrack: track,
		decoded: false,
		encrypted: false,
	}
}

/** A 1 kHz-bin summary covering the whole 1.024 Msps span. */
function summaryAt(): BlockSummary {
	const bins = Array.from({ length: 1_024 }, () => -60)
	return {
		sourceId: "rtl",
		stream: 1,
		epoch: 1,
		endSample: 0,
		centreHz: CENTRE,
		sampleRateHz: 1_024_000,
		binHz: 1_000,
		startHz: CENTRE - 512_000,
		bins,
		floorDbfs: -90,
		thresholdDb: 9,
		tracks: [],
		masks: { dcHz: CENTRE, dcGuardHz: 0, spurRanges: [] },
		floorOccupied: false,
		overload: false,
	}
}

describe("PSD evidence keeps off edge tracks (DQ 1.4e)", () => {
	async function psdOf(offsetHz: number, edge: boolean) {
		const { job, internal } = await boot({ psd: true, iq: false })
		const obs = makeObs({
			id: `p${offsetHz}`,
			centreHz: CENTRE + offsetHz,
			startedAt: 0,
			snrDb: 30,
			blocks: 40,
			obwHz: 12_500,
			gate: "passed",
			sourceId: "rtl",
		})
		internal.store.ingest(obs)
		const id = internal.store.snapshot().discoveries[0]?.id
		expect(id).toBeDefined()
		const track = makeTrack({
			id: `p${offsetHz}`,
			centreHz: CENTRE + offsetHz,
			startedAt: 0,
			snrDb: 30,
			obwHz: 12_500,
			edge,
		})
		const live = liveOf(track, job.id, id!)
		internal.live.set(track.trackId, live)
		internal.onBlockSummary("rtl", summaryAt())
		internal.live.delete(track.trackId)
		await internal.writePsdEvidence(live)
		return {
			file: existsSync(join(internal.storageDir, "evidence", id!, "psd.json")),
			flag: internal.store.get(id!)?.evidence.psd,
		}
	}

	it("a strong edge track at +460.8 kHz closes with no PSD file and no flag", async () => {
		expect(await psdOf(460_800, true)).toEqual({ file: false, flag: false })
	})

	it("a non-edge control still writes", async () => {
		expect(await psdOf(100_000, false)).toEqual({ file: true, flag: true })
	})

	it("a slice held before the track turned edge is dropped", async () => {
		const { job, internal } = await boot({ psd: true, iq: false })
		internal.store.ingest(
			makeObs({
				id: "q",
				centreHz: CENTRE + 100_000,
				startedAt: 0,
				snrDb: 30,
				blocks: 40,
				gate: "passed",
				sourceId: "rtl",
			}),
		)
		const id = internal.store.snapshot().discoveries[0]!.id
		const track = makeTrack({
			id: "q",
			centreHz: CENTRE + 100_000,
			startedAt: 0,
			snrDb: 30,
		})
		const live = liveOf(track, job.id, id)
		internal.live.set(track.trackId, live)
		internal.onBlockSummary("rtl", summaryAt())
		live.lastTrack = { ...track, flags: { ...track.flags, edge: true } }
		internal.onBlockSummary("rtl", summaryAt())
		internal.live.delete(track.trackId)
		await internal.writePsdEvidence(live)
		expect(existsSync(join(internal.storageDir, "evidence", id))).toBe(false)
		expect(internal.store.get(id)?.evidence.psd).toBe(false)
	})
})

describe("a capture whose track turns edge is not replayed or kept (DQ 1.4e)", () => {
	async function lifecycle(turnsEdge: boolean) {
		const { job, internal } = await boot({ psd: false, iq: false })
		const port = {
			capture: vi.fn().mockReturnValue({ captureId: "c_1" }),
			discard: vi.fn().mockReturnValue(true),
			end: vi.fn(),
		}
		internal.deps = {
			...internal.deps,
			iqCapture: { ...internal.deps.iqCapture, ...port } as never,
		}
		const close = vi.spyOn(CaptureRecorder.prototype, "close")
		const opened = makeTrack({
			id: "e",
			centreHz: CENTRE + 300_000,
			startedAt: 0,
			obwHz: 12_500,
		})
		opened.gate = "passed"
		const live = liveOf(opened, job.id, "d_e")
		internal.live.set(opened.trackId, live)
		internal.requestIqCapture(live, opened)
		expect(port.capture).toHaveBeenCalledTimes(1)
		const later: TrackSnapshot = {
			...opened,
			flags: { ...opened.flags, edge: turnsEdge },
		}
		internal.onTrack("rtl", { kind: "track-update", track: later })
		internal.onTrack("rtl", {
			kind: "track-close",
			track: later,
			endReason: "quiet",
		})
		const closedAt = close.mock.calls.find(
			c => c[0] === live.observationId,
		)?.[1]
		return { port, closedAt, track: later }
	}

	it("an IQ capture is discarded when the track turns edge, never ended for replay", async () => {
		const { port, closedAt, track } = await lifecycle(true)
		expect(port.discard).toHaveBeenCalledWith("c_1", "invalid")
		expect(port.end).not.toHaveBeenCalled()
		// A burst capture closes on an empty window (the recorder discards it).
		expect(closedAt).toBe(Number.MIN_SAFE_INTEGER)
		// The planner plans no replay trial for the edge track either.
		expect(planReplayTrials(planInput(track))).toEqual([])
	})

	it("a control that stays inside the span ends normally and is replayed", async () => {
		const { port, closedAt, track } = await lifecycle(false)
		expect(port.discard).not.toHaveBeenCalled()
		expect(port.end).toHaveBeenCalledWith("c_1")
		expect(closedAt).toBe(track.lastSample)
		expect(planReplayTrials(planInput(trackOf({}))).length).toBeGreaterThan(0)
	})
})

const view: IqCaptureView = {
	captureId: "c1",
	sourceId: "rtl",
	observationId: "o_t1",
	epoch: 1,
	rfHz: TARGET_HZ,
	tuningTrust: "commanded",
	capturedAtMs: 0,
	durationMs: 2000,
	gapSamples: 0,
}

function planInput(track: TrackSnapshot) {
	return {
		capture: view,
		track,
		knownProtocol: null,
		priors: {},
		narrowRaster: false,
	}
}

describe("replay planner refuses edge tracks (DQ 1.4e)", () => {
	it("an edge track plans nothing, the same track inside plans trials", () => {
		const inside = trackOf({ acf30: -0.94, acf60: 0.99 })
		expect(planReplayTrials(planInput(inside)).length).toBeGreaterThan(0)
		const edge = { ...inside, flags: { ...inside.flags, edge: true } }
		expect(planReplayTrials(planInput(edge))).toEqual([])
	})
})

describe("burst capture closed on an empty window (DQ 1.4e)", () => {
	class Engine extends EventEmitter implements CaptureEngineView {
		readonly sourceId = "rtl"
		readonly format = "U8_IQ" as const
		edgeAt = 0
		private readonly taps = new Set<
			(start: number, bytes: Uint8Array) => void
		>()
		currentEpoch() {
			return {
				stream: 0,
				epoch: 1,
				startSample: 0,
				centreHz: CENTRE,
				sampleRateHz: 64_000,
				gainKey: "m:296",
				tuningTrust: "commanded" as const,
				settleMode: "marker" as const,
			}
		}
		accounting() {
			return { stream: 0 }
		}
		liveEdge() {
			return this.edgeAt
		}
		oldestSample() {
			return 0
		}
		readRing() {
			return null
		}
		tap(fn: (start: number, bytes: Uint8Array) => void) {
			this.taps.add(fn)
			return () => this.taps.delete(fn)
		}
		push(samples: number) {
			const start = this.edgeAt
			this.edgeAt += samples
			for (const t of this.taps) t(start, new Uint8Array(samples * 2))
		}
	}

	for (const onlyDecoded of [false, true])
		it(`never commits and removes its staging file (onlyDecoded ${onlyDecoded})`, async () => {
			const dir = mkdtempSync(join(tmpdir(), "wk-cap-edge-"))
			const engine = new Engine()
			const store = new CaptureStore({
				dir: join(dir, "captures"),
				logger: pino({ level: "silent" }),
				now: () => 1_000_000,
			})
			const recorder = new CaptureRecorder({
				store,
				engines: () => engine,
				diskOk: () => true,
				logger: pino({ level: "silent" }),
				now: () => 1_000_000,
				decodeWaitMs: 5,
			})
			const captured: ScannerCapture[] = []
			const discarded: string[] = []
			recorder.on("captured", (c: ScannerCapture) => captured.push(c))
			recorder.on("discarded", (_id: string, reason: string) =>
				discarded.push(reason),
			)
			try {
				await store.init()
				expect(
					recorder.open({
						observationId: "o1",
						jobId: "j1",
						sourceId: "rtl",
						stream: 0,
						epoch: 1,
						startSample: 0,
						targetHz: CENTRE,
						spec: { ...DEFAULT_CAPTURE, enabled: true, onlyDecoded },
					}),
				).toBe(true)
				engine.push(32_000)
				recorder.close("o1", Number.MIN_SAFE_INTEGER, () => {
					throw new Error("never evaluated for an empty window")
				})
				engine.push(32_000)
				for (let i = 0; i < 100 && discarded.length === 0; i++)
					await new Promise(r => setTimeout(r, 5))
				expect(captured).toEqual([])
				expect(discarded).toHaveLength(1)
				expect(recorder.has("o1")).toBe(false)
				const left = existsSync(join(dir, "captures"))
					? readdirSync(join(dir, "captures"), { recursive: true }).filter(f =>
							String(f).includes("cap_"),
						)
					: []
				expect(left).toEqual([])
			} finally {
				await recorder.stop()
				rmSync(dir, { recursive: true, force: true })
			}
		})
})
