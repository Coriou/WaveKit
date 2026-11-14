/**
 * Contract: the web's SpectrumSocket (web/src/spectrum/socket.ts, the code the spectrum worker runs)
 * against the real core (harness.ts: src/index.ts with its Fastify server and `/ws` broadcaster, fed
 * by an rtl_tcp fake in this process, all on 127.0.0.1). After each event the page lives through (a
 * receiver pause and resume, told to the socket or missed; a receiver reconnect; a dropped socket;
 * a retune or a sample-rate change; the scanner holding the engine as in production), the core must
 * count a spectrum subscriber and fresh live frames must arrive within 10 s.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SpectrumLinkState } from "../../src/spectrum/protocol.ts"
import { SpectrumSocket, wsUrlFrom } from "../../src/spectrum/socket.ts"
import {
	startDropProxy,
	startRealCore,
	within,
	type DropProxy,
	type RealCore,
} from "./harness.ts"

const RECOVER_MS = 10_000

let core: RealCore
/** The page's path to the core: dropping it closes the page's socket. */
let proxy: DropProxy

beforeAll(async () => {
	// the scanner on, as in production: its job holds the spectrum engine through pauses
	core = await startRealCore({ scanner: true })
	proxy = await startDropProxy(core.apiPort)
}, 90_000)

afterAll(async () => {
	await proxy?.close()
	await core?.stop()
}, 30_000)

interface Client {
	socket: SpectrumSocket
	/** Date.now() of each live (not backfill, not snapshot) frame. */
	live: number[]
	states: SpectrumLinkState[]
	freshSince(t: number): boolean
}

function client(): Client {
	const live: number[] = []
	const states: SpectrumLinkState[] = []
	const socket = new SpectrumSocket(
		wsUrlFrom(proxy.base),
		{
			message: msg => {
				if (
					msg.type === "spectrum:frame" &&
					msg.data.sourceId === "rtl" &&
					msg.data.snapshot !== true &&
					msg.data.backfill !== true
				)
					live.push(Date.now())
			},
			state: s => states.push(s),
		},
		// the session route answers 200 in legacy access; keep the probe off the network anyway
		{ authProbe: () => Promise.resolve({ lost: false, status: 200 }) },
	)
	socket.setSubscription({ sourceId: "rtl", hz: 10, backfillMs: 2000 })
	return {
		socket,
		live,
		states,
		freshSince: t => live.some(at => at > t),
	}
}

/** Subscribed on the core and live frames newer than `t` within RECOVER_MS. */
async function recovers(c: Client, t: number): Promise<void> {
	const fresh = await within(RECOVER_MS, () => c.freshSince(t))
	const subscribers = await core.subscribers()
	expect(
		{ fresh, subscribers: subscribers >= 1 },
		core.output().slice(-3000),
	).toEqual({ fresh: true, subscribers: true })
}

async function feed(): Promise<string | undefined> {
	const rows = (await core.get("/api/sources")) as {
		id: string
		feed?: { state: string }
	}[]
	return rows.find(r => r.id === "rtl")?.feed?.state
}

describe("SpectrumSocket against the real core", () => {
	it("streams, then recovers after a pause and resume the page was told of", async () => {
		const c = client()
		try {
			await recovers(c, 0)
			expect((await core.post("/api/sources/rtl/pause")).status).toBe(200)
			c.socket.setSourcePaused(true)
			await within(3000, async () => (await feed()) === "paused")
			const t = Date.now()
			expect((await core.post("/api/sources/rtl/resume")).status).toBe(200)
			c.socket.setSourcePaused(false)
			await recovers(c, t)
		} finally {
			c.socket.dispose()
		}
	}, 60_000)

	it("recovers after a pause and resume the page never heard of", async () => {
		const c = client()
		try {
			await recovers(c, 0)
			expect((await core.post("/api/sources/rtl/pause")).status).toBe(200)
			await within(3000, async () => (await feed()) === "paused")
			// paused for longer than the stall timeout: the socket resubscribes into a stopped stream
			await new Promise(resolve => setTimeout(resolve, 7000))
			const t = Date.now()
			expect((await core.post("/api/sources/rtl/resume")).status).toBe(200)
			await recovers(c, t)
		} finally {
			c.socket.dispose()
		}
	}, 60_000)

	it("recovers when the page still believes the receiver paused after it resumed", async () => {
		const c = client()
		try {
			await recovers(c, 0)
			expect((await core.post("/api/sources/rtl/pause")).status).toBe(200)
			c.socket.setSourcePaused(true)
			await within(3000, async () => (await feed()) === "paused")
			const t = Date.now()
			expect((await core.post("/api/sources/rtl/resume")).status).toBe(200)
			// no setSourcePaused(false): a missed or stale feed update
			await recovers(c, t)
		} finally {
			c.socket.dispose()
		}
	}, 60_000)

	it("recovers after the receiver drops and the core reconnects it", async () => {
		const c = client()
		try {
			await recovers(c, 0)
			const before = core.upstream.connections()
			const t = Date.now()
			core.upstream.dropConnections()
			await within(RECOVER_MS, () => core.upstream.connections() > before)
			await recovers(c, t)
		} finally {
			c.socket.dispose()
		}
	}, 60_000)

	it("recovers when its socket drops during a pause and the page hears the resume", async () => {
		const c = client()
		try {
			await recovers(c, 0)
			expect((await core.post("/api/sources/rtl/pause")).status).toBe(200)
			c.socket.setSourcePaused(true)
			proxy.dropAll()
			await new Promise(resolve => setTimeout(resolve, 3000))
			const t = Date.now()
			expect((await core.post("/api/sources/rtl/resume")).status).toBe(200)
			c.socket.setSourcePaused(false)
			await recovers(c, t)
		} finally {
			c.socket.dispose()
		}
	}, 60_000)

	it("recovers when its socket drops during a pause and the page misses the resume", async () => {
		const c = client()
		try {
			await recovers(c, 0)
			expect((await core.post("/api/sources/rtl/pause")).status).toBe(200)
			c.socket.setSourcePaused(true)
			proxy.dropAll()
			await new Promise(resolve => setTimeout(resolve, 3000))
			const t = Date.now()
			expect((await core.post("/api/sources/rtl/resume")).status).toBe(200)
			// no setSourcePaused(false): the page's feed state is stale
			await recovers(c, t)
		} finally {
			c.socket.dispose()
		}
	}, 60_000)

	it("recovers after a long pause the page was told of", async () => {
		const c = client()
		try {
			await recovers(c, 0)
			expect((await core.post("/api/sources/rtl/pause")).status).toBe(200)
			c.socket.setSourcePaused(true)
			await new Promise(resolve => setTimeout(resolve, 35_000))
			const t = Date.now()
			expect((await core.post("/api/sources/rtl/resume")).status).toBe(200)
			c.socket.setSourcePaused(false)
			await recovers(c, t)
		} finally {
			c.socket.dispose()
		}
	}, 90_000)

	it("recovers after its socket drops while live", async () => {
		const c = client()
		try {
			await recovers(c, 0)
			const t = Date.now()
			proxy.dropAll()
			await recovers(c, t)
		} finally {
			c.socket.dispose()
		}
	}, 60_000)

	it("recovers after a retune and after a sample-rate change", async () => {
		const c = client()
		try {
			await recovers(c, 0)
			let t = Date.now()
			const tuned = await core.post("/api/tuner/rtl/frequency", {
				hz: 101_000_000,
			})
			expect(tuned.status, JSON.stringify(tuned.body)).toBe(200)
			await recovers(c, t)
			t = Date.now()
			const rated = await core.post("/api/tuner/rtl/sample-rate", {
				hz: 1_024_000,
			})
			expect(rated.status, JSON.stringify(rated.body)).toBe(200)
			await recovers(c, t)
		} finally {
			c.socket.dispose()
		}
	}, 60_000)
})
