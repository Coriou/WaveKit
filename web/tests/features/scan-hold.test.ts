import { describe, expect, it } from "vitest"
import type { Discovery, ScanJob } from "@wavekit/api-types"

import { ApiError } from "../../src/data/api-client.ts"
import { decoderLabel } from "../../src/features/tuned/signal.ts"
import {
	consentNames,
	decoderNamer,
	followingText,
	heldDiscoveryId,
	holdRowModel,
	holdSaveName,
	latestRequest,
	resumeApproved,
	resumeRefusal,
	resumeWithConsent,
	scanResumable,
	skipPatch,
	skipState,
	sweepLive,
	unskipPatch,
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
	decoderName: id => id.toUpperCase(),
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

	it("held after a plain resume of the receiver: says so, with Resume scan", () => {
		const m = holdRowModel(
			input({
				job: job({ state: "paused", reason: "resumed-without-retune" }),
			}),
		)
		expect(m).toMatchObject({ tone: "paused", title: "Scan paused" })
		expect(m.detail).toBe(" · receiver resumed without retuning")
		expect(ids(m)).toEqual(["resume", "stop"])
		expect(m.actions[0]).toMatchObject({
			label: "Resume scan",
			kind: "primary",
			title: "Retunes the receiver to the scan's current hop",
		})
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
		// no dead button: each says what it waits for
		expect(other.detail).toBe(" · carries on when it ends")
		expect(down.detail).toBe(" · carries on when it returns")
		expect(ids(down)).toEqual(["stop"])
	})

	it("blocked by someone new on the receiver: says so, with a Resume that asks first", () => {
		const m = holdRowModel(
			input({ job: job({ state: "paused", reason: "resume-blocked" }) }),
		)
		expect(m).toMatchObject({
			tone: "paused",
			title: "Scan paused",
			detail: " · someone else is using the receiver",
		})
		expect(ids(m)).toEqual(["resume", "stop"])
		expect(m.actions[0]?.label).toBe("Resume")
	})

	it("blocked with someone named: the first button already says who it interrupts, under the same words", () => {
		const blocked = job({
			state: "paused",
			reason: "resume-blocked",
			impact: {
				liveAudioClients: 1,
				digitalVoiceListeners: 0,
				runningDecoders: ["aprs"],
				pinnedDecoders: [],
				scannerJobs: [],
				unrestorable: [],
			},
		})
		const m = holdRowModel(input({ job: blocked }))
		expect(m).toMatchObject({
			glyph: "pause",
			title: "Scan paused",
			detail: " · someone else is using the receiver",
		})
		expect(m.actions[0]).toMatchObject({
			id: "takeover",
			label: "Resume and interrupt 1 listener, APRS",
		})
	})

	it("blocked by what cannot be named reads plain Resume", () => {
		const m = holdRowModel(
			input({
				job: job({
					state: "paused",
					reason: "resume-blocked",
					impact: {
						liveAudioClients: 0,
						digitalVoiceListeners: 0,
						runningDecoders: [],
						pinnedDecoders: [],
						scannerJobs: [],
						unrestorable: ["gain"],
					},
				}),
			}),
		)
		expect(m.actions[0]).toMatchObject({ id: "resume", label: "Resume" })
	})

	it("every paused reason has a working way on, or says what it waits for", () => {
		for (const reason of [
			"operator",
			"preempted-operator",
			"preempted-relay",
			"preempted-job",
			"source-down",
			"core-restart",
			"resume-blocked",
			"resumed-without-retune",
		] as const) {
			const j = job({ state: "paused", reason })
			const m = holdRowModel(input({ job: j }))
			expect(ids(m).includes("resume")).toBe(scanResumable(j))
			if (!scanResumable(j)) expect(m.detail).toContain("carries on when")
		}
	})

	it("asks for consent when resuming would interrupt someone", () => {
		const m = holdRowModel(
			input({
				job: job({ state: "paused", reason: "operator" }),
				consent: ["APRS"],
			}),
		)
		expect(m).toMatchObject({ glyph: "warn", title: "Resume needs your OK" })
		expect(m.actions[0]).toMatchObject({
			id: "takeover",
			label: "Resume and interrupt APRS",
		})
		const many = holdRowModel(
			input({
				job: job({ state: "paused", reason: "operator" }),
				consent: ["APRS", "AIS", "Pager", "ADS-B"],
			}),
		)
		expect(many.actions[0]?.label).toBe("Resume and interrupt APRS, AIS +2")
	})

	it("read-only access only reports", () => {
		expect(holdRowModel(input({ readOnly: true })).actions).toEqual([])
	})
})

describe("resume refusals", () => {
	const none = {
		liveAudioClients: 0,
		digitalVoiceListeners: 0,
		runningDecoders: [],
		pinnedDecoders: [],
		scannerJobs: [],
		unrestorable: [],
	}
	const name = (id: string) => id.toUpperCase()

	it("names listeners, decoders once and other scans", () => {
		expect(
			consentNames(
				{
					...none,
					liveAudioClients: 1,
					digitalVoiceListeners: 2,
					runningDecoders: ["aprs", "ais"],
					pinnedDecoders: ["ais"],
					scannerJobs: ["j2"],
				},
				name,
			),
		).toEqual([
			"1 listener",
			"2 digital voice listeners",
			"APRS",
			"AIS",
			"another scan",
		])
		expect(consentNames(none, name)).toEqual([])
	})

	it("a listener alone is named on the confirm", () => {
		const m = holdRowModel(
			input({
				job: job({ state: "paused", reason: "resume-blocked" }),
				consent: consentNames({ ...none, liveAudioClients: 1 }, name),
			}),
		)
		expect(m.actions[0]).toMatchObject({
			id: "takeover",
			label: "Resume and interrupt 1 listener",
			title: "Resumes the scan. 1 listener stop until the scan ends.",
		})
	})

	it("a 409 takeover-required asks; any other refusal says the core's words", () => {
		const asked = new ApiError({
			status: 409,
			code: "SCANNER_TAKEOVER_REQUIRED",
			message: "Resuming interrupts 1 live audio listener",
			body: { details: { impact: { ...none, liveAudioClients: 1 } } },
			method: "POST",
			path: "/api/scanner/jobs/j1/resume",
		})
		expect(resumeRefusal(asked, name)).toEqual({
			kind: "consent",
			names: ["1 listener"],
		})
		expect(resumeRefusal(new Error("Stop that job"), name)).toEqual({
			kind: "error",
			message: "Stop that job",
		})
	})
})

describe("one click on Resume", () => {
	const none = {
		liveAudioClients: 0,
		digitalVoiceListeners: 0,
		runningDecoders: [],
		pinnedDecoders: [],
		scannerJobs: [],
		unrestorable: [],
	}
	const takeoverRequired = (impact: object) =>
		new ApiError({
			status: 409,
			code: "SCANNER_TAKEOVER_REQUIRED",
			message: "Resuming interrupts someone",
			body: { details: { impact: { ...none, ...impact } } },
			method: "POST",
			path: "/api/scanner/jobs/j1/resume",
		})
	const busy = new ApiError({
		status: 409,
		code: "SCANNER_SOURCE_BUSY",
		message: "Lease held by scanner job j2",
		body: {},
		method: "POST",
		path: "/api/scanner/jobs/j1/resume",
	})

	/** A fake resume answering each call in turn (an Error rejects), and what it was sent. */
	function fake(...answers: (Error | "ok")[]) {
		const calls: { id: string; takeover: boolean }[] = []
		return {
			calls,
			resume: async (id: string, options: { takeover?: boolean }) => {
				calls.push({ id, takeover: options.takeover === true })
				const answer = answers.shift()
				if (answer instanceof Error) throw answer
				return answer
			},
		}
	}
	const click = (
		approved: readonly string[] | null,
		resume: (id: string, options: { takeover?: boolean }) => Promise<unknown>,
		current: () => boolean = () => true,
	) =>
		resumeWithConsent({
			jobId: "j1",
			approved,
			resume,
			decoderName: id => id.toUpperCase(),
			current,
		})
	const PLAIN = { id: "j1", takeover: false }
	const TAKEOVER = { id: "j1", takeover: true }

	it("the people the button named: plain, then a takeover in the same click", async () => {
		const f = fake(takeoverRequired({ liveAudioClients: 1 }), "ok")
		expect(await click(["1 listener"], f.resume)).toEqual({ kind: "resumed" })
		expect(f.calls).toEqual([PLAIN, TAKEOVER])
	})

	it("a plain success never sends a takeover", async () => {
		const f = fake("ok")
		expect(await click(["1 listener"], f.resume)).toEqual({ kind: "resumed" })
		expect(f.calls).toEqual([PLAIN])
	})

	it("someone the button did not name: no takeover, and the confirm names them", async () => {
		const f = fake(
			takeoverRequired({ liveAudioClients: 1, runningDecoders: ["aprs"] }),
		)
		expect(await click(["1 listener"], f.resume)).toEqual({
			kind: "confirm",
			names: ["1 listener", "APRS"],
		})
		expect(f.calls).toEqual([PLAIN])
	})

	it("one more listener is someone new", async () => {
		const f = fake(takeoverRequired({ liveAudioClients: 2 }))
		expect(await click(["1 listener"], f.resume)).toEqual({
			kind: "confirm",
			names: ["2 listeners"],
		})
		expect(f.calls).toEqual([PLAIN])
	})

	it("a confirm click checks again and refuses a further newcomer, then goes through on the next", async () => {
		const first = fake(takeoverRequired({ runningDecoders: ["aprs"] }))
		const asked = await click(null, first.resume)
		expect(asked).toEqual({ kind: "confirm", names: ["APRS"] })
		expect(first.calls).toEqual([PLAIN])

		const impact = { runningDecoders: ["aprs", "ais"] }
		const second = fake(takeoverRequired(impact))
		const again = await click(["APRS"], second.resume)
		expect(again).toEqual({ kind: "confirm", names: ["APRS", "AIS"] })
		expect(second.calls).toEqual([PLAIN])

		const third = fake(takeoverRequired(impact), "ok")
		expect(await click(["APRS", "AIS"], third.resume)).toEqual({
			kind: "resumed",
		})
		expect(third.calls).toEqual([PLAIN, TAKEOVER])
	})

	it("a plain Resume agrees to nothing, even a refusal that names nobody", async () => {
		const f = fake(takeoverRequired({ unrestorable: ["gain"] }))
		expect(await click(null, f.resume)).toEqual({ kind: "confirm", names: [] })
		expect(f.calls).toEqual([PLAIN])
	})

	it("Resume anyway agrees to a refusal that names nobody, and to no more than that", async () => {
		const asked = takeoverRequired({ unrestorable: ["gain"] })
		const f = fake(asked, "ok")
		expect(await click([], f.resume)).toEqual({ kind: "resumed" })
		expect(f.calls).toEqual([PLAIN, TAKEOVER])

		const more = fake(takeoverRequired({ liveAudioClients: 1 }))
		expect(await click([], more.resume)).toEqual({
			kind: "confirm",
			names: ["1 listener"],
		})
		expect(more.calls).toEqual([PLAIN])
	})

	it("a button that named someone does not agree to a refusal that names nobody", async () => {
		const f = fake(takeoverRequired({ unrestorable: ["gain"] }))
		expect(await click(["1 listener"], f.resume)).toEqual({
			kind: "confirm",
			names: [],
		})
		expect(f.calls).toEqual([PLAIN])
	})

	it("a busy refusal says the core's words, on the plain request and on the takeover", async () => {
		const plain = fake(busy)
		expect(await click(["1 listener"], plain.resume)).toEqual({
			kind: "error",
			message: "Lease held by scanner job j2",
		})
		expect(plain.calls).toEqual([PLAIN])

		const late = fake(takeoverRequired({ liveAudioClients: 1 }), busy)
		expect(await click(["1 listener"], late.resume)).toEqual({
			kind: "error",
			message: "Lease held by scanner job j2",
		})
		expect(late.calls).toEqual([PLAIN, TAKEOVER])
	})

	it("a request superseded while it waits shows nothing and sends no takeover", async () => {
		const requests = latestRequest()
		const current = requests.begin()
		const f = fake(takeoverRequired({ liveAudioClients: 1 }))
		const pending = click(["1 listener"], f.resume, current)
		requests.cancel()
		expect(await pending).toEqual({ kind: "superseded" })
		expect(f.calls).toEqual([PLAIN])
	})

	it("a response that lands after a newer request is ignored, whatever it says", async () => {
		const requests = latestRequest()
		const old = requests.begin()
		const f = fake("ok")
		const pending = click(null, f.resume, old)
		const newer = requests.begin()
		expect(await pending).toEqual({ kind: "superseded" })
		expect(newer()).toBe(true)
		expect(old()).toBe(false)
	})

	it("the approved list is the confirm's names, else a blocked job's, else nothing", () => {
		const name = (id: string) => id.toUpperCase()
		const impact = { ...none, runningDecoders: ["aprs"] }
		const blocked = { reason: "resume-blocked", impact } as const
		expect(resumeApproved(blocked, null, name)).toEqual(["APRS"])
		expect(resumeApproved(blocked, ["AIS"], name)).toEqual(["AIS"])
		expect(resumeApproved(blocked, [], name)).toEqual([])
		expect(
			resumeApproved({ reason: "resume-blocked", impact: none }, null, name),
		).toBeNull()
		expect(
			resumeApproved({ reason: "resume-blocked", impact: null }, null, name),
		).toBeNull()
		expect(
			resumeApproved({ reason: "operator", impact }, null, name),
		).toBeNull()
	})

	it("decoderNamer labels a known decoder by type and falls back to the id", () => {
		const name = decoderNamer([{ id: "d-1", type: "acars" }])
		expect(name("d-1")).toBe(decoderLabel("acars"))
		expect(name("unlisted")).toBe("unlisted")
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

	it("skipState tells a Skip from the plan's skips, and unskipPatch removes only the Skip", () => {
		const j = job()
		const planned = job({
			spec: {
				...j.spec,
				exclusions: [
					{ startHz: 161_000_000, endHz: 161_100_000, reason: "Broadcast" },
				],
			},
		})
		expect(skipState(planned, 161_150_000)).toBeNull()
		expect(skipState(planned, 161_050_000)).toBe("plan")
		const p = skipPatch(planned, 161_150_000, 12_500)
		const skipped = job({ spec: { ...j.spec, exclusions: p.exclusions ?? [] } })
		expect(skipState(skipped, 161_150_000)).toBe("you")
		expect(unskipPatch(skipped, 161_150_000).exclusions).toEqual(
			planned.spec.exclusions,
		)
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
