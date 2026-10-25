import { describe, expect, it, vi } from "vitest"
import type { Discovery, ScannerProof } from "@wavekit/api-types"
import { EventsClient } from "../../src/data/events-client.ts"
import {
	NearDiscoveryStore,
	proofKind,
} from "../../src/data/near-discovery-store.ts"
import { json, scripted, type Call } from "./fake-fetch.ts"
import { fakeSockets } from "./fake-socket.ts"

const proof = (over: Partial<ScannerProof> = {}): ScannerProof => ({
	kind: "decoded",
	protocol: "dmr",
	transport: "ambient",
	at: "2026-10-22T10:00:00.000Z",
	observationId: "o1",
	tried: [],
	unavailable: [],
	encrypted: false,
	summary: "DMR decoded (CC1)",
	...over,
})

function discovery(id: string, over: Partial<Discovery> = {}): Discovery {
	const stats = { peakDbfs: -40, meanDbfs: -50, snrDb: 20, floorDbfs: -70 }
	return {
		id,
		frequencyHz: 446_006_250,
		frequencyKey: "446006250",
		measuredOffsetHz: 0,
		bandwidthHz: 12_500,
		protocol: "dmr",
		family: "digital-voice",
		class: "fsk4-12k5",
		confidence: "decoded",
		encrypted: false,
		coChannel: [],
		firstSeenAt: "2026-10-22T09:00:00.000Z",
		lastSeenAt: "2026-10-22T10:00:00.000Z",
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
		jobIds: [],
		tuningTrust: "commanded",
		evidence: { recordings: 0, psd: false, iq: false },
		proof: proof(),
		evidenceLevel: "proven",
		...over,
	}
}

function setup(handler: (call: Call) => Response) {
	const { api, calls } = scripted(handler)
	const sockets = fakeSockets()
	const events = new EventsClient({ createSocket: sockets.factory })
	events.connect()
	sockets.last().open()
	const store = new NearDiscoveryStore(api, events)
	const send = (data: unknown) =>
		sockets
			.last()
			.receive({ type: "scanner:discovery", channel: "scanner", data })
	return { store, calls, send }
}

const flush = () => new Promise(r => setTimeout(r, 0))

describe("NearDiscoveryStore", () => {
	it("asks for the nearest proven discovery and the latest observation's proof", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		try {
			const { store, calls } = setup(call =>
				call.url.includes("/observations")
					? json(200, {
							items: [
								{
									id: "o2",
									proof: proof({ kind: "analog-voice", protocol: "analog-fm" }),
								},
							],
							nextCursor: null,
						})
					: json(200, { items: [discovery("d1")], nextCursor: null }),
			)
			store.follow(446_006_000, 6250)
			await vi.waitFor(() => expect(store.get().status).toBe("ready"))
			const q = new URL(calls[0]!.url, "http://x").searchParams
			expect(q.get("nearHz")).toBe("446006000")
			expect(q.get("toleranceHz")).toBe("6250")
			expect(q.get("evidence")).toBe("proven")
			expect(store.get().discovery?.id).toBe("d1")
			vi.runAllTimers()
			await vi.waitFor(() =>
				expect(proofKind(store.get().lastProof)).toBe("analog"),
			)
			store.dispose()
		} finally {
			vi.useRealTimers()
		}
	})

	it("ignores an answer out of tolerance or without a proof", async () => {
		const { store } = setup(() =>
			json(200, {
				items: [discovery("far", { frequencyHz: 447_000_000 })],
				nextCursor: null,
			}),
		)
		store.follow(446_006_000, 6250)
		await vi.waitFor(() => expect(store.get().status).toBe("ready"))
		expect(store.get().discovery).toBeNull()
		store.dispose()
	})

	it("a core before WG12 (400) stops asking", async () => {
		const { store, calls } = setup(() =>
			json(400, { code: "VALIDATION_ERROR", message: "unknown query" }),
		)
		store.follow(446_006_000, 6250)
		await vi.waitFor(() => expect(store.get().status).toBe("unsupported"))
		store.follow(446_100_000, 6250)
		await flush()
		expect(calls).toHaveLength(1)
		expect(store.get().status).toBe("unsupported")
		store.dispose()
	})

	it("takes a discovery event near the followed frequency", async () => {
		const { store, send } = setup(call =>
			call.url.includes("/observations")
				? json(200, { items: [], nextCursor: null })
				: json(200, { items: [], nextCursor: null }),
		)
		store.follow(446_006_000, 6250)
		await vi.waitFor(() => expect(store.get().status).toBe("ready"))
		send({
			change: "updated",
			discovery: discovery("far", { frequencyHz: 450e6 }),
		})
		expect(store.get().discovery).toBeNull()
		send({ change: "upgraded", discovery: discovery("d2") })
		expect(store.get().discovery?.id).toBe("d2")
		send({
			change: "updated",
			discovery: {
				...discovery("weak"),
				proof: undefined,
				evidenceLevel: "weak",
			},
		})
		expect(store.get().discovery?.id).toBe("d2")
		store.dispose()
	})
})

describe("proofKind", () => {
	it("reads analog or digital from one transmission's proof", () => {
		expect(proofKind(null)).toBeNull()
		expect(
			proofKind(proof({ kind: "carrier-only", protocol: "unknown" })),
		).toBeNull()
		expect(
			proofKind(proof({ kind: "analog-tone", protocol: "analog-fm" })),
		).toBe("analog")
		expect(proofKind(proof({ kind: "decoded", protocol: "analog-fm" }))).toBe(
			"analog",
		)
		expect(proofKind(proof())).toBe("digital")
		expect(
			proofKind(proof({ kind: "digital-undecoded", protocol: "unknown" })),
		).toBe("digital")
	})
})

describe("NearDiscoveryStore: band inspection UX merges (req 3.2)", () => {
	const ok = (call: Call) =>
		call.url.includes("/observations")
			? json(200, { items: [], nextCursor: null })
			: json(200, { items: [discovery("d1")], nextCursor: null })

	it("reloads when the shown id is in a deleted event's mergedIds", async () => {
		const { store, calls, send } = setup(ok)
		store.follow(446_006_250, 6250)
		await flush()
		const before = calls.filter(c => !c.url.includes("/observations")).length
		send({
			change: "deleted",
			discovery: discovery("s"),
			mergedIds: ["d1"],
		})
		await flush()
		expect(calls.filter(c => !c.url.includes("/observations")).length).toBe(
			before + 1,
		)
		store.dispose()
	})

	it("reloads on mergedTruncated and on a resync", async () => {
		const { store, calls, send } = setup(ok)
		store.follow(446_006_250, 6250)
		await flush()
		const lists = () =>
			calls.filter(c => !c.url.includes("/observations")).length
		const before = lists()
		send({
			change: "merged",
			discovery: discovery("far", { frequencyHz: 100e6 }),
			mergedIds: ["x"],
			mergedTruncated: true,
		})
		await flush()
		expect(lists()).toBe(before + 1)
		store.dispose()
	})
})
