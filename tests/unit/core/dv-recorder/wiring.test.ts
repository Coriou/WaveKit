/**
 * Real wiring, a clear digital-voice call to a playable, linked recording and back, through
 * every real serializer: the recorder wiring as src/index.ts composes it (its catalogue source,
 * decoder ids and linker), driven by a fake call tap and decoder outputs published as
 * DecoderManager publishes them; the production Activity runtime (inline store and reader); the
 * recordings catalogue and keep service; the recordings and Activity REST routes (Fastify
 * inject); the Activity WebSocket hub and its frame serializer; the link sweep. An encrypted call
 * leaves no file and no link. Real clock, fs and SQLite; synthetic audio and ids only.
 */
import { EventEmitter } from "node:events"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Fastify from "fastify"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import { activityRoutes } from "../../../../src/api/routes/activity.js"
import {
	recordingRoutes,
	type RecordingRoutesOptions,
} from "../../../../src/api/routes/recordings.js"
import {
	createActivitySubscriptions,
	type ActivityWireMessage,
} from "../../../../src/api/activity-subscriptions.js"
import { createCallRecordingLinker } from "../../../../src/core/activity/ingress.js"
import { wireRecordingLinks } from "../../../../src/core/activity/recording-links.js"
import { startActivityRuntime } from "../../../../src/core/activity/runtime.js"
import type { ActivityRuntime } from "../../../../src/core/activity/runtime.js"
import { DV_TAP_SETTLE_MS } from "../../../../src/core/dv-tap/types.js"
import {
	createDvCallRecorderWiring,
	dvCallDecoderIds,
	dvCallTapSourceOf,
} from "../../../../src/core/dv-recorder/wiring.js"
import { createRecordingInventory } from "../../../../src/core/recordings/inventory.js"
import { openRecordingKeepService } from "../../../../src/core/recordings/keep-service.js"
import { DvRecordCallsConfigSchema } from "../../../../src/config.js"
import type { ActivityPublisher } from "../../../../src/decoders/manager.js"
import type { DecoderOutput } from "../../../../src/decoders/types.js"
import { recordingDsdFmeDirs } from "../../../../src/index.js"
import { FakeCall, FakeTapSource, GIB, fsWithFree } from "./fake-tap.js"

const logger = pino({ level: "silent" })
const realNow = (): number => performance.timeOrigin + performance.now()
const DECODER = "dsd-fme"

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c()
})

class Transport {
	readonly key = "client-1"
	sent: ActivityWireMessage[] = []
	send(m: ActivityWireMessage): boolean {
		this.sent.push(m)
		return true
	}
	close(): void {}
}

async function compose() {
	const stateDir = await mkdtemp(join(tmpdir(), "wk-dvwire-"))
	cleanups.push(() => rm(stateDir, { recursive: true, force: true }))
	const config = { id: DECODER, type: "dsd-fme", enabled: true, options: {} }
	// DecoderManager, structurally: the configured decoder, its outputs (emitted, then published).
	const manager = Object.assign(new EventEmitter(), {
		getConfiguredDecoderConfigs: () => [config],
		getAllDecoders: () => [config],
	})
	let publish: ActivityPublisher | null = null
	const emit = (output: DecoderOutput) => {
		manager.emit("decoder:output", DECODER, output)
		publish?.(DECODER, "dsd-fme", output)
	}
	const runtime: ActivityRuntime = await startActivityRuntime({
		enabled: true,
		stateDir,
		logger,
		execution: "inline",
		queryExecution: "inline",
		limits: { batchWindowMs: 0 },
		setPublisher: p => {
			publish = p
		},
		// As src/index.ts: the dsd-fme gate lists only decoders with a `-7` directory (none here).
		callRecordings: id =>
			recordingDsdFmeDirs(manager).some(d => d.decoderId === id),
	})
	cleanups.push(() => runtime.close())
	expect(runtime.status).toBe("ready")
	const recordCalls = DvRecordCallsConfigSchema.parse({})
	const tap = new FakeTapSource()
	let links: ReturnType<typeof wireRecordingLinks> | null = null
	const dir = join(stateDir, "recordings", "dv-calls")
	const inventory = createRecordingInventory({
		dsdFmeDirs: () => recordingDsdFmeDirs(manager, dir),
		dvCallDecoderIds: () => dvCallDecoderIds(manager),
		scannerRecordingsDir: () => null,
		logger,
		// A minute on: a new file is past the catalogue's in-progress wait.
		now: () => realNow() + 60_000,
		activityEventId: key => links?.activityEventId(key) ?? null,
	})
	cleanups.push(() => inventory.close?.())
	const keeps = await openRecordingKeepService({ stateDir, inventory, logger })
	cleanups.push(() => keeps.close())
	links = wireRecordingLinks({
		links: runtime.recordingLinks?.() ?? null,
		catalogue: inventory,
		logger,
		now: realNow,
		sweepMs: 3_600_000,
		missingMs: 0,
	})
	cleanups.push(() => links?.close())
	const wiring = createDvCallRecorderWiring({
		config: recordCalls,
		stateDir,
		tapSource: dvCallTapSourceOf(tap),
		inventory,
		ingress: createCallRecordingLinker({
			callRecordings: id => dvCallDecoderIds(manager).includes(id),
			link: op => runtime.recordingLinks?.()?.link(op),
		}),
		decoderIds: () => dvCallDecoderIds(manager),
		outputs: manager,
		protectionInstalled: () => true,
		logger,
		recorder: { fs: fsWithFree(() => 10 * GIB) },
	})
	cleanups.push(() => wiring.stop())
	expect(wiring.dir).toBe(dir)
	await wiring.start()
	const app = Fastify({ logger: false })
	await app.register(recordingRoutes, {
		inventory,
		authorize: () => undefined,
		authorizeMutation: () => undefined,
		keeps,
		access: {
			leaseDownload: () => ({
				kind: "attached",
				active: () => true,
				release: () => undefined,
			}),
		},
	} as unknown as RecordingRoutesOptions)
	await app.register(activityRoutes, {
		service: runtime.service,
		enabled: true,
	})
	cleanups.push(() => app.close())
	return { runtime, tap, emit, wiring, inventory, links, app, dir }
}

function callOutput(
	type: "call_start" | "call_end",
	callId: string,
	extra: Record<string, unknown> = {},
): DecoderOutput {
	return {
		timestamp: new Date(),
		decoder: DECODER,
		type,
		data: {
			callId,
			protocol: "P25",
			talkgroup: 9,
			source: 2001,
			slot: 1,
			encrypted: false,
			...(type === "call_end"
				? { duration: 1500 + DV_TAP_SETTLE_MS, flags: { encrypted: false } }
				: {}),
			...extra,
		},
	}
}

interface ListedItem {
	id: string
	key: string
	kind: string
	decoderId: string | null
	talkgroup: string | null
	source: string | null
	activityEventId?: string | null
}

describe("a clear digital-voice call to a linked recording and back", () => {
	it("records, lists, links over REST and the WebSocket, and unlinks on delete", async () => {
		const { runtime, tap, emit, wiring, inventory, links, app, dir } =
			await compose()
		const hub = createActivitySubscriptions({
			service: runtime.service,
			enabled: true,
		})
		cleanups.push(() => hub.close())
		const live = new Transport()
		hub.handleMessage(live, {
			type: "activity:subscribe",
			id: "s1",
			query: { decoderIds: [DECODER] },
		})
		await expect
			.poll(() => live.sent.some(m => m.type === "activity:progress"), {
				timeout: 5_000,
			})
			.toBe(true)
		const progress = live.sent.find(m => m.type === "activity:progress")
		const startCursor = (progress?.data as { cursor: string }).cursor
		emit(callOutput("call_start", "c-clear"))
		const call = new FakeCall(tap, { callId: "c-clear", slot: 1 })
		call.voice(1500)
		// The decoder's end row first; the tap's end follows DV_TAP_SETTLE_MS later.
		emit(callOutput("call_end", "c-clear"))
		call.voice(DV_TAP_SETTLE_MS)
		call.end()
		// The final name only (the TEMP goes once the final name holds the file).
		const finals = async () =>
			(await readdir(dir)).filter(n => !n.startsWith("TEMP_"))
		await expect.poll(finals, { timeout: 5_000 }).toHaveLength(1)
		const [name] = await finals()
		expect(name).toMatch(/_dsd-fme_GROUP_TGT_9_SRC_2001\.wav$/)
		const key = `dsd~${name}`
		const store = runtime.recordingLinks?.()
		await expect
			.poll(() => store?.recordingEventId(key), { timeout: 5_000 })
			.toBeTypeOf("string")
		const eventId = store?.recordingEventId(key)

		// GET /api/recordings: kind dv-call, the call's decoder and names, the row it links to.
		const listed = await app.inject({ method: "GET", url: "/api/recordings" })
		expect(listed.statusCode).toBe(200)
		const page = listed.json() as {
			items: ListedItem[]
			counts: { byKind: Record<string, number> }
		}
		expect(page.items).toHaveLength(1)
		const item = page.items[0]
		expect(item).toMatchObject({
			key,
			kind: "dv-call",
			decoderId: DECODER,
			talkgroup: "9",
			source: "2001",
			activityEventId: eventId,
		})
		expect(item?.id).toMatch(/^dsd:\d+~/)
		expect(page.counts.byKind["dv-call"]).toBe(1)
		const byKind = await app.inject({
			method: "GET",
			url: "/api/recordings?kind=dv-call",
		})
		expect((byKind.json() as { items: unknown[] }).items).toHaveLength(1)
		const file = await app.inject({
			method: "GET",
			url: `/api/recordings/${encodeURIComponent(item?.id ?? "")}/file`,
		})
		expect(file.statusCode).toBe(200)
		expect(file.rawPayload.subarray(0, 4).toString("ascii")).toBe("RIFF")

		// GET /api/activity: the call_end row carries `recording` with the written duration.
		const rows = await app.inject({
			method: "GET",
			url: "/api/activity?hasRecording=true",
		})
		expect(rows.statusCode).toBe(200)
		const rowItems = (
			rows.json() as {
				items: { eventId: string; recording?: unknown; title: string }[]
			}
		).items
		expect(rowItems.map(r => [r.eventId, r.recording])).toEqual([
			[eventId, { id: key, durationMs: 1500 + DV_TAP_SETTLE_MS }],
		])
		expect(rowItems[0]?.title).toBe("TG 9 · radio 2001")

		// The Activity WebSocket stream (the hub and its frame serializer): a client resuming from
		// a cursor taken before the call (a reconnect) is replayed the row with its link. A live
		// client was sent the row when it was stored, before the file existed (see `live`).
		const resumed = new Transport()
		hub.handleMessage(resumed, {
			type: "activity:subscribe",
			id: "s2",
			query: { decoderIds: [DECODER] },
			cursor: startCursor,
		})
		const records = (t: Transport) =>
			t.sent
				.filter(m => m.type === "activity:records")
				.flatMap(m => {
					const wire = JSON.parse(JSON.stringify(m)) as {
						channel: string
						data: { items: { eventId: string; recording?: unknown }[] }
					}
					expect(wire.channel).toBe("activity")
					return wire.data.items
				})
		await expect
			.poll(() => records(resumed).some(i => i.eventId === eventId), {
				timeout: 5_000,
			})
			.toBe(true)
		expect(
			records(resumed).find(i => i.eventId === eventId)?.recording,
		).toEqual({ id: key, durationMs: 1500 + DV_TAP_SETTLE_MS })
		const liveRow = records(live).find(i => i.eventId === eventId)
		expect(liveRow).toBeDefined()
		expect(liveRow?.recording).toBeUndefined()

		// DELETE: the file goes, then its link once a complete catalogue lacks it.
		const del = await app.inject({
			method: "DELETE",
			url: `/api/recordings/${encodeURIComponent(item?.id ?? "")}`,
		})
		expect(del.statusCode).toBe(200)
		expect(del.json()).toEqual({ id: item?.id, deleted: true })
		expect(await readdir(dir)).toEqual([])
		const again = await app.inject({
			method: "DELETE",
			url: `/api/recordings/${encodeURIComponent(item?.id ?? "")}`,
		})
		expect(again.statusCode).toBe(404)
		expect(again.json()).toMatchObject({
			code: "RECORDING_NOT_FOUND",
			message: "Recording not found",
		})
		inventory.invalidate?.()
		await inventory.list({})
		links.sweep()
		links.sweep()
		await expect
			.poll(() => store?.recordingEventId(key), { timeout: 5_000 })
			.toBeNull()
		const after = await app.inject({
			method: "GET",
			url: "/api/activity?hasRecording=true",
		})
		expect((after.json() as { items: unknown[] }).items).toEqual([])
		expect(wiring.recorder?.counters().recorded).toBe(1)
	}, 30_000)

	it("an encrypted call leaves no file and no link", async () => {
		const { runtime, tap, emit, wiring, app, dir } = await compose()
		emit(callOutput("call_start", "c-enc"))
		const call = new FakeCall(tap, { callId: "c-enc", slot: 2 })
		call.voice(1500)
		call.state("encrypted")
		emit(callOutput("call_end", "c-enc", { encrypted: true }))
		call.end("end", "encrypted")
		await wiring.stop()
		expect(await readdir(dir)).toEqual([])
		expect(wiring.recorder?.counters().encryptedDiscarded).toBe(1)
		const listed = await app.inject({ method: "GET", url: "/api/recordings" })
		expect((listed.json() as { items: unknown[] }).items).toEqual([])
		const rows = await app.inject({
			method: "GET",
			url: "/api/activity?hasRecording=true",
		})
		expect((rows.json() as { items: unknown[] }).items).toEqual([])
		const all = await runtime.service.search({
			query: { decoderIds: [DECODER] },
		})
		expect(all.items.length).toBeGreaterThan(0)
	}, 30_000)
})
