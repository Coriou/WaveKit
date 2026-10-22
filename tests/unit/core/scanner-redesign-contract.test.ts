/**
 * WG12 frozen contract (docs/specs/scanner-redesign, task 0.1): channel-gate and
 * analog-trial arithmetic, widened identify unions, optional DTO fields, CLI guards,
 * the absent-iqCapture config shape, evidence-sink bounds and the accepted route fields.
 * No runtime behaviour.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import {
	DISCOVERY_MERGED_IDS_MAX,
	DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ,
	DISCOVERY_NEAR_MAX_TOLERANCE_HZ,
	IDENTIFY_WAIT_DEFAULT_MS,
	IDENTIFY_WAIT_MAX_MS,
	IDENTIFY_WAIT_MIN_MS,
	SCANNER_PROOF_PROTOCOL_LABEL,
	SCANNER_PROOF_SUMMARY_MAX_CHARS,
	SCANNER_PROOF_TRIED_MAX,
} from "@wavekit/api-types"
import {
	guardScan,
	guardSpectrumFrame,
} from "../../../cli/source/data/scanner-guards.js"
import {
	SCAN_DISCOVERY,
	SCAN_FRAME,
	SCAN_JOB,
} from "../../../cli/source/test/fixtures.js"
import {
	discoveryQuerySchema,
	identifyBodySchema,
} from "../../../src/api/routes/scanner-schemas.js"
import { ScannerConfigSchema } from "../../../src/config.js"
import { IQ_CAPTURE_MAX_MS } from "../../../src/core/scanner/iq-capture-contract.js"
import {
	ANALOG_TRIAL_AM_CARRIER_DB,
	ANALOG_TRIAL_AUDIO_MIN_DB,
	ANALOG_TRIAL_CORES,
	ANALOG_TRIAL_DATA_SCORE,
	ANALOG_TRIAL_FRAME_MS,
	ANALOG_TRIAL_MAX_FRAMES,
	ANALOG_TRIAL_MIN_QUIET_FRACTION,
	ANALOG_TRIAL_QUIETING_DB,
	ANALOG_TRIAL_VOICE_INDEX,
	ANALYZE_EVENT_MAX_BYTES,
	CHANNEL_GATE_BURST_MARGIN_DB,
	CHANNEL_GATE_BURST_MIN_DURATION_MS,
	CHANNEL_GATE_DEFAULT_WIDTH_HZ,
	CHANNEL_GATE_HYSTERESIS_DB,
	CHANNEL_GATE_K_DB,
	CHANNEL_GATE_MARGIN_DB,
	CHANNEL_GATE_MAX_MASKED_FRACTION,
	CHANNEL_GATE_MAX_SLOTS,
	CHANNEL_GATE_MAX_WIDTH_HZ,
	CHANNEL_GATE_MIN_DURATION_MS,
	CHANNEL_GATE_MIN_WIDTH_HZ,
	PROOF_ANALOG_MAX_PER_OBSERVATION,
	PROOF_TRIALS_MAX_PER_OBSERVATION,
	type DiscoveryNearQuery,
	type ObservationEvidenceSink,
} from "../../../src/core/scanner/scanner-redesign-contract.js"

import {
	scannerRoutes,
	type ScannerRouteService,
} from "../../../src/api/routes/scanner.js"
import {
	identifyHarness,
	trackOf,
	viewOf,
} from "../../mocks/scanner/identify-fakes.js"

/** Capture defaults apply even when the key is absent. */
const iqCaptureDefault = {
	enabled: true,
	maxTotalMb: 256,
	maxCaptureMs: 4000,
	preRollMs: 500,
	binaryPath: "wavekit-iqcap",
	allowLegacy: false,
}

describe("WG12 scanner redesign contract", () => {
	let app: FastifyInstance
	beforeAll(async () => {
		app = Fastify({ logger: false })
		app.post("/identify", { schema: { body: identifyBodySchema } }, () => ({}))
		app.get(
			"/discoveries",
			{ schema: { querystring: discoveryQuerySchema } },
			() => ({}),
		)
		await app.ready()
	})
	afterAll(async () => {
		await app.close()
	})

	const postIdentify = (body: object) =>
		app.inject({ method: "POST", url: "/identify", payload: body })
	const getDiscoveries = (query: string) =>
		app.inject({ method: "GET", url: `/discoveries?${query}` })

	it("keeps failed digital target proof through REST and the CLI boundary", async () => {
		const h = identifyHarness()
		const route = Fastify({ logger: false })
		try {
			await h.runner.start()
			h.tracks.push(viewOf(trackOf({ obwHz: 12_000 })))
			for (let i = 0; i < 40 && h.record.state !== "completed"; i++)
				await h.advance(1000)
			const target = h.last()!
			expect(target.result?.proof).toMatchObject({
				kind: "digital-undecoded",
				summary: expect.stringMatching(/^Digital, not decoded \(tried /),
			})
			expect(target.result?.hint).toBe("fsk2-wide")
			const job = {
				...SCAN_JOB,
				identify: { ...SCAN_JOB.identify, targets: [target] },
			}
			await route.register(scannerRoutes, {
				scanner: { getJob: () => job } as unknown as ScannerRouteService,
			})
			const response = await route.inject(`/api/scanner/jobs/${SCAN_JOB.id}`)
			expect(response.statusCode).toBe(200)
			const parsed = guardScan("job", response.json())
			expect(parsed?.identify?.targets[0]?.result?.proof).toEqual(
				target.result?.proof,
			)
			expect(parsed?.identify?.targets[0]?.result?.hint).toBe(
				target.result?.hint,
			)
			const withResult = (result: object) => ({
				...job,
				identify: { ...job.identify, targets: [{ ...target, result }] },
			})
			const { proof, hint, ...legacy } = target.result!
			expect(proof).toBeDefined()
			expect(hint).toBeDefined()
			expect(guardScan("job", withResult(legacy))).toBeDefined()
			const malformed = guardScan(
				"job",
				withResult({
					...legacy,
					proof: { ...proof, tried: [42] },
					hint: "decoder output",
				}),
			)
			expect(malformed).toBeDefined()
			expect(malformed?.identify?.targets[0]?.result?.proof).toBeUndefined()
			expect(malformed?.identify?.targets[0]?.result?.hint).toBeUndefined()
		} finally {
			await h.runner.dispose()
			await route.close()
		}
	})
	it("pins the gate arithmetic", () => {
		expect(CHANNEL_GATE_K_DB + CHANNEL_GATE_MARGIN_DB).toBe(6)
		expect(CHANNEL_GATE_K_DB + CHANNEL_GATE_BURST_MARGIN_DB).toBe(9)
		expect(CHANNEL_GATE_MIN_DURATION_MS / 50).toBe(6)
		expect(CHANNEL_GATE_BURST_MIN_DURATION_MS / 50).toBe(2)
		expect(CHANNEL_GATE_MAX_MASKED_FRACTION).toBe(0.5)
		expect(CHANNEL_GATE_MAX_SLOTS).toBe(4_096)
	})
	it("pins the analog trial frame budget", () => {
		expect(ANALOG_TRIAL_MAX_FRAMES * ANALOG_TRIAL_FRAME_MS).toBe(
			IQ_CAPTURE_MAX_MS,
		)
		expect(ANALOG_TRIAL_CORES).toBe(0.05)
	})
	it("pins the proof summary examples (R 3.5)", () => {
		const examples = [
			"DMR decoded (CC1, TG 9)",
			"Analog FM voice, CTCSS 88.5",
			"Digital, not decoded (tried DMR, dPMR, NXDN)",
			"Carrier only",
		]
		for (const s of examples)
			expect(s.length).toBeLessThanOrEqual(SCANNER_PROOF_SUMMARY_MAX_CHARS)
		expect(SCANNER_PROOF_SUMMARY_MAX_CHARS).toBe(160)
		expect(SCANNER_PROOF_TRIED_MAX).toBe(16)
		expect(DISCOVERY_MERGED_IDS_MAX).toBe(64)
		// SCANNER_PROOF_PROTOCOL_LABEL is Record<ScannerProtocol, string>, so tsc enforces every key
		expect(SCANNER_PROOF_PROTOCOL_LABEL.dmr).toBe("DMR")
		expect(SCANNER_PROOF_PROTOCOL_LABEL.dpmr).toBe("dPMR")
		expect(SCANNER_PROOF_PROTOCOL_LABEL.nxdn48).toBe("NXDN")
		expect(SCANNER_PROOF_PROTOCOL_LABEL.nxdn96).toBe("NXDN")
	})
	it("CLI guards accept every new value and strip nothing they must keep", () => {
		// guardScan, guardSpectrumFrame and the SCAN_* fixtures are the existing ones
		// (cli/source/data/scanner-guards.ts, cli/source/test/fixtures.ts); no new guard is added
		const target = SCAN_JOB.identify.targets[0]!
		const jobWith = (patch: object) => ({
			...SCAN_JOB,
			identify: { ...SCAN_JOB.identify, targets: [{ ...target, ...patch }] },
		})
		const trial = (outcome: string, decoder = "dsd-fme") => ({
			protocol: "dmr",
			decoder,
			mode: null,
			transport: "replay",
			outcome,
		})
		for (const outcome of ["data-like", "carrier-only"])
			expect(
				guardScan("job", jobWith({ trials: [trial(outcome)] }))?.identify
					?.targets[0]?.trials[0]?.outcome,
			).toBe(outcome)
		expect(
			guardScan("job", jobWith({ trials: [trial("heard", "analog-demod")] }))
				?.identify?.targets[0]?.trials[0]?.decoder,
		).toBe("analog-demod")
		expect(
			guardScan(
				"job",
				jobWith({ result: { ...target.result, ended: "no-signal" } }),
			)?.identify?.targets[0]?.result?.ended,
		).toBe("no-signal")
		expect(
			guardScan(
				"job",
				jobWith({ result: { ...target.result, ended: "bogus" } }),
			),
		).toBeUndefined()
		const proof = {
			kind: "carrier-only",
			protocol: "unknown",
			transport: "replay",
			at: "2026-01-01T00:00:00.000Z",
			observationId: "o1",
			tried: [],
			unavailable: [],
			encrypted: false,
			summary: "Carrier only",
		}
		expect(
			guardScan("discovery", {
				...SCAN_DISCOVERY,
				proof,
				evidenceLevel: "proven",
				mergedIds: ["d2"],
			}),
		).toBeDefined()
		const progress = {
			...SCAN_JOB.progress,
			phase: "trialing",
			parked: true,
			holding: { discoveryId: null, frequencyHz: 446_006_250, trackId: "t1" },
			trial: {
				protocol: "dmr",
				decoder: "dsd-fme",
				transport: "replay",
				discoveryId: null,
			},
			replayQueueDepth: 0,
		}
		expect(guardScan("job", { ...SCAN_JOB, progress })).toBeDefined()
		const tracks = Array.from({ length: 256 }, (_, i) => ({
			...SCAN_FRAME.tracks[0],
			trackId: `t${i}`,
			gate: "passed",
			channelSnrDb: 7.5,
		}))
		expect(guardSpectrumFrame({ ...SCAN_FRAME, tracks })?.tracks).toHaveLength(
			256,
		)
	})
	it("config: absent iqCapture enables capture; allowLegacy defaults false", () => {
		expect(ScannerConfigSchema.parse({}).iqCapture).toEqual(iqCaptureDefault)
		expect(
			ScannerConfigSchema.parse({ iqCapture: { enabled: true } }).iqCapture
				?.allowLegacy,
		).toBe(false)
	})
	it("pins the evidence sink bounds (A12)", () => {
		expect(PROOF_TRIALS_MAX_PER_OBSERVATION).toBe(32)
		expect(PROOF_ANALOG_MAX_PER_OBSERVATION).toBe(8)
		const sink: ObservationEvidenceSink = {
			nextTrialOrder: () => 1,
			recordTrial: () => false,
			recordAnalog: () => false,
			recordUnavailable: () => false,
		}
		expect(sink.nextTrialOrder()).toBe(1)
	})
	it("route schemas: waitMs without waitUntilSignal and toleranceHz without nearHz are refused", async () => {
		// Fastify app with identifyBodySchema and discoveryQuerySchema, as in tests/unit/api/scanner-schemas-wg6.test.ts
		const target = { frequencyHz: 446_006_250 }
		expect(
			(await postIdentify({ sourceId: "rtl", target, waitMs: 5_000 }))
				.statusCode,
		).toBe(400)
		expect(
			(
				await postIdentify({
					sourceId: "rtl",
					target,
					waitUntilSignal: true,
					waitMs: 5_000,
				})
			).statusCode,
		).toBe(200)
		expect((await getDiscoveries("toleranceHz=1000")).statusCode).toBe(400)
		expect(
			(await getDiscoveries("nearHz=446006250&toleranceHz=1000")).statusCode,
		).toBe(200)
		expect((await getDiscoveries("evidence=proven")).statusCode).toBe(200)
		expect((await getDiscoveries("evidence=maybe")).statusCode).toBe(400)
	})
	it("bounds: waitMs 999 and 600001 refused, 1000 and 600000 accepted; toleranceHz 1000001 refused", async () => {
		const body = (waitMs: number) => ({
			sourceId: "rtl",
			target: { frequencyHz: 446_006_250 },
			waitUntilSignal: true,
			waitMs,
		})
		expect(IDENTIFY_WAIT_MIN_MS).toBe(1_000)
		expect(IDENTIFY_WAIT_MAX_MS).toBe(600_000)
		expect(IDENTIFY_WAIT_DEFAULT_MS).toBe(300_000)
		expect(DISCOVERY_NEAR_MAX_TOLERANCE_HZ).toBe(1_000_000)
		expect(DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ).toBe(6_250)
		expect((await postIdentify(body(999))).statusCode).toBe(400)
		expect((await postIdentify(body(1_000))).statusCode).toBe(200)
		expect((await postIdentify(body(600_000))).statusCode).toBe(200)
		expect((await postIdentify(body(600_001))).statusCode).toBe(400)
		expect(
			(await getDiscoveries("nearHz=446006250&toleranceHz=1000000")).statusCode,
		).toBe(200)
		expect(
			(await getDiscoveries("nearHz=446006250&toleranceHz=1000001")).statusCode,
		).toBe(400)
		expect((await getDiscoveries("nearHz=100000000000")).statusCode).toBe(200)
		expect((await getDiscoveries("nearHz=100000000001")).statusCode).toBe(400)
	})
	it("DiscoveryNearQuery is structural", () => {
		const q: DiscoveryNearQuery = { near: () => [] }
		expect(q.near(446_006_250, DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ)).toEqual([])
	})
	it("pins the remaining gate, trial and analyze constants", () => {
		expect(CHANNEL_GATE_DEFAULT_WIDTH_HZ).toBe(12_500)
		expect(CHANNEL_GATE_MIN_WIDTH_HZ).toBe(6_250)
		expect(CHANNEL_GATE_MAX_WIDTH_HZ).toBe(200_000)
		expect(CHANNEL_GATE_K_DB).toBe(3)
		expect(CHANNEL_GATE_HYSTERESIS_DB).toBe(1.5)
		expect(CHANNEL_GATE_MARGIN_DB).toBe(3)
		expect(CHANNEL_GATE_MIN_DURATION_MS).toBe(300)
		expect(CHANNEL_GATE_BURST_MIN_DURATION_MS).toBe(100)
		expect(CHANNEL_GATE_BURST_MARGIN_DB).toBe(6)
		expect(ANALOG_TRIAL_FRAME_MS).toBe(50)
		expect(ANALOG_TRIAL_MAX_FRAMES).toBe(80)
		expect(ANALOG_TRIAL_QUIETING_DB).toBe(8)
		expect(ANALOG_TRIAL_MIN_QUIET_FRACTION).toBe(0.5)
		expect(ANALOG_TRIAL_VOICE_INDEX).toBe(0.3)
		expect(ANALOG_TRIAL_AUDIO_MIN_DB).toBe(-30)
		expect(ANALOG_TRIAL_DATA_SCORE).toBe(0.6)
		expect(ANALOG_TRIAL_AM_CARRIER_DB).toBe(6)
		expect(ANALYZE_EVENT_MAX_BYTES).toBe(16_384)
	})
})
