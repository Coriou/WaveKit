import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type {
	BandPlanStackView,
	BandPlanUpdateCheck,
	BandPlanWriteDto,
	ImportPreview,
	ImportUrlPreview,
	ResolvedBandPlanView,
} from "@wavekit/api-types"
import { buildResolvedBandPlan } from "../../mock/data.ts"
import { INTERNATIONAL_URL } from "../../mock/bandplans.ts"
import { buildMockServer } from "../../mock/server.ts"
import type { MockServer } from "../../mock/server.ts"

describe("mock band plans", () => {
	let server: MockServer
	beforeAll(async () => {
		server = await buildMockServer({ port: 0 })
		await server.app.ready()
	})
	afterAll(async () => {
		await server.close()
	})
	const get = async <T>(url: string) => {
		const res = await server.app.inject({ method: "GET", url })
		expect(res.statusCode).toBe(200)
		return res.json<T>()
	}
	const stack = () => get<BandPlanStackView>("/api/bandplans")
	const resolved = () => get<ResolvedBandPlanView>("/api/bandplans/resolved")
	const expected = async () => {
		const s = (await stack()).store
		if (s.state !== "available" || s.storeId === null) throw new Error("store")
		return { storeId: s.storeId, revision: s.revision }
	}
	const write = async (
		method: "PUT" | "PATCH" | "POST" | "DELETE",
		url: string,
		body: Record<string, unknown>,
	) =>
		server.app.inject({
			method,
			url,
			payload: { expected: await expected(), ...body },
		})

	it("starts with the canvas plan: the same resolution as the static mock", async () => {
		const r = await resolved()
		const base = buildResolvedBandPlan()
		expect(r.bands).toEqual(base.bands)
		expect(r.shadowed).toEqual(base.shadowed)
		expect(r.hidden).toEqual(base.hidden)
		const v = await stack()
		expect(v.stack.entries.map(e => [e.name, e.enabled])).toEqual([
			["France", true],
			["CEPT / EU baseline", true],
			["International", false],
		])
		expect(v.capabilities.writable).toBe(true)
		expect(v.edits).toHaveLength(2)
		expect(v.operatorBands.map(b => b.id)).toEqual(["harbour"])
	})

	it("refuses a write without the token or with a stale one", async () => {
		const none = await server.app.inject({
			method: "DELETE",
			url: "/api/bandplans/stack",
			payload: {},
		})
		expect(none.statusCode).toBe(428)
		const stale = await server.app.inject({
			method: "DELETE",
			url: "/api/bandplans/stack",
			payload: { expected: { ...(await expected()), revision: 0 } },
		})
		expect(stale.statusCode).toBe(409)
		expect(stale.json().code).toBe("BANDPLANS_CONFLICT")
	})

	it("edits a pack band field by field and resets it", async () => {
		const res = await write(
			"PATCH",
			"/api/bandplans/packs/builtin-fr/bands/fm/edit",
			{ set: { name: "Radio FM" } },
		)
		expect(res.statusCode).toBe(200)
		let fm = (await resolved()).bands.find(b => b.key === "builtin-fr/fm")
		expect(fm?.band.name).toBe("Radio FM")
		expect(fm?.editedFields).toEqual(["name"])
		await write("PATCH", "/api/bandplans/packs/builtin-fr/bands/fm/edit", {
			reset: ["name"],
		})
		fm = (await resolved()).bands.find(b => b.key === "builtin-fr/fm")
		expect(fm?.band.name).toBe("FM broadcast")
		expect(fm?.editedFields).toEqual([])
	})

	it("turns a plan on and off through the stack", async () => {
		const v = await stack()
		const entries = v.stack.entries.map(({ packId, enabled }) => ({
			packId,
			enabled: packId === "builtin-fr" ? false : enabled,
		}))
		const res = await write("PUT", "/api/bandplans/stack", { entries })
		expect(res.statusCode).toBe(200)
		const r = await resolved()
		expect(r.bands.some(b => b.packId === "builtin-fr")).toBe(false)
		await write("PUT", "/api/bandplans/stack", {
			entries: v.stack.entries.map(({ packId, enabled }) => ({
				packId,
				enabled,
			})),
		})
	})

	it("adds, replaces and deletes an operator band", async () => {
		const band = {
			name: "Club repeater",
			startHz: 145_600_000,
			endHz: 145_800_000,
			group: "amateur",
			mode: "nfm",
			bandwidthHz: 12_500,
			stepHz: 12_500,
			skip: null,
			channels: [],
			parentId: null,
			colourHint: null,
			registryRef: null,
		}
		const res = await write("POST", "/api/bandplans/operator-bands", { band })
		expect(res.statusCode).toBe(201)
		const id = res.json<BandPlanWriteDto>().createdId
		expect(id).toBe("club-repeater")
		await write("PUT", `/api/bandplans/operator-bands/${id}`, {
			band: { ...band, name: "Club relay" },
		})
		expect(
			(await resolved()).bands.find(b => b.key === `operator/${id}`)?.band.name,
		).toBe("Club relay")
		const del = await write("DELETE", `/api/bandplans/operator-bands/${id}`, {})
		expect(del.statusCode).toBe(200)
	})

	it("previews and commits a file import, then removes it", async () => {
		const file = JSON.stringify({
			name: "Test plan",
			author_name: "F4ABC",
			bands: [
				{
					name: "Marine",
					type: "marine",
					start: 156_000_000,
					end: 162_000_000,
				},
				{ name: "Odd", type: "whatever", start: 400_000_000, end: 401_000_000 },
			],
		})
		const body = {
			format: "sdrpp-json",
			fileName: "test.json",
			contentBase64: Buffer.from(file).toString("base64"),
			groupOverrides: [],
		}
		const pv = await server.app.inject({
			method: "POST",
			url: "/api/bandplans/imports/preview",
			payload: body,
		})
		expect(pv.statusCode).toBe(200)
		const preview = pv.json<ImportPreview>()
		expect(preview.meta.name).toBe("Test plan")
		expect(preview.report.mapped).toBe(1)
		expect(preview.report.toOther).toBe(1)
		const commit = await write("POST", "/api/bandplans/imports", {
			...body,
			previewDigest: preview.previewDigest,
			name: null,
			author: null,
			licence: null,
			keepColourHints: false,
			replacesPackId: null,
			addToStack: true,
		})
		expect(commit.statusCode).toBe(201)
		const dto = commit.json<BandPlanWriteDto>()
		expect(dto.view.stack.entries.at(-1)).toMatchObject({
			name: "Test plan",
			enabled: true,
		})
		const del = await write(
			"DELETE",
			`/api/bandplans/packs/${dto.createdId}`,
			{},
		)
		expect(del.statusCode).toBe(200)
	})

	it("reads a URL once and finds an update for International", async () => {
		const bad = await server.app.inject({
			method: "POST",
			url: "/api/bandplans/imports/preview-url",
			payload: {
				url: "https://example.com/plan.csv",
				format: "gqrx-csv",
				groupOverrides: [],
			},
		})
		expect(bad.statusCode).toBe(422)
		const ok = await server.app.inject({
			method: "POST",
			url: "/api/bandplans/imports/preview-url",
			payload: {
				url: INTERNATIONAL_URL,
				format: "gqrx-csv",
				groupOverrides: [],
			},
		})
		expect(ok.statusCode).toBe(200)
		expect(ok.json<ImportUrlPreview>().bands).toHaveLength(18)
		const intl = (await stack()).packs.find(p => p.name === "International")
		const check = await server.app.inject({
			method: "POST",
			url: `/api/bandplans/packs/${intl?.id}/check-update`,
			payload: {},
		})
		const diff = check.json<BandPlanUpdateCheck>()
		expect(diff.upToDate).toBe(false)
		expect(diff.changed).toHaveLength(2)
		expect(diff.added.map(b => b.name)).toEqual(["PMR446"])
	})
})
