import { makeTmpDir } from "../../helpers/tmp-dir.js"
import type * as NodeFs from "node:fs"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import Fastify, { type FastifyError, type FastifyInstance } from "fastify"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	scannerRoutes,
	type ScannerRouteService,
} from "../../../src/api/routes/scanner.js"
import { ScannerApiError } from "../../../src/core/scanner/errors.js"

const { producer } = vi.hoisted(() => ({
	producer: vi.fn<typeof NodeFs.createReadStream>(),
}))
vi.mock("node:fs", async importOriginal => {
	const actual = await importOriginal<typeof NodeFs>()
	producer.mockImplementation(actual.createReadStream)
	return { ...actual, createReadStream: producer }
})

function fakeService(
	overrides: Partial<Record<keyof ScannerRouteService, unknown>> = {},
) {
	const job = { id: "j_1", state: "running", spec: { mode: "sweep" } }
	const base = {
		status: vi.fn(() => ({ enabled: true, engines: [] })),
		settingsView: vi.fn(() => ({
			effective: {},
			passiveBySource: {},
			provenance: {},
			bounds: {},
		})),
		patchSettings: vi.fn(() =>
			Promise.resolve({
				effective: {},
				passiveBySource: { rtl: false },
				provenance: { "passiveBySource.rtl": "runtime" },
				bounds: {},
			}),
		),
		bandplans: vi.fn(() => [
			{ id: "eu-pmr446", region: "EU", name: "PMR446", ranges: [] },
		]),
		preview: vi.fn(() => ({
			issues: [{ code: "poi-low", severity: "warning", message: "POI 40 %" }],
		})),
		createJob: vi.fn(() => Promise.resolve(job)),
		listJobs: vi.fn(() => [job]),
		getJob: vi.fn((id: string) => (id === "j_1" ? job : undefined)),
		patchJob: vi.fn(() =>
			Promise.resolve({ job, plan: { hops: [] }, issues: [] }),
		),
		pauseJob: vi.fn(() => Promise.resolve({ ...job, state: "paused" })),
		resumeJob: vi.fn(() => Promise.resolve(job)),
		cancelJob: vi.fn(() => Promise.resolve({ ...job, state: "cancelled" })),
		deleteJob: vi.fn(),
		listDiscoveries: vi.fn(() => ({ items: [], nextCursor: null })),
		getDiscovery: vi.fn(() => undefined),
		discoveryObservations: vi.fn(() => ({ items: [], nextCursor: null })),
		patchDiscovery: vi.fn(() => Promise.resolve({ id: "d_1" })),
		deleteDiscovery: vi.fn(() => Promise.resolve(false)),
		recordingPath: vi.fn(() => null),
		evidencePath: vi.fn(() => Promise.resolve(null)),
		listen: vi.fn(() =>
			Promise.resolve({
				mode: "live-audio",
				sourceId: "rtl",
				frequencyHz: 1,
				httpUrl: "u",
				wavUrl: "w",
			}),
		),
	}
	return { ...base, ...overrides } as typeof base
}

describe("scanner routes", () => {
	let app: FastifyInstance
	let service: ReturnType<typeof fakeService>

	async function build(overrides: Parameters<typeof fakeService>[0] = {}) {
		service = fakeService(overrides)
		app = Fastify({ logger: false })
		await app.register(scannerRoutes, {
			scanner: service as unknown as ScannerRouteService,
		})
	}

	afterEach(async () => {
		await app.close()
	})

	it("maps recording authority failure to the exact safe 503 before producer or WAV headers", async () => {
		await build({
			recordingPath: vi.fn(() => {
				throw new ScannerApiError(
					"Scanner recording evidence is unavailable",
					"SCANNER_EVIDENCE_UNAVAILABLE",
					503,
				)
			}),
		})
		producer.mockClear()
		const result = await app.inject({
			url: "/api/scanner/recordings/d_1~call.wav",
		})
		expect(result.statusCode).toBe(503)
		expect(result.json()).toEqual({
			error: "ScannerApiError",
			code: "SCANNER_EVIDENCE_UNAVAILABLE",
			message: "Scanner recording evidence is unavailable",
		})
		expect(result.headers["content-type"]).not.toContain("audio/wav")
		expect(producer).not.toHaveBeenCalled()
	})

	it("maps repeated absent-metadata cleanup uncertainty, then settled and known absent deletion", async () => {
		const pending = () =>
			new ScannerApiError(
				"Scanner evidence cleanup is pending",
				"SCANNER_EVIDENCE_CLEANUP_PENDING",
				503,
			)
		const remove = vi
			.fn<ScannerRouteService["deleteDiscovery"]>()
			.mockRejectedValueOnce(pending())
			.mockRejectedValueOnce(pending())
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false)
		await build({ deleteDiscovery: remove })
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = await app.inject({
				method: "DELETE",
				url: "/api/scanner/discoveries/d_1",
			})
			expect(result.statusCode).toBe(503)
			expect(result.json()).toEqual({
				error: "ScannerApiError",
				code: "SCANNER_EVIDENCE_CLEANUP_PENDING",
				message: "Scanner evidence cleanup is pending",
			})
		}
		expect(
			(
				await app.inject({
					method: "DELETE",
					url: "/api/scanner/discoveries/d_1",
				})
			).statusCode,
		).toBe(204)
		expect(
			(
				await app.inject({
					method: "DELETE",
					url: "/api/scanner/discoveries/d_1",
				})
			).statusCode,
		).toBe(404)
		expect(remove).toHaveBeenCalledTimes(4)
		expect(service.getDiscovery).not.toHaveBeenCalled()
	})

	it("preserves legacy unexpected recording lookup failure as an ordinary framework error", async () => {
		await build({
			recordingPath: vi.fn(() => {
				throw new Error("legacy lookup failed")
			}),
		})
		const result = await app.inject({
			url: "/api/scanner/recordings/d_1~call.wav",
		})
		expect(result.statusCode).toBe(500)
		expect(result.json()).toMatchObject({ message: "legacy lookup failed" })
	})

	it("creates a job (201) and maps scanner errors to their status with details", async () => {
		await build()
		const ok = await app.inject({
			method: "POST",
			url: "/api/scanner/jobs",
			payload: { ranges: [{ startHz: 446e6, endHz: 446.2e6 }] },
		})
		expect(ok.statusCode).toBe(201)
		expect(ok.json()).toMatchObject({ id: "j_1" })
		const impact = {
			liveAudioClients: 1,
			digitalVoiceListeners: 0,
			runningDecoders: ["dmr"],
			pinnedDecoders: [],
			scannerJobs: [],
			unrestorable: [],
		}
		await build({
			createJob: vi.fn(() =>
				Promise.reject(
					new ScannerApiError(
						"needs takeover",
						"SCANNER_TAKEOVER_REQUIRED",
						409,
						{ impact },
					),
				),
			),
		})
		const conflict = await app.inject({
			method: "POST",
			url: "/api/scanner/jobs",
			payload: { mode: "sweep" },
		})
		expect(conflict.statusCode).toBe(409)
		expect(conflict.json()).toEqual({
			error: "ScannerApiError",
			code: "SCANNER_TAKEOVER_REQUIRED",
			message: "needs takeover",
			details: { impact },
		})
		await build({
			createJob: vi.fn(() =>
				Promise.reject(
					new ScannerApiError("bad", "SCANNER_PLAN_INVALID", 400, {
						issues: [],
					}),
				),
			),
		})
		expect(
			(
				await app.inject({
					method: "POST",
					url: "/api/scanner/jobs",
					payload: {},
				})
			).statusCode,
		).toBe(400)
	})

	it("rejects malformed bodies before they reach the service", async () => {
		await build()
		const bad = await app.inject({
			method: "POST",
			url: "/api/scanner/jobs",
			payload: { sensitivity: "extreme" },
		})
		expect(bad.statusCode).toBe(400)
		const hugeLimit = await app.inject({
			method: "GET",
			url: "/api/scanner/discoveries?limit=501",
		})
		expect(hugeLimit.statusCode).toBe(400)
		const settings = await app.inject({
			method: "PATCH",
			url: "/api/scanner/settings",
			payload: { cpuBudgetCores: -1 },
		})
		expect(settings.statusCode).toBe(400)
		expect(service.createJob).not.toHaveBeenCalled()
		expect(service.patchSettings).not.toHaveBeenCalled()
	})

	it("parses discovery filters into the store's types", async () => {
		await build()
		const res = await app.inject({
			method: "GET",
			url: "/api/scanner/discoveries?sourceId=rtl&minConfidence=decoded&freqMinHz=446000000&since=2026-10-09T10:00:00.000Z&encrypted=false&sort=frequency&limit=50",
		})
		expect(res.statusCode).toBe(200)
		expect(service.listDiscoveries).toHaveBeenCalledWith({
			sourceId: "rtl",
			minConfidence: "decoded",
			freqMinHz: 446_000_000,
			since: Date.parse("2026-10-09T10:00:00.000Z"),
			encrypted: false,
			sort: "frequency",
			limit: 50,
		})
	})

	it("answers 404 for unknown jobs and discoveries, and 204 for deletes", async () => {
		await build({ deleteDiscovery: vi.fn(() => Promise.resolve(true)) })
		expect(
			(await app.inject({ method: "GET", url: "/api/scanner/jobs/nope" }))
				.statusCode,
		).toBe(404)
		expect(
			(
				await app.inject({
					method: "GET",
					url: "/api/scanner/discoveries/nope",
				})
			).statusCode,
		).toBe(404)
		expect(
			(
				await app.inject({
					method: "DELETE",
					url: "/api/scanner/discoveries/d_1",
				})
			).statusCode,
		).toBe(204)
		expect(
			(await app.inject({ method: "DELETE", url: "/api/scanner/jobs/j_1" }))
				.statusCode,
		).toBe(204)
	})

	it("passes takeover on resume and streams recordings as audio/wav", async () => {
		const dir = makeTmpDir("wk-rec-")
		const wav = join(dir, "call.wav")
		writeFileSync(wav, Buffer.from("RIFF0000WAVE"))
		await build({
			recordingPath: vi.fn((id: string) =>
				id === "d_1~call.wav" ? wav : null,
			),
		})
		await app.inject({
			method: "POST",
			url: "/api/scanner/jobs/j_1/resume",
			payload: { takeover: true },
		})
		expect(service.resumeJob).toHaveBeenCalledWith("j_1", { takeover: true })
		const rec = await app.inject({
			method: "GET",
			url: "/api/scanner/recordings/d_1~call.wav",
		})
		expect(rec.statusCode).toBe(200)
		expect(rec.headers["content-type"]).toBe("audio/wav")
		expect(rec.body).toBe("RIFF0000WAVE")
		expect(
			(
				await app.inject({
					method: "GET",
					url: "/api/scanner/recordings/missing",
				})
			).statusCode,
		).toBe(404)
	})

	it("converts range and exclusion shorthands into core types (spec § 5.1)", async () => {
		await build()
		const ok = await app.inject({
			method: "POST",
			url: "/api/scanner/jobs",
			payload: {
				ranges: [
					{ startHz: 446_000_000, endHz: 446_200_000, spacingHz: 12_500 },
					{ startHz: 433_050_000, endHz: 434_790_000 },
				],
				exclusions: [
					{ frequencyHz: 446_100_000, widthHz: 20_000, reason: "repeater" },
					{ startHz: 446_150_000, endHz: 446_160_000 },
				],
			},
		})
		expect(ok.statusCode).toBe(201)
		expect(service.createJob).toHaveBeenCalledWith({
			ranges: [
				{
					startHz: 446_000_000,
					endHz: 446_200_000,
					rasters: [{ spacingHz: 12_500, firstChannelHz: 446_006_250 }],
				},
				{ startHz: 433_050_000, endHz: 434_790_000 },
			],
			exclusions: [
				{ startHz: 446_090_000, endHz: 446_110_000, reason: "repeater" },
				{ startHz: 446_150_000, endHz: 446_160_000 },
			],
		})
		await app.inject({
			method: "POST",
			url: "/api/scanner/plan",
			payload: {
				ranges: [
					{
						startHz: 446e6,
						endHz: 446.2e6,
						spacingHz: 6250,
						firstChannelHz: 446.103125e6,
					},
				],
			},
		})
		expect(service.preview).toHaveBeenCalledWith({
			ranges: [
				{
					startHz: 446e6,
					endHz: 446.2e6,
					rasters: [{ spacingHz: 6250, firstChannelHz: 446.103125e6 }],
				},
			],
		})
		const half = await app.inject({
			method: "POST",
			url: "/api/scanner/jobs",
			payload: { exclusions: [{ frequencyHz: 446_100_000 }] },
		})
		expect(half.statusCode).toBe(400)
		const orphan = await app.inject({
			method: "POST",
			url: "/api/scanner/jobs",
			payload: {
				ranges: [
					{ startHz: 446e6, endHz: 446.2e6, firstChannelHz: 446.00625e6 },
				],
			},
		})
		expect(orphan.statusCode).toBe(400)
		const both = await app.inject({
			method: "POST",
			url: "/api/scanner/jobs",
			payload: {
				ranges: [
					{
						startHz: 446e6,
						endHz: 446.2e6,
						spacingHz: 12_500,
						rasters: [{ spacingHz: 12_500, firstChannelHz: 446.00625e6 }],
					},
				],
			},
		})
		expect(both.statusCode).toBe(400)
		expect(service.createJob).toHaveBeenCalledTimes(1)
	})

	it("maps listen conflicts", async () => {
		await build({
			listen: vi.fn(() =>
				Promise.reject(new ScannerApiError("outside", "OUT_OF_WINDOW", 409)),
			),
		})
		const res = await app.inject({
			method: "POST",
			url: "/api/scanner/discoveries/d_1/listen",
		})
		expect(res.statusCode).toBe(409)
		expect(res.json()).toMatchObject({ code: "OUT_OF_WINDOW" })
	})

	it("maps the state and settings codes of the service to 503, 400 and 500", async () => {
		const unavailable = new ScannerApiError(
			"state unreadable",
			"SCANNER_STATE_UNAVAILABLE",
			503,
		)
		await build({
			createJob: vi.fn(() => Promise.reject(unavailable)),
			resumeJob: vi.fn(() => Promise.reject(unavailable)),
		})
		const create = await app.inject({
			method: "POST",
			url: "/api/scanner/jobs",
			payload: { mode: "sweep" },
		})
		expect(create.statusCode).toBe(503)
		expect(create.json()).toEqual({
			error: "ScannerApiError",
			code: "SCANNER_STATE_UNAVAILABLE",
			message: "state unreadable",
		})
		expect(
			(
				await app.inject({
					method: "POST",
					url: "/api/scanner/jobs/j_1/resume",
					payload: {},
				})
			).statusCode,
		).toBe(503)
		const cases = [
			new ScannerApiError("state unreadable", "SCANNER_STATE_UNAVAILABLE", 503),
			new ScannerApiError("bad patch", "SCANNER_SETTINGS_INVALID", 400, {
				issues: [],
			}),
			new ScannerApiError("disk full", "SCANNER_SETTINGS_WRITE_FAILED", 500),
		]
		for (const err of cases) {
			await app.close()
			await build({ patchSettings: vi.fn(() => Promise.reject(err)) })
			const res = await app.inject({
				method: "PATCH",
				url: "/api/scanner/settings",
				payload: { cpuBudgetCores: 2 },
			})
			expect(res.statusCode).toBe(err.statusCode)
			expect(res.json()).toMatchObject({
				error: "ScannerApiError",
				code: err.code,
				message: err.message,
			})
		}
	})

	it("surfaces busy-source refusals as 409 with the arbiter's detail", async () => {
		for (const detail of [
			"holder is starting",
			"releasing",
			"recovery pending",
		]) {
			await build({
				resumeJob: vi.fn(() =>
					Promise.reject(
						new ScannerApiError(detail, "SCANNER_SOURCE_BUSY", 409),
					),
				),
			})
			const res = await app.inject({
				method: "POST",
				url: "/api/scanner/jobs/j_1/resume",
				payload: { takeover: true },
			})
			expect(res.statusCode).toBe(409)
			expect(res.json()).toEqual({
				error: "ScannerApiError",
				code: "SCANNER_SOURCE_BUSY",
				message: detail,
			})
			await app.close()
		}
		await build()
	})

	it("POST /api/scanner/jobs answers 409 with details.holderJobId when a job holds the lease (Task 38)", async () => {
		await build({
			createJob: vi.fn(() =>
				Promise.reject(
					new ScannerApiError(
						"Lease held by scanner job j_high",
						"SCANNER_SOURCE_BUSY",
						409,
						{ holderJobId: "j_high" },
					),
				),
			),
		})
		const res = await app.inject({
			method: "POST",
			url: "/api/scanner/jobs",
			payload: { mode: "sweep", takeover: true },
		})
		expect(res.statusCode).toBe(409)
		expect(res.json()).toEqual({
			error: "ScannerApiError",
			code: "SCANNER_SOURCE_BUSY",
			message: "Lease held by scanner job j_high",
			details: { holderJobId: "j_high" },
		})
	})

	it("validates the settings PATCH with ScannerSettingsPatchSchema and rejects config-only keys", async () => {
		await build()
		for (const ws of [
			{ spectrumSummaryBins: 512 },
			{ spectrumMaxProfiles: 4 },
		]) {
			const res = await app.inject({
				method: "PATCH",
				url: "/api/scanner/settings",
				payload: { ws },
			})
			expect(res.statusCode).toBe(400)
			expect(res.json()).toMatchObject({
				error: "ValidationError",
				code: "VALIDATION_ERROR",
			})
		}
		expect(service.patchSettings).not.toHaveBeenCalled()
		const ok = await app.inject({
			method: "PATCH",
			url: "/api/scanner/settings",
			payload: { passive: { rtl: false }, ws: { spectrumHz: 2 } },
		})
		expect(ok.statusCode).toBe(200)
		expect(service.patchSettings).toHaveBeenCalledWith({
			passive: { rtl: false },
			ws: { spectrumHz: 2 },
		})
		expect(ok.json()).toMatchObject({
			passiveBySource: { rtl: false },
			provenance: { "passiveBySource.rtl": "runtime" },
		})
	})

	it("resumes without a body as takeover false", async () => {
		await build()
		expect(
			(
				await app.inject({
					method: "POST",
					url: "/api/scanner/jobs/j_1/resume",
				})
			).statusCode,
		).toBe(200)
		expect(service.resumeJob).toHaveBeenCalledWith("j_1", { takeover: false })
		expect(
			(
				await app.inject({ method: "POST", url: "/api/scanner/jobs/j_1/pause" })
			).json(),
		).toMatchObject({ state: "paused" })
	})

	it("rejects ids that could leave the evidence and recording folders before the service sees them", async () => {
		await build()
		for (const url of [
			"/api/scanner/discoveries/..%2F..%2Fetc/evidence/psd",
			"/api/scanner/discoveries/..%2F..%2Fetc/evidence/iq",
			"/api/scanner/discoveries/d_1%2F..%2F..%2Fetc/evidence/psd",
		]) {
			const res = await app.inject({ method: "GET", url })
			expect(res.statusCode).toBe(400)
			expect(res.json()).toMatchObject({ code: "FST_ERR_VALIDATION" })
		}
		expect(
			(
				await app.inject({
					method: "DELETE",
					url: "/api/scanner/discoveries/..%2F..%2Fetc",
				})
			).statusCode,
		).toBe(400)
		expect(
			(
				await app.inject({
					method: "GET",
					url: "/api/scanner/recordings/..%2F..%2Fetc%2Fpasswd.wav",
				})
			).statusCode,
		).toBe(404)
		expect(
			(
				await app.inject({
					method: "GET",
					url: "/api/scanner/recordings/d_1~..%2F..%2Fx.wav",
				})
			).statusCode,
		).toBe(404)
		expect(service.evidencePath).not.toHaveBeenCalled()
		expect(service.deleteDiscovery).not.toHaveBeenCalled()
		expect(service.recordingPath).not.toHaveBeenCalled()
		expect(
			(
				await app.inject({
					method: "GET",
					url: "/api/scanner/discoveries/d_01ABC/evidence/psd",
				})
			).statusCode,
		).toBe(404)
		expect(service.evidencePath).toHaveBeenCalledWith("d_01ABC", "psd")
	})

	it("keeps the central handler's correlationId and array details in error bodies", async () => {
		service = fakeService()
		app = Fastify({ logger: false })
		// Like ApiServer's handler for schema-validation errors.
		app.setErrorHandler((error: FastifyError, _request, reply) =>
			reply.status(400).send({
				error: "ValidationError",
				code: "VALIDATION_ERROR",
				message: error.message,
				details: error.validation,
				correlationId: "c-1",
			}),
		)
		await app.register(scannerRoutes, {
			scanner: service as unknown as ScannerRouteService,
		})
		const res = await app.inject({
			method: "POST",
			url: "/api/scanner/jobs",
			payload: { sensitivity: "extreme" },
		})
		expect(res.statusCode).toBe(400)
		const body = res.json<{ correlationId?: string; details?: unknown }>()
		expect(body.correlationId).toBe("c-1")
		expect(Array.isArray(body.details)).toBe(true)
	})
})
