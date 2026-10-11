import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Fastify from "fastify"
import type { FastifyInstance, FastifyRequest } from "fastify"
import {
	operatorDataReadDtoSchema,
	operatorDataWriteDtoSchema,
	operatorDataErrorDtoSchema,
} from "@wavekit/api-types"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DeniedAdmission } from "../../../src/access/types.js"
import { snapshotToken } from "../../../src/operator-data/domain.js"
import { operatorDataRoutes } from "../../../src/operator-data/routes.js"
import { OperatorDataError } from "../../../src/operator-data/schema.js"
import { OperatorDataService } from "../../../src/operator-data/service.js"
import type { OperatorDataServiceOptions } from "../../../src/operator-data/service.js"

const roots: string[] = []
const services: OperatorDataService[] = []
const apps: FastifyInstance[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	for (const app of apps.splice(0)) await app.close()
	for (const service of services.splice(0)) await service.close()
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true })
})
async function service(
	options: Omit<OperatorDataServiceOptions, "stateDir"> = {},
) {
	const stateDir = await mkdtemp(join(tmpdir(), "wavekit-operator-routes-"))
	roots.push(stateDir)
	const result = await OperatorDataService.open({ stateDir, ...options })
	services.push(result)
	return result
}
async function server(
	operatorData: OperatorDataService | undefined,
	authorizeMetadataMutation: (
		request: FastifyRequest,
	) => DeniedAdmission | undefined = () => undefined,
) {
	const app = Fastify()
	apps.push(app)
	// Prove the plugin handles its own errors instead of this root fallback.
	app.setErrorHandler((_error, _request, reply) => {
		void reply.code(400).send({ global: true })
	})
	await app.register(operatorDataRoutes, {
		operatorData,
		authorizeMetadataMutation,
	})
	await app.ready()
	return app
}
const base = "/api/operator-data"
const absentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const frequency = {
	name: " Repeater ",
	frequencyHz: 145_500_000,
	mode: "nfm",
	bandwidthHz: 12_500,
	tone: { kind: "ctcss", frequencyTenthsHz: 885 },
}
function gate() {
	let release!: () => void
	const promise = new Promise<void>(resolve => {
		release = resolve
	})
	return { promise, release }
}

describe("unmounted operator-data routes (Requirements 5.1, 3.1–3.5)", () => {
	it("serves all seven operations with canonical DTOs, stable IDs, preferences and no internal fields", async () => {
		const data = await service({
			onCommit: () => {
				throw new Error("private delivery failure")
			},
		})
		const app = await server(data)
		const registrations: string[] = []
		const isolated = Fastify()
		apps.push(isolated)
		isolated.addHook("onRoute", route => {
			if (route.method !== "HEAD")
				registrations.push(`${String(route.method)} ${route.url}`)
		})
		await isolated.register(operatorDataRoutes, {
			operatorData: data,
			authorizeMetadataMutation: () => undefined,
		})
		await isolated.ready()
		expect(registrations).toEqual([
			`GET ${base}`,
			`POST ${base}/saved-frequencies`,
			`PUT ${base}/saved-frequencies/:id`,
			`DELETE ${base}/saved-frequencies/:id`,
			`PATCH ${base}/preferences`,
			`POST ${base}/command-usage`,
			`DELETE ${base}/command-usage`,
		])
		const read = await app.inject({ method: "GET", url: base })
		expect(read.statusCode).toBe(200)
		expect(operatorDataReadDtoSchema.parse(read.json()).capabilities).toEqual({
			toneSelection: true,
			toneDetection: false,
			toneSquelch: false,
		})
		const create = await app.inject({
			method: "POST",
			url: `${base}/saved-frequencies`,
			payload: { expected: snapshotToken(data.snapshot()), frequency },
		})
		expect(create.statusCode).toBe(201)
		const created = operatorDataWriteDtoSchema.parse(create.json())
		const id = created.savedFrequencyId!
		expect(created.snapshot.savedFrequencies[0]).toMatchObject({
			id,
			name: "Repeater",
			tone: frequency.tone,
		})
		expect(Object.keys(create.json<Record<string, unknown>>()).sort()).toEqual([
			"savedFrequencyId",
			"snapshot",
		])
		const replace = await app.inject({
			method: "PUT",
			url: `${base}/saved-frequencies/${id}`,
			payload: {
				expected: snapshotToken(data.snapshot()),
				frequency: {
					...frequency,
					tone: { kind: "dcs", code: "023", polarity: "inverted" },
				},
			},
		})
		expect(replace.statusCode).toBe(200)
		const replaced = operatorDataWriteDtoSchema.parse(replace.json())
		expect(replaced.snapshot.savedFrequencies[0]).toMatchObject({
			id,
			createdAt: created.snapshot.savedFrequencies[0]!.createdAt,
			tone: { kind: "dcs", code: "023", polarity: "inverted" },
		})
		expect(Object.keys(replace.json<Record<string, unknown>>())).toEqual([
			"snapshot",
		])
		const patch = await app.inject({
			method: "PATCH",
			url: `${base}/preferences`,
			payload: {
				expected: snapshotToken(data.snapshot()),
				set: { units: "metric", timeFormat: "utc" },
			},
		})
		expect(patch.statusCode).toBe(200)
		operatorDataWriteDtoSchema.parse(patch.json())
		const preferences = operatorDataReadDtoSchema.parse(
			(await app.inject({ method: "GET", url: base })).json(),
		).preferences
		expect(preferences.values.units).toBe("metric")
		expect(preferences.provenance.units).toBe("operator")
		const report = await app.inject({
			method: "POST",
			url: `${base}/command-usage`,
			payload: {
				expected: snapshotToken(data.snapshot()),
				command: "open-saved-frequency",
				savedFrequencyId: id,
			},
		})
		expect(report.statusCode).toBe(200)
		expect(
			operatorDataWriteDtoSchema.parse(report.json()).snapshot.commandUsage[0],
		).toMatchObject({
			command: "open-saved-frequency",
			savedFrequencyId: id,
			count: 1,
		})
		const reset = await app.inject({
			method: "DELETE",
			url: `${base}/command-usage`,
			payload: { expected: snapshotToken(data.snapshot()) },
		})
		expect(reset.statusCode).toBe(200)
		expect(
			operatorDataWriteDtoSchema.parse(reset.json()).snapshot.commandUsage,
		).toEqual([])
		const remove = await app.inject({
			method: "DELETE",
			url: `${base}/saved-frequencies/${id}`,
			payload: { expected: snapshotToken(data.snapshot()) },
		})
		expect(remove.statusCode).toBe(200)
		expect(
			operatorDataWriteDtoSchema.parse(remove.json()).snapshot.savedFrequencies,
		).toEqual([])
		const restore = await app.inject({
			method: "PATCH",
			url: `${base}/preferences`,
			payload: { expected: snapshotToken(data.snapshot()), reset: ["units"] },
		})
		expect(restore.statusCode).toBe(200)
		expect(
			operatorDataReadDtoSchema.parse(
				(await app.inject({ method: "GET", url: base })).json(),
			).preferences.provenance.units,
		).toBe("default")
	})

	it("returns conflict current token only before missing-ID lookup and preserves current noops", async () => {
		const data = await service()
		const app = await server(data)
		const old = snapshotToken(data.snapshot())
		await data.mutate({
			type: "patch-preferences",
			expected: old,
			set: { units: "metric" },
		})
		const conflict = await app.inject({
			method: "DELETE",
			url: `${base}/saved-frequencies/${absentId}`,
			payload: { expected: old },
		})
		expect(conflict.statusCode).toBe(409)
		expect(operatorDataErrorDtoSchema.parse(conflict.json()).details).toEqual({
			current: snapshotToken(data.snapshot()),
		})
		const missing = await app.inject({
			method: "DELETE",
			url: `${base}/saved-frequencies/${absentId}`,
			payload: { expected: snapshotToken(data.snapshot()) },
		})
		expect(missing.statusCode).toBe(404)
		expect(operatorDataErrorDtoSchema.parse(missing.json()).code).toBe(
			"OPERATOR_DATA_NOT_FOUND",
		)
		const noop = await app.inject({
			method: "PATCH",
			url: `${base}/preferences`,
			payload: {
				expected: snapshotToken(data.snapshot()),
				set: { units: "metric" },
			},
		})
		expect(noop.statusCode).toBe(200)
		expect(
			operatorDataWriteDtoSchema.parse(noop.json()).snapshot.revision,
		).toBe(1)
	})

	it.each([400, 401, 403, 429, 503] as const)(
		"sends owner denial %i, headers and safe code without mutation",
		async status => {
			const data = await service()
			const mutate = vi.spyOn(data, "mutate")
			const authorize = vi.fn((request: FastifyRequest): DeniedAdmission => {
				expect(request.raw.url).toBe(`${base}/preferences`)
				expect(request.raw.headers["authorization"]).toBe("Bearer original")
				return {
					kind: "deny",
					status,
					code: "AUTH_REQUIRED",
					headers: { "cache-control": "no-store", "retry-after": "1" },
				}
			})
			const app = await server(data, authorize)
			const response = await app.inject({
				method: "PATCH",
				url: `${base}/preferences`,
				headers: { authorization: "Bearer original" },
				payload: {
					expected: snapshotToken(data.snapshot()),
					set: { units: "metric" },
				},
			})
			expect(response.statusCode).toBe(status)
			expect(response.json()).toEqual({ code: "AUTH_REQUIRED" })
			expect(response.headers["cache-control"]).toBe("no-store")
			expect(response.headers["retry-after"]).toBe("1")
			expect(authorize).toHaveBeenCalledOnce()
			expect(mutate).not.toHaveBeenCalled()
		},
	)

	it("validates before authorization and invokes admission in the same turn with the original request", async () => {
		const data = await service()
		let revoked = false
		let original: FastifyRequest | undefined
		const app = await server(data, request => {
			original = request
			queueMicrotask(() => {
				revoked = true
			})
			return undefined
		})
		const realMutate = data.mutate.bind(data)
		const mutate = vi.spyOn(data, "mutate").mockImplementation(input => {
			expect(revoked).toBe(false)
			expect(original?.raw.url).toBe(`${base}/preferences`)
			expect(input).not.toBe(original?.body)
			return realMutate(input)
		})
		const response = await app.inject({
			method: "PATCH",
			url: `${base}/preferences`,
			payload: {
				expected: snapshotToken(data.snapshot()),
				set: { units: "metric" },
			},
		})
		expect(response.statusCode).toBe(200)
		expect(mutate).toHaveBeenCalledOnce()
	})

	it("reevaluates current authorization at admission after an earlier owner hook", async () => {
		const data = await service()
		let revoked = false
		let original: FastifyRequest | undefined
		const app = Fastify()
		apps.push(app)
		app.addHook("onRequest", async request => {
			original = request
		})
		app.addHook("preHandler", async () => {
			revoked = true
		})
		const mutate = vi.spyOn(data, "mutate")
		await app.register(operatorDataRoutes, {
			operatorData: data,
			authorizeMetadataMutation: request => {
				expect(request).toBe(original)
				return revoked
					? { kind: "deny", status: 401, code: "AUTH_REQUIRED", headers: {} }
					: undefined
			},
		})
		const response = await app.inject({
			method: "PATCH",
			url: `${base}/preferences`,
			payload: {
				expected: snapshotToken(data.snapshot()),
				set: { units: "metric" },
			},
		})
		expect(response.statusCode).toBe(401)
		expect(mutate).not.toHaveBeenCalled()
	})

	it("keeps an accepted write through modeled caller abort and revocation; plugin close leaves service owned", async () => {
		const entered = gate()
		const release = gate()
		let armed = false
		const data = await service({
			storageStage: async (stage, phase) => {
				if (armed && stage === "temp-sync" && phase === "before") {
					armed = false
					entered.release()
					await release.promise
				}
			},
		})
		let revoked = false
		let caller: FastifyRequest | undefined
		const app = await server(data, request => {
			caller = request
			return revoked
				? { kind: "deny", status: 401, code: "AUTH_REQUIRED", headers: {} }
				: undefined
		})
		armed = true
		const pending = app
			.inject({
				method: "PATCH",
				url: `${base}/preferences`,
				payload: {
					expected: snapshotToken(data.snapshot()),
					set: { units: "metric" },
				},
			})
			.then(response => response)
		await entered.promise
		revoked = true
		caller!.raw.emit("aborted") // Model notification only; no live socket acceptance claim.
		release.release()
		expect((await pending).statusCode).toBe(200)
		expect(data.snapshot().revision).toBe(1)
		expect(
			(
				await app.inject({
					method: "PATCH",
					url: `${base}/preferences`,
					payload: {
						expected: snapshotToken(data.snapshot()),
						set: { units: "imperial" },
					},
				})
			).statusCode,
		).toBe(401)
		const close = vi.spyOn(data, "close")
		await app.close()
		expect(close).not.toHaveBeenCalled()
		expect(data.snapshot().revision).toBe(1)
	})

	it.each([
		["POST", "/saved-frequencies", { frequency }, 428],
		[
			"PATCH",
			"/preferences",
			{ expected: null, set: { units: "metric" } },
			400,
		],
		[
			"POST",
			"/saved-frequencies",
			{ frequency, type: "delete-saved-frequency" },
			400,
		],
		["POST", "/saved-frequencies", { frequency, id: absentId }, 400],
		[
			"POST",
			"/saved-frequencies",
			{ frequency: { ...frequency, id: absentId } },
			400,
		],
		[
			"POST",
			"/saved-frequencies",
			{
				frequency: { ...frequency, tone: { kind: "ctcss", frequencyHz: 88.5 } },
			},
			400,
		],
		[
			"POST",
			"/saved-frequencies",
			{ frequency: { ...frequency, mode: "am" } },
			400,
		],
		[
			"POST",
			"/saved-frequencies",
			{ frequency: { ...frequency, bandwidthHz: 0 } },
			400,
		],
		["PATCH", "/preferences", { set: { source: "receiver" } }, 400],
		[
			"PATCH",
			"/preferences",
			{ set: { units: "metric" }, reset: ["units"] },
			400,
		],
		["PATCH", "/preferences", { reset: ["units", "units"] }, 400],
		["PATCH", "/preferences", {}, 400],
		["POST", "/command-usage", { command: "tune", query: "secret" }, 400],
		["POST", "/command-usage", { command: "open-saved-frequency" }, 400],
		["DELETE", "/command-usage", { clientUUID: absentId }, 400],
		["PUT", `/saved-frequencies/${absentId}`, { frequency, id: absentId }, 400],
		["DELETE", `/saved-frequencies/${absentId.toUpperCase()}`, {}, 400],
		["DELETE", "/saved-frequencies/not-a-uuid", {}, 400],
	] as const)(
		"rejects invalid %s %s before owner callback",
		async (method, path, body, status) => {
			const data = await service()
			const authorize = vi.fn(() => undefined)
			const app = await server(data, authorize)
			const payload =
				status === 428
					? body
					: { expected: snapshotToken(data.snapshot()), ...body }
			const response = await app.inject({ method, url: base + path, payload })
			expect(response.statusCode).toBe(status)
			expect(operatorDataErrorDtoSchema.parse(response.json()).code).toBe(
				status === 428
					? "OPERATOR_DATA_PRECONDITION_REQUIRED"
					: "OPERATOR_DATA_INVALID",
			)
			expect(authorize).not.toHaveBeenCalled()
			expect(data.snapshot().revision).toBe(0)
		},
	)

	it.each([
		["{broken", "application/json", 400, "OPERATOR_DATA_INVALID"],
		[" ".repeat(16385), "application/json", 409, "OPERATOR_DATA_QUOTA"],
		["plain", "application/x-unsupported", 400, "OPERATOR_DATA_INVALID"],
	] as const)(
		"handles native parser failure safely (case %#)",
		async (payload, contentType, status, code) => {
			const authorize = vi.fn(() => undefined)
			const app = await server(undefined, authorize)
			const response = await app.inject({
				method: "PATCH",
				url: `${base}/preferences`,
				headers: { "content-type": contentType },
				payload,
			})
			expect(response.statusCode).toBe(status)
			expect(operatorDataErrorDtoSchema.parse(response.json()).code).toBe(code)
			expect(authorize).not.toHaveBeenCalled()
		},
	)

	it("requires owner authorization even without a service and never returns fake empty state", async () => {
		const authorize = vi.fn(() => undefined)
		const app = await server(undefined, authorize)
		const response = await app.inject({
			method: "PATCH",
			url: `${base}/preferences`,
			payload: {
				expected: { storeId: absentId, revision: 0 },
				set: { units: "metric" },
			},
		})
		expect(response.statusCode).toBe(503)
		expect(authorize).toHaveBeenCalledOnce()
		expect(operatorDataErrorDtoSchema.parse(response.json()).code).toBe(
			"OPERATOR_DATA_UNAVAILABLE",
		)
		const read = await app.inject({ method: "GET", url: base })
		expect(read.statusCode).toBe(503)
		operatorDataErrorDtoSchema.parse(read.json())
	})

	it("reports real bounded admission overload without accepting an extra write", async () => {
		const entered = gate()
		const release = gate()
		let armed = false
		const data = await service({
			storageStage: async (stage, phase) => {
				if (armed && stage === "temp-sync" && phase === "before") {
					armed = false
					entered.release()
					await release.promise
				}
			},
		})
		const app = await server(data)
		const token = snapshotToken(data.snapshot())
		armed = true
		const first = data.mutate({
			type: "patch-preferences",
			expected: token,
			set: { units: "metric" },
		})
		await entered.promise
		const waiting = Array.from({ length: 32 }, () =>
			data.mutate({
				type: "reset-command-usage",
				expected: { ...token, revision: 1 },
			}),
		)
		try {
			const response = await app.inject({
				method: "PATCH",
				url: `${base}/preferences`,
				payload: { expected: token, set: { units: "imperial" } },
			})
			expect(response.statusCode).toBe(503)
			expect(operatorDataErrorDtoSchema.parse(response.json()).code).toBe(
				"OPERATOR_DATA_BUSY",
			)
		} finally {
			release.release()
			await Promise.all([first, ...waiting])
		}
		expect(data.snapshot().revision).toBe(1)
		expect(data.snapshot().preferenceOverrides.units).toBe("metric")
	})

	it.each([
		["POST", "/saved-frequencies", { frequency }],
		["PUT", `/saved-frequencies/${absentId}`, { frequency }],
		["DELETE", `/saved-frequencies/${absentId}`, {}],
		["PATCH", "/preferences", { set: { units: "metric" } }],
		["POST", "/command-usage", { command: "tune" }],
		["DELETE", "/command-usage", {}],
	] as const)(
		"preserves missing-token 428 for %s %s even when unavailable",
		async (method, path, payload) => {
			const authorize = vi.fn(() => undefined)
			const app = await server(undefined, authorize)
			const response = await app.inject({ method, url: base + path, payload })
			expect(response.statusCode).toBe(428)
			expect(operatorDataErrorDtoSchema.parse(response.json()).code).toBe(
				"OPERATOR_DATA_PRECONDITION_REQUIRED",
			)
			expect(authorize).not.toHaveBeenCalled()
		},
	)

	it.each(["OPERATOR_DATA_BUSY", "OPERATOR_DATA_UNAVAILABLE"] as const)(
		"preserves explicit service %s instead of root 400",
		async code => {
			const data = await service()
			vi.spyOn(data, "mutate").mockRejectedValue(new OperatorDataError(code))
			const app = await server(data)
			const response = await app.inject({
				method: "PATCH",
				url: `${base}/preferences`,
				payload: {
					expected: snapshotToken(data.snapshot()),
					set: { units: "metric" },
				},
			})
			expect(response.statusCode).toBe(503)
			expect(operatorDataErrorDtoSchema.parse(response.json()).code).toBe(code)
		},
	)

	it("maps unknown internal errors safely and isolates the boundary from sibling routes", async () => {
		const data = await service()
		vi.spyOn(data, "snapshot").mockImplementation(() => {
			throw new Error("secret state path")
		})
		const app = await server(data)
		const response = await app.inject({ method: "GET", url: base })
		expect(response.statusCode).toBe(503)
		expect(operatorDataErrorDtoSchema.parse(response.json()).code).toBe(
			"OPERATOR_DATA_UNAVAILABLE",
		)
		expect(response.body).not.toContain("secret")
		const sibling = Fastify()
		apps.push(sibling)
		sibling.setErrorHandler((_error, _request, reply) => {
			void reply.code(418).send({ sibling: true })
		})
		sibling.get("/sibling", () => {
			throw new Error("sibling")
		})
		await sibling.register(operatorDataRoutes, {
			operatorData: undefined,
			authorizeMetadataMutation: () => undefined,
		})
		expect((await sibling.inject("/sibling")).statusCode).toBe(418)
	})
})
