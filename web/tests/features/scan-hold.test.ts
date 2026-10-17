import { describe, expect, it } from "vitest"
import type { Discovery, ScanJob } from "@wavekit/api-types"

import {
	followingText,
	heldDiscoveryId,
	holdRowModel,
	holdSaveName,
	skipPatch,
	sweepLive,
	sweepMoving,
	type HoldRowInput,
} from "../../src/features/tuner/scan-hold.ts"

/** Discovery fields to override; `undefined` removes an optional one. */
type Over = { [K in keyof Discovery]?: Discovery[K] | undefined }

const NOW = Date.parse("2026-10-17T08:00:00.000Z")

function hop(index: number, startHz: number, endHz: number) {
	return {
		index,
		centreHz: (startHz + endHz) / 2,
		covered: { startHz, endHz },
		channelCount: 10,
		dcAdjacentChannelsHz: [],
		excluded: [],
		dcMinEdgeHz: 0,
	}
}

function job(over: Partial<ScanJob> = {}, hops = 4): ScanJob {
	return {
		resumeAt: null,
		resumeHeldBy: null,
		id: "j1",
		name: "Land mobile + Marine",
		state: "running",
		passive: false,
		spec: {
			kind: "discover",
			mode: "sweep",
			exclusions: [],
		} as unknown as ScanJob["spec"],
		plan: {
			hops: Array.from({ length: hops }, (_, i) =>
				hop(i, 146e6 + i * 2e6, 148e6 + i * 2e6),
			),
			usableHalfSpanHz: 1e6,
			dcGuardHz: 10_000,
			ppmMarginHz: 0,
		},
		issues: [],
		impact: null,
		unrestorable: [],
		progress: {
			sweepIndex: 1,
			hopIndex: 2,
			hopCount: hops,
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
		createdAt: "2026-10-17T07:00:00.000Z",
		updatedAt: "2026-10-17T07:00:00.000Z",
		...over,
	}
}

function discovery(over: Over = {}): Discovery {
	const stats = { peakDbfs: -40, meanDbfs: -50, snrDb: 20, floorDbfs: -70 }
	const d = {
		id: "d1",
		frequencyHz: 161_150_000,
		frequencyKey: "161150000",
		measuredOffsetHz: 0,
		bandwidthHz: 12_500,
		protocol: "dmr",
		family: "digital-voice",
		class: "fsk4-12k5",
		confidence: "decoded",
		identity: { kind: "dmr-cc", value: "1" },
		encrypted: false,
		coChannel: [],
		firstSeenAt: "2026-10-17T07:00:00.000Z",
		lastSeenAt: "2026-10-17T07:59:00.000Z",
		observationCount: 1,
		airtimeMs: 1000,
		signal: { best: stats, last: stats },
		metadata: {
			talkgroups: [],
			sources: [],
			slots: [],
			callsigns: [],
			capcodes: [],
			ismModels: [],
		},
		sourceIds: ["pi"],
		jobIds: ["j1"],
		tuningTrust: "commanded",
		evidence: { recordings: 0, psd: false, iq: false },
		...over,
	} as Discovery
	for (const k of Object.keys(over) as (keyof Discovery)[])
		if (over[k] === undefined) delete d[k]
	return d
}

const input = (over: Partial<HoldRowInput> = {}): HoldRowInput => ({
	job: job(),
	progress: null,
	now: NOW,
	heldHz: null,
	held: null,
	saved: false,
	consent: null,
	...over,
})

const ids = (m: { actions: { id: string }[] }) => m.actions.map(a => a.id)

describe("scan hold row", () => {
	it("a running sweep: phosphor, name, current frequency, pass line, Pause and Stop", () => {
		const m = holdRowModel(
			input({
				progress: {
					sweepIndex: 1,
					hopIndex: 1,
					hopCount: 4,
					centerHz: 149_000_000,
				},
			}),
		)
		expect(m).toMatchObject({
			tone: "live",
			pulse: false,
			glyph: "scan",
			title: "Land mobile + Marine",
			detail: "",
			freq: "149.000",
			bar: 0.5,
		})
		expect(ids(m)).toEqual(["pause", "stop"])
		// no hop counts on the row; the tooltip tells how it moves
		expect(m.title + m.detail).not.toMatch(/hop/)
		expect(m.tooltip).toContain("Pass 2 · hop 2/4")
		expect(m.aria).toBe("Land mobile + Marine · 149.000. Open the scan plan")
	})

	it("falls back to the job's own progress before the first progress event", () => {
		const m = holdRowModel(input())
		expect(m.freq).toBe("151.000") // hop 2's centre
		expect(m.bar).toBe(0.75)
	})

	it("a one-hop plan watches the band: eye, no moving frequency, no progress line", () => {
		const m = holdRowModel(input({ job: job({ name: "PMR446" }, 1) }))
		expect(m).toMatchObject({
			glyph: "eye",
			title: "Watching PMR446",
			freq: "146.000–148.000",
			bar: null,
		})
	})

	it("starting has Stop only", () => {
		const m = holdRowModel(input({ job: job({ state: "starting" }) }))
		expect(m.detail).toBe(" · starting")
		expect(ids(m)).toEqual(["stop"])
	})

	it("holding on a hit pulses and offers Skip, Ignore, Save, Stop", () => {
		const m = holdRowModel(
			input({
				job: job({ state: "holding" }),
				heldHz: 161_150_000,
				held: discovery(),
			}),
		)
		expect(m).toMatchObject({
			tone: "live",
			pulse: true,
			title: "Hearing DMR · CC 1",
			freq: "161.150",
		})
		expect(ids(m)).toEqual(["skip", "ignore", "save", "stop"])
		expect(m.actions.find(a => a.id === "save")?.pressed).toBe(false)
		const saved = holdRowModel(
			input({
				job: job({ state: "holding" }),
				heldHz: 161_150_000,
				held: discovery(),
				saved: true,
			}),
		)
		expect(saved.actions.find(a => a.id === "save")).toMatchObject({
			pressed: true,
			aria: "Saved",
		})
	})

	it("a hit only heard (no protocol yet) reads Hearing activity", () => {
		const heard = discovery({
			confidence: "activity",
			protocol: "unknown",
			identity: undefined,
		})
		const m = holdRowModel(
			input({
				job: job({ state: "holding" }),
				heldHz: 162_400_000,
				held: heard,
			}),
		)
		expect(m.title).toBe("Hearing activity")
		expect(m.freq).toBe("162.400")
		expect(
			followingText(job({ state: "holding" }), 162_400_000, heard).text,
		).toBe("162.400")
	})

	it("holding before the discovery is known says where it holds", () => {
		const m = holdRowModel(
			input({ job: job({ state: "holding" }), heldHz: 146_962_500 }),
		)
		expect(m.title).toBe("Held on 146.9625")
		expect(m.freq).toBeNull()
		const unknown = holdRowModel(input({ job: job({ state: "holding" }) }))
		expect(unknown.title).toBe("Holding")
	})

	it("paused because you tuned: amber, countdown, Stay here and Resume now", () => {
		const m = holdRowModel(
			input({
				job: job({
					state: "paused",
					reason: "preempted-operator",
					resumeAt: new Date(NOW + 42_000).toISOString(),
				}),
			}),
		)
		expect(m).toMatchObject({
			tone: "paused",
			glyph: "pause",
			title: "Scan paused",
			detail: " · resumes in 42 s",
		})
		// the row is short of room with three buttons: who tuned is in the tooltip and the name
		expect(m.tooltip).toMatch(/^Scan paused · you tuned · resumes in 42 s/)
		expect(m.aria).toMatch(/^Scan paused · you tuned · resumes in 42 s/)
		expect(m.actions.map(a => a.label)).toEqual(["Stay here", "Resume now", ""])
		expect(ids(m)).toEqual(["stay", "resume", "stop"])
		expect(m.bar).toBe(0.75)
	})

	it("paused by the operator: Scan paused with Resume", () => {
		const m = holdRowModel(
			input({ job: job({ state: "paused", reason: "operator" }) }),
		)
		expect(m.title).toBe("Scan paused")
		expect(ids(m)).toEqual(["resume", "stop"])
	})

	it("paused by another scan or a dead source: Stop only", () => {
		const other = holdRowModel(
			input({
				job: job({
					state: "paused",
					reason: "preempted-job",
					preemptedBy: { jobId: "j2", name: "Marine VHF" },
				}),
			}),
		)
		expect(other.title).toBe("Paused by Marine VHF")
		expect(ids(other)).toEqual(["stop"])
		const down = holdRowModel(
			input({ job: job({ state: "paused", reason: "source-down" }) }),
		)
		expect(down).toMatchObject({ glyph: "plug", title: "Source down" })
	})

	it("asks for consent when resuming would pause decoders", () => {
		const m = holdRowModel(
			input({
				job: job({ state: "paused", reason: "operator" }),
				consent: ["APRS"],
			}),
		)
		expect(m).toMatchObject({ glyph: "warn", title: "Resume needs your OK" })
		expect(m.actions[0]).toMatchObject({
			id: "takeover",
			label: "Resume and pause APRS",
		})
		const many = holdRowModel(
			input({
				job: job({ state: "paused", reason: "operator" }),
				consent: ["APRS", "AIS", "Pager", "ADS-B"],
			}),
		)
		expect(many.actions[0]?.label).toBe("Resume and pause APRS, AIS +2")
	})

	it("read-only access only reports", () => {
		expect(holdRowModel(input({ readOnly: true })).actions).toEqual([])
	})
})

describe("scan hold helpers", () => {
	it("sweepMoving and sweepLive", () => {
		expect(sweepMoving("running")).toBe(true)
		expect(sweepMoving("starting")).toBe(true)
		expect(sweepMoving("holding")).toBe(false)
		expect(sweepMoving(undefined)).toBe(false)
		expect(sweepLive("holding")).toBe(true)
		expect(sweepLive("paused")).toBe(false)
	})

	it("heldDiscoveryId picks the job's active observation nearest the held frequency", () => {
		const a = (over: object) => ({
			discoveryId: "x",
			jobIds: ["j1"],
			frequencyHz: 161_150_000,
			peakDbfs: -50,
			active: true,
			...over,
		})
		const activity = [
			a({ discoveryId: "far", frequencyHz: 162e6, peakDbfs: -10 }),
			a({ discoveryId: "near", frequencyHz: 161_150_100 }),
			a({ discoveryId: "other-job", jobIds: ["j9"], frequencyHz: 161_150_000 }),
			a({ discoveryId: "ended", active: false, frequencyHz: 161_150_000 }),
			a({ discoveryId: undefined, frequencyHz: 161_150_000 }),
		]
		expect(heldDiscoveryId({ id: "j1" }, activity, 161_150_000)).toBe("near")
		// without a frequency, the strongest
		expect(heldDiscoveryId({ id: "j1" }, activity, null)).toBe("far")
		expect(heldDiscoveryId({ id: "j1" }, [], 1)).toBeNull()
	})

	it("skipPatch adds the held channel to the job's exclusions once", () => {
		const j = job()
		const p = skipPatch(j, 161_150_000, 12_500)
		expect(p).toEqual({
			exclusions: [
				{ startHz: 161_143_750, endHz: 161_156_250, reason: "Skipped" },
			],
		})
		const again = skipPatch(
			job({ spec: { ...j.spec, exclusions: p.exclusions ?? [] } }),
			161_150_000,
			12_500,
		)
		expect(again.exclusions).toHaveLength(1)
	})

	it("followingText names the hit, a one-hop watch, or the scan", () => {
		expect(followingText(job(), null, null).text).toBe("Following the scan")
		expect(followingText(job({}, 1), null, null).text).toBe(
			"Waits for a channel",
		)
		expect(
			followingText(job({ state: "holding" }), 161_150_000, discovery()).text,
		).toBe("DMR · CC 1")
		expect(
			followingText(job({ state: "holding" }), 146_962_500, null).text,
		).toBe("146.9625")
	})

	it("holdSaveName prefers the label, then a named title, then the fallback", () => {
		expect(holdSaveName(null, "Saved 161.150")).toBe("Saved 161.150")
		expect(holdSaveName(discovery(), "x")).toBe("DMR · CC 1")
		expect(
			holdSaveName(discovery({ operator: { label: "Port ops" } }), "x"),
		).toBe("Port ops")
		expect(
			holdSaveName(
				discovery({ confidence: "activity", identity: undefined }),
				"Marine ch 16",
			),
		).toBe("Marine ch 16")
	})
})
