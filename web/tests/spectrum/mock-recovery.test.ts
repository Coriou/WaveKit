/**
 * The page's spectrum stream against the mock API (web/mock), over a real loopback socket through a
 * proxy that can drop it: the stream hints the plot derives from the mock's source rows, and the
 * worker's SpectrumSocket through pause, resume and a dropped socket. The same scenarios run against
 * the real core in tests/live-core/spectrum-recovery-contract.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type {
	ExtendedSourceStatus,
	SourceFeedResponse,
} from "@wavekit/api-types"
import { MOCK_SOURCE_ID } from "../../mock/data.ts"
import { buildMockServer, type MockServer } from "../../mock/server.ts"
import type { FeedEntry } from "../../src/features/receiver/feed.ts"
import { spectrumStream } from "../../src/plot/spectrum-stream.ts"
import { SpectrumSocket, wsUrlFrom } from "../../src/spectrum/socket.ts"
import { startDropProxy, within, type DropProxy } from "../live-core/harness.ts"

const RECOVER_MS = 10_000

let server: MockServer
let api: string
let proxy: DropProxy

beforeAll(async () => {
	server = await buildMockServer({ port: 0, resumeMs: 0 })
	const { port, apiUrl } = await server.listen()
	api = apiUrl
	proxy = await startDropProxy(port)
})

afterAll(async () => {
	await proxy?.close()
	await server?.close()
})

async function row(): Promise<ExtendedSourceStatus | undefined> {
	const res = await fetch(`${api}/api/sources`)
	const rows = (await res.json()) as ExtendedSourceStatus[]
	return rows.find(r => r.id === MOCK_SOURCE_ID)
}

async function post(op: "pause" | "resume"): Promise<SourceFeedResponse> {
	const res = await fetch(`${api}/api/sources/${MOCK_SOURCE_ID}/${op}`, {
		method: "POST",
	})
	expect(res.status).toBe(200)
	return (await res.json()) as SourceFeedResponse
}

async function subscribers(): Promise<number> {
	const res = await fetch(`${api}/api/spectrum`)
	return ((await res.json()) as { subscribers: number }).subscribers
}

function entry(feed: FeedEntry["feed"]): FeedEntry {
	return { feed, pending: null, error: null, unsaved: null, resumeKind: null }
}

describe("spectrum stream hints from the mock's source rows", () => {
	it("rests only while the receiver is paused and down, and changes on every transition", async () => {
		const live = spectrumStream(await row(), undefined, {
			frequency: 1e8,
			sampleRate: 2.4e6,
		})
		expect(live.paused).toBe(false)

		const answer = await post("pause")
		const pausedRow = await row()
		const paused = spectrumStream(pausedRow, entry(answer.feed), {
			frequency: 1e8,
			sampleRate: 2.4e6,
		})
		expect(paused.paused).toBe(true)
		expect(paused.resync).not.toBe(live.resync)

		await post("resume")
		const resumedRow = await row()
		expect(resumedRow?.connected).toBe(true)
		// this page missed the resume: its cached feed still says paused, newer than the row's
		const stale = entry({
			state: "paused",
			since: new Date(Date.now() + 60_000).toISOString(),
		})
		const resumed = spectrumStream(resumedRow, stale, {
			frequency: 1e8,
			sampleRate: 2.4e6,
		})
		expect(resumed.paused).toBe(false)
		expect(resumed.resync).not.toBe(paused.resync)

		// a retune or a sample-rate change is a resync too
		const retuned = spectrumStream(resumedRow, undefined, {
			frequency: 1.01e8,
			sampleRate: 2.4e6,
		})
		const rerated = spectrumStream(resumedRow, undefined, {
			frequency: 1.01e8,
			sampleRate: 1.024e6,
		})
		expect(new Set([live.resync, retuned.resync, rerated.resync]).size).toBe(3)
	})
})

describe("SpectrumSocket against the mock core", () => {
	function client() {
		const live: number[] = []
		const socket = new SpectrumSocket(
			wsUrlFrom(proxy.base),
			{
				message: msg => {
					if (
						msg.type === "spectrum:frame" &&
						msg.data.snapshot !== true &&
						msg.data.backfill !== true
					)
						live.push(Date.now())
				},
				state: () => undefined,
			},
			{ authProbe: () => Promise.resolve({ lost: false, status: 200 }) },
		)
		socket.setSubscription({ sourceId: MOCK_SOURCE_ID, hz: 10 })
		return { socket, freshSince: (t: number) => live.some(at => at > t) }
	}

	async function recovers(
		c: ReturnType<typeof client>,
		t: number,
	): Promise<void> {
		const fresh = await within(RECOVER_MS, () => c.freshSince(t))
		expect({ fresh, subscribed: (await subscribers()) >= 1 }).toEqual({
			fresh: true,
			subscribed: true,
		})
	}

	it("streams again after its socket drops during a pause whose resume the page missed", async () => {
		const c = client()
		try {
			await recovers(c, 0)
			await post("pause")
			c.socket.setSourcePaused(true)
			proxy.dropAll()
			await new Promise(resolve => setTimeout(resolve, 2000))
			const t = Date.now()
			await post("resume")
			// no setSourcePaused(false)
			await recovers(c, t)
		} finally {
			c.socket.dispose()
		}
	}, 30_000)

	it("streams again after a pause and resume the page heard of", async () => {
		const c = client()
		try {
			await recovers(c, 0)
			await post("pause")
			c.socket.setSourcePaused(true)
			await new Promise(resolve => setTimeout(resolve, 1000))
			const t = Date.now()
			await post("resume")
			c.socket.setSourcePaused(false)
			await recovers(c, t)
		} finally {
			c.socket.dispose()
		}
	}, 30_000)

	it("streams again after its socket drops while live", async () => {
		const c = client()
		try {
			await recovers(c, 0)
			const t = Date.now()
			proxy.dropAll()
			await recovers(c, t)
		} finally {
			c.socket.dispose()
		}
	}, 30_000)
})
