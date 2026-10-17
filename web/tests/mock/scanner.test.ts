import { afterEach, describe, expect, it } from "vitest"
import WebSocket from "ws"
import type {
	Bandplan,
	Discovery,
	HopPlan,
	PlanIssue,
	PlanPreview,
	ScanJob,
	ScanJobHitsResponse,
	ScannerActivityEventData,
	ScannerDiscoveryEventData,
	ScannerProgressEventData,
	ScannerSettingsView,
	ScannerStatus,
	TunerState,
} from "@wavekit/api-types"
import { heldFrequencyHz } from "../../src/data/scanner-format.ts"
import {
	heldDiscoveryId,
	skipPatch,
} from "../../src/features/tuner/scan-hold.ts"
import { DISCOVERY_SEEDS, MOCK_SIGNALS } from "../../mock/data.ts"
import { buildMockServer } from "../../mock/server.ts"
import type { MockServer } from "../../mock/server.ts"

interface Envelope {
	type: string
	channel?: string
	data: unknown
}

interface Page {
	items: Discovery[]
	nextCursor: string | null
}

class Inbox {
	readonly messages: (Envelope & { at: number })[] = []
	private waiters: {
		match: (m: Envelope) => boolean
		resolve: (m: Envelope) => void
	}[] = []

	constructor(socket: WebSocket) {
		socket.on("message", raw => {
			const m = { ...(JSON.parse(String(raw)) as Envelope), at: Date.now() }
			this.messages.push(m)
			this.waiters = this.waiters.filter(w => {
				if (!w.match(m)) return true
				w.resolve(m)
				return false
			})
		})
	}

	/** The first message matching, from index `from` on (already received or still to come). */
	next(
		match: (m: Envelope) => boolean,
		timeoutMs = 5000,
		from = 0,
	): Promise<Envelope> {
		const seen = this.messages.slice(from).find(match)
		if (seen) return Promise.resolve(seen)
		return new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("timed out waiting for a message")),
				timeoutMs,
			)
			this.waiters.push({
				match,
				resolve: m => {
					clearTimeout(timer)
					resolve(m)
				},
			})
		})
	}
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** A short marine sweep: integration 5 ms gives a 50 ms minimum dwell, no holds. */
const marineSweep = {
	name: "Marine test",
	bandplans: ["marine-vhf"],
	integrationMs: 5,
	dwellMs: 60,
	hold: { policy: "never" },
	takeover: true,
}

describe("mock scanner REST", () => {
	let server: MockServer
	afterEach(async () => {
		await server.close()
	})
	const start = async () => {
		server = await buildMockServer({ port: 0 })
		await server.app.ready()
	}
	const inject = (
		method: "GET" | "POST" | "PATCH" | "DELETE",
		url: string,
		payload?: unknown,
	) =>
		server.app.inject(
			payload === undefined
				? { method, url }
				: { method, url, payload: payload as Record<string, unknown> },
		)

	it("serves status, settings with provenance and bounds, and the EU bandplans", async () => {
		await start()
		const status = (await inject("GET", "/api/scanner")).json<ScannerStatus>()
		expect(status).toMatchObject({
			enabled: true,
			channelizerAvailable: false,
			engines: [{ sourceId: "rtl-0", fftSize: 2048, rbwHz: 1171.875 }],
			jobs: { active: 1, total: 2 },
		})
		const view = (
			await inject("GET", "/api/scanner/settings")
		).json<ScannerSettingsView>()
		expect(view.effective.detection.integrationMs).toBe(50)
		expect(view.passiveBySource).toEqual({ "rtl-0": true })
		expect(view.provenance["detection.integrationMs"]).toBe("default")
		expect(view.bounds["passive.<sourceId>"]).toEqual({ type: "boolean" })
		const patched = await inject("PATCH", "/api/scanner/settings", {
			detection: { integrationMs: 20 },
		})
		expect(patched.statusCode).toBe(200)
		const after = patched.json<ScannerSettingsView>()
		expect(after.effective.detection.integrationMs).toBe(20)
		expect(after.provenance["detection.integrationMs"]).toBe("runtime")
		const bad = await inject("PATCH", "/api/scanner/settings", {
			detection: { integrationMs: 1 },
		})
		expect(bad.statusCode).toBe(400)
		expect(bad.json()).toEqual({
			error: "ValidationError",
			code: "VALIDATION_ERROR",
			message:
				"Configuration validation failed:\n  - detection.integrationMs: Value is too small (minimum: 5)",
		})
		const plans = (await inject("GET", "/api/scanner/bandplans")).json<
			Bandplan[]
		>()
		expect(plans.map(p => p.id)).toEqual(
			expect.arrayContaining([
				"airband",
				"marine-vhf",
				"amateur-2m",
				"pmr446",
				"uhf-land-mobile",
				"vhf-land-mobile",
				"pager-466",
				"ism-433",
				"ism-868",
			]),
		)
		expect(plans.every(p => p.region === "EU" || p.region === "all")).toBe(true)
	})

	it("previews a marine sweep: hops in the 2.4 MHz window, period, poi, impact, lockouts", async () => {
		await start()
		const res = await inject("POST", "/api/scanner/plan", {
			bandplans: ["marine-vhf"],
		})
		expect(res.statusCode).toBe(200)
		const p = res.json<PlanPreview>()
		expect(p.spec.mode).toBe("sweep")
		expect(p.spec.provenance["ranges"]).toBe("bandplan")
		expect(p.plan.usableHalfSpanHz).toBe(960_000)
		expect(p.plan.hops.map(h => h.centreHz)).toEqual([
			156_912_500, 158_762_500, 160_612_500, 162_482_500,
		])
		for (const hop of p.plan.hops)
			expect(hop.covered.endHz - hop.covered.startHz).toBe(1_920_000)
		// 4 hops + 1 revisit (share 0.3) at 185 ms (settle 35 + 3 × 50 ms)
		expect(p.sweepPeriodMs).toBe(925)
		expect(p.poi).toHaveLength(4)
		// analog-fm only: no probe decoder, the engine alone
		expect(p.estimates).toEqual({ cpuCores: 0.08, diskMbPerHour: 0, probes: 0 })
		// the decoders the mock runs at 161.5 MHz
		expect(p.impact.runningDecoders).toEqual(["dsd-fme", "ais-catcher"])
		// the seeded 160.900 spur is locked out
		expect(p.lockoutExclusions).toEqual([
			expect.objectContaining({
				startHz: 160_887_500,
				endHz: 160_912_500,
				applied: true,
			}),
		])
		expect(p.issues.filter(i => i.severity === "error")).toEqual([])
	})

	it("honours exclusions and disabled ranges and reports plan issues", async () => {
		await start()
		const preview = async (spec: unknown) =>
			(await inject("POST", "/api/scanner/plan", spec)).json<PlanPreview>()
		const codes = (issues: PlanIssue[]) => issues.map(i => i.code)
		const outside = await preview({
			ranges: [{ startHz: 10_000_000, endHz: 20_000_000 }],
		})
		expect(codes(outside.issues)).toContain("range-outside-tuner")
		const empty = await preview({
			mode: "sweep",
			ranges: [
				{
					startHz: 156_000_000,
					endHz: 156_030_000,
					spacingHz: 25_000,
					firstChannelHz: 156_000_000,
				},
			],
			exclusions: [
				{ frequencyHz: 156_000_000, widthHz: 2000 },
				{ frequencyHz: 156_025_000, widthHz: 2000 },
			],
		})
		expect(codes(empty.issues)).toContain("plan-empty")
		expect(empty.spec.exclusions).toEqual([
			{ startHz: 155_999_000, endHz: 156_001_000 },
			{ startHz: 156_024_000, endHz: 156_026_000 },
		])
		const disabled = await preview({
			ranges: [
				{ startHz: 144_000_000, endHz: 146_000_000 },
				{ startHz: 430_000_000, endHz: 440_000_000, enabled: false },
			],
		})
		// 2 m only (2 MHz: two hops); the disabled range stays in the spec
		expect(disabled.plan.hops).toHaveLength(2)
		for (const hop of disabled.plan.hops) {
			expect(hop.centreHz).toBeGreaterThan(144_000_000)
			expect(hop.centreHz).toBeLessThan(147_000_000)
		}
		expect(disabled.spec.ranges[1]).toMatchObject({ enabled: false })
		expect(disabled.spec.ranges[0]?.bandplanId).toBe("amateur-2m")
		const allOff = await preview({
			ranges: [{ startHz: 144_000_000, endHz: 146_000_000, enabled: false }],
		})
		expect(codes(allOff.issues)).toContain("range-empty")
		const window = await preview({
			ranges: [{ startHz: 161_000_000, endHz: 162_000_000 }],
		})
		expect(window.spec.mode).toBe("in-window")
		expect(window.plan.hops[0]?.centreHz).toBe(161_500_000)
		expect(window.sweepPeriodMs).toBeNull()
		expect(window.impact.runningDecoders).toEqual([])
		const notIn = await preview({
			mode: "in-window",
			ranges: [{ startHz: 144_000_000, endHz: 146_000_000 }],
		})
		expect(codes(notIn.issues)).toContain("not-in-window")
		const schema = await inject("POST", "/api/scanner/plan", { mode: "x" })
		expect(schema.statusCode).toBe(400)
		expect(schema.json()).toMatchObject({ code: "VALIDATION_ERROR" })
	})

	it("lists the passive job and the seeded sweep, and refuses invalid jobs", async () => {
		await start()
		const jobs = (await inject("GET", "/api/scanner/jobs")).json<ScanJob[]>()
		const passive = jobs.find(j => j.passive)
		expect(passive).toMatchObject({
			id: "passive-rtl-0",
			state: "running",
			spec: { mode: "in-window" },
			resumeAt: null,
			resumeHeldBy: null,
		})
		expect(passive?.plan.hops[0]?.centreHz).toBe(161_500_000)
		const done = jobs.find(j => j.state === "completed")
		expect(done).toMatchObject({ name: "Marine VHF", spec: { mode: "sweep" } })
		const hits = (
			await inject("GET", `/api/scanner/jobs/${done?.id ?? ""}/hits?limit=2`)
		).json<ScanJobHitsResponse>()
		expect(hits.hits).toHaveLength(2)
		expect(hits.stats.discoveries).toBe(3)
		const consent = await inject("POST", "/api/scanner/jobs", {
			bandplans: ["marine-vhf"],
		})
		expect(consent.statusCode).toBe(409)
		expect(consent.json()).toMatchObject({
			error: "ScannerApiError",
			code: "SCANNER_TAKEOVER_REQUIRED",
			details: { impact: { runningDecoders: ["dsd-fme", "ais-catcher"] } },
		})
		const invalid = await inject("POST", "/api/scanner/jobs", {
			ranges: [{ startHz: 10_000_000, endHz: 20_000_000 }],
		})
		expect(invalid.statusCode).toBe(400)
		expect(invalid.json()).toMatchObject({
			code: "SCANNER_PLAN_INVALID",
			details: {
				issues: [expect.objectContaining({ code: "range-outside-tuner" })],
			},
		})
		const missing = await inject("POST", "/api/scanner/jobs/j_nope/pause")
		expect(missing.statusCode).toBe(404)
		expect(missing.json()).toMatchObject({ code: "SCANNER_JOB_NOT_FOUND" })
		const gone = await inject("GET", "/api/scanner/jobs/j_nope")
		expect(gone.json()).toMatchObject({ code: "SCANNER_NOT_FOUND" })
	})

	it("runs a sweep: pause, resume, live range edits, cancel restores the tuner, delete", async () => {
		await start()
		const created = await inject("POST", "/api/scanner/jobs", marineSweep)
		expect(created.statusCode).toBe(201)
		const job = created.json<ScanJob>()
		expect(job.state).toBe("starting")
		await sleep(400)
		const tuner = (await inject("GET", "/api/tuner/rtl-0")).json<TunerState>()
		expect(job.plan.hops.map(h => h.centreHz)).toContain(tuner.frequency)
		let now = (
			await inject("GET", `/api/scanner/jobs/${job.id}`)
		).json<ScanJob>()
		expect(now.state).toBe("running")
		expect(now.progress.coverage).toBeGreaterThan(0)
		// identify refuses while the sweep holds the tuner
		const identify = await inject("POST", "/api/scanner/identify", {
			target: { all: true },
		})
		expect(identify.statusCode).toBe(409)
		expect(identify.json()).toMatchObject({
			code: "SCANNER_SOURCE_BUSY",
			details: { reason: "held", holderJobId: job.id },
		})
		const paused = (
			await inject("POST", `/api/scanner/jobs/${job.id}/pause`)
		).json<ScanJob>()
		expect(paused).toMatchObject({ state: "paused", reason: "operator" })
		const again = await inject("POST", `/api/scanner/jobs/${job.id}/pause`)
		expect(again.statusCode).toBe(409)
		expect(again.json()).toMatchObject({ code: "SCANNER_INVALID_TRANSITION" })
		// edges are locked; live fields are not
		const ranges = paused.spec.ranges
		const locked = await inject("PATCH", `/api/scanner/jobs/${job.id}`, {
			ranges: ranges.map((r, i) =>
				i === 0 ? { ...r, endHz: r.endHz + 1 } : r,
			),
		})
		expect(locked.statusCode).toBe(400)
		expect(locked.json()).toMatchObject({
			code: "SCANNER_PLAN_INVALID",
			details: {
				issues: [
					expect.objectContaining({
						code: "range-locked",
						details: { index: 0, fields: ["endHz"] },
					}),
				],
			},
		})
		const live = await inject("PATCH", `/api/scanner/jobs/${job.id}`, {
			ranges: ranges.map((r, i) =>
				i === 1 ? { ...r, enabled: false, name: "AIS gap" } : r,
			),
		})
		expect(live.statusCode).toBe(200)
		const edit = live.json<{
			job: ScanJob
			plan: HopPlan
			issues: PlanIssue[]
		}>()
		expect(edit.job.spec.ranges[1]).toMatchObject({
			enabled: false,
			name: "AIS gap",
		})
		expect(edit.plan.hops).toEqual(edit.job.plan.hops)
		const resumed = (
			await inject("POST", `/api/scanner/jobs/${job.id}/resume`, {})
		).json<ScanJob>()
		expect(resumed.state).toBe("running")
		expect(resumed.reason).toBeUndefined()
		const busy = await inject("DELETE", `/api/scanner/jobs/${job.id}`)
		expect(busy.statusCode).toBe(409)
		expect(busy.json()).toMatchObject({ code: "SCANNER_JOB_NOT_TERMINAL" })
		const cancelled = (
			await inject("POST", `/api/scanner/jobs/${job.id}/cancel`)
		).json<ScanJob>()
		expect(cancelled.state).toBe("cancelled")
		expect(cancelled.endedAt).toBeDefined()
		// the arbiter restores the pre-job tuning
		now = (await inject("GET", `/api/scanner/jobs/${job.id}`)).json<ScanJob>()
		expect(
			(await inject("GET", "/api/tuner/rtl-0")).json<TunerState>().frequency,
		).toBe(161_500_000)
		const terminal = await inject("PATCH", `/api/scanner/jobs/${job.id}`, {
			sensitivity: "high",
		})
		expect(terminal.json()).toMatchObject({ code: "SCANNER_JOB_TERMINAL" })
		expect(
			(await inject("DELETE", `/api/scanner/jobs/${job.id}`)).statusCode,
		).toBe(204)
		expect(now.progress.hitStats).toBeDefined()
	})

	it("completes after stop.afterSweeps", async () => {
		await start()
		const job = (
			await inject("POST", "/api/scanner/jobs", {
				...marineSweep,
				stop: { afterSweeps: 1 },
			})
		).json<ScanJob>()
		await sleep(900)
		const done = (
			await inject("GET", `/api/scanner/jobs/${job.id}`)
		).json<ScanJob>()
		expect(done.state).toBe("completed")
		expect(done.progress).toMatchObject({ sweepIndex: 1, coverage: 1 })
	})
})

describe("mock scanner discoveries", () => {
	let server: MockServer
	afterEach(async () => {
		await server.close()
	})
	const inject = (
		method: "GET" | "POST" | "PATCH" | "DELETE",
		url: string,
		payload?: unknown,
	) =>
		server.app.inject(
			payload === undefined
				? { method, url }
				: { method, url, payload: payload as Record<string, unknown> },
		)
	const list = async (query = "") =>
		(await inject("GET", `/api/scanner/discoveries${query}`)).json<Page>()

	it("seeds Brittany discoveries on mock signals", async () => {
		server = await buildMockServer({ port: 0 })
		await server.app.ready()
		const page = await list()
		expect(page.items).toHaveLength(DISCOVERY_SEEDS.length)
		expect(page.nextCursor).toBeNull()
		for (const d of page.items)
			expect(MOCK_SIGNALS.some(s => s.hz === d.frequencyHz)).toBe(true)
		const confidences = new Set(page.items.map(d => d.confidence))
		expect([...confidences].sort()).toEqual([
			"activity",
			"candidate",
			"classified",
			"decoded",
		])
		expect(page.items.filter(d => d.encrypted)).toHaveLength(1)
		expect(page.items.filter(d => d.operator?.lockout)).toHaveLength(1)
		expect(page.items.filter(d => d.operator?.keep).length).toBeGreaterThan(0)
		// last seen first
		const seen = page.items.map(d => d.lastSeenAt)
		expect(seen).toEqual([...seen].sort().reverse())
	})

	it("filters, sorts and pages like the core's store", async () => {
		server = await buildMockServer({ port: 0 })
		await server.app.ready()
		const dmr = await list("?protocol=dmr")
		expect(dmr.items.map(d => d.frequencyHz).sort()).toEqual([
			161_150_000, 446_093_750,
		])
		const cc = await list("?identity=dmr-cc:1")
		expect(cc.items.map(d => d.frequencyHz)).toEqual([161_150_000])
		const capcode = await list("?q=1234567")
		expect(capcode.items[0]?.protocol).toBe("pocsag")
		const label = await list("?q=marine")
		expect(label.items.map(d => d.frequencyHz)).toEqual([156_800_000])
		const decoded = await list("?minConfidence=decoded")
		expect(decoded.items.every(d => d.confidence === "decoded")).toBe(true)
		const band = await list("?freqMinHz=156000000&freqMaxHz=157000000")
		expect(band.items.map(d => d.frequencyHz).sort()).toEqual([
			156_600_000, 156_800_000,
		])
		const encrypted = await list("?encrypted=true")
		expect(encrypted.items).toHaveLength(1)
		const byFreq = await list("?sort=frequency&limit=5")
		expect(byFreq.items.map(d => d.frequencyHz)).toEqual(
			[...byFreq.items.map(d => d.frequencyHz)].sort((a, b) => a - b),
		)
		expect(byFreq.items[0]?.frequencyHz).toBe(118_100_000)
		expect(byFreq.nextCursor).toBe("5")
		const second = await list("?sort=frequency&limit=5&cursor=5")
		expect(second.items[0]?.frequencyHz).toBeGreaterThan(
			byFreq.items[4]?.frequencyHz ?? 0,
		)
		const byConfidence = await list("?sort=confidence")
		expect(byConfidence.items[0]?.confidence).toBe("decoded")
		expect(byConfidence.items.at(-1)?.confidence).toBe("activity")
		const cursor = await inject("GET", "/api/scanner/discoveries?cursor=abc")
		expect(cursor.statusCode).toBe(400)
		expect(cursor.json()).toMatchObject({
			error: "WaveKitError",
			code: "SCANNER_INVALID_CURSOR",
		})
		const kind = await inject("GET", "/api/scanner/discoveries?identity=nope:1")
		expect(kind.json()).toMatchObject({ code: "VALIDATION_ERROR" })
	})

	it("reads, labels, locks out, deletes and listens to discoveries", async () => {
		server = await buildMockServer({ port: 0 })
		await server.app.ready()
		const dmr = (await list("?identity=dmr-cc:1")).items[0]
		const id = dmr?.id ?? ""
		expect(
			(await inject("GET", `/api/scanner/discoveries/${id}`)).json<Discovery>(),
		).toMatchObject({
			protocol: "dmr",
			metadata: { talkgroups: ["2081", "9"] },
		})
		const missing = await inject("GET", "/api/scanner/discoveries/d_nope")
		expect(missing.statusCode).toBe(404)
		expect(missing.json()).toMatchObject({ code: "SCANNER_NOT_FOUND" })
		const observations = (
			await inject("GET", `/api/scanner/discoveries/${id}/observations?limit=2`)
		).json<{ items: { discoveryId: string }[]; nextCursor: string | null }>()
		expect(observations.items).toHaveLength(2)
		expect(observations.nextCursor).toBe("2")
		const labelled = (
			await inject("PATCH", `/api/scanner/discoveries/${id}`, {
				label: "Rennes DMR",
				notes: "TG 2081",
			})
		).json<Discovery>()
		expect(labelled.operator).toMatchObject({
			label: "Rennes DMR",
			notes: "TG 2081",
			keep: true,
		})
		const empty = await inject("PATCH", `/api/scanner/discoveries/${id}`, {})
		expect(empty.statusCode).toBe(400)
		// listen inside the window: live audio retargets to the discovery
		const listen = await inject("POST", `/api/scanner/discoveries/${id}/listen`)
		expect(listen.statusCode).toBe(200)
		expect(listen.json()).toMatchObject({
			mode: "live-audio",
			sourceId: "rtl-0",
			frequencyHz: 161_150_000,
		})
		const offsetHz = (listen.json() as { offsetHz: number }).offsetHz
		expect(Math.abs(offsetHz + 350_000)).toBeLessThan(1000)
		const status = (await inject("GET", "/api/live-audio/status")).json<{
			running: boolean
			config: { offsetHz: number }
		}>()
		expect(status).toMatchObject({ running: true, config: { offsetHz } })
		const far = (await list("?protocol=aprs")).items[0]
		const out = await inject(
			"POST",
			`/api/scanner/discoveries/${far?.id ?? ""}/listen`,
		)
		expect(out.statusCode).toBe(409)
		expect(out.json()).toMatchObject({ code: "OUT_OF_WINDOW" })
		// lockout: listen refuses, sweeps plan around it
		await inject("PATCH", `/api/scanner/discoveries/${id}`, { lockout: true })
		const refused = await inject(
			"POST",
			`/api/scanner/discoveries/${id}/listen`,
		)
		expect(refused.json()).toMatchObject({
			code: "SCANNER_DISCOVERY_LOCKED_OUT",
		})
		const plan = (
			await inject("POST", "/api/scanner/plan", { bandplans: ["marine-vhf"] })
		).json<PlanPreview>()
		expect(plan.lockoutExclusions?.map(x => x.discoveryId)).toContain(id)
		expect(
			(await inject("DELETE", `/api/scanner/discoveries/${id}`)).statusCode,
		).toBe(204)
		expect(
			(await inject("DELETE", `/api/scanner/discoveries/${id}`)).statusCode,
		).toBe(404)
		const bad = await inject("DELETE", "/api/scanner/discoveries/..%2Fx")
		expect(bad.statusCode).toBe(400)
	})

	it("records identify results on the discovery", async () => {
		server = await buildMockServer({ port: 0 })
		await server.app.ready()
		const seeded = (await list("?identity=dmr-cc:1")).items[0]
		const job = (
			await inject("POST", "/api/scanner/identify", {
				target: { frequencyHz: 161_150_000 },
			})
		).json<ScanJob>()
		await sleep(2300)
		const done = (
			await inject("GET", `/api/scanner/jobs/${job.id}`)
		).json<ScanJob>()
		expect(done.state).toBe("completed")
		const result = done.identify?.targets[0]?.result
		expect(result?.discoveryId).toBe(seeded?.id)
		expect(result?.observationId).toMatch(/^o_/)
		const after = (
			await inject("GET", `/api/scanner/discoveries/${seeded?.id ?? ""}`)
		).json<Discovery>()
		expect(after.jobIds).toContain(job.id)
		expect(after.observationCount).toBe((seeded?.observationCount ?? 0) + 1)
		const paused = await inject("POST", `/api/scanner/jobs/${job.id}/pause`)
		expect(paused.json()).toMatchObject({
			code: "SCANNER_IDENTIFY_NOT_PAUSABLE",
		})
	})
})

describe("mock scanner WebSocket", () => {
	let server: MockServer
	let api: string
	afterEach(async () => {
		await server.close()
	})
	const connect = async () => {
		server = await buildMockServer({ port: 0, audioPort: 0 })
		api = (await server.listen()).apiUrl
		const socket = new WebSocket(`${api.replace(/^http/, "ws")}/ws`)
		const inbox = new Inbox(socket)
		await new Promise(resolve => socket.once("open", resolve))
		const ack = inbox.next(m => m.type === "subscribed")
		socket.send(
			JSON.stringify({ type: "subscribe", channels: ["scanner", "tuner"] }),
		)
		await ack
		return inbox
	}
	const post = async (path: string, body?: unknown) => {
		const res = await fetch(`${api}${path}`, {
			method: "POST",
			headers: body === undefined ? {} : { "Content-Type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		})
		return { status: res.status, body: (await res.json()) as unknown }
	}
	const isJob = (id: string, state: string) => (m: Envelope) =>
		m.type === "scanner:job" &&
		(m.data as ScanJob).id === id &&
		(m.data as ScanJob).state === state

	it("streams a sweep: job states, 2 Hz progress, the tuner following the hops", async () => {
		const inbox = await connect()
		const created = await post("/api/scanner/jobs", marineSweep)
		expect(created.status).toBe(201)
		const job = created.body as ScanJob
		await inbox.next(isJob(job.id, "running"))
		await sleep(1700)
		const progress = inbox.messages.filter(
			m =>
				m.type === "scanner:progress" &&
				(m.data as ScannerProgressEventData).jobId === job.id,
		)
		expect(progress.length).toBeGreaterThanOrEqual(3)
		for (let i = 1; i < progress.length; i++)
			expect(
				(progress[i]?.at ?? 0) - (progress[i - 1]?.at ?? 0),
			).toBeGreaterThanOrEqual(400)
		const last = progress.at(-1)?.data as ScannerProgressEventData
		expect(last).toMatchObject({ jobId: job.id, hopCount: 4, probes: 0 })
		expect(job.plan.hops.map(h => h.centreHz)).toContain(last.centerHz)
		const scannerTunes = inbox.messages.filter(
			m =>
				m.type === "tuner:command-sent" &&
				(m.data as { origin?: string }).origin === "scanner",
		)
		expect(scannerTunes.length).toBeGreaterThan(4)
		await post(`/api/scanner/jobs/${job.id}/cancel`)
		await inbox.next(isJob(job.id, "cancelled"))
	})

	it("pauses a sweep on operator tuning and resumes it when resumeAt passes", async () => {
		const inbox = await connect()
		const job = (
			await post("/api/scanner/jobs", {
				...marineSweep,
				resume: { autoAfterIdleMs: 1500 },
			})
		).body as ScanJob
		await inbox.next(isJob(job.id, "running"))
		const before = Date.now()
		const tuned = await post("/api/tuner/rtl-0/frequency", { hz: 145_500_000 })
		expect(tuned.status).toBe(200)
		const paused = (await inbox.next(isJob(job.id, "paused"))).data as ScanJob
		const mark = inbox.messages.length
		expect(paused).toMatchObject({
			reason: "preempted-operator",
			resumeHeldBy: null,
		})
		const resumeAt = Date.parse(paused.resumeAt ?? "")
		expect(resumeAt - before).toBeGreaterThanOrEqual(1400)
		expect(resumeAt - before).toBeLessThan(2500)
		// the operator owns the tuner: the sweep no longer moves it
		await sleep(100)
		const state = (await (
			await fetch(`${api}/api/tuner/rtl-0`)
		).json()) as TunerState
		expect(state.frequency).toBe(145_500_000)
		const resumed = (await inbox.next(isJob(job.id, "running"), 4000, mark))
			.data as ScanJob
		expect(resumed.resumeAt).toBeNull()
		await post(`/api/scanner/jobs/${job.id}/cancel`)
	})

	it("defaults resumeAt to 60 s after the operator's last write", async () => {
		const inbox = await connect()
		const job = (await post("/api/scanner/jobs", marineSweep)).body as ScanJob
		await inbox.next(isJob(job.id, "running"))
		const before = Date.now()
		await post("/api/tuner/rtl-0/gain", { tenthsDb: 400 })
		const paused = (await inbox.next(isJob(job.id, "paused"))).data as ScanJob
		expect(paused.reason).toBe("preempted-operator")
		const ahead = Date.parse(paused.resumeAt ?? "") - before
		expect(ahead).toBeGreaterThanOrEqual(59_000)
		expect(ahead).toBeLessThanOrEqual(61_000)
		// an explicit resume takes the tuner back at once
		const resumed = await post(`/api/scanner/jobs/${job.id}/resume`, {
			takeover: true,
		})
		expect(resumed.body).toMatchObject({ state: "running", resumeAt: null })
		await post(`/api/scanner/jobs/${job.id}/cancel`)
	})

	it("holds on an active signal and reports discovery hits and activity", async () => {
		const inbox = await connect()
		// 162.400 MHz carries an always-on carrier (seeded as activity)
		const job = (
			await post("/api/scanner/jobs", {
				mode: "sweep",
				ranges: [{ startHz: 162_390_000, endHz: 162_410_000 }],
				protocols: ["analog-fm"],
				integrationMs: 5,
				dwellMs: 60,
				hold: { policy: "hold", maxHoldMs: 400 },
				takeover: true,
			})
		).body as ScanJob
		const holding = (await inbox.next(isJob(job.id, "holding"))).data as ScanJob
		const discovery = (
			await inbox.next(
				m =>
					m.type === "scanner:discovery" &&
					(m.data as ScannerDiscoveryEventData).discovery.frequencyHz ===
						162_400_000,
			)
		).data as ScannerDiscoveryEventData
		// like the core's scheduler, the hold names a tracker track, never a discovery id
		expect(holding.progress.holdingOn).toMatch(/^trk_/)
		expect(holding.progress.holdingOn).not.toBe(discovery.discovery.id)
		expect(discovery.change).toBe("updated")
		expect(discovery.jobHits?.[0]).toMatchObject({
			jobId: job.id,
			discoveryId: discovery.discovery.id,
			firstSeenInJob: false,
		})
		const active = (
			await inbox.next(
				m =>
					m.type === "scanner:activity" &&
					(m.data as ScannerActivityEventData).active,
			)
		).data as ScannerActivityEventData
		expect(active).toMatchObject({
			sourceId: "rtl-0",
			discoveryId: discovery.discovery.id,
			jobIds: [job.id],
			frequencyHz: 162_400_000,
		})
		// the web app finds the held signal from scanner:activity (no probe in the mock), as with a core
		expect(heldFrequencyHz(holding, holding.progress.holdingOn, [active])).toBe(
			162_400_000,
		)
		expect(heldDiscoveryId(holding, [active], 162_400_000)).toBe(
			discovery.discovery.id,
		)
		await inbox.next(
			m =>
				m.type === "scanner:activity" &&
				!(m.data as ScannerActivityEventData).active,
		)
		const hits = (await (
			await fetch(`${api}/api/scanner/jobs/${job.id}/hits`)
		).json()) as ScanJobHitsResponse
		expect(hits.stats.hits).toBeGreaterThanOrEqual(1)
		expect(hits.hits[0]?.discoveryId).toBe(discovery.discovery.id)
		await post(`/api/scanner/jobs/${job.id}/cancel`)
	})
	it("Skip on a held hit releases the hold and leaves the frequency out", async () => {
		const inbox = await connect()
		// 162.400 MHz carries an always-on carrier, the only signal in this range
		const job = (
			await post("/api/scanner/jobs", {
				mode: "sweep",
				ranges: [{ startHz: 162_300_000, endHz: 162_500_000 }],
				protocols: ["analog-fm"],
				integrationMs: 5,
				dwellMs: 60,
				hold: { policy: "hold", maxHoldMs: 60_000 },
				takeover: true,
			})
		).body as ScanJob
		const holding = (await inbox.next(isJob(job.id, "holding"))).data as ScanJob
		const mark = inbox.messages.length
		// the hold row's skipPatch: the held channel ± half its bandwidth
		const res = await fetch(`${api}/api/scanner/jobs/${job.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(skipPatch(holding, 162_400_000, 14_000)),
		})
		const patched = (await res.json()) as { job: ScanJob }
		expect(res.status, JSON.stringify(patched)).toBe(200)
		expect(patched.job.spec.exclusions).toContainEqual({
			startHz: 162_393_000,
			endHz: 162_407_000,
			reason: "Skipped",
		})
		// the hold ends at once (the core releases the probe), not after maxHoldMs
		expect(patched.job.state).not.toBe("holding")
		await inbox.next(isJob(job.id, "running"), 2000, mark)
		await sleep(600)
		expect(
			inbox.messages
				.slice(mark)
				.some(
					m =>
						m.type === "scanner:job" &&
						(m.data as ScanJob).id === job.id &&
						(m.data as ScanJob).state === "holding",
				),
		).toBe(false)
		await post(`/api/scanner/jobs/${job.id}/cancel`)
	})
})
