import { describe, expect, it } from "vitest"
import type { Discovery, ScanJob, ScanJobHit } from "@wavekit/api-types"

import {
	discoveryMode,
	discoverySaveInput,
	inCapture,
} from "../../src/features/scanner/drawer/actions.ts"
import {
	discoveryRow,
	footerText,
	frequencyParts,
	groupDiscoveries,
	headerCount,
	measuredText,
	heardText,
	hitEntries,
	hitMeta,
	identityChips,
	identityLine,
	listEntries,
	spanText,
	whyText,
} from "../../src/features/scanner/drawer/rows.ts"
import {
	addToken,
	buildDiscoveryQuery,
	frequencyToken,
	prefixRange,
	protocolToken,
	sameQuery,
	suggest,
	textToken,
} from "../../src/features/scanner/drawer/search.ts"
import { watchView } from "../../src/features/scanner/drawer/state.ts"

const NOW = Date.parse("2026-10-17T12:00:00Z")
const ago = (ms: number) => new Date(NOW - ms).toISOString()

function disc(over: Partial<Discovery> = {}): Discovery {
	return {
		id: "d1",
		frequencyHz: 161_150_000,
		frequencyKey: "161150000",
		measuredOffsetHz: 0,
		bandwidthHz: 12_500,
		protocol: "dmr",
		family: "dmr" as Discovery["family"],
		class: "fsk4-12k5",
		confidence: "decoded",
		encrypted: false,
		coChannel: [],
		firstSeenAt: ago(86_400_000),
		lastSeenAt: ago(6 * 60_000),
		observationCount: 12,
		airtimeMs: 64_000,
		signal: {
			best: { peakDbfs: -30, meanDbfs: -40, snrDb: 24.2, floorDbfs: -70 },
			last: { peakDbfs: -32, meanDbfs: -42, snrDb: 20, floorDbfs: -70 },
		},
		metadata: {
			talkgroups: [],
			sources: [],
			slots: [],
			callsigns: [],
			capcodes: [],
			ismModels: [],
		},
		sourceIds: ["rtl"],
		jobIds: [],
		tuningTrust: "commanded",
		evidence: { recordings: 0, psd: false, iq: false },
		...over,
	}
}

function job(over: Partial<ScanJob> = {}): ScanJob {
	return {
		resumeAt: null,
		resumeHeldBy: null,
		id: "j1",
		name: "Land mobile",
		state: "running",
		passive: false,
		spec: {} as ScanJob["spec"],
		plan: {
			hops: [{}, {}, {}] as ScanJob["plan"]["hops"],
			usableHalfSpanHz: 960_000,
			dcGuardHz: 0,
			ppmMarginHz: 0,
		},
		issues: [],
		impact: null,
		unrestorable: [],
		progress: {
			sweepIndex: 0,
			hopIndex: 1,
			hopCount: 3,
			sweepPeriodMs: 8000,
			coverage: 0.5,
			holdingOn: null,
			settleMode: null,
			probes: [],
			counts: {
				observations: 0,
				transients: 0,
				discoveries: { activity: 0, candidate: 0, classified: 0, decoded: 0 },
			},
		},
		createdAt: ago(720_000),
		updatedAt: ago(1000),
		startedAt: ago(720_000),
		...over,
	}
}

describe("scanner drawer search", () => {
	it("reads a short number as a colour code first, then a frequency prefix", () => {
		const s = suggest("1")
		expect(s[0]).toMatchObject({
			kind: "identity",
			value: "dmr-cc:1",
			kindLabel: "Colour code",
		})
		expect(s.at(-1)).toMatchObject({ kind: "text", value: "1" })
	})

	it("reads a decimal number as a frequency prefix in MHz", () => {
		expect(prefixRange("161")).toEqual({
			minHz: 161_000_000,
			maxHz: 161_999_999,
		})
		expect(prefixRange("161.15")).toEqual({
			minHz: 161_150_000,
			maxHz: 161_159_999,
		})
		const first = suggest("161.15")[0]
		expect(first?.kind).toBe("frequency")
		expect(buildDiscoveryQuery(first ? [first] : [], "lastSeen")).toEqual({
			freqMinHz: 161_150_000,
			freqMaxHz: 161_159_999,
		})
	})

	it("reads typed ranges and frequencies with a unit", () => {
		expect(suggest("146-174")[0]).toMatchObject({
			kind: "frequency",
			value: "146000000-174000000",
		})
		expect(suggest("433920 kHz")[0]).toMatchObject({
			kind: "frequency",
			value: "433913750-433926250",
		})
	})

	it("reads identity prefixes, capcodes, MMSIs and callsigns", () => {
		expect(suggest("cc 3")[0]?.value).toBe("dmr-cc:3")
		expect(suggest("nac 293")[0]?.value).toBe("p25-nac:293")
		expect(suggest("1234567")[0]?.value).toBe("pocsag-capcode:1234567")
		expect(suggest("235012345")[0]?.value).toBe("ais-mmsi:235012345")
		const call = suggest("f4abc-9").map(t => t.value)
		expect(call).toContain("aprs-call:F4ABC-9")
		expect(call).toContain("dstar-call:F4ABC-9")
	})

	it("offers protocols and confidence by name", () => {
		expect(suggest("dm").map(t => t.value)).toContain("dmr")
		const p25 = suggest("p25")
			.filter(t => t.kind === "protocol")
			.map(t => t.value)
		expect(p25).toEqual(["p25p1", "p25p2"])
		expect(suggest("decod")[0]).toMatchObject({
			kind: "confidence",
			value: "decoded",
		})
		expect(suggest("")).toEqual([])
	})

	it("keeps one chip per kind, since the core takes one value per filter", () => {
		let tokens = addToken([], protocolToken("dmr"))
		tokens = addToken(tokens, textToken("roscoff"))
		tokens = addToken(tokens, protocolToken("pocsag"))
		expect(tokens.map(t => t.value)).toEqual(["roscoff", "pocsag"])
	})

	it("maps every chip kind onto the core query", () => {
		const tokens = [
			textToken("pager"),
			suggest("cc 1")[0]!,
			protocolToken("dmr"),
			suggest("likely")[0]!,
			frequencyToken(160_000_000, 162_000_000),
		]
		expect(buildDiscoveryQuery(tokens, "confidence")).toEqual({
			sort: "confidence",
			q: "pager",
			identity: "dmr-cc:1",
			protocol: "dmr",
			minConfidence: "classified",
			freqMinHz: 160_000_000,
			freqMaxHz: 162_000_000,
		})
		expect(buildDiscoveryQuery([], "lastSeen")).toEqual({})
		// WG12: proven only unless weak activity is shown; nothing on an older core
		expect(buildDiscoveryQuery([], "lastSeen", false)).toEqual({
			evidence: "proven",
		})
		expect(buildDiscoveryQuery([], "lastSeen", true)).toEqual({
			evidence: "all",
		})
		expect(sameQuery({ protocol: "dmr" }, { protocol: "dmr" })).toBe(true)
		expect(
			sameQuery({ protocol: "dmr" }, { protocol: "dmr", sort: "frequency" }),
		).toBe(false)
	})
})

describe("scanner drawer rows", () => {
	it("writes the frequency with a quiet tail", () => {
		expect(frequencyParts(161_150_000)).toEqual({
			main: "161.150",
			tail: "000",
		})
		expect(frequencyParts(446_006_250)).toEqual({
			main: "446.006",
			tail: "250",
		})
	})

	it("says last heard in short words", () => {
		expect(heardText(ago(20_000), NOW)).toBe("Just now")
		expect(heardText(ago(6 * 60_000), NOW)).toBe("6 min")
		expect(heardText(ago(3 * 3_600_000), NOW)).toBe("3 h")
		expect(heardText(ago(3 * 86_400_000), NOW)).toBe("3 d")
	})

	it("builds a decoded row with identity, star and lock", () => {
		const d = disc({
			identity: { kind: "dmr-cc", value: "1" },
			metadata: {
				talkgroups: ["2081", "9", "91"],
				sources: [],
				slots: [1],
				callsigns: [],
				capcodes: [],
				ismModels: [],
			},
			encrypted: true,
			operator: { keep: true },
		})
		const v = discoveryRow(d, NOW)
		expect(v).toMatchObject({
			confidence: "DMR",
			decoded: true,
			tone: "accent",
			title: "CC 1 · TG 2081, TG 9 +1 · slot 1",
			labelled: false,
			encrypted: true,
			kept: true,
			heard: "6 min",
			aria: "161.150 MHz, DMR, CC 1",
		})
		expect(identityLine(d)).toBe("CC 1 · TG 2081, TG 9 +1 · slot 1")
		expect(identityChips(d)).toEqual([
			"CC 1",
			"TG 2081",
			"TG 9",
			"TG 91",
			"Slot 1",
		])
	})

	it("puts caps and failure reasons on the second line and prefers the label", () => {
		const v = discoveryRow(
			disc({
				confidence: "candidate",
				protocol: "nxdn48",
				class: "fsk4-6k25",
				undecodedReason: "no-sync",
				confidenceCap: "adjacent-leak",
				operator: { label: "Taxis?" },
			}),
			NOW,
		)
		expect(v).toMatchObject({
			confidence: "Maybe NXDN",
			tone: "plain",
			decoded: false,
			title: "Taxis?",
			labelled: true,
			reason: "May be a neighbour's leak · No sync",
		})
	})

	it("explains the confidence", () => {
		expect(whyText(disc({ identity: { kind: "dmr-cc", value: "1" } }))).toBe(
			"DMR decoded · CC 1",
		)
		expect(
			whyText(
				disc({
					confidence: "candidate",
					protocol: "nxdn48",
					class: "fsk4-6k25",
					undecodedReason: "no-sync",
				}),
			),
		).toBe("Looks like 4FSK 6.25 kHz · no sync")
		expect(
			whyText(
				disc({
					confidence: "activity",
					protocol: "unknown",
					class: "unknown",
					observationCount: 1,
				}),
			),
		).toBe("Heard once · too little to tell")
		expect(
			whyText(
				disc({
					protocol: "carrier",
					class: "carrier",
					confidence: "classified",
				}),
			),
		).toBe("A steady carrier · no modulation")
	})

	it("groups by the sort and keeps ignored ones apart", () => {
		const items = [
			disc({ id: "a", lastSeenAt: ago(5_000) }),
			disc({ id: "b", lastSeenAt: ago(10 * 60_000) }),
			disc({
				id: "c",
				lastSeenAt: ago(5 * 3_600_000),
				frequencyHz: 446_006_250,
			}),
			disc({ id: "x", operator: { lockout: true, label: "Birdie" } }),
		]
		const live = new Set(["a"])
		const byTime = groupDiscoveries(items, "lastSeen", live, NOW)
		expect(byTime.groups.map(g => [g.label, g.items.map(d => d.id)])).toEqual([
			["Active now", ["a"]],
			["Last hour", ["b"]],
			["Earlier", ["c"]],
		])
		expect(byTime.ignored.map(d => d.id)).toEqual(["x"])
		const byBand = groupDiscoveries(items, "frequency", live, NOW)
		expect(byBand.groups.map(g => g.label)).toEqual(["VHF", "UHF"])
		const byConf = groupDiscoveries(
			[
				disc({ id: "h", confidence: "activity" }),
				disc({ id: "d" }),
				disc({ id: "m", confidence: "candidate" }),
			],
			"confidence",
			live,
			NOW,
		)
		expect(byConf.groups.map(g => g.label)).toEqual([
			"Decoded",
			"Maybe",
			"Heard",
		])
	})

	it("lists entries with the ignored toggle last", () => {
		const items = [
			disc({ id: "a" }),
			disc({ id: "x", operator: { lockout: true, label: "Birdie" } }),
		]
		const closed = listEntries(items, "lastSeen", new Set(), NOW, false)
		expect(closed.map(e => e.type)).toEqual(["group", "row", "ignored"])
		expect(closed.at(-1)).toMatchObject({ count: 1, names: "Birdie" })
		const shown = listEntries(items, "lastSeen", new Set(), NOW, true)
		expect(shown.map(e => e.key)).toEqual(["g:hour", "a", "ignored", "x"])
	})
})

describe("scanner drawer hit log", () => {
	const hit = (id: string, over: Partial<ScanJobHit> = {}): ScanJobHit => ({
		jobId: "j1",
		discoveryId: id,
		hits: 1,
		firstHitAt: ago(60_000),
		lastHitAt: ago(30_000),
		firstSeenInJob: false,
		...over,
	})
	const hits = new Map([
		["old", hit("old", { lastHitAt: ago(10_000) })],
		["new", hit("new", { firstSeenInJob: true, lastHitAt: ago(50_000) })],
		["live", hit("live", { lastHitAt: ago(40_000) })],
	])
	const byId = new Map([["old", disc({ id: "old", confidence: "candidate" })]])

	it("puts live hits first, then new ones, then the most recent", () => {
		const e = hitEntries(hits, byId, new Set(["live"]), false)
		expect(e.map(x => x.hit.discoveryId)).toEqual(["live", "new", "old"])
		expect(e[0]?.live).toBe(true)
		expect(e[1]?.fresh).toBe(true)
	})

	it("keeps only first-seen hits with New only", () => {
		expect(
			hitEntries(hits, byId, new Set(), true).map(x => x.hit.discoveryId),
		).toEqual(["new"])
		expect(hitEntries(undefined, byId, new Set(), false)).toEqual([])
	})

	it("describes a hit", () => {
		const e = hitEntries(hits, byId, new Set(), false).find(
			x => x.hit.discoveryId === "old",
		)!
		expect(hitMeta(e)).toMatch(/^1 hit · first \d\d:\d\d · last \d\d:\d\d$/)
		const ignored = {
			...e,
			discovery: disc({ operator: { lockout: true } }),
			hit: { ...e.hit, hits: 3, lastDurationMs: 4200 },
		}
		expect(hitMeta(ignored)).toMatch(/^Ignored · 3 hits · .* · 4 s long$/)
	})
})

describe("scanner drawer header and footer", () => {
	it("counts this scan's finds while a sweep runs, else the list", () => {
		expect(
			headerCount({
				sweep: job(),
				found: 4,
				fresh: 2,
				listed: 0,
				more: false,
				loaded: true,
			}),
		).toBe("Sweeping · 4 found · 2 new")
		const oneHop = job({
			name: "PMR446",
			plan: { ...job().plan, hops: [{}] as ScanJob["plan"]["hops"] },
		})
		expect(
			headerCount({
				sweep: oneHop,
				found: 1,
				fresh: 1,
				listed: 0,
				more: false,
				loaded: true,
			}),
		).toBe("Watching PMR446 · 1 found")
		expect(
			headerCount({
				sweep: job({ state: "paused" }),
				found: 4,
				fresh: 2,
				listed: 0,
				more: false,
				loaded: true,
			}),
		).toBe("4 found · 2 new")
		expect(
			headerCount({
				sweep: null,
				found: 0,
				fresh: 0,
				listed: 100,
				more: true,
				loaded: true,
			}),
		).toBe("100+")
		expect(
			headerCount({
				sweep: null,
				found: 0,
				fresh: 0,
				listed: 0,
				more: false,
				loaded: false,
			}),
		).toBe("")
	})

	it("is honest about time and coverage", () => {
		const base = {
			lastSweep: null,
			progress: null,
			passive: null,
			watching: false,
			found: 0,
			readOnly: false,
			now: NOW,
		}
		expect(footerText({ ...base, sweep: job() })).toMatch(
			/^Scanning for 12 min · started \d\d:\d\d · 50 % covered$/,
		)
		expect(footerText({ ...base, sweep: job({ state: "paused" }) })).toBe(
			"Paused after 12 min · 50 % covered",
		)
		const ended = job({
			state: "completed",
			endedAt: ago(60_000),
			startedAt: ago(780_000),
			progress: { ...job().progress, coverage: 0.91 },
		})
		expect(footerText({ ...base, sweep: null, lastSweep: ended })).toBe(
			"Nothing found in 12 min of scanning (91 % covered)",
		)
		expect(footerText({ ...base, sweep: null })).toBe(
			"Not watching · discoveries so far are kept",
		)
		expect(
			footerText({ ...base, sweep: null, readOnly: true, watching: true }),
		).toBe("View only · Watching where you are tuned")
	})

	it("writes the watched span", () => {
		expect(spanText(161_800_000, 2_400_000)).toBe("160.6–163.0")
	})
})

describe("scanner drawer actions and Watch here", () => {
	it("prefills a saved frequency from the discovery", () => {
		expect(discoveryMode({ protocol: "analog-am" })).toBe("am")
		expect(
			discoverySaveInput(
				disc({ identity: { kind: "dmr-cc", value: "1" } }),
				"Local",
			),
		).toEqual({
			name: "DMR · CC 1",
			frequencyHz: 161_150_000,
			mode: "nfm",
			bandwidthHz: 12_500,
			tone: { kind: "none" },
			group: "Local",
		})
		const fm = discoverySaveInput(
			disc({
				protocol: "analog-fm",
				confidence: "candidate",
				bandwidthHz: 900_000,
				metadata: { ...disc().metadata, ctcssHz: 88.5 },
			}),
			null,
		)
		expect(fm).toMatchObject({
			name: "Maybe FM voice 161.150",
			bandwidthHz: 25_000,
			tone: { kind: "ctcss", frequencyTenthsHz: 885 },
		})
		expect(
			discoverySaveInput(disc({ operator: { label: "Ferry" } }), null).name,
		).toBe("Ferry")
	})

	it("knows when a frequency is in the capture", () => {
		const tuner = { frequency: 161_000_000, sampleRate: 2_400_000 }
		expect(inCapture(161_150_000, tuner)).toBe(true)
		expect(inCapture(163_000_000, tuner)).toBe(false)
		expect(inCapture(161_150_000, undefined)).toBe(false)
	})

	it("lets the switch write the per-source setting only when core allows", () => {
		const settings = {
			effective: { passive: { enabled: true, offsetProbes: false } },
			passiveBySource: { rtl: true },
			provenance: {},
			bounds: {},
		} as unknown as NonNullable<Parameters<typeof watchView>[1]["settings"]>
		const state = { settings, settingsError: null, pending: null, error: null }
		expect(watchView("rtl", state, undefined, false)).toEqual({
			on: true,
			canToggle: true,
			why: null,
		})
		expect(
			watchView("rtl", { ...state, pending: false }, undefined, false),
		).toMatchObject({ on: false, canToggle: false })
		expect(watchView("rtl", state, undefined, true)).toMatchObject({
			canToggle: false,
			why: "View only",
		})
		const off = {
			...settings,
			effective: {
				...settings.effective,
				passive: { enabled: false, offsetProbes: false },
			},
		}
		expect(
			watchView("rtl", { ...state, settings: off }, undefined, false),
		).toMatchObject({ on: false, canToggle: false })
		expect(
			watchView(
				"rtl",
				{ ...state, settings: null, settingsError: "not on this core" },
				{ passive: { enabled: true } },
				false,
			),
		).toMatchObject({ on: true, canToggle: false })
	})
})

describe("scanner drawer proofs (WG12)", () => {
	const proof = {
		kind: "decoded" as const,
		protocol: "dmr" as const,
		transport: "live" as const,
		at: ago(1000),
		observationId: "o1",
		tried: [],
		unavailable: [],
		encrypted: false,
		summary: "DMR decoded (CC1, TG 9)",
	}

	it("titles and explains a proven discovery with its proof", () => {
		const d = disc({ proof, evidenceLevel: "proven" })
		expect(discoveryRow(d, NOW).title).toBe("DMR decoded (CC1, TG 9)")
		expect(whyText(d)).toBe("DMR decoded (CC1, TG 9)")
		// a name someone gave it still wins
		expect(
			discoveryRow(disc({ proof, operator: { label: "Taxis" } }), NOW).title,
		).toBe("Taxis")
	})

	it("ends the list with the weak-activity toggle only on cores that prove", () => {
		const items = [disc()]
		const last = (weak: "none" | "hidden" | "shown") =>
			listEntries(items, "lastSeen", new Set(), NOW, false, weak).at(-1)
		expect(last("none")?.type).toBe("row")
		expect(last("hidden")).toEqual({ type: "weak", key: "weak", shown: false })
		expect(last("shown")).toEqual({ type: "weak", key: "weak", shown: true })
	})
})

it("does not present anchor placeholders as RF measurements", () => {
	const d = disc({ anchor: "decode", bandwidthHz: 0, airtimeMs: 1000 })
	expect(measuredText(d)).not.toMatch(/SNR|wide|on air/)
})
