import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { DiscoveryFilter } from "../../../../src/core/scanner/store/discovery-store.js"
import type {
	Discovery,
	IdentityKind,
	ScannerConfidence,
	ScannerProtocol,
} from "../../../../src/core/scanner/types.js"
import { CONFIDENCE_RANK } from "../../../../src/core/scanner/types.js"
import {
	counterIds,
	evidence,
	makeObs,
} from "../../../mocks/scanner/observations.js"

const CH = 446_006_250
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const PROTOCOL_OF: Record<IdentityKind, ScannerProtocol> = {
	"dmr-cc": "dmr",
	"p25-nac": "p25p1",
	"nxdn-ran": "nxdn48",
	"ysf-dgid": "ysf",
	"dstar-call": "dstar",
	"dpmr-cc": "dpmr",
	"pocsag-capcode": "pocsag",
	"aprs-call": "aprs",
	"ism-model": "ism",
	"ais-mmsi": "ais",
	"acars-reg": "acars",
	"vdl2-addr": "vdl2",
	"lora-node": "lora",
}
const KINDS = Object.keys(PROTOCOL_OF) as IdentityKind[]

function newStore(): DiscoveryStore {
	return new DiscoveryStore({
		maxDiscoveries: 50,
		now: () => T0,
		newId: counterIds(),
	})
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

interface SeedRow {
	kind: IdentityKind
	value: string
	label?: string
	notes?: string
	talkgroup?: string
	callsign?: string
	capcode?: string
	encrypted?: boolean
	jobId?: string
	sourceId?: string
	/** Skip evidence: an activity discovery with no identity. */
	bare?: boolean
}

function seed(rows: SeedRow[]): DiscoveryStore {
	const store = newStore()
	rows.forEach((row, i) => {
		const startedAt = T0 + i * 10_000
		const created = store.ingest(
			makeObs({
				id: `o${i}`,
				centreHz: CH + i * 100_000,
				startedAt,
				blocks: 2,
				jobIds: [row.jobId ?? "job-1"],
				sourceId: row.sourceId ?? "src-1",
			}),
		)
		const id = created.discoveryId
		if (id === null) throw new Error(`row ${i} did not surface`)
		if (row.bare === true) return
		const ev = evidence(PROTOCOL_OF[row.kind], startedAt + 2_000, {
			identity: { kind: row.kind, value: row.value },
			...(row.encrypted !== undefined ? { encrypted: row.encrypted } : {}),
			...(row.talkgroup !== undefined ? { talkgroups: [row.talkgroup] } : {}),
		})
		if (row.callsign !== undefined) ev.metadata.callsigns = [row.callsign]
		if (row.capcode !== undefined) ev.metadata.capcodes = [row.capcode]
		store.applyEvidence(id, ev)
		if (row.label !== undefined || row.notes !== undefined) {
			store.setOperator(id, {
				...(row.label !== undefined ? { label: row.label } : {}),
				...(row.notes !== undefined ? { notes: row.notes } : {}),
			})
		}
	})
	return store
}

function byLastSeen(a: Discovery, b: Discovery): number {
	return compareText(b.lastSeenAt, a.lastSeenAt) || compareText(a.id, b.id)
}

/** Spec of list(): identity equality, q over label or identity value, then the unchanged sort and page. */
function expectedPage(
	all: readonly Discovery[],
	filter: DiscoveryFilter,
): { ids: string[]; nextCursor: string | null } {
	const q = filter.q?.toLowerCase()
	const identity = filter.identity
	const identityValue = identity?.value.trim().toLowerCase()
	const matched = all.filter(d => {
		if (filter.jobId !== undefined && !d.jobIds.includes(filter.jobId))
			return false
		if (filter.sourceId !== undefined && !d.sourceIds.includes(filter.sourceId))
			return false
		if (filter.protocol !== undefined && d.protocol !== filter.protocol)
			return false
		if (
			filter.minConfidence !== undefined &&
			CONFIDENCE_RANK[d.confidence] < CONFIDENCE_RANK[filter.minConfidence]
		)
			return false
		if (filter.freqMinHz !== undefined && d.frequencyHz < filter.freqMinHz)
			return false
		if (filter.freqMaxHz !== undefined && d.frequencyHz > filter.freqMaxHz)
			return false
		if (filter.since !== undefined && Date.parse(d.lastSeenAt) < filter.since)
			return false
		if (filter.encrypted !== undefined && d.encrypted !== filter.encrypted)
			return false
		if (
			identity !== undefined &&
			(d.identity?.kind !== identity.kind ||
				d.identity.value.trim().toLowerCase() !== identityValue)
		)
			return false
		if (
			q !== undefined &&
			!(d.operator?.label ?? "").toLowerCase().includes(q) &&
			!(d.identity?.value ?? "").toLowerCase().includes(q)
		)
			return false
		return true
	})
	const sort = filter.sort ?? "lastSeen"
	matched.sort(
		sort === "frequency"
			? (a, b) => a.frequencyHz - b.frequencyHz || compareText(a.id, b.id)
			: sort === "confidence"
				? (a, b) =>
						CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] ||
						byLastSeen(a, b)
				: byLastSeen,
	)
	const limit = Math.min(500, Math.max(1, Math.floor(filter.limit ?? 100)))
	const offset = filter.cursor === undefined ? 0 : Number(filter.cursor)
	const page = matched.slice(offset, offset + limit)
	return {
		ids: page.map(d => d.id),
		nextCursor: offset + limit < matched.length ? String(offset + limit) : null,
	}
}

const letters = fc.string({
	unit: fc.constantFrom(..."abcdef".split("")),
	minLength: 1,
	maxLength: 6,
})

describe("discovery identity filter", () => {
	it("keeps the same kind and a case-insensitive trimmed value", () => {
		const store = seed([
			{ kind: "dmr-cc", value: "  AbC  " },
			{ kind: "dmr-cc", value: "abd" },
			{ kind: "p25-nac", value: "abc" },
			{ kind: "dmr-cc", value: "abc", bare: true },
		])
		const match = (value: string) =>
			store.list({ identity: { kind: "dmr-cc", value }, limit: 50 }).items
		expect(match("abc").map(d => d.identity)).toEqual([
			{ kind: "dmr-cc", value: "  AbC  " },
		])
		expect(match("  ABC ").map(d => d.id)).toEqual(match("abc").map(d => d.id))
		expect(match("ab c")).toHaveLength(0)
	})

	it("ANDs identity with the other filters and keeps sort, cursor and limit", () => {
		const store = seed([
			{ kind: "dmr-cc", value: "1", jobId: "job-a" },
			{ kind: "dmr-cc", value: "1", jobId: "job-a" },
			{ kind: "dmr-cc", value: "1", jobId: "job-b" },
			{ kind: "p25-nac", value: "1", jobId: "job-a" },
		])
		const filter: DiscoveryFilter = {
			identity: { kind: "dmr-cc", value: "1" },
			jobId: "job-a",
			sort: "frequency",
			limit: 1,
		}
		const page1 = store.list(filter)
		expect(page1.items).toHaveLength(1)
		expect(page1.items[0]!.protocol).toBe("dmr")
		expect(page1.items[0]!.jobIds).toEqual(["job-a"])
		expect(page1.nextCursor).toBe("1")
		const page2 = store.list({ ...filter, cursor: page1.nextCursor })
		expect(page2.items).toHaveLength(1)
		expect(page2.items[0]!.jobIds).toEqual(["job-a"])
		expect(page2.nextCursor).toBeNull()
		expect(page1.items[0]!.frequencyHz).toBeLessThan(
			page2.items[0]!.frequencyHz,
		)
		const full = store.list({
			identity: { kind: "dmr-cc", value: "1" },
			sort: "frequency",
			limit: 10,
		})
		expect(full.items.map(d => d.frequencyHz)).toEqual(
			[...full.items.map(d => d.frequencyHz)].sort((a, b) => a - b),
		)
		expect(full.items).toHaveLength(3)
		expect(full.items.map(d => d.id)).toEqual([
			...store
				.list({ sort: "frequency", limit: 10 })
				.items.filter(
					d => d.identity?.kind === "dmr-cc" && d.identity.value === "1",
				)
				.map(d => d.id),
		])
	})

	// Feature: scanner-followups, Property 8: Identity filter
	// Validates: Requirements 5.2, 5.4
	it("returns exactly the kind and case-insensitive value, intersected with the other filters", () => {
		const rowArb = fc.record({
			kind: fc.constantFrom(...KINDS),
			value: fc.string({ maxLength: 8 }),
			label: fc.option(letters, { nil: undefined }),
			encrypted: fc.boolean(),
			jobId: fc.constantFrom("job-a", "job-b"),
			sourceId: fc.constantFrom("src-a", "src-b"),
			bare: fc.boolean(),
		})
		const confidence: ScannerConfidence[] = [
			"activity",
			"candidate",
			"classified",
			"decoded",
		]
		const filterArb = fc.record({
			identity: fc.option(
				fc.record({
					kind: fc.constantFrom(...KINDS),
					value: fc.string({ maxLength: 10 }),
				}),
				{ nil: undefined },
			),
			q: fc.option(fc.string({ maxLength: 6 }), { nil: undefined }),
			jobId: fc.option(fc.constantFrom("job-a", "job-b"), { nil: undefined }),
			sourceId: fc.option(fc.constantFrom("src-a", "src-b"), {
				nil: undefined,
			}),
			protocol: fc.option(
				fc.constantFrom(...(Object.values(PROTOCOL_OF) as ScannerProtocol[])),
				{ nil: undefined },
			),
			minConfidence: fc.option(fc.constantFrom(...confidence), {
				nil: undefined,
			}),
			encrypted: fc.option(fc.boolean(), { nil: undefined }),
			freqMinHz: fc.option(fc.integer({ min: CH - 1, max: CH + 700_000 }), {
				nil: undefined,
			}),
			freqMaxHz: fc.option(fc.integer({ min: CH - 1, max: CH + 700_000 }), {
				nil: undefined,
			}),
			since: fc.option(fc.integer({ min: T0 - 1, max: T0 + 80_000 }), {
				nil: undefined,
			}),
			sort: fc.option(
				fc.constantFrom(
					"lastSeen" as const,
					"frequency" as const,
					"confidence" as const,
				),
				{ nil: undefined },
			),
			limit: fc.integer({ min: 1, max: 5 }),
			cursor: fc.integer({ min: 0, max: 8 }),
		})
		fc.assert(
			fc.property(
				fc.array(rowArb, { minLength: 1, maxLength: 6 }),
				filterArb,
				(rows, raw) => {
					const store = seed(
						rows.map(row => ({
							kind: row.kind,
							value: row.value,
							encrypted: row.encrypted,
							jobId: row.jobId,
							sourceId: row.sourceId,
							bare: row.bare,
							...(row.label !== undefined ? { label: row.label } : {}),
						})),
					)
					const all = store.list({ limit: 500 }).items
					const filter: DiscoveryFilter = {
						...(raw.identity !== undefined ? { identity: raw.identity } : {}),
						...(raw.q !== undefined ? { q: raw.q } : {}),
						...(raw.jobId !== undefined ? { jobId: raw.jobId } : {}),
						...(raw.sourceId !== undefined ? { sourceId: raw.sourceId } : {}),
						...(raw.protocol !== undefined ? { protocol: raw.protocol } : {}),
						...(raw.minConfidence !== undefined
							? { minConfidence: raw.minConfidence }
							: {}),
						...(raw.encrypted !== undefined
							? { encrypted: raw.encrypted }
							: {}),
						...(raw.freqMinHz !== undefined
							? { freqMinHz: raw.freqMinHz }
							: {}),
						...(raw.freqMaxHz !== undefined
							? { freqMaxHz: raw.freqMaxHz }
							: {}),
						...(raw.since !== undefined ? { since: raw.since } : {}),
						...(raw.sort !== undefined ? { sort: raw.sort } : {}),
						limit: raw.limit,
						...(raw.cursor > 0 ? { cursor: String(raw.cursor) } : {}),
					}
					const got = store.list(filter)
					const want = expectedPage(all, filter)
					expect(got.items.map(d => d.id)).toEqual(want.ids)
					expect(got.nextCursor).toBe(want.nextCursor)
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("discovery q over identity values", () => {
	it("matches the label or the identity value and not metadata or notes", () => {
		const store = seed([
			{ kind: "dmr-cc", value: "other", label: "Tower Alpha" },
			{ kind: "p25-nac", value: "  NaC-12 ", label: "site" },
			{
				kind: "dmr-cc",
				value: "plain",
				label: "quiet",
				notes: "nac-12",
				talkgroup: "nac-12",
				callsign: "NAC-12",
				capcode: "nac-12",
			},
		])
		const ids = (q: string) =>
			store
				.list({ q, limit: 20 })
				.items.map(d => d.identity?.value ?? d.operator?.label)
		expect(ids("alpha")).toEqual(["other"])
		expect(ids("NAC-12").sort()).toEqual(["  NaC-12 "])
		expect(ids("missing")).toEqual([])
	})

	// Feature: scanner-followups, Property 9: q superset
	// Validates: Requirements 5.3
	it("keeps every label match and adds exactly the identity-value matches", () => {
		const needleArb = letters
		const roleArb = fc.constantFrom(
			"label" as const,
			"identity" as const,
			"both" as const,
			"metadata" as const,
			"none" as const,
		)
		fc.assert(
			fc.property(
				needleArb,
				fc.array(roleArb, { minLength: 1, maxLength: 6 }),
				(needle, roles) => {
					const cased = needle.toUpperCase()
					const rows: SeedRow[] = roles.map(role => {
						const labelHit = role === "label" || role === "both"
						const valueHit = role === "identity" || role === "both"
						const metaHit = role === "metadata"
						return {
							kind: "dmr-cc" as const,
							value: valueHit ? ` ${needle.toLowerCase()} ` : "000",
							label: labelHit ? `xx${cased}yy` : "111",
							notes: metaHit ? needle : "222",
							talkgroup: metaHit ? needle : "333",
							callsign: metaHit ? cased : "444",
							capcode: metaHit ? needle : "555",
						}
					})
					const store = seed(rows)
					const all = store.list({ limit: 500 }).items
					const q = needle
					const got = new Set(
						store.list({ q, limit: 500 }).items.map(d => d.id),
					)
					const labelOnly = (d: Discovery) =>
						(d.operator?.label ?? "").toLowerCase().includes(q.toLowerCase())
					const valueHit = (d: Discovery) =>
						(d.identity?.value ?? "").toLowerCase().includes(q.toLowerCase())
					const needleIn = (text: string) =>
						text.toLowerCase().includes(q.toLowerCase())
					for (const d of all) {
						if (labelOnly(d)) expect(got.has(d.id)).toBe(true)
					}
					const added = all.filter(d => got.has(d.id) && !labelOnly(d))
					expect(added.every(valueHit)).toBe(true)
					for (const d of all) {
						const want = labelOnly(d) || valueHit(d)
						expect(got.has(d.id)).toBe(want)
						const metadataOnly =
							!labelOnly(d) &&
							!valueHit(d) &&
							(d.metadata.talkgroups.some(needleIn) ||
								d.metadata.callsigns.some(needleIn) ||
								d.metadata.capcodes.some(needleIn) ||
								needleIn(d.operator?.notes ?? ""))
						if (metadataOnly) expect(got.has(d.id)).toBe(false)
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})
