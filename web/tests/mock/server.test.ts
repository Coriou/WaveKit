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
		expect(
			(await inject("POST", "/api/tuner/rtl-0/frequency", { hz: "x" }))
				.statusCode,
		).toBe(400)
		const range = await inject("POST", "/api/tuner/rtl-0/frequency", {
			hz: 5_000_000_000,
		})
		expect(range.statusCode).toBe(400)
		expect(range.json()).toMatchObject({ code: "TUNER_FREQUENCY_OUT_OF_RANGE" })
		const missing = await inject("GET", "/api/tuner/nope")
		expect(missing.statusCode).toBe(404)
		expect(missing.json()).toMatchObject({ code: "TUNER_SOURCE_NOT_FOUND" })
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
		expect(job).toMatchObject({
			state: "running",
			spec: { kind: "identify" },
			identify: { targets: [{ state: "waiting-for-signal" }] },
		})
		expect(
			(await inject("GET", `/api/scanner/jobs/${job.id}`)).statusCode,
		).toBe(200)
		const out = await inject("POST", "/api/scanner/identify", {
			target: { frequencyHz: 446_006_250 },
		})
		expect(out.statusCode).toBe(409)
		expect(out.json()).toMatchObject({ code: "OUT_OF_WINDOW" })
		expect(
			(await inject("POST", "/api/scanner/identify", { target: {} }))
				.statusCode,
		).toBe(400)
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
		expect(first).toMatchObject({
			snapshot: true,
			binCount: 512,
			centerHz: 161_500_000,
			startHz: 160_300_000,
			binHz: 4687.5,
			binEncoding: "u8-halfdb-127.5",
		})
		const bytes = Buffer.from(first.bins, "base64")
		expect(bytes).toHaveLength(512)
		const db = [...bytes].map(v => v / 2 - 127.5)
		const median = [...db].sort((a, b) => a - b)[256] ?? 0
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
		const output = await inbox.next(m => m.type === "decoder:output")
		expect(output.channel).toBe("decoders")
		const fed = await inbox.next(m => m.type === "activity:records")
		expect((fed.data as { id: string }).id).toBe("feed")
		socket.close()
	})

	it("serves a streaming WAV while live audio runs", async () => {
		expect((await fetch(`${audio}/stream.wav`)).status).toBe(503)
		await fetch(`${api}/api/live-audio/start`, { method: "POST" })
		const controller = new AbortController()
		const res = await fetch(`${audio}/stream.wav`, {
			signal: controller.signal,
		})
		expect(res.status).toBe(200)
		expect(res.headers.get("x-sample-rate")).toBe("16000")
		const reader = res.body?.getReader()
		const chunk = await reader?.read()
		const head = Buffer.from(chunk?.value ?? new Uint8Array())
		expect(head.subarray(0, 4).toString("ascii")).toBe("RIFF")
		expect(head.readUInt32LE(24)).toBe(16_000)
		controller.abort()
		await fetch(`${api}/api/live-audio/stop`, { method: "POST" })
	})
})
