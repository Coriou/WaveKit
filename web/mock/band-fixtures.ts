// Band inspection UX fixtures (docs/specs/2026-10-25-band-inspection-ux.md, "Mock fixtures"): extra
// discoveries seeded when WAVEKIT_MOCK_BAND_FIXTURES=1 (or `bandFixtures: true` in buildMockServer):
//
// - stacked: five discoveries within 433.915-433.935 MHz (decoded, tentative, a weak one hinted
//   "ism-device", one with an operator label) plus one at 433.980, and a dense run 25 kHz apart from
//   434.400 (just under 19 px at the mock's 1.92 MHz view on a 1440 px plot: unbounded chaining);
// - nearby-off-screen: tuned to 433.92 MHz the mock shows 432.96-434.88 MHz; one discovery at 432.900
//   and three past 434.880 sit inside the fetched half-view margins ("1 ←", "3 →");
// - stale-cache: three discoveries at 145.500 MHz, loaded while tuned there; after a retune to
//   433.92 MHz none may be drawn (the left-edge regression);
// - hints: weak discoveries at PMR446 with every hint value plus an unknown and a malformed one, and
//   every coverage variant (absent, [], running, each named suspension, an unknown reason and state).
//
// Type stripping only: no enums, parameter properties or namespaces.
import type {
	Discovery,
	DiscoveryCoverage,
	ProtocolFamily,
	ScannerClass,
	ScannerConfidence,
	ScannerProtocol,
} from "@wavekit/api-types"

export interface FixtureSpec {
	id: string
	mhz: number
	protocol: ScannerProtocol
	family: ProtocolFamily
	class: ScannerClass
	confidence: ScannerConfidence
	bandwidthHz?: number
	agoMin: number
	label?: string
	identity?: Discovery["identity"]
	/** Any value: unknown and malformed hints are part of the fixture. */
	hint?: unknown
	/** Any value: unknown states and reasons are part of the fixture; undefined leaves it absent. */
	coverage?: unknown
}

const weak = (
	id: string,
	mhz: number,
	agoMin: number,
	extra: Partial<FixtureSpec> = {},
): FixtureSpec => ({
	id,
	mhz,
	protocol: "unknown",
	family: "unknown",
	class: "unknown",
	confidence: "activity",
	agoMin,
	...extra,
})

const running = (decoderId: string): DiscoveryCoverage => ({
	decoderId,
	state: "running",
})
const suspended = (decoderId: string, reason: string): unknown => ({
	decoderId,
	state: "suspended",
	suspensionReason: reason,
})

export const BAND_FIXTURE_SPECS: readonly FixtureSpec[] = [
	// stacked
	{
		id: "bf-stack-1",
		mhz: 433.915,
		protocol: "ism",
		family: "ism",
		class: "ook-burst",
		confidence: "decoded",
		identity: { kind: "ism-model", value: "Acurite-Tower" },
		agoMin: 1,
	},
	{
		id: "bf-stack-2",
		mhz: 433.92,
		protocol: "ism",
		family: "ism",
		class: "ook-burst",
		confidence: "candidate",
		agoMin: 3,
		coverage: [running("rtl433")],
	},
	weak("bf-stack-3", 433.922, 5, {
		hint: "ism-device",
		coverage: [running("rtl433")],
	}),
	{
		id: "bf-stack-4",
		mhz: 433.925,
		protocol: "ism",
		family: "ism",
		class: "ook-burst",
		confidence: "classified",
		agoMin: 12,
		label: "Garage door",
	},
	weak("bf-stack-5", 433.935, 30, { hint: "ism-device" }),
	weak("bf-stack-6", 433.98, 8, { hint: "ook-burst", coverage: [] }),
	...[0, 1, 2, 3, 4, 5, 6].map(k =>
		weak(`bf-dense-${k}`, 434.4 + k * 0.025, 20 + k, { hint: "ism-device" }),
	),
	// nearby-off-screen
	weak("bf-near-left", 432.9, 4, { hint: "lora" }),
	weak("bf-near-right-1", 434.9, 6, { hint: "ism-device" }),
	weak("bf-near-right-2", 435.05, 9),
	{
		id: "bf-near-right-3",
		mhz: 435.3,
		protocol: "aprs",
		family: "packet",
		class: "afsk-fm",
		confidence: "decoded",
		identity: { kind: "aprs-call", value: "F4ABC-9" },
		agoMin: 2,
	},
	// bookmark: six discoveries within 5 kHz of a saved frequency (BAND_FIXTURE_BOOKMARK) under live bursts
	weak("bf-mark-1", 434.7015, 1, { hint: "ism-device" }),
	weak("bf-mark-2", 434.7025, 2, { hint: "ism-device" }),
	weak("bf-mark-3", 434.704, 3),
	weak("bf-mark-4", 434.705, 4, { hint: "ism-device" }),
	weak("bf-mark-5", 434.7065, 6, { hint: "ism-device" }),
	weak("bf-mark-6", 434.7085, 9),
	// stale-cache
	{
		id: "bf-stale-1",
		mhz: 145.5,
		protocol: "analog-fm",
		family: "analog",
		class: "analog-fm",
		confidence: "classified",
		agoMin: 2,
		label: "Calling channel",
	},
	weak("bf-stale-2", 145.5125, 7, { hint: "analog-voice" }),
	weak("bf-stale-3", 145.525, 40, { hint: "analog-fm" }),
	// hints and coverage (PMR446)
	weak("bf-hint-voice", 446.00625, 1, { hint: "analog-voice", coverage: [] }),
	weak("bf-hint-ism", 446.01875, 2, {
		hint: "ism-device",
		coverage: [suspended("rtl433", "frequency-out-of-band")],
	}),
	weak("bf-hint-lora", 446.03125, 3, {
		hint: "lora",
		coverage: [suspended("lora-meshtastic", "capture-too-narrow")],
	}),
	weak("bf-hint-class", 446.04375, 4, {
		hint: "fsk2-wide",
		coverage: [suspended("multimon-ng", "no-channel-selected")],
	}),
	weak("bf-hint-unknown", 446.05625, 5, {
		hint: "sub-ghz-warble",
		coverage: [suspended("dsd-fme", "some-future-reason")],
	}),
	weak("bf-hint-malformed", 446.06875, 6, {
		hint: 42,
		coverage: [{ decoderId: "dsd-fme", state: "hibernating" }],
	}),
	weak("bf-hint-none", 446.08125, 7, { coverage: [] }),
	weak("bf-hint-stopped", 446.09375, 8, {
		hint: "analog-voice",
		coverage: [{ decoderId: "dsd-fme", state: "stopped" }],
	}),
	weak("bf-hint-absent", 446.10625, 9, { hint: "analog-voice" }),
]

/** The saved frequency of the "bookmark" fixture (a neutral name). */
export const BAND_FIXTURE_BOOKMARK = {
	name: "Test cluster",
	frequencyHz: 434_705_000,
	mode: "nfm",
	bandwidthHz: 12_500,
	tone: { kind: "none" },
	group: "Fixtures",
} as const

const stats = (dbfs: number) => ({
	peakDbfs: dbfs,
	meanDbfs: dbfs - 4,
	snrDb: dbfs + 100,
	floorDbfs: -100,
})

/** The fixtures (or other `specs`) as discoveries on `sourceId`, timed against `now`. */
export function bandFixtureDiscoveries(
	sourceId: string,
	now: number,
	specs: readonly FixtureSpec[] = BAND_FIXTURE_SPECS,
): Discovery[] {
	return specs.map((s, i) => {
		const hz = Math.round(s.mhz * 1e6)
		const last = now - s.agoMin * 60_000
		const d: Discovery = {
			id: s.id,
			frequencyHz: hz,
			frequencyKey: `r:${hz}`,
			measuredOffsetHz: 0,
			bandwidthHz: s.bandwidthHz ?? 12_500,
			protocol: s.protocol,
			family: s.family,
			class: s.class,
			confidence: s.confidence,
			encrypted: false,
			coChannel: [],
			firstSeenAt: new Date(last - 86_400_000 - i * 60_000).toISOString(),
			lastSeenAt: new Date(last).toISOString(),
			observationCount: 3 + i,
			airtimeMs: 1500 * (3 + i),
			signal: { best: stats(-52 - i), last: stats(-56 - i) },
			metadata: {
				talkgroups: [],
				sources: [],
				slots: [],
				callsigns: [],
				capcodes: [],
				ismModels: [],
			},
			sourceIds: [sourceId],
			jobIds: [`passive-${sourceId}`],
			tuningTrust: "commanded",
			evidence: { recordings: 0, psd: true, iq: false },
		}
		if (s.identity) d.identity = { ...s.identity }
		if (s.label) d.operator = { label: s.label }
		// deliberately loose: the fixture serves unknown and malformed values as a newer core might
		const loose = d as unknown as Record<string, unknown>
		if (s.hint !== undefined) loose["hint"] = s.hint
		if (s.coverage !== undefined)
			loose["coverage"] = structuredClone(s.coverage)
		return d
	})
}

/** WAVEKIT_MOCK_ACTIVITY_429 values: the Retry-After the mock sends on every other Activity read. */
export type Activity429Mode = "1" | "30" | "date" | "malformed"

export function isActivity429Mode(v: string | undefined): v is Activity429Mode {
	return v === "1" || v === "30" || v === "date" || v === "malformed"
}

/** The Retry-After header value for `mode` at `now`: seconds, an HTTP date 2 s ahead, or garbage. */
export function activity429RetryAfter(
	mode: Activity429Mode,
	now: number,
): string {
	if (mode === "date") return new Date(now + 2000).toUTCString()
	if (mode === "malformed") return "soon-ish"
	return mode
}
