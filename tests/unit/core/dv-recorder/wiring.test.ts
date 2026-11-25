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
import { afterEach, describe, expect, it, vi } from "vitest"
import { activityRoutes } from "../../../../src/api/routes/activity.js"
import {
	recordingRoutes,
	type RecordingRoutesOptions,
} from "../../../../src/api/routes/recordings.js"
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

// These cases exercise the dv call recorder's catalogue path, which is off in production
// (DV_CALL_RECORDINGS_SERVED: no call tap feeds the recorder yet); they pin it for its re-enable.
vi.mock("../../../../src/core/recordings/names.js", async importOriginal => ({
	...(await importOriginal<Record<string, unknown>>()),
	DV_CALL_RECORDINGS_SERVED: true,
}))

const logger = pino({ level: "silent" })
const realNow = (): number => performance.timeOrigin + performance.now()
const DECODER = "dsd-fme"

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c()
})

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
			// Known clear by its own clear print (clearEvidence): a P25 link is presented only then.
			encryptionKnown: true,
			clearEvidence: true,
			...(type === "call_end"
				? { duration: 1500 + DV_TAP_SETTLE_MS, flags: { encrypted: false } }
				: {}),
			...extra,
		},
	}
}

describe("a clear digital-voice call to a linked recording and back", () => {
	it("records a call but neither links nor serves it until the clear-call gate admits dv names", async () => {
		// The shared clear-call gate (callLinkAdmits) admits only recordable dsd-fme protocol
		// names; a dv recorder name carries the decoder id in its protocol slot, so its link is
		// refused and the file stays hidden (fail closed). The re-enable work teaches the gate dv names.
		const { runtime, tap, emit, wiring, app, dir } = await compose()
		emit(callOutput("call_start", "c-clear"))
		const call = new FakeCall(tap, { callId: "c-clear", slot: 1 })
		call.voice(1500)
		emit(callOutput("call_end", "c-clear"))
		call.voice(DV_TAP_SETTLE_MS)
		call.end()
		const finals = async () =>
			(await readdir(dir)).filter(n => !n.startsWith("TEMP_"))
		await expect.poll(finals, { timeout: 5_000 }).toHaveLength(1)
		const [name] = await finals()
		expect(name).toMatch(/_dsd-fme_GROUP_TGT_9_SRC_2001\.wav$/)
		const key = `dsd~${name}`
		const store = runtime.recordingLinks?.()
		await expect
			.poll(() => store?.linkedRecordings().includes(key), { timeout: 5_000 })
			.toBe(true)
		expect(store?.recordingEventId(key)).toBeNull()
		const listed = await app.inject({ method: "GET", url: "/api/recordings" })
		expect(listed.statusCode).toBe(200)
		expect((listed.json() as { items: unknown[] }).items).toEqual([])
		const file = await app.inject({
			method: "GET",
			url: `/api/recordings/${encodeURIComponent(key)}/file`,
		})
		expect(file.statusCode).toBe(404)
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
