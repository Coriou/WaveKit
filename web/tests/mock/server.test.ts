import { afterAll, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "ws"
import type {
	ActivitySearchPage,
	DecoderInfo,
	ExtendedSourceStatus,
	LiveAudioStatus,
	ResolvedBandPlanView,
	ScanJob,
	ScannerIdentifyEventData,
	SpectrumFrameEventData,
	SpectrumProfileEventData,
	TunerState,
} from "@wavekit/api-types"
import { buildMockServer } from "../../mock/server.ts"
import type { MockServer } from "../../mock/server.ts"

describe("mock server REST", () => {
	let server: MockServer
	beforeAll(async () => {
		server = await buildMockServer({
			port: 0,
			audioOrigin: "http://localhost:3102",
		})
		await server.app.ready()
	})
	afterAll(async () => {
		await server.close()
	})
	const inject = (
		method: "GET" | "POST" | "PATCH",
		url: string,
		payload?: unknown,
	) =>
		server.app.inject(
			payload === undefined
				? { method, url }
				: { method, url, payload: payload as Record<string, unknown> },
		)

	it("answers health and is a legacy core (no bootstrap)", async () => {
		expect((await inject("GET", "/health")).json()).toMatchObject({
			status: "ok",
		})
		expect((await inject("GET", "/health/live")).statusCode).toBe(200)
		expect((await inject("GET", "/api/access/bootstrap")).statusCode).toBe(404)
	})

	it("serves one rtl_tcp IQ source and the decoders with their band check", async () => {
		const sources = (await inject("GET", "/api/sources")).json<
			ExtendedSourceStatus[]
		>()
		expect(sources).toHaveLength(1)
		expect(sources[0]).toMatchObject({
			id: "rtl-0",
			type: "rtl_tcp",
			connected: true,
			caps: { kind: "iq", sampleRate: 2_400_000, centerFreq: 161_500_000 },
		})
		const decoders = (await inject("GET", "/api/decoders")).json<
			DecoderInfo[]
		>()
		const dmr = decoders.find(d => d.id === "dsd-fme")
		const ism = decoders.find(d => d.id === "rtl433-433")
		expect(dmr).toMatchObject({
			running: true,
			suspended: false,
			bandAssessment: { verdict: "in-band" },
		})
		expect(ism).toMatchObject({
			running: false,
			suspended: true,
			suspension: { reasonCode: "frequency-out-of-band" },
		})
		expect(
			decoders.find(d => d.id === "readsb")?.bandAssessment?.reasonCode,
		).toBe("external-input")
	})

	it("tunes the source and validates the body", async () => {
		const list = (await inject("GET", "/api/tuner")).json<TunerState[]>()
		expect(list[0]?.frequency).toBe(161_500_000)
		const tuned = await inject("POST", "/api/tuner/rtl-0/frequency", {
			hz: 433_920_000,
		})
		expect(tuned.statusCode).toBe(200)
		expect(tuned.json<TunerState>().frequency).toBe(433_920_000)
		const decoders = (await inject("GET", "/api/decoders")).json<
			DecoderInfo[]
		>()
		expect(decoders.find(d => d.id === "rtl433-433")?.suspended).toBe(false)
		// error bodies as a real core sends them (lot C7)
		const invalid = await inject("POST", "/api/tuner/rtl-0/frequency", {
			hz: "x",
		})
		expect(invalid.statusCode).toBe(400)
		expect(invalid.json()).toMatchObject({
			error: "ValidationError",
			code: "VALIDATION_ERROR",
			message: "body/hz must be integer",
		})
		expect(invalid.json()).toHaveProperty("details")
		expect(invalid.json()).toHaveProperty("correlationId")
		const range = await inject("POST", "/api/tuner/rtl-0/frequency", {
			hz: 5_000_000_000,
		})
		expect(range.statusCode).toBe(400)
		expect(range.json()).toEqual({
			error: "TunerValidationError",
			code: "TUNER_VALIDATION_ERROR",
			message:
				"frequency out of range: 5000000000 (expected 24000000-1900000000)",
		})
		const missing = await inject("GET", "/api/tuner/nope")
		expect(missing.statusCode).toBe(404)
		expect(missing.json()).toMatchObject({
			error: "TunerSourceNotFoundError",
			code: "TUNER_SOURCE_NOT_FOUND",
		})
		const route = await inject("GET", "/api/sources/rtl-0")
		expect(route.statusCode).toBe(404)
		expect(route.json()).toMatchObject({
			error: "NotFound",
			code: "NOT_FOUND",
			message: "Route GET /api/sources/rtl-0 not found",
		})
		await inject("POST", "/api/tuner/rtl-0/frequency", { hz: 161_500_000 })
	})

	it("starts, configures and stops live audio", async () => {
		const status = (
			await inject("GET", "/api/live-audio/status")
		).json<LiveAudioStatus>()
		expect(status).toMatchObject({
			running: false,
			wavUrl: "http://localhost:3102/stream.wav",
			config: { offsetHz: -350_000 },
		})
		expect((await inject("POST", "/api/live-audio/start")).json()).toEqual({
			success: true,
		})
		const patched = await inject("PATCH", "/api/live-audio/config", {
			modulation: "wfm",
			bandwidth: 180_000,
			offsetHz: 0,
		})
		expect(patched.statusCode).toBe(200)
		expect(patched.json<LiveAudioStatus>()).toMatchObject({
			running: true,
			effectiveSampleRate: 48_000,
			config: { modulation: "wfm", offsetHz: 0 },
		})
		const bad = await inject("PATCH", "/api/live-audio/config", {
			offsetHz: 1_190_000,
		})
		expect(bad.statusCode).toBe(400)
		expect(bad.json()).toMatchObject({ error: "Bad Request" })
		expect(
			(await inject("PATCH", "/api/live-audio/config", { modulation: "fm" }))
				.statusCode,
		).toBe(400)
		await inject("POST", "/api/live-audio/stop")
		expect(
			(await inject("GET", "/api/live-audio/status")).json<LiveAudioStatus>()
				.running,
		).toBe(false)
		await inject("PATCH", "/api/live-audio/config", {
			modulation: "nfm",
			bandwidth: 12_500,
			offsetHz: -350_000,
		})
	})

	it("takes the WG7 noise squelch on FM only, as the core", async () => {
		const ok = await inject("PATCH", "/api/live-audio/config", {
			squelchMode: "noise",
			noiseQuietingDb: 9,
		})
		expect(ok.statusCode).toBe(200)
		expect(ok.json<LiveAudioStatus>().config).toMatchObject({
			squelchMode: "noise",
			noiseQuietingDb: 9,
		})
		const am = await inject("PATCH", "/api/live-audio/config", {
			modulation: "am",
		})
		expect(am.statusCode).toBe(400)
		expect(am.json()).toMatchObject({ error: "Bad Request" })
		const out = await inject("PATCH", "/api/live-audio/config", {
			noiseQuietingDb: 31,
		})
		expect(out.statusCode).toBe(400)
		const back = await inject("PATCH", "/api/live-audio/config", {
			modulation: "am",
			squelchMode: "auto",
			noiseQuietingDb: 6,
		})
		expect(back.statusCode).toBe(200)
		await inject("PATCH", "/api/live-audio/config", { modulation: "nfm" })
	})

	it("serves the resolved band plan", async () => {
		const view = (
			await inject("GET", "/api/bandplans/resolved")
		).json<ResolvedBandPlanView>()
		expect(view.context).toEqual({ region: "EU", effectiveCountry: "FR" })
		expect(view.bands.map(b => b.key)).toContain("operator/harbour")
		expect(view.hidden).toEqual(["builtin-fr/dab"])
		const starts = view.bands.map(b => b.segments[0]?.startHz ?? 0)
		expect([...starts].sort((a, b) => a - b)).toEqual(starts)
	})

	it("starts identify jobs inside the window only", async () => {
		const created = await inject("POST", "/api/scanner/identify", {
			target: { frequencyHz: 161_150_000 },
		})
		expect(created.statusCode).toBe(201)
		const job = created.json<ScanJob>()
		// a real core answers before the job starts
		expect(job).toMatchObject({
			state: "starting",
			spec: { kind: "identify" },
			identify: { targets: [{ state: "waiting-for-signal" }] },
		})
		expect(job.startedAt).toBeUndefined()
		expect(
			(await inject("GET", `/api/scanner/jobs/${job.id}`)).statusCode,
		).toBe(200)
		const out = await inject("POST", "/api/scanner/identify", {
			target: { frequencyHz: 446_006_250 },
		})
		expect(out.statusCode).toBe(409)
		expect(out.json()).toMatchObject({ code: "OUT_OF_WINDOW" })
		const empty = await inject("POST", "/api/scanner/identify", { target: {} })
		expect(empty.statusCode).toBe(400)
		expect(empty.json()).toMatchObject({ code: "VALIDATION_ERROR" })
		const source = await inject("POST", "/api/scanner/identify", {
			sourceId: "nope",
			target: { frequencyHz: 161_150_000 },
		})
		expect(source.statusCode).toBe(400)
		expect(source.json()).toMatchObject({
			error: "WaveKitError",
			code: "SCANNER_SOURCE_NOT_FOUND",
		})
		const gone = await inject("GET", "/api/scanner/jobs/nope")
		expect(gone.statusCode).toBe(404)
		expect(gone.json()).toEqual({
			error: "NotFound",
			code: "SCANNER_NOT_FOUND",
			message: "Job nope not found",
		})
	})

	it("pages activity newest first with filters", async () => {
		const page = (
			await inject("GET", "/api/activity?limit=5")
		).json<ActivitySearchPage>()
		expect(page.items).toHaveLength(5)
		expect(Number(page.items[0]?.commitSeq)).toBeGreaterThan(
			Number(page.items[4]?.commitSeq),
		)
		expect(page.nextPageToken).not.toBeNull()
		const next = (
			await inject(
				"GET",
				`/api/activity?limit=5&pageToken=${page.nextPageToken ?? ""}`,
			)
		).json<ActivitySearchPage>()
		expect(Number(next.items[0]?.commitSeq)).toBeLessThan(
			Number(page.items[4]?.commitSeq),
		)
		const paging = (
			await inject("GET", "/api/activity?categories=paging")
		).json<ActivitySearchPage>()
		expect(paging.items.length).toBeGreaterThan(0)
		expect(paging.items.every(i => i.category === "paging")).toBe(true)
		expect((await inject("GET", "/api/activity?bogus=1")).json()).toMatchObject(
			{ code: "ACTIVITY_QUERY_INVALID" },
		)
	})
})

interface Envelope {
	type: string
	channel?: string
	data: unknown
}

class Inbox {
	readonly messages: Envelope[] = []
	private waiters: {
		match: (m: Envelope) => boolean
		resolve: (m: Envelope) => void
	}[] = []

	constructor(socket: WebSocket) {
		socket.on("message", raw => {
			const m = JSON.parse(String(raw)) as Envelope
			this.messages.push(m)
			this.waiters = this.waiters.filter(w => {
				if (!w.match(m)) return true
				w.resolve(m)
				return false
			})
		})
	}

	next(match: (m: Envelope) => boolean, timeoutMs = 4000): Promise<Envelope> {
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

describe("mock server WebSocket and audio", () => {
	let server: MockServer
	let api: string
	let audio: string
	beforeAll(async () => {
		server = await buildMockServer({
			port: 0,
			audioPort: 0,
			messageIntervalMs: 300,
		})
		const urls = await server.listen()
		api = urls.apiUrl
		audio = urls.audioUrl
	})
	afterAll(async () => {
		await server.close()
	})

	it("streams a spectrum subscription: profile, snapshot, live frames, new epoch on retune", async () => {
		const socket = new WebSocket(`${api.replace(/^http/, "ws")}/ws`)
		const inbox = new Inbox(socket)
		await new Promise(resolve => socket.once("open", resolve))
		const ack = inbox.next(m => m.type === "subscribed")
		const profile = inbox.next(m => m.type === "spectrum:profile")
		const snapshot = inbox.next(m => m.type === "spectrum:frame")
		socket.send(
			JSON.stringify({
				type: "subscribe",
				channels: ["spectrum", "tuner"],
				options: { spectrum: { sourceId: "rtl-0", hz: 20, bins: 512 } },
			}),
		)
		expect((await ack).data).toEqual({ channels: ["spectrum", "tuner"] })
		expect((await profile).data).toMatchObject<
			Partial<SpectrumProfileEventData>
		>({
			selection: "source",
			sourceId: "rtl-0",
			outcome: "exact",
			profile: { key: "20:512", hz: 20, bins: 512 },
		})
		const first = (await snapshot).data as SpectrumFrameEventData
		// as a real core: only the usable 80 % of the 2.4 MHz capture, max-reduced to at most 512 bins
		expect(first).toMatchObject({
			snapshot: true,
			binCount: 410,
			centerHz: 161_500_000,
			startHz: 160_539_648,
			binHz: 4687.5,
			binEncoding: "u8-halfdb-127.5",
		})
		const span = first.binCount * first.binHz
		expect(span).toBeGreaterThan(2_400_000 * 0.8 - first.binHz)
		expect(span).toBeLessThan(2_400_000 * 0.8 + first.binHz)
		const bytes = Buffer.from(first.bins, "base64")
		expect(bytes).toHaveLength(410)
		const db = [...bytes].map(v => v / 2 - 127.5)
		const median = [...db].sort((a, b) => a - b)[205] ?? 0
		expect(median).toBeGreaterThan(-115)
		expect(median).toBeLessThan(-104)
		// AIS A at 161.975 MHz is bursty; the steady carrier at 160.900 MHz is always there.
		const carrierBin = Math.floor((160_900_000 - first.startHz) / first.binHz)
		expect(db[carrierBin]).toBeGreaterThan(-100)

		const live = (
			await inbox.next(
				m =>
					m.type === "spectrum:frame" &&
					!(m.data as SpectrumFrameEventData).snapshot,
			)
		).data as SpectrumFrameEventData
		expect(live.epoch).toBe(first.epoch)

		const changed = inbox.next(m => m.type === "tuner:state-changed")
		const res = await fetch(`${api}/api/tuner/rtl-0/frequency`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ hz: 162_000_000 }),
		})
		expect(res.status).toBe(200)
		expect((await changed).data).toMatchObject({
			sourceId: "rtl-0",
			state: { frequency: 162_000_000 },
		})
		const moved = (
			await inbox.next(
				m =>
					m.type === "spectrum:frame" &&
					(m.data as SpectrumFrameEventData).centerHz === 162_000_000,
			)
		).data as SpectrumFrameEventData
		expect(moved.epoch).toBeGreaterThan(first.epoch)

		const unsub = inbox.next(m => m.type === "unsubscribed")
		socket.send(JSON.stringify({ type: "unsubscribe", channels: ["spectrum"] }))
		expect((await unsub).data).toEqual({ channels: ["tuner"] })
		await fetch(`${api}/api/tuner/rtl-0/frequency`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ hz: 161_500_000 }),
		})
		socket.close()
	})

	it("replays backfill frames of the current epoch, oldest first, before the snapshot", async () => {
		await new Promise(resolve => setTimeout(resolve, 400))
		const socket = new WebSocket(`${api.replace(/^http/, "ws")}/ws`)
		const inbox = new Inbox(socket)
		await new Promise(resolve => socket.once("open", resolve))
		const snapshot = inbox.next(
			m =>
				m.type === "spectrum:frame" &&
				(m.data as SpectrumFrameEventData).snapshot === true,
		)
		socket.send(
			JSON.stringify({
				type: "subscribe",
				channels: ["spectrum"],
				options: {
					spectrum: {
						sourceId: "rtl-0",
						hz: 20,
						bins: 256,
						backfillMs: 10_000,
					},
				},
			}),
		)
		await snapshot
		const profile = inbox.messages.find(m => m.type === "spectrum:profile")
		const n = (profile?.data as SpectrumProfileEventData).backfillFrames ?? 0
		expect(n).toBeGreaterThanOrEqual(1)
		expect(n).toBeLessThanOrEqual(64)
		const frames = inbox.messages
			.filter(m => m.type === "spectrum:frame")
			.map(m => m.data as SpectrumFrameEventData)
		const backfill = frames.slice(0, n)
		expect(backfill.every(f => f.backfill === true && !f.snapshot)).toBe(true)
		const at = backfill.map(f => Date.parse(f.at))
		expect(at).toEqual([...at].sort((a, b) => a - b))
		expect(frames[n]?.snapshot).toBe(true)
		expect(new Set(frames.map(f => f.epoch)).size).toBe(1)
		socket.close()
	})

	it("walks an identify job over scanner:identify and feeds decoded messages", async () => {
		const socket = new WebSocket(`${api.replace(/^http/, "ws")}/ws`)
		const inbox = new Inbox(socket)
		await new Promise(resolve => socket.once("open", resolve))
		const subscribed = inbox.next(m => m.type === "activity:subscribed")
		const replayed = inbox.next(m => m.type === "activity:records")
		socket.send(
			JSON.stringify({ type: "subscribe", channels: ["scanner", "decoders"] }),
		)
		socket.send(
			JSON.stringify({
				type: "activity:subscribe",
				id: "feed",
				query: {},
				cursor: "mock:0",
			}),
		)
		await subscribed
		const replay = (await replayed).data as { items: unknown[]; cursor: string }
		expect(replay.items.length).toBeGreaterThan(10)
		const res = await fetch(`${api}/api/scanner/identify`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ target: { frequencyHz: 161_150_000 } }),
		})
		expect(res.status).toBe(201)
		const job = (await res.json()) as ScanJob
		const final = (
			await inbox.next(
				m =>
					m.type === "scanner:identify" &&
					(m.data as ScannerIdentifyEventData).state === "identified",
			)
		).data as ScannerIdentifyEventData
		expect(final).toMatchObject({
			jobId: job.id,
			targetHz: 161_150_000,
			result: {
				protocol: "dmr",
				confidence: "decoded",
				identity: { kind: "dmr-cc", value: "1" },
			},
		})
		const states = inbox.messages
			.filter(m => m.type === "scanner:identify")
			.map(m => (m.data as ScannerIdentifyEventData).state)
		expect(states[0]).toBe("waiting-for-signal")
		expect(states).toContain("trying")
		// a real core's order: waiting-for-signal, then the job turns running
		const ofJob = inbox.messages.filter(
			m =>
				(m.type === "scanner:identify" &&
					(m.data as ScannerIdentifyEventData).jobId === job.id) ||
				(m.type === "scanner:job" && (m.data as ScanJob).id === job.id),
		)
		expect(ofJob[0]?.type).toBe("scanner:identify")
		const running = ofJob.find(m => m.type === "scanner:job")
		expect((running?.data as ScanJob | undefined)?.state).toBe("running")
		expect((running?.data as ScanJob | undefined)?.startedAt).toBeDefined()
		const output = await inbox.next(m => m.type === "decoder:output")
		expect(output.channel).toBe("decoders")
		const fed = await inbox.next(m => m.type === "activity:records")
		expect((fed.data as { id: string }).id).toBe("feed")
		socket.close()
	})

	it("serves a streaming WAV while live audio runs", async () => {
		// stopped: the core's audio server is not listening, so the request fails outright
		await expect(fetch(`${audio}/stream.wav`)).rejects.toThrow()
		await fetch(`${api}/api/live-audio/start`, { method: "POST" })
		const controller = new AbortController()
		const res = await fetch(`${audio}/stream.wav`, {
			signal: controller.signal,
		})
		expect(res.status).toBe(200)
		expect(res.headers.get("x-sample-rate")).toBe("16000")
		// like a legacy core since WG7: wildcard CORS, headers exposed, no credentials
		expect(res.headers.get("access-control-allow-origin")).toBe("*")
		expect(res.headers.get("access-control-allow-credentials")).toBeNull()
		expect(res.headers.get("access-control-expose-headers")).toContain(
			"X-Sample-Rate",
		)
		const reader = res.body?.getReader()
		const chunk = await reader?.read()
		const head = Buffer.from(chunk?.value ?? new Uint8Array())
		expect(head.subarray(0, 4).toString("ascii")).toBe("RIFF")
		expect(head.readUInt32LE(24)).toBe(16_000)
		controller.abort()
		await fetch(`${api}/api/live-audio/stop`, { method: "POST" })
	})

	it("answers a CORS preflight on stream paths only, as a legacy core", async () => {
		const pre = await fetch(`${audio}/stream`, { method: "OPTIONS" })
		expect(pre.status).toBe(204)
		expect(pre.headers.get("access-control-allow-origin")).toBe("*")
		expect(pre.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS")
		expect(pre.headers.get("access-control-allow-headers")).toBe("Range")
		expect(pre.headers.get("access-control-max-age")).toBe("600")
		const other = await fetch(`${audio}/other`, { method: "OPTIONS" })
		expect(other.status).toBe(404)
		expect(other.headers.get("access-control-allow-origin")).toBe("*")
	})
})
