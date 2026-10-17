import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type {
	BandPlanPack,
	BandPlanPackView,
	BandPlanStackView,
	BandPlanUpdateCheck,
	ResolvedBandPlanView,
} from "@wavekit/api-types"
import { buildMockServer } from "../../mock/server.ts"
import type { MockServer } from "../../mock/server.ts"
import {
	bandChips,
	bandEntries,
	bandRows,
	droppedBefore,
	moved,
	planItems,
	toggleText,
	typedMHz,
} from "../../src/features/settings/bandplans/model.ts"
import { editPatch } from "../../src/features/settings/bandplans/actions.ts"
import {
	channelId,
	parseChannelName,
	parseEdges,
} from "../../src/features/settings/bandplans/editor-rows.ts"
import { updateText } from "../../src/features/settings/bandplans/UpdateCheck.tsx"
import { formatOf } from "../../src/features/settings/bandplans/ImportSheet.tsx"

describe("Settings › Band plans model", () => {
	let server: MockServer
	let view: BandPlanStackView
	let resolved: ResolvedBandPlanView
	const packs: Record<string, BandPlanPack> = {}
	beforeAll(async () => {
		server = await buildMockServer({ port: 0 })
		await server.app.ready()
		const get = async <T>(url: string) =>
			(await server.app.inject({ method: "GET", url })).json<T>()
		view = await get<BandPlanStackView>("/api/bandplans")
		resolved = await get<ResolvedBandPlanView>("/api/bandplans/resolved")
		for (const e of view.stack.entries)
			packs[e.packId] = (
				await get<BandPlanPackView>(`/api/bandplans/packs/${e.packId}`)
			).pack
	})
	afterAll(async () => {
		await server.close()
	})

	it("lists the bands the active plans add up to, hidden ones kept, marks from the edits", () => {
		const entries = bandEntries(view, packs, resolved)
		const by = (key: string) => entries.find(e => e.key === key)
		expect(by("operator/harbour")?.mark).toBe("Added")
		expect(by("builtin-fr/dab")?.mark).toBe("Hidden")
		expect(by("builtin-fr/cb")?.mark).toBe("Edited")
		expect(by("builtin-fr/fm")?.mark).toBeNull()
		expect(by("builtin-eu/air")?.verified).toBe(true)
		// International is off: none of its bands
		expect(entries.some(e => e.packId.startsWith("imported-"))).toBe(false)
		expect(entries.map(e => e.band.startHz)).toEqual(
			[...entries.map(e => e.band.startHz)].sort((a, b) => a - b),
		)
	})

	it("nests narrower bands under their parent unless the list is narrowed", () => {
		const entries = bandEntries(view, packs, resolved)
		const tree = bandRows(entries, "", "all")
		const pmr = tree.find(r => r.entry.band.id === "pmr446")
		expect(pmr?.depth).toBe(1)
		const flat = bandRows(entries, "", "personal-radio")
		expect(flat.every(r => r.depth === 0)).toBe(true)
		expect(flat.map(r => r.entry.band.id)).toEqual(["cb", "pmr446"])
		expect(
			bandRows(entries, "446.1", "all").map(r => r.entry.band.id),
		).toContain("pmr446")
		expect(
			bandRows(entries, "routiers", "all").map(r => r.entry.band.id),
		).toEqual(["cb"])
		expect(bandRows(entries, "", "edited")).toHaveLength(3)
		const chips = bandChips(entries)
		expect(chips[0]).toMatchObject({ id: "all", n: entries.length })
		expect(chips.at(-1)).toMatchObject({ id: "edited", n: 3 })
	})

	it("says what each plan is and where it comes from", () => {
		const items = planItems(view, packs, 3)
		expect(items.map(i => i.name)).toEqual([
			"Your edits",
			"France",
			"CEPT / EU baseline",
			"International",
		])
		expect(items[0]?.sub).toBe(
			"3 changes, kept when packs update. Always on top.",
		)
		expect(items[1]?.sub).toBe("Names a band first where plans overlap")
		expect(items[2]?.sub).toBe("Fills what France leaves out")
		expect(items[2]?.prov).toBe("6 of 6 verified · ERC Report 25")
		expect(items[3]?.prov).toBe(
			"Gqrx CSV · 18 bands · by Arrin-KN1E · CC0 · none verified",
		)
		expect(items[3]?.canCheck).toBe(true)
		expect(toggleText(view.stack.entries, "builtin-fr", false)).toBe(
			"France off · its bands fall through to CEPT / EU baseline",
		)
	})

	it("reorders the stack", () => {
		const e = view.stack.entries
		expect(moved(e, "builtin-eu", -1).map(x => x.packId)[0]).toBe("builtin-eu")
		expect(
			droppedBefore(e, e[2]?.packId ?? "", "builtin-fr").map(x => x.name),
		).toEqual(["International", "France", "CEPT / EU baseline"])
	})

	it("splits an edit into overrides and fields back to the pack", () => {
		const fm = packs["builtin-fr"]?.bands.find(b => b.id === "fm")
		if (!fm) throw new Error("fm")
		expect(editPatch(fm, { name: "Radio FM", group: "broadcast" })).toEqual({
			set: { name: "Radio FM" },
			reset: ["group"],
		})
		expect(editPatch(fm, { hidden: false })).toEqual({
			set: null,
			reset: ["hidden"],
		})
	})

	it("reads typed edges, channels and file formats", () => {
		expect(parseEdges("156.000 – 162.025")).toEqual({
			value: [156_000_000, 162_025_000],
		})
		expect(parseEdges("162 156")).toEqual({
			error: "The lower edge must be below the upper edge",
		})
		expect(parseEdges("10 20")).toEqual({
			error: "Outside what the dongle tunes, 24 to 1766 MHz",
		})
		expect(typedMHz("446,1")).toBe(446_100_000)
		expect(parseChannelName("France Info, info, fip", 104_500_000)).toEqual({
			name: "France Info",
			aliases: ["info", "fip"],
		})
		expect(channelId("Marine ch 16", ["marine-ch-16"])).toBe("marine-ch-16-2")
		expect(formatOf("https://x/International.csv?raw=1")).toBe("gqrx-csv")
		expect(formatOf("plan.json")).toBe("sdrpp-json")
		expect(formatOf("plan.txt")).toBeNull()
	})

	it("words an update check", async () => {
		const intl = view.packs.find(p => p.name === "International")
		const check = (
			await server.app.inject({
				method: "POST",
				url: `/api/bandplans/packs/${intl?.id}/check-update`,
				payload: {},
			})
		).json<BandPlanUpdateCheck>()
		expect(updateText(check)).toBe(
			"A newer file is there: 2 bands changed, 1 added. Your edits stay on top.",
		)
	})
})
