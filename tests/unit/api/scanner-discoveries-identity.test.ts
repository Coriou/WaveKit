import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	scannerRoutes,
	type ScannerRouteService,
} from "../../../src/api/routes/scanner.js"
import { DiscoveryStore } from "../../../src/core/scanner/store/discovery-store.js"
import {
	counterIds,
	evidence,
	makeObs,
} from "../../mocks/scanner/observations.js"

const CH = 446_006_250
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)

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
		patchSettings: vi.fn(() => Promise.resolve({})),
		bandplans: vi.fn(() => []),
		preview: vi.fn(() => ({ issues: [] })),
		createJob: vi.fn(() => Promise.resolve(job)),
		listJobs: vi.fn(() => [job]),
		getJob: vi.fn(() => undefined),
		patchJob: vi.fn(() =>
			Promise.resolve({ job, plan: { hops: [] }, issues: [] }),
		),
		pauseJob: vi.fn(() => Promise.resolve(job)),
		resumeJob: vi.fn(() => Promise.resolve(job)),
		cancelJob: vi.fn(() => Promise.resolve(job)),
		deleteJob: vi.fn(),
		listDiscoveries: vi.fn(() => ({ items: [], nextCursor: null })),
		getDiscovery: vi.fn(() => undefined),
		discoveryObservations: vi.fn(() => ({ items: [], nextCursor: null })),
		patchDiscovery: vi.fn(() => Promise.resolve({ id: "d_1" })),
		deleteDiscovery: vi.fn(() => Promise.resolve(false)),
		recordingPath: vi.fn(() => null),
		evidencePath: vi.fn(() => Promise.resolve(null)),
		listen: vi.fn(() => Promise.resolve({ mode: "live-audio" })),
		identify: vi.fn(() => Promise.resolve()),
		listCaptures: vi.fn(() => []),
		capturePath: vi.fn(() => null),
		deleteCapture: vi.fn(() => Promise.resolve(false)),
	}
	return { ...base, ...overrides }
}

describe("GET /api/scanner/discoveries identity", () => {
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

	it("parses a valid identity on the first colon and trims the value", async () => {
		await build()
		const res = await app.inject({
			method: "GET",
			url: "/api/scanner/discoveries?identity=p25-nac:%20ab:cd%20&q=NaC&sourceId=rtl&limit=10",
		})
		expect(res.statusCode).toBe(200)
		expect(service.listDiscoveries).toHaveBeenCalledWith({
			identity: { kind: "p25-nac", value: "ab:cd" },
			q: "NaC",
			sourceId: "rtl",
			limit: 10,
		})
	})

	it("rejects an unknown kind and a missing colon with the schema", async () => {
		await build()
		for (const identity of ["nope:1", "dmr-cc", "dmr-cc:"]) {
			const res = await app.inject({
				method: "GET",
				url: `/api/scanner/discoveries?identity=${encodeURIComponent(identity)}`,
			})
			expect(res.statusCode).toBe(400)
			expect(res.json()).toMatchObject({ code: "FST_ERR_VALIDATION" })
		}
		expect(service.listDiscoveries).not.toHaveBeenCalled()
	})

	it("rejects a whitespace-only value after trim", async () => {
		await build()
		const res = await app.inject({
			method: "GET",
			url: `/api/scanner/discoveries?identity=${encodeURIComponent("dmr-cc:   ")}`,
		})
		expect(res.statusCode).toBe(400)
		expect(res.json()).toEqual({
			error: "ValidationError",
			code: "VALIDATION_ERROR",
			message:
				"Configuration validation failed:\n  - identity: Identity value is empty",
		})
		expect(service.listDiscoveries).not.toHaveBeenCalled()
	})

	it("lets q match an identity value and not a metadata-only copy of it", async () => {
		const store = new DiscoveryStore({
			maxDiscoveries: 10,
			now: () => T0,
			newId: counterIds(),
		})
		const withIdentity = store.ingest(
			makeObs({ id: "o1", centreHz: CH, startedAt: T0, blocks: 2 }),
		).discoveryId
		const metadataOnly = store.ingest(
			makeObs({
				id: "o2",
				centreHz: CH + 100_000,
				startedAt: T0 + 1_000,
				blocks: 2,
			}),
		).discoveryId
		if (withIdentity === null || metadataOnly === null)
			throw new Error("discoveries did not surface")
		store.applyEvidence(
			withIdentity,
			evidence("p25p1", T0 + 2_000, {
				identity: { kind: "p25-nac", value: "NAC-12" },
			}),
		)
		store.setOperator(withIdentity, { label: "tower" })
		const decoy = evidence("dmr", T0 + 3_000, {
			identity: { kind: "dmr-cc", value: "9" },
			talkgroups: ["nac-12"],
		})
		decoy.metadata.callsigns = ["NAC-12"]
		decoy.metadata.capcodes = ["nac-12"]
		store.applyEvidence(metadataOnly, decoy)
		store.setOperator(metadataOnly, { label: "site", notes: "nac-12" })
		await build({
			listDiscoveries: (filter: Parameters<DiscoveryStore["list"]>[0]) =>
				store.list(filter),
		})
		const res = await app.inject({
			method: "GET",
			url: "/api/scanner/discoveries?q=nac-12",
		})
		expect(res.statusCode).toBe(200)
		const body = res.json<{ items: { id: string }[] }>()
		expect(body.items.map(d => d.id)).toEqual([withIdentity])
	})
})
