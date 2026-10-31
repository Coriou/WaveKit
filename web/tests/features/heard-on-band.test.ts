import { describe, expect, it } from "vitest"
import type { ActivitySummary, DecoderInfo } from "@wavekit/api-types"

import {
	bandTable,
	cardIdentity,
	heardOnBand,
	parseSummary,
} from "../../src/features/tuned/band-table.ts"
import { nowView } from "../../src/features/tuned/now.ts"
import { TUNED_CASE_NOW, TUNED_CASES } from "../../mock/tuned-cases.ts"

const NO_SCAN = { scanJobId: null, budget: null }

const caseById = (id: string) => {
	const c = TUNED_CASES.find(x => x.id === id)
	if (!c) throw new Error(`no case ${id}`)
	return c
}

let seq = 0
const decode = (over: Partial<ActivitySummary> = {}): ActivitySummary => {
	seq += 1
	return {
		eventId: `h${seq}`,
		commitSeq: String(seq),
		kind: "decoder-reception",
		producedAt: new Date(TUNED_CASE_NOW - 1_000).toISOString(),
		receivedAt: new Date(TUNED_CASE_NOW - 1_000).toISOString(),
		decoderId: "multimon-ng",
		sourceId: "rtl-0",
		protocol: "pocsag",
		category: "paging",
		frequencyHz: 466_000_000,
		entityKey: null,
		title: "Capcode 0000001",
		fields: [],
		...over,
	}
}

const status = (
	over: Partial<DecoderInfo> & Pick<DecoderInfo, "id" | "type">,
): DecoderInfo => ({
	running: true,
	health: "running",
	uptime: 1,
	stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
	restartCount: 0,
	desiredRunning: true,
	suspended: false,
	mode: "auto",
	owner: "config",
	...over,
})

/** The card's header and latest for a case's channel Activity, as TunedCard composes them. */
function cardOf(id: string, filter: boolean) {
	const c = caseById(id)
	const summary = parseSummary(c.summary)
	const activity = c.activity ?? []
	const items = filter
		? heardOnBand(activity, summary, c.decoders, c.hz)
		: [...activity]
	const rows = bandTable(summary, c.decoders, c.hz, NO_SCAN, TUNED_CASE_NOW)
	const now = nowView({
		items,
		decoderTypes: c.decoders
			.filter(d => rows.some(r => r.id === d.id))
			.map(d => d.type),
		modulation: "raw",
		channelName: null,
		hz: c.hz,
		count: null,
		live: false,
		now: TUNED_CASE_NOW,
	})
	const identity = cardIdentity({
		heard: now.protocol,
		named: c.named,
		rows,
		band: c.band?.name ?? null,
		channel: null,
		modeLabel: "RAW",
	})
	return { c, now, identity }
}

describe("tuned card: decodes from a decoder whose band does not hold the frequency", () => {
	it("adsb-stray-page: the stray pager decode would win unfiltered (the reported defect)", () => {
		const { now, identity } = cardOf("adsb-stray-page", false)
		expect(now.latest?.protocol).toBe("pocsag")
		expect(identity.proto).toMatch(/POCSAG/)
	})

	it("adsb-stray-page: ADS-B names the card and its latest, the pager decode is left out", () => {
		const { c, now, identity } = cardOf("adsb-stray-page", true)
		expect(identity.proto).toBe(c.expect.proto)
		expect(now.latest?.eventId ?? null).toBe(c.expect.latest)
		expect(now.line).toMatch(/^Latest: /)
		expect(now.line).not.toMatch(/POCSAG|unknown/i)
		expect(
			[now.latest, ...now.earlier.map(r => r.item)].every(
				i => i?.decoderId === "readsb",
			),
		).toBe(true)
	})

	it("keeps a decode from a decoder whose band does cover the frequency", () => {
		const c = caseById("pager-dmr-466")
		const page = decode()
		const items = heardOnBand([page], parseSummary(c.summary), c.decoders, c.hz)
		expect(items).toEqual([page])
		const now = nowView({
			items,
			decoderTypes: ["multimon-ng"],
			modulation: "nfm",
			channelName: null,
			hz: c.hz,
			count: null,
			live: false,
			now: TUNED_CASE_NOW,
		})
		expect(now.protocol).toMatch(/POCSAG/)
	})

	it("reads the statuses' bands when the core has no summary", () => {
		const stray = caseById("adsb-stray-page")
		expect(
			heardOnBand(stray.activity ?? [], null, stray.decoders, stray.hz).map(
				i => i.decoderId,
			),
		).toEqual(["readsb", "readsb"])
		const at466 = caseById("pager-dmr-466")
		const page = decode()
		expect(heardOnBand([page], null, at466.decoders, at466.hz)).toEqual([page])
	})

	it("trusts the core's coversHz over the statuses", () => {
		const c = caseById("pager-dmr-466")
		const page = decode()
		const pagerOff = [{ id: "multimon-ng", coversHz: false }]
		expect(heardOnBand([page], pagerOff, c.decoders, c.hz)).toEqual([])
		const pagerOn = [{ id: "multimon-ng", coversHz: true }]
		const stray = caseById("adsb-stray-page")
		expect(heardOnBand([page], pagerOn, stray.decoders, stray.hz)).toEqual([
			page,
		])
	})

	it("keeps what has no band to read: no decoder id, an unknown decoder, a decoder without a band", () => {
		const hz = 1_090_062_000
		const anonymous = decode({ decoderId: null })
		const unknown = decode({ decoderId: "gone" })
		const bandless = decode({ decoderId: "custom", protocol: "custom" })
		const decoders = [status({ id: "custom", type: "custom" })]
		const items = [anonymous, unknown, bandless]
		expect(heardOnBand(items, null, decoders, hz)).toEqual(items)
		// a summary item without coversHz (an older core) is no band either
		expect(
			heardOnBand(items, [{ id: "custom", coversHz: null }], decoders, hz),
		).toEqual(items)
	})

	it("keeps a scanner probe's and an ephemeral decoder's decodes, placed on the frequency to decode it", () => {
		const hz = 1_090_062_000
		const probe = decode({ decoderId: "probe" })
		const once = decode({ decoderId: "once" })
		const decoders = [
			status({
				id: "probe",
				type: "multimon-ng",
				owner: "scanner",
				targetFrequenciesHz: [466_000_000],
			}),
			status({
				id: "once",
				type: "multimon-ng",
				ephemeral: true,
				targetFrequenciesHz: [466_000_000],
			}),
		]
		const summary = [
			{ id: "probe", coversHz: false },
			{ id: "once", coversHz: false },
		]
		expect(heardOnBand([probe, once], summary, decoders, hz)).toEqual([
			probe,
			once,
		])
	})

	it("uses the band plan for a decoder without a band of its own once it is loaded", () => {
		const page = decode({ decoderId: "pager" })
		const decoders = [status({ id: "pager", type: "multimon-ng" })]
		const plan = [
			{
				startHz: 466_000_000,
				endHz: 466_100_000,
				protocols: ["pocsag" as const],
			},
		]
		// not loaded: no band to read, kept
		expect(heardOnBand([page], null, decoders, 1_090_062_000)).toEqual([page])
		expect(heardOnBand([page], null, decoders, 1_090_062_000, plan)).toEqual([])
		expect(heardOnBand([page], null, decoders, 466_050_000, plan)).toEqual([
			page,
		])
	})
})
