import { readFileSync } from "node:fs"
import {
	DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ,
	DISCOVERY_NEAR_MAX_TOLERANCE_HZ,
} from "@wavekit/api-types"
import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	scannerRoutes,
	type ScannerRouteService,
} from "../../../src/api/routes/scanner.js"
import { DiscoveryStore } from "../../../src/core/scanner/store/discovery-store.js"
import type { DiscoveryFilter } from "../../../src/core/scanner/store/discovery-store.js"
import {
	counterIds,
	evidence,
	makeObs,
} from "../../mocks/scanner/observations.js"

/**
 * Recorded from GET /api/scanner/discoveries with no evidence, nearHz or
 * toleranceHz, against the store at HEAD before this task's edits.
 */
const BASE_BODY = readFileSync(
	new URL("./scanner-discoveries-base-response.json", import.meta.url),
	"utf8",
)

const CH = 446_006_250
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const NEAR_HZ_MAX = 100_000_000_000

const finiteMessage = (path: string): string =>
	`Invalid query parameter: ${path} must be a finite number`

/** Fixed discoveries used for the byte-identical base response. */
function fixtureStore(): DiscoveryStore {
	const store = new DiscoveryStore({
		maxDiscoveries: 10,
		now: () => T0,
		newId: counterIds(),
	})
	const weak = store.ingest(
		makeObs({
			id: "o-weak",
			centreHz: CH,
			startedAt: T0,
			blocks: 2,
			sourceId: "src-1",
			jobIds: ["job-1"],
		}),
	).discoveryId
	const proven = store.ingest(
		makeObs({
			id: "o-proven",
			centreHz: CH + 100_000,
			startedAt: T0 + 2_000,
			blocks: 2,
			sourceId: "src-1",
			jobIds: ["job-1"],
		}),
	).discoveryId
	const other = store.ingest(
		makeObs({
			id: "o-other",
			centreHz: CH + 200_000,
			startedAt: T0 + 1_000,
			blocks: 2,
			sourceId: "src-2",
			jobIds: ["job-2"],
		}),
	).discoveryId
	if (weak === null || proven === null || other === null)
		throw new Error("fixture discoveries did not surface")
	const decode = evidence("dmr", T0 + 2_500, {
		identity: { kind: "dmr-cc", value: "1" },
	})
	if (!store.appendObservationEvidence("o-proven", decode))
		throw new Error("fixture decode was not retained")
	if (store.applyEvidence(proven, decode) === null)
		throw new Error("fixture evidence was not applied")
	store.setOperator(weak, { label: "quiet" })
	return store
}

interface Placed {
	id: string
	frequencyHz: number
	evidenceLevel: "proven" | "weak"
}

function place(
	store: DiscoveryStore,
	spec: {
		obsId: string
		centreHz: number
		startedAt: number
		sourceId?: string
		jobIds?: string[]
		proven?: boolean
		decodeOnly?: boolean
	},
): Placed {
	const id = store.ingest(
		makeObs({
			id: spec.obsId,
			centreHz: spec.centreHz,
			startedAt: spec.startedAt,
			blocks: 2,
			...(spec.sourceId !== undefined ? { sourceId: spec.sourceId } : {}),
			...(spec.jobIds !== undefined ? { jobIds: spec.jobIds } : {}),
		}),
	).discoveryId
	if (id === null) throw new Error(`${spec.obsId} did not surface`)
	if (spec.proven === true || spec.decodeOnly === true) {
		const decode = evidence("dmr", spec.startedAt + 10, {
			identity: { kind: "dmr-cc", value: "1" },
		})
		if (
			spec.proven === true &&
			!store.appendObservationEvidence(spec.obsId, decode)
		)
			throw new Error(`${spec.obsId} decode was not retained`)
		if (store.applyEvidence(id, decode) === null)
			throw new Error(`${spec.obsId} evidence was not applied`)
	}
	const dto = store.get(id)
	if (dto === undefined || dto.evidenceLevel === undefined)
		throw new Error(`${spec.obsId} has no evidence level`)
	return { id, frequencyHz: dto.frequencyHz, evidenceLevel: dto.evidenceLevel }
}

function fakeService(
	store: DiscoveryStore,
	listDiscoveries: (
		filter: DiscoveryFilter,
	) => ReturnType<DiscoveryStore["list"]>,
) {
	const job = { id: "j_1", state: "running", spec: { mode: "sweep" } }
	return {
		status: () => ({ enabled: true, engines: [] }),
		settingsView: () => ({
			effective: {},
			passiveBySource: {},
			provenance: {},
			bounds: {},
		}),
		patchSettings: () => Promise.resolve({}),
		bandplans: () => [],
		preview: () => ({ issues: [] }),
		createJob: () => Promise.resolve(job),
		listJobs: () => [job],
		getJob: () => undefined,
		patchJob: () => Promise.resolve({ job, plan: { hops: [] }, issues: [] }),
		pauseJob: () => Promise.resolve(job),
		resumeJob: () => Promise.resolve(job),
		cancelJob: () => Promise.resolve(job),
		deleteJob: () => undefined,
		listDiscoveries,
		getDiscovery: () => undefined,
		discoveryObservations: () => ({ items: [], nextCursor: null }),
		patchDiscovery: () => Promise.resolve({ id: "d_1" }),
		deleteDiscovery: () => Promise.resolve(false),
		recordingPath: () => null,
		evidencePath: () => Promise.resolve(null),
		listen: () => Promise.resolve({ mode: "live-audio" }),
		identify: () => Promise.resolve(),
		listCaptures: () => [],
		capturePath: () => null,
		deleteCapture: () => Promise.resolve(false),
	}
}

describe("GET /api/scanner/discoveries evidence, nearHz and toleranceHz", () => {
	let app: FastifyInstance
	let listDiscoveries: ReturnType<typeof vi.fn>

	async function build(store: DiscoveryStore) {
		listDiscoveries = vi.fn((filter: DiscoveryFilter) => store.list(filter))
		app = Fastify({ logger: false })
		await app.register(scannerRoutes, {
			scanner: fakeService(
				store,
				listDiscoveries as (
					filter: DiscoveryFilter,
				) => ReturnType<DiscoveryStore["list"]>,
			) as unknown as ScannerRouteService,
		})
	}

	afterEach(async () => {
		await app.close()
	})

	it("absent evidence, nearHz and toleranceHz is byte-identical to the base response", async () => {
		await build(fixtureStore())
		const res = await app.inject({
			method: "GET",
			url: "/api/scanner/discoveries",
		})
		expect(res.statusCode).toBe(200)
		expect(res.body).toBe(BASE_BODY)
		const all = await app.inject({
			method: "GET",
			url: "/api/scanner/discoveries?evidence=all",
		})
		expect(all.statusCode).toBe(200)
		expect(all.body).toBe(BASE_BODY)
	})

	it("rejects a non-finite nearHz or toleranceHz as VALIDATION_ERROR", async () => {
		await build(fixtureStore())
		const alone: [string, string][] = [
			["/api/scanner/discoveries?nearHz=Infinity", "nearHz"],
			["/api/scanner/discoveries?nearHz=-Infinity", "nearHz"],
			["/api/scanner/discoveries?nearHz=1e999", "nearHz"],
			[
				"/api/scanner/discoveries?nearHz=446006250&toleranceHz=Infinity",
				"toleranceHz",
			],
			[
				"/api/scanner/discoveries?nearHz=446006250&toleranceHz=-Infinity",
				"toleranceHz",
			],
			[
				"/api/scanner/discoveries?nearHz=446006250&toleranceHz=1e999",
				"toleranceHz",
			],
		]
		for (const [url, path] of alone) {
			const res = await app.inject({ method: "GET", url })
			expect(res.statusCode, url).toBe(400)
			expect(res.json(), url).toEqual({
				error: "ValidationError",
				code: "VALIDATION_ERROR",
				message: finiteMessage(path),
				fields: [{ field: path, expected: "finite number, Hz" }],
			})
			expect(JSON.stringify(res.json()), url).not.toMatch(/Infinity|1e999/)
		}
		const both = await app.inject({
			method: "GET",
			url: "/api/scanner/discoveries?nearHz=1e999&toleranceHz=-Infinity",
		})
		expect(both.statusCode).toBe(400)
		expect(both.json()).toEqual({
			error: "ValidationError",
			code: "VALIDATION_ERROR",
			message:
				"Invalid query parameter: nearHz must be a finite number; toleranceHz must be a finite number",
			fields: [
				{ field: "nearHz", expected: "finite number, Hz" },
				{ field: "toleranceHz", expected: "finite number, Hz" },
			],
		})
		expect(listDiscoveries).not.toHaveBeenCalled()
	})

	it("refuses toleranceHz without nearHz and tolerance past 1000000", async () => {
		await build(fixtureStore())
		for (const url of [
			"/api/scanner/discoveries?toleranceHz=6250",
			"/api/scanner/discoveries?toleranceHz=0",
			`/api/scanner/discoveries?nearHz=${CH}&toleranceHz=${DISCOVERY_NEAR_MAX_TOLERANCE_HZ + 1}`,
			"/api/scanner/discoveries?nearHz=0",
			"/api/scanner/discoveries?nearHz=-1",
			`/api/scanner/discoveries?nearHz=${NEAR_HZ_MAX + 1}`,
			`/api/scanner/discoveries?nearHz=${CH}&toleranceHz=-1`,
			"/api/scanner/discoveries?evidence=maybe",
		]) {
			const res = await app.inject({ method: "GET", url })
			expect(res.statusCode, url).toBe(400)
			expect(res.json().code, url).toBe("FST_ERR_VALIDATION")
		}
		expect(listDiscoveries).not.toHaveBeenCalled()
	})

	it("accepts the tolerance and nearHz bounds and the default 6250 Hz window", async () => {
		const store = new DiscoveryStore({
			maxDiscoveries: 20,
			now: () => T0,
			newId: counterIds(),
		})
		const centre = place(store, {
			obsId: "o-centre",
			centreHz: CH,
			startedAt: T0,
		})
		const plus = place(store, {
			obsId: "o-plus",
			centreHz: centre.frequencyHz + DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ,
			startedAt: T0 + 1_000,
		})
		const minus = place(store, {
			obsId: "o-minus",
			centreHz: centre.frequencyHz - DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ,
			startedAt: T0 + 2_000,
		})
		const outside = place(store, {
			obsId: "o-out",
			centreHz: centre.frequencyHz + DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ + 1,
			startedAt: T0 + 3_000,
			sourceId: "src-2",
		})
		expect(plus.frequencyHz - centre.frequencyHz).toBe(
			DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ,
		)
		expect(centre.frequencyHz - minus.frequencyHz).toBe(
			DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ,
		)
		expect(outside.frequencyHz - centre.frequencyHz).toBe(
			DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ + 1,
		)
		const hz = centre.frequencyHz
		const expected = [centre, plus, minus]
			.sort(
				(a, b) =>
					Math.abs(a.frequencyHz - hz) - Math.abs(b.frequencyHz - hz) ||
					(a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
			)
			.map(d => d.id)
		await build(store)
		const omitted = await app.inject({
			method: "GET",
			url: `/api/scanner/discoveries?nearHz=${hz}`,
		})
		const explicit = await app.inject({
			method: "GET",
			url: `/api/scanner/discoveries?nearHz=${hz}&toleranceHz=${DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ}`,
		})
		expect(omitted.statusCode).toBe(200)
		expect(explicit.statusCode).toBe(200)
		expect(explicit.body).toBe(omitted.body)
		expect(
			omitted.json<{ items: { id: string }[] }>().items.map(d => d.id),
		).toEqual(expected)
		const tighter = await app.inject({
			method: "GET",
			url: `/api/scanner/discoveries?nearHz=${hz}&toleranceHz=${DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ - 1}`,
		})
		expect(tighter.statusCode).toBe(200)
		expect(
			tighter.json<{ items: { id: string }[] }>().items.map(d => d.id),
		).toEqual([centre.id])
		const page = await app.inject({
			method: "GET",
			url: `/api/scanner/discoveries?nearHz=${hz}&limit=1`,
		})
		expect(page.json()).toMatchObject({
			items: [{ id: expected[0] }],
			nextCursor: "1",
		})
		const next = await app.inject({
			method: "GET",
			url: `/api/scanner/discoveries?nearHz=${hz}&limit=1&cursor=1`,
		})
		expect(next.json()).toMatchObject({
			items: [{ id: expected[1] }],
			nextCursor: "2",
		})
		const last = await app.inject({
			method: "GET",
			url: `/api/scanner/discoveries?nearHz=${hz}&limit=1&cursor=2`,
		})
		expect(last.json()).toMatchObject({
			items: [{ id: expected[2] }],
			nextCursor: null,
		})
	})

	it("keeps a discovery 1000000 Hz away and refuses 1000001", async () => {
		const store = new DiscoveryStore({
			maxDiscoveries: 10,
			now: () => T0,
			newId: counterIds(),
		})
		const centre = place(store, {
			obsId: "o-centre",
			centreHz: CH,
			startedAt: T0,
		})
		const edge = place(store, {
			obsId: "o-edge",
			centreHz: centre.frequencyHz + DISCOVERY_NEAR_MAX_TOLERANCE_HZ,
			startedAt: T0 + 1_000,
		})
		const past = place(store, {
			obsId: "o-past",
			centreHz: centre.frequencyHz + DISCOVERY_NEAR_MAX_TOLERANCE_HZ + 1,
			startedAt: T0 + 2_000,
			sourceId: "src-2",
		})
		expect(edge.frequencyHz - centre.frequencyHz).toBe(
			DISCOVERY_NEAR_MAX_TOLERANCE_HZ,
		)
		expect(past.frequencyHz - centre.frequencyHz).toBe(
			DISCOVERY_NEAR_MAX_TOLERANCE_HZ + 1,
		)
		await build(store)
		const ok = await app.inject({
			method: "GET",
			url: `/api/scanner/discoveries?nearHz=${centre.frequencyHz}&toleranceHz=${DISCOVERY_NEAR_MAX_TOLERANCE_HZ}`,
		})
		expect(ok.statusCode).toBe(200)
		expect(ok.json<{ items: { id: string }[] }>().items.map(d => d.id)).toEqual(
			[centre.id, edge.id],
		)
		const refused = await app.inject({
			method: "GET",
			url: `/api/scanner/discoveries?nearHz=${centre.frequencyHz}&toleranceHz=${DISCOVERY_NEAR_MAX_TOLERANCE_HZ + 1}`,
		})
		expect(refused.statusCode).toBe(400)
		expect(refused.json().code).toBe("FST_ERR_VALIDATION")
		const zero = await app.inject({
			method: "GET",
			url: `/api/scanner/discoveries?nearHz=${centre.frequencyHz}&toleranceHz=0`,
		})
		expect(zero.statusCode).toBe(200)
		expect(
			zero.json<{ items: { id: string }[] }>().items.map(d => d.id),
		).toEqual([centre.id])
		const top = await app.inject({
			method: "GET",
			url: `/api/scanner/discoveries?nearHz=${NEAR_HZ_MAX}&toleranceHz=0`,
		})
		expect(top.statusCode).toBe(200)
	})

	it("combines evidence=proven with sourceId, limit and nearHz", async () => {
		const store = new DiscoveryStore({
			maxDiscoveries: 20,
			now: () => T0,
			newId: counterIds(),
		})
		const older = place(store, {
			obsId: "o-old",
			centreHz: CH,
			startedAt: T0,
			sourceId: "src-1",
			jobIds: ["job-1"],
			proven: true,
		})
		const newer = place(store, {
			obsId: "o-new",
			centreHz: CH + 100_000,
			startedAt: T0 + 5_000,
			sourceId: "src-1",
			jobIds: ["job-1"],
			proven: true,
		})
		const otherSource = place(store, {
			obsId: "o-other",
			centreHz: CH + 200_000,
			startedAt: T0 + 9_000,
			sourceId: "src-2",
			jobIds: ["job-1"],
			proven: true,
		})
		const weak = place(store, {
			obsId: "o-weak",
			centreHz: CH + 300_000,
			startedAt: T0 + 8_000,
			sourceId: "src-1",
			jobIds: ["job-2"],
		})
		expect(older.evidenceLevel).toBe("proven")
		expect(newer.evidenceLevel).toBe("proven")
		expect(otherSource.evidenceLevel).toBe("proven")
		expect(weak.evidenceLevel).toBe("weak")
		await build(store)
		const first = await app.inject({
			method: "GET",
			url: "/api/scanner/discoveries?evidence=proven&sourceId=src-1&limit=1",
		})
		expect(first.statusCode).toBe(200)
		expect(first.json()).toMatchObject({
			items: [{ id: newer.id }],
			nextCursor: "1",
		})
		expect(listDiscoveries).toHaveBeenCalledWith({
			evidence: "proven",
			sourceId: "src-1",
			limit: 1,
		})
		const second = await app.inject({
			method: "GET",
			url: "/api/scanner/discoveries?evidence=proven&sourceId=src-1&limit=1&cursor=1",
		})
		expect(second.json()).toMatchObject({
			items: [{ id: older.id }],
			nextCursor: null,
		})
		const weakOnly = await app.inject({
			method: "GET",
			url: "/api/scanner/discoveries?evidence=weak&sourceId=src-1",
		})
		expect(
			weakOnly.json<{ items: { id: string }[] }>().items.map(d => d.id),
		).toEqual([weak.id])
		const near = await app.inject({
			method: "GET",
			url: `/api/scanner/discoveries?evidence=proven&sourceId=src-1&nearHz=${newer.frequencyHz}&toleranceHz=0&limit=1`,
		})
		expect(near.json()).toMatchObject({
			items: [{ id: newer.id }],
			nextCursor: null,
		})
	})
})
