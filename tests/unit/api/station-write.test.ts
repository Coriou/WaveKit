import Fastify from "fastify"
import { describe, expect, it, vi } from "vitest"
import { stationRoutes } from "../../../src/api/routes/station.js"
import { StationUpdateError } from "../../../src/core/station/errors.js"
import type { DeniedAdmission } from "../../../src/access/types.js"
import type { StationService } from "../../../src/core/station/contract.js"
import type { StationIdentity, StationUpdateResult } from "@wavekit/api-types"

function identity(
	name: string,
	revision = 0,
	prov: "ui" | "default" = "ui",
): StationIdentity {
	const unset = { value: null, provenance: "default" } as const
	return {
		name: { value: name, provenance: prov },
		lat: unset,
		lon: unset,
		altM: unset,
		callsign: unset,
		country: unset,
		effectiveCountry: null,
		region: "EU",
		...(prov === "ui" ? { revision, writable: true } : {}),
	} as unknown as StationIdentity
}

function fakeService(fail?: () => never) {
	let current = identity("start")
	const update = vi.fn(
		async (patch: { name?: string | null }, options?: { ifMatch?: number }) => {
			void options
			fail?.()
			current = identity(patch.name ?? "x", current.revision! + 1)
			return {
				station: current,
				revision: current.revision,
				changed: ["name"],
				appliesOnRestart: [],
				restartRequired: [],
				coverageCleared: false,
			} as unknown as StationUpdateResult
		},
	)
	const service = {
		identity: () => current,
		location: () => null,
		update,
		onChange: () => () => {},
		close: async () => {},
	} as unknown as StationService
	return { service, update }
}

const denial: DeniedAdmission = {
	kind: "deny",
	status: 401,
	code: "ACCESS_REQUIRED",
	headers: { "WWW-Authenticate": "Pairing", "Cache-Control": "no-store" },
} as unknown as DeniedAdmission

async function build(options: Parameters<typeof stationRoutes>[1]) {
	const app = Fastify()
	await app.register(stationRoutes, options)
	return app
}

const patch = (
	app: Awaited<ReturnType<typeof build>>,
	payload: unknown,
	headers: Record<string, string> = {},
) =>
	app.inject({
		method: "PATCH",
		url: "/api/station",
		payload: payload as object,
		headers,
	})

describe.each([true, false])(
	"PATCH /api/station, writeRequiresAccess=%s",
	flag => {
		const base = {
			station: identity("static", 0, "default"),
			writeRequiresAccess: flag,
		}

		it("legacy mode (no hook): 404 when access is required, works otherwise", async () => {
			const { service, update } = fakeService()
			const app = await build({ ...base, service })
			const res = await patch(app, { name: "a" })
			if (flag) {
				expect(res.statusCode).toBe(404)
				expect(update).not.toHaveBeenCalled()
			} else {
				expect(res.statusCode).toBe(200)
				expect(update).toHaveBeenCalledWith({ name: "a" }, undefined)
			}
			await app.close()
		})

		it("not mounted without a service", async () => {
			const app = await build({ ...base, authorizeMutation: () => undefined })
			expect((await patch(app, { name: "a" })).statusCode).toBe(404)
			await app.close()
		})

		it("protected denial returns status and headers and skips the service", async () => {
			const { service, update } = fakeService()
			const app = await build({
				...base,
				service,
				authorizeMutation: () => denial,
			})
			const res = await patch(app, { name: "a" })
			expect(res.statusCode).toBe(401)
			expect(res.headers["www-authenticate"]).toBe("Pairing")
			expect(res.json()).toEqual({ code: "ACCESS_REQUIRED" })
			expect(update).not.toHaveBeenCalled()
			await app.close()
		})

		it("protected success, If-Match forms and malformed values", async () => {
			const { service, update } = fakeService()
			const app = await build({
				...base,
				service,
				authorizeMutation: () => undefined,
			})
			expect(
				(await patch(app, { name: "a" }, { "if-match": '"3"' })).statusCode,
			).toBe(200)
			expect(update).toHaveBeenLastCalledWith({ name: "a" }, { ifMatch: 3 })
			expect(
				(await patch(app, { name: "a" }, { "if-match": "4" })).statusCode,
			).toBe(200)
			expect(update).toHaveBeenLastCalledWith({ name: "a" }, { ifMatch: 4 })
			for (const bad of ['"x"', 'W/"1"', "-1", "1.5", "*", ""]) {
				const res = await patch(app, { name: "a" }, { "if-match": bad })
				expect(res.statusCode).toBe(400)
				expect(res.json().code).toBe("STATION_UPDATE_INVALID")
			}
			expect(update).toHaveBeenCalledTimes(2)
			await app.close()
		})

		it("rejects non-object bodies and oversized bodies", async () => {
			const { service, update } = fakeService()
			const app = await build({
				...base,
				service,
				authorizeMutation: () => undefined,
			})
			for (const body of ["[1]", "null", "3"]) {
				const res = await app.inject({
					method: "PATCH",
					url: "/api/station",
					payload: body,
					headers: { "content-type": "application/json" },
				})
				expect(res.statusCode).toBe(400)
			}
			const big = await patch(app, { name: "x".repeat(5000) })
			expect(big.statusCode).toBe(413)
			expect(update).not.toHaveBeenCalled()
			await app.close()
		})

		it.each([
			[400, "STATION_UPDATE_INVALID", ["lat"]],
			[409, "STATION_FIELD_PINNED", ["name"]],
			[412, "STATION_REVISION_MISMATCH", undefined],
			[503, "STATION_STORE_UNAVAILABLE", undefined],
		] as const)("maps service error %i", async (status, code, fields) => {
			const { service } = fakeService(() => {
				throw new StationUpdateError(
					code,
					"boom",
					fields ? [...fields] : undefined,
				)
			})
			const app = await build({
				...base,
				service,
				authorizeMutation: () => undefined,
			})
			const res = await patch(app, { name: "a" })
			expect(res.statusCode).toBe(status)
			expect(res.json().code).toBe(code)
			expect(res.json().message).toBe("boom")
			if (fields) expect(res.json().fields).toEqual([...fields])
			await app.close()
		})

		it("unknown errors are 500", async () => {
			const { service } = fakeService(() => {
				throw new Error("secret")
			})
			const app = await build({
				...base,
				service,
				authorizeMutation: () => undefined,
			})
			const res = await patch(app, { name: "a" })
			expect(res.statusCode).toBe(500)
			expect(res.body).not.toContain("secret")
			await app.close()
		})

		it("GET and HEAD reflect live changes", async () => {
			const { service } = fakeService()
			const app = await build({
				...base,
				service,
				authorizeMutation: () => undefined,
			})
			const get = () => app.inject({ method: "GET", url: "/api/station" })
			expect((await get()).json().name.value).toBe("start")
			await patch(app, { name: "next" })
			const res = await get()
			expect(res.json().name.value).toBe("next")
			expect(res.json().revision).toBe(1)
			const head = await app.inject({ method: "HEAD", url: "/api/station" })
			expect(head.statusCode).toBe(200)
			expect(head.body).toBe("")
			await app.close()
		})
	},
)
