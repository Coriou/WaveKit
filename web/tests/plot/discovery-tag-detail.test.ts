import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"
import fc from "fast-check"
import type { Discovery, ScannerProof } from "@wavekit/api-types"

import {
	approxBandwidth,
	DISCOVERY_TAG_MAX_LABEL_PX,
	FLICKER_HOLD_MS,
	FUTURE_SLACK_MS,
	howWeKnow,
	listenAfterTune,
	placeDiscoveryTags,
	PROVEN_LIVE_HOLD_MS,
	RECENT_MS,
	tagDetail,
	tagName,
	tagState,
	tagTier,
	TAG_CLOCK_MS,
	unidentifiedLabel,
} from "../../src/plot/discovery-tags.ts"

/** Discovery fields to override; `undefined` removes an optional one. */
type Over = { [K in keyof Discovery]?: Discovery[K] | undefined }

const NOW = Date.parse("2026-10-30T08:00:00.000Z")
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const view = { startHz: 161_000_000, endHz: 162_000_000 }

const proof = (over: Partial<ScannerProof> = {}): ScannerProof => ({
	kind: "decoded",
	protocol: "dmr",
	transport: "live",
	at: ago(60_000),
	observationId: "o1",
	identity: { kind: "dmr-cc", value: "7" },
	tried: ["dmr"],
	unavailable: [],
	encrypted: false,
	summary: "DMR decoded (CC7)",
	...over,
})

/** A synthesised DMR control channel: proven by its colour code, no call in it. */
function disc(id: string, over: Over = {}): Discovery {
	const stats = { peakDbfs: -40, meanDbfs: -50, snrDb: 20, floorDbfs: -70 }
	const d = {
		id,
		frequencyHz: 161_312_500,
		frequencyKey: "r:161312500",
		measuredOffsetHz: 0,
		bandwidthHz: 9000,
		protocol: "dmr",
		family: "digital-voice",
		class: "tdma-ms",
		confidence: "decoded",
		identity: { kind: "dmr-cc", value: "7" },
		encrypted: false,
		coChannel: [],
		firstSeenAt: ago(3 * 86_400_000),
		lastSeenAt: ago(60_000),
		observationCount: 640,
		airtimeMs: 384_000,
		signal: { best: stats, last: stats },
		metadata: {
			talkgroups: [],
			sources: [],
			slots: [],
			callsigns: [],
			capcodes: [],
			ismModels: [],
		},
		sourceIds: ["rx"],
		jobIds: [],
		tuningTrust: "commanded",
		evidence: { recordings: 0, psd: true, iq: false },
		proof: proof(),
		evidenceLevel: "proven",
		...over,
	} as Discovery
	for (const k of Object.keys(over) as (keyof Discovery)[])
		if (over[k] === undefined) delete d[k]
	return d
}

/** A synthesised continuous 4FSK carrier nobody identified, as a current core publishes it. */
const carrier = (over: Over = {}) =>
	disc("carrier", {
		frequencyHz: 161_737_500,
		protocol: "unknown",
		family: "unknown",
		class: "fsk4-12k5",
		confidence: "activity",
		identity: undefined,
		proof: undefined,
		evidenceLevel: "weak",
		...over,
	})

const none = new Set<string>()

describe("tag state", () => {
	it("proven only with a proven decoded or analog proof, or a decoded discovery from a core without proofs", () => {
		expect(tagState(disc("p"))).toBe("proven")
		expect(
			tagState(
				disc("tone", {
					protocol: "analog-fm",
					proof: proof({ kind: "analog-tone", protocol: "analog-fm" }),
				}),
			),
		).toBe("proven")
		expect(
			tagState(disc("legacy", { proof: undefined, evidenceLevel: undefined })),
		).toBe("proven")
	})

	it("never proven on weak, malformed or name-less evidence", () => {
		// an explicit weak level wins over `decoded`
		expect(tagState(disc("w", { evidenceLevel: "weak" }))).toBe("likely")
		expect(
			tagState(
				disc("odd", { evidenceLevel: "certain" as unknown as "proven" }),
			),
		).toBe("likely")
		// a proven carrier-only or sync-only proof names nothing
		expect(
			tagState(
				disc("c", {
					protocol: "carrier",
					proof: proof({ kind: "carrier-only", protocol: "carrier" }),
				}),
			),
		).toBe("heard")
		expect(
			tagState(disc("s", { proof: proof({ kind: "digital-undecoded" }) })),
		).toBe("likely")
		expect(tagState(carrier())).toBe("heard")
		expect(
			tagState(
				disc("maybe", {
					confidence: "candidate",
					proof: undefined,
					evidenceLevel: undefined,
				}),
			),
		).toBe("likely")
	})
})

describe("tag state: a core without evidence levels", () => {
	it("is proven by `decoded` only when there is no proof field at all", () => {
		const legacy = { evidenceLevel: undefined, proof: undefined } as const
		expect(tagState(disc("l", legacy))).toBe("proven")
		// a proof without an evidence level is a non-proving or malformed one, never legacy proven
		for (const kind of [
			"digital-undecoded",
			"carrier-only",
			"decoded",
			"analog-tone",
		] as const)
			expect(
				tagState(
					disc(kind, { evidenceLevel: undefined, proof: proof({ kind }) }),
				),
			).not.toBe("proven")
		for (const odd of [null, {}, "decoded", { kind: "nonsense" }, 7])
			expect(
				tagState(
					disc("m", {
						evidenceLevel: undefined,
						proof: odd as unknown as ScannerProof,
					}),
				),
			).not.toBe("proven")
	})

	it("never promotes a discovery carrying any proof without an evidence level (property)", () => {
		// Feature: spectrum tag evidence, discovery tags, Property 3: legacy proven needs no proof field at all
		// Validates: review finding 2 (unknown → not proven)
		fc.assert(
			fc.property(
				fc.oneof(
					fc.constant(null),
					fc.anything(),
					fc.record({ kind: fc.string() }),
					fc
						.constantFrom<
							ScannerProof["kind"]
						>("decoded", "analog-tone", "analog-voice", "digital-undecoded", "carrier-only")
						.map(kind => proof({ kind })),
				),
				fc.constantFrom<Discovery["confidence"]>(
					"decoded",
					"classified",
					"candidate",
					"activity",
				),
				(p, confidence) =>
					p === undefined ||
					tagState(
						disc("x", {
							evidenceLevel: undefined,
							proof: p as ScannerProof,
							confidence,
						}),
					) !== "proven",
			),
			{ numRuns: 200 },
		)
	})
})

describe("tag lifetime", () => {
	it("a proven tag stays live up to PROVEN_LIVE_HOLD_MS after it was last heard, then is recent", () => {
		expect(PROVEN_LIVE_HOLD_MS).toBe(5 * TAG_CLOCK_MS)
		const at = (ms: number) =>
			tagTier(disc("p", { lastSeenAt: ago(ms) }), none, NOW)
		expect(at(PROVEN_LIVE_HOLD_MS)).toBe("active")
		expect(at(PROVEN_LIVE_HOLD_MS + 1)).toBe("recent")
		expect(at(RECENT_MS + 1)).toBe("older")
	})

	it("any other tag holds its live look for one tick plus 30 s (FLICKER_HOLD_MS)", () => {
		expect(FLICKER_HOLD_MS).toBe(90_000)
		const at = (ms: number) =>
			tagTier(carrier({ lastSeenAt: ago(ms) }), none, NOW)
		expect(at(FLICKER_HOLD_MS)).toBe("active")
		expect(at(FLICKER_HOLD_MS + 1)).toBe("recent")
		// the hold is the proven one's only: 2 min ago is live for a proven tag, not for a guess
		expect(at(120_000)).toBe("recent")
		expect(tagTier(disc("p", { lastSeenAt: ago(120_000) }), none, NOW)).toBe(
			"active",
		)
	})

	it("a last-heard time beyond the clock's slack, or a malformed one, is never live", () => {
		expect(FUTURE_SLACK_MS).toBe(2 * TAG_CLOCK_MS)
		const ahead = (ms: number) =>
			tagTier(
				disc("f", { lastSeenAt: new Date(NOW + ms).toISOString() }),
				none,
				NOW,
			)
		expect(ahead(FUTURE_SLACK_MS)).toBe("active")
		expect(ahead(FUTURE_SLACK_MS + 1)).not.toBe("active")
		expect(tagTier(disc("bad", { lastSeenAt: "soon" }), none, NOW)).toBe(
			"older",
		)
		// active now is active whatever the timestamp says
		expect(
			tagTier(disc("bad", { lastSeenAt: "soon" }), new Set(["bad"]), NOW),
		).toBe("active")
	})

	// Feature: spectrum-tags, Property 1: a proven tag does not flash with its bursts
	// Validates: Requirements R3
	it("a proven tag heard within its hold is live whether or not a burst is on now; a guess follows its own hold", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						burst: fc.boolean(),
						ageMs: fc.integer({ min: 0, max: RECENT_MS }),
					}),
					{ minLength: 1, maxLength: 40 },
				),
				steps => {
					for (const { burst, ageMs } of steps) {
						const active = burst ? new Set(["p", "carrier"]) : none
						const p = disc("p", { lastSeenAt: ago(ageMs) })
						const u = carrier({ lastSeenAt: ago(ageMs) })
						const pLive = tagTier(p, active, NOW) === "active"
						const uLive = tagTier(u, active, NOW) === "active"
						expect(pLive).toBe(burst || ageMs <= PROVEN_LIVE_HOLD_MS)
						expect(uLive).toBe(burst || ageMs <= FLICKER_HOLD_MS)
					}
				},
			),
			{ numRuns: 100 },
		)
	})

	it("placed, a proven tag between bursts is live, solid and proven; the carrier is quiet and unidentified", () => {
		const tags = placeDiscoveryTags(
			[disc("p", { lastSeenAt: ago(150_000) }), carrier()],
			view,
			{ widthPx: 1000, activeNow: none, now: NOW },
		)
		expect(
			tags.map(t => [t.id, t.state, t.tier, t.solid, t.heard, t.name]),
		).toEqual([
			["p", "proven", "active", true, false, "DMR · CC 7"],
			["carrier", "heard", "active", false, true, "Unidentified · 4FSK ~9 kHz"],
		])
	})
})

describe("unidentified label", () => {
	it("names the measured shape and width", () => {
		expect(unidentifiedLabel(carrier())).toBe("Unidentified · 4FSK ~9 kHz")
		expect(tagName(carrier())).toBe("Unidentified · 4FSK ~9 kHz")
		// a class-like hint when the class is unknown
		expect(
			unidentifiedLabel(carrier({ class: "unknown", hint: "gmsk-narrow" })),
		).toBe("Unidentified · GMSK ~9 kHz")
		// a non-class hint or malformed fields say nothing they cannot back
		expect(
			unidentifiedLabel(
				carrier({ class: "unknown", hint: "lora", bandwidthHz: Number.NaN }),
			),
		).toBe("Unidentified")
		expect(
			unidentifiedLabel(
				carrier({ class: "weird" as unknown as "unknown", bandwidthHz: 0 }),
			),
		).toBe("Unidentified")
		expect(unidentifiedLabel(carrier({ anchor: "decode" }))).toBe(
			"Unidentified",
		)
		// an operator's label wins; DMR sync only keeps its "DMR?"
		expect(tagName(carrier({ operator: { label: "Mystery" } }))).toBe("Mystery")
		expect(
			tagName(
				carrier({ protocol: "dmr", family: "digital-voice", proof: undefined }),
			),
		).toBe("DMR?")
	})

	it("bandwidth words at and past each bound", () => {
		expect(approxBandwidth(0.4)).toBeNull()
		expect(approxBandwidth(-5)).toBeNull()
		expect(approxBandwidth("9000")).toBeNull()
		expect(approxBandwidth(999)).toBe("~999 Hz")
		expect(approxBandwidth(999.6)).toBe("~1 kHz")
		expect(approxBandwidth(1000)).toBe("~1 kHz")
		expect(approxBandwidth(12_500)).toBe("~13 kHz")
		expect(approxBandwidth(999_499)).toBe("~999 kHz")
		expect(approxBandwidth(999_500)).toBe("~1.0 MHz")
		expect(approxBandwidth(1_200_000)).toBe("~1.2 MHz")
	})

	it("the label cap holds the unidentified name whole (26 characters) and cuts at 28", () => {
		const px = (s: string) => [...s].length * 5.9
		expect(px("Unidentified · 4FSK ~9 kHz")).toBeLessThanOrEqual(
			DISCOVERY_TAG_MAX_LABEL_PX,
		)
		expect(px("x".repeat(27))).toBeLessThanOrEqual(DISCOVERY_TAG_MAX_LABEL_PX)
		expect(px("x".repeat(28))).toBeGreaterThan(DISCOVERY_TAG_MAX_LABEL_PX)
	})
})

describe("tag detail", () => {
	it("a proven control channel: how we know, and why it has no Activity rows", () => {
		const v = tagDetail(disc("p"), none, NOW)
		expect(v).toMatchObject({
			state: "proven",
			stateText: "Decoded",
			name: "DMR · CC 7",
			freq: "161.3125",
			howWeKnow: "DMR decoded: checked control bursts, colour code 7",
			coreSummary: "DMR decoded (CC7)",
			evidence: "Proven",
			firstSeen: "3 d ago",
			lastSeen: "60 s ago",
			airtime: "6 min",
			calls: false,
			noCalls: "No calls heard yet — control channel only",
			live: true,
		})
		expect(tagDetail(disc("p"), new Set(["p"]), NOW).lastSeen).toBe(
			"active now",
		)
	})

	it("calls heard: the Activity link instead of the no-calls line", () => {
		const v = tagDetail(
			disc("p", {
				metadata: {
					talkgroups: ["12"],
					sources: [],
					slots: [1],
					callsigns: [],
					capcodes: [],
					ismModels: [],
				},
				encrypted: true,
			}),
			none,
			NOW,
		)
		expect(v.howWeKnow).toBe(
			"DMR decoded: checked calls, colour code 7 (encrypted)",
		)
		expect(v.calls).toBe(true)
		expect(v.noCalls).toBeNull()
	})

	it("an unidentified carrier: not proven, weak, no calls line", () => {
		const v = tagDetail(carrier(), none, NOW)
		expect(v).toMatchObject({
			state: "heard",
			stateText: "Heard",
			name: "Unidentified · 4FSK ~9 kHz",
			howWeKnow: "Not proven: heard on the air, not identified",
			coreSummary: null,
			evidence: "Weak",
			calls: false,
			noCalls: null,
		})
	})

	it("weak digital voice says no calls without claiming a control channel; unknown fields stay modest", () => {
		const sync = disc("s", {
			confidence: "activity",
			evidenceLevel: "weak",
			proof: proof({
				kind: "digital-undecoded",
				summary: "Digital, DMR-like sync, not decoded",
			}),
		})
		const v = tagDetail(sync, none, NOW)
		expect(v.state).toBe("heard")
		expect(v.howWeKnow).toBe("Digital, DMR-like sync, not decoded")
		expect(v.coreSummary).toBeNull()
		expect(v.noCalls).toBe("No calls heard yet")
		const odd = tagDetail(
			disc("o", {
				evidenceLevel: undefined,
				proof: undefined,
				confidence: "candidate",
				airtimeMs: Number.NaN,
				firstSeenAt: "never",
			}),
			none,
			NOW,
		)
		expect(odd.evidence).toBe("Not reported")
		expect(odd.airtime).toBe("unknown")
		expect(odd.firstSeen).toBe("unknown")
		expect(odd.howWeKnow).toBe("Not proven: Maybe DMR from the signal's shape")
		expect(tagDetail(disc("z", { airtimeMs: 400 }), none, NOW).airtime).toBe(
			"under 1 s",
		)
	})

	it("analog and carrier-only proofs in words", () => {
		expect(
			howWeKnow(
				disc("a", {
					protocol: "analog-fm",
					family: "analog",
					proof: proof({
						kind: "analog-tone",
						protocol: "analog-fm",
						summary: "Analog FM, CTCSS 77.0",
					}),
				}),
			),
		).toBe("Heard as Analog FM, CTCSS 77.0")
		expect(
			howWeKnow(
				carrier({
					proof: proof({ kind: "carrier-only", protocol: "carrier" }),
				}),
			),
		).toBe("Only a carrier: nothing to decode yet")
	})
})

describe("tag popover layout", () => {
	const css = readFileSync(
		new URL("../../src/plot/discovery-tags.css", import.meta.url),
		"utf8",
	)
	const rule = (sel: string) => {
		const m = new RegExp(
			`\\n\\s*${sel.replace(/\./g, "\\.")} \\{([^}]*)\\}`,
		).exec(css)
		expect(m, sel).not.toBeNull()
		return m?.[1] ?? ""
	}

	it("scrolls a single discovery's detail inside the popover's height cap, like a group's list", () => {
		expect(rule(".wk-plot-disc-pop")).toMatch(/max-height:\s*280px/)
		const detail = rule(".wk-plot-disc-detail")
		expect(detail).toMatch(/overflow-y:\s*auto/)
		expect(detail).toMatch(/min-height:\s*0/)
		expect(rule(".wk-plot-disc-pop-list")).toMatch(/overflow-y:\s*auto/)
	})
})

describe("tag popover Listen", () => {
	function fakeListen(wanted = false) {
		const calls: string[] = []
		const listen = {
			wanted,
			get: () => ({ wanted: listen.wanted }),
			start: () => {
				calls.push("start")
				listen.wanted = true
				return Promise.resolve()
			},
		}
		return { listen, calls }
	}

	it("starts audio only once the tune has landed, never before", async () => {
		const { listen, calls } = fakeListen()
		let land: (ok: boolean) => void = () => undefined
		const tune = (hz: number) => {
			calls.push(`tune ${hz}`)
			return new Promise<boolean>(resolve => {
				land = resolve
			})
		}
		const done = listenAfterTune(161_312_500, tune, listen)
		await Promise.resolve()
		await Promise.resolve()
		// a slow tune: nothing plays yet (it would be the previous frequency)
		expect(calls).toEqual(["tune 161312500"])
		land(true)
		expect(await done).toBe(true)
		expect(calls).toEqual(["tune 161312500", "start"])
	})

	it("never plays when the tune fails or is superseded", async () => {
		const { listen, calls } = fakeListen()
		expect(
			await listenAfterTune(1e8, () => Promise.resolve(false), listen),
		).toBe(false)
		expect(calls).toEqual([])
	})

	it("leaves audio already on alone: it follows the tune", async () => {
		const { listen, calls } = fakeListen(true)
		expect(
			await listenAfterTune(1e8, () => Promise.resolve(true), listen),
		).toBe(true)
		expect(calls).toEqual([])
	})

	it("is what the popover's Listen runs", () => {
		const src = readFileSync(
			new URL("../../src/plot/DiscoveryTags.tsx", import.meta.url),
			"utf8",
		)
		expect(src).toContain("listenAfterTune(hz,")
		expect(src).not.toMatch(/void services\.listen\.start\(\)/)
	})
})
