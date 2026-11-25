/**
 * Rule six on the recordings routes, for links that arrive after their row (review fixes of the
 * call link gate): a late file's `link-call`, the backfill of an older store, a JSON null trust
 * field, the catalogue noticing a link change, and a Kept clear call file outliving its row's
 * link. Real Activity store (inline SQLite) and link index, real catalogue over a temporary
 * dsd-fme directory, real routes and keep service. Synthetic files and rows only.
 */
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Fastify from "fastify"
import type { FastifyInstance } from "fastify"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import type {
	RecordingInventoryPage,
	RecordingsChangedEventData,
} from "@wavekit/api-types"
import {
	recordingRoutes,
	type RecordingRoutesOptions,
} from "../../../src/api/routes/recordings.js"
import { wireRecordingLinks } from "../../../src/core/activity/recording-links.js"
import type { RecordingLinkWiring } from "../../../src/core/activity/recording-links.js"
import type { ActivityRecordingLinks } from "../../../src/core/activity/runtime.js"
import type { ActivityStoreHandle } from "../../../src/core/activity/storage/contract.js"
import { openSqliteFile } from "../../../src/core/activity/storage/probe.js"
import type { DecodeEnvelope } from "../../../src/core/activity/types.js"
import type { RecordingKeepKey } from "../../../src/core/recordings/contract.js"
import { createRecordingInventory } from "../../../src/core/recordings/inventory.js"
import { RECORDING_KEEPS_MAX_ENTRIES } from "@wavekit/api-types"
import type { RecordingInventory } from "../../../src/core/recordings/inventory.js"
import { openRecordingKeepService } from "../../../src/core/recordings/keep-service.js"
import type { OpenedRecordingKeepService } from "../../../src/core/recordings/keep-service.js"
import { lateBoundRecordingProtection } from "../../../src/core/recordings/late-bound-protection.js"
import {
	envelope,
	openStore,
	roots,
	stores,
	tempDir,
} from "../core/activity/storage/helpers.js"

const logger = pino({ level: "silent" })
const BYTES = Buffer.from("RIFF-fake-wav-bytes-0123456789")

const CLEAR = "20261016_120001_01231_YSF_1_GROUP_TGT_100_SRC_2001.wav"
const UNPROVEN = "20261016_120002_01232_YSF_1_GROUP_TGT_100_SRC_2002.wav"
const NULL_FLAG = "20261016_120003_01233_YSF_1_GROUP_TGT_100_SRC_2003.wav"
const NAMES = [CLEAR, UNPROVEN, NULL_FLAG]

type Trust = "clear" | "unproven" | "null-flag"

/** A dsd-fme YSF call_end row (with its callId ref unless legacy), with its trust fields. */
function callEnd(
	callId: string,
	trust: Trust,
	extra: { wavFile?: string; late?: boolean; legacy?: boolean } = {},
): DecodeEnvelope {
	const base = envelope({
		decoderId: "dsd-a",
		outputType: "call_end",
		protocol: "ysf",
		category: "voice",
		entityKey: "talkgroup:100",
		title: "YSF TG 100",
		fields: [{ key: "talkgroup", label: "Talkgroup", value: 100 }],
		decodedData: {
			callId,
			protocol: "ysf",
			talkgroup: 100,
			duration: 2000,
			// YSF carries no privacy field: clear unless the decoder said it cannot tell.
			...(trust === "unproven" ? { encryptionKnown: false } : {}),
			...(extra.wavFile !== undefined ? { wavFile: extra.wavFile } : {}),
			// A JSON null encrypted flag: not a proof of clear (callTrustAdmits refuses it).
			...(trust === "null-flag"
				? { flags: { encrypted: null } }
				: extra.late === true
					? { flags: { wavFileUpdate: true } }
					: {}),
		},
	})
	return extra.legacy === true ? base : { ...base, refs: { callId } }
}

let app: FastifyInstance | undefined
const keepServices: OpenedRecordingKeepService[] = []
const wirings: RecordingLinkWiring[] = []
afterEach(async () => {
	for (const w of wirings.splice(0)) w.close()
	await app?.close()
	app = undefined
	await Promise.all(keepServices.splice(0).map(k => k.close()))
	await Promise.all(
		stores.splice(0).map(store => store.close().catch(() => undefined)),
	)
	await Promise.all(
		roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
	)
})

async function callDir(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "wk-call-gate-late-"))
	roots.push(root)
	const dsd = join(root, "dsd")
	await mkdir(dsd)
	const old = (Date.now() - 60_000) / 1000
	for (const name of NAMES) {
		await writeFile(join(dsd, name), BYTES)
		await utimes(join(dsd, name), old, old)
	}
	return dsd
}

interface Mounted {
	inventory: RecordingInventory
	keeps: OpenedRecordingKeepService
}

/** The catalogue, keep service and routes, wired as src/index.ts wires them. */
async function mount(
	dsd: string,
	store: ActivityStoreHandle,
	stateDir?: string,
	/** Wire the links as src/index.ts does (wireRecordingLinks) instead of a bare onLinks. */
	viaWiring = false,
): Promise<Mounted> {
	let keeps: OpenedRecordingKeepService | undefined
	let wiring: RecordingLinkWiring | undefined
	const inventory = createRecordingInventory({
		dsdFmeDirs: () => [{ decoderId: "dsd-a", dir: dsd }],
		scannerRecordingsDir: () => null,
		logger,
		protection: lateBoundRecordingProtection(() => keeps),
		// As src/index.ts: through the wiring's return value once it is stored.
		activityEventId: viaWiring
			? key => wiring?.activityEventId(key) ?? null
			: key => store.recordingEventId?.(key) ?? null,
	})
	keeps = await openRecordingKeepService({
		stateDir: stateDir ?? (await tempDir()),
		inventory,
		logger,
	})
	keepServices.push(keeps)
	if (viaWiring) {
		wiring = wireRecordingLinks({
			links: storeLinks(store),
			catalogue: inventory,
			logger,
		})
		wirings.push(wiring)
	} else
		// MAIN-NEEDED wiring (recording-links.ts): link changes reach the catalogue.
		store.onLinks?.(events =>
			inventory.linksChanged?.(events.map(e => e.recordingId)),
		)
	app = Fastify({ logger: false })
	await app.register(recordingRoutes, {
		inventory,
		authorize: () => undefined,
		access: {
			leaseDownload: () => ({
				kind: "attached",
				active: () => true,
				release: () => {},
			}),
		},
	} as RecordingRoutesOptions)
	await app.ready()
	return { inventory, keeps }
}

/** The store's link surface as ActivityRuntime.recordingLinks() hands it to the wiring. */
function storeLinks(store: ActivityStoreHandle): ActivityRecordingLinks {
	return {
		admitRecording: () => undefined,
		link: op => store.link?.(op),
		recordingEventId: key => store.recordingEventId?.(key) ?? null,
		linkedRecordings: () => store.linkedRecordings?.() ?? [],
		onLinks: listener => store.onLinks?.(listener) ?? (() => undefined),
	}
}

async function listedIds(): Promise<string[]> {
	const res = await app!.inject({ method: "GET", url: "/api/recordings" })
	expect(res.statusCode).toBe(200)
	const page = res.json<RecordingInventoryPage>()
	const body = JSON.stringify(page)
	for (const name of [UNPROVEN, NULL_FLAG])
		if (!page.items.some(i => i.key === `dsd~${name}`))
			expect(body).not.toContain(name)
	return page.items.map(i => i.id)
}

async function fileStatus(id: string): Promise<number> {
	const res = await app!.inject({
		method: "GET",
		url: `/api/recordings/${encodeURIComponent(id)}/file`,
	})
	return res.statusCode
}

async function expectOnlyClear(): Promise<void> {
	expect(await listedIds()).toEqual([`dsd:0~${CLEAR}`])
	expect(await fileStatus(`dsd:0~${CLEAR}`)).toBe(200)
	expect(await fileStatus(`dsd~${CLEAR}`)).toBe(200)
	for (const name of [UNPROVEN, NULL_FLAG]) {
		expect(await fileStatus(`dsd:0~${name}`)).toBe(404)
		expect(await fileStatus(`dsd~${name}`)).toBe(404)
	}
}

/** Rows stored without their file, then each call's late file linked (`link-call`). */
function linkLate(store: ActivityStoreHandle): void {
	const calls: [string, Trust, string][] = [
		["c-1", "clear", CLEAR],
		["c-2", "unproven", UNPROVEN],
		["c-3", "null-flag", NULL_FLAG],
	]
	for (const [callId, trust] of calls) store.admit(callEnd(callId, trust))
	for (const [callId, , name] of calls)
		store.link?.({
			type: "link-call",
			decoderId: "dsd-a",
			callId,
			recording: { id: `dsd~${name}`, durationMs: 2000 },
		})
}

describe("recordings routes: late and backfilled call links pass the same gate", () => {
	it("a link-call of an unproven call is refused, of a clear call admitted", async () => {
		const dsd = await callDir()
		const store = await openStore()
		linkLate(store)
		await mount(dsd, store)
		await expectOnlyClear()
		// Refused links stay indexed (the sweep still drops them with their file).
		expect(store.linkedRecordings?.()).toEqual(
			expect.arrayContaining([`dsd~${UNPROVEN}`, `dsd~${NULL_FLAG}`]),
		)
	})

	it("a link-call answers the same after a store reopen", async () => {
		const dsd = await callDir()
		const stateDir = await tempDir()
		const first = await openStore({ stateDir })
		linkLate(first)
		await first.close()
		const second = await openStore({ stateDir })
		await mount(dsd, second)
		await expectOnlyClear()
	})

	it("a JSON null encrypted flag is refused at commit and after a reopen", async () => {
		const dsd = await callDir()
		const stateDir = await tempDir()
		const first = await openStore({ stateDir })
		first.admit(callEnd("c-1", "clear"), undefined, {
			id: `dsd~${CLEAR}`,
			durationMs: 2000,
		})
		first.admit(callEnd("c-3", "null-flag"), undefined, {
			id: `dsd~${NULL_FLAG}`,
			durationMs: 2000,
		})
		expect(first.recordingEventId?.(`dsd~${NULL_FLAG}`)).toBeNull()
		await first.close()
		const second = await openStore({ stateDir })
		expect(second.recordingEventId?.(`dsd~${NULL_FLAG}`)).toBeNull()
		expect(second.recordingEventId?.(`dsd~${CLEAR}`)).not.toBeNull()
		await mount(dsd, second)
		await expectOnlyClear()
	})

	it("the backfill admits a clear call's file and no unproven one, live and after a reopen", async () => {
		const dsd = await callDir()
		const stateDir = await tempDir()
		const first = await openStore({ stateDir })
		// Rows of an older core: no callId ref, the file in the data (late for c-2).
		first.admit(
			callEnd("c-1", "clear", { wavFile: `/calls/${CLEAR}`, legacy: true }),
		)
		first.admit(callEnd("c-2", "unproven", { legacy: true }))
		first.admit(
			callEnd("c-2", "clear", {
				wavFile: `/calls/${UNPROVEN}`,
				late: true,
				legacy: true,
			}),
		)
		first.admit(
			callEnd("c-3", "null-flag", {
				wavFile: `/calls/${NULL_FLAG}`,
				legacy: true,
			}),
		)
		await first.close()
		const db = await openSqliteFile(first.dbPath)
		db.prepare("UPDATE store_meta SET value = '0' WHERE key = ?").run(
			"recordingLinkBackfill",
		)
		db.close()
		const second = await openStore({ stateDir })
		await mount(dsd, second)
		await expectOnlyClear()
		await app?.close()
		app = undefined
		await second.close()
		const third = await openStore({ stateDir })
		await mount(dsd, third)
		await expectOnlyClear()
	})
})

describe("recordings catalogue: a link change is a listing change", () => {
	it("a clear link committed after the file was indexed bumps the revision and notifies", async () => {
		const dsd = await callDir()
		const store = await openStore()
		store.admit(callEnd("c-1", "clear"))
		const { inventory } = await mount(dsd, store)
		expect(await listedIds()).toEqual([])
		const before = inventory.status?.().revision ?? 0
		const notices: RecordingsChangedEventData[] = []
		inventory.onChange?.(e => notices.push(e))
		store.link?.({
			type: "link-call",
			decoderId: "dsd-a",
			callId: "c-1",
			recording: { id: `dsd~${CLEAR}`, durationMs: 2000 },
		})
		await expect
			.poll(() => notices.length, { timeout: 5_000 })
			.toBeGreaterThan(0)
		expect(inventory.status?.().revision ?? 0).toBeGreaterThan(before)
		expect(notices[0]?.changed).toBeGreaterThan(0)
		expect(await listedIds()).toEqual([`dsd:0~${CLEAR}`])
	})

	it("a link change of a key the catalogue does not index changes nothing", async () => {
		const dsd = await callDir()
		const store = await openStore()
		const { inventory } = await mount(dsd, store)
		await listedIds()
		const before = inventory.status?.().revision ?? 0
		inventory.linksChanged?.([
			"dsd~20261016_120009_01239_YSF_1_GROUP_TGT_100_SRC_2009.wav",
			"scan:d_01JTESTDISCOVERY~analog-x.wav",
		])
		expect(inventory.status?.().revision ?? 0).toBe(before)
	})
})

describe("recordings keep: a Kept clear call file outlives its link", () => {
	it("stays listed and served after its link is gone, also after a keep service reopen", async () => {
		const dsd = await callDir()
		const store = await openStore()
		const keepDir = await tempDir()
		store.admit(callEnd("c-1", "clear"), undefined, {
			id: `dsd~${CLEAR}`,
			durationMs: 2000,
		})
		const { keeps } = await mount(dsd, store, keepDir)
		await expect(keeps.keep(`dsd:0~${CLEAR}`)).resolves.toMatchObject({
			kept: true,
		})
		// The row's link goes (its row pruned, or the sweep): the keep's verdict holds.
		store.link?.({ type: "unlink", recordingIds: [`dsd~${CLEAR}`] })
		await expect
			.poll(() => store.recordingEventId?.(`dsd~${CLEAR}`) ?? null)
			.toBeNull()
		expect(await listedIds()).toEqual([`dsd:0~${CLEAR}`])
		expect(await fileStatus(`dsd~${CLEAR}`)).toBe(200)
		await app?.close()
		app = undefined
		await mount(dsd, store, keepDir)
		expect(await listedIds()).toEqual([`dsd:0~${CLEAR}`])
		expect(await fileStatus(`dsd:0~${CLEAR}`)).toBe(200)
	})

	it("an unproven call's file cannot be kept (404)", async () => {
		const dsd = await callDir()
		const store = await openStore()
		store.admit(callEnd("c-2", "unproven"), undefined, {
			id: `dsd~${UNPROVEN}`,
			durationMs: 2000,
		})
		const { keeps } = await mount(dsd, store)
		await expect(keeps.keep(`dsd:0~${UNPROVEN}`)).rejects.toMatchObject({
			code: "RECORDING_NOT_FOUND",
			status: 404,
		})
		expect(keeps.isCallClearKept?.(`dsd~${UNPROVEN}`)).toBe(false)
		expect(await listedIds()).toEqual([])
	})

	it("a keep made before the verdict was recorded admits nothing once unlinked", async () => {
		const dsd = await callDir()
		const store = await openStore()
		const keepDir = await tempDir()
		// A keep file of an older core: no callClear on the entry.
		await writeFile(
			join(keepDir, "recording-keeps.json"),
			`${JSON.stringify({
				schemaVersion: 1,
				revision: 1,
				keeps: [
					{
						key: `dsd~${CLEAR}`,
						keptAt: "2026-10-16T12:00:00.000Z",
						bytes: BYTES.length,
					},
				],
			})}\n`,
			{ mode: 0o600 },
		)
		const { keeps } = await mount(dsd, store, keepDir)
		expect(keeps.state()).toBe("ready")
		expect(keeps.isProtected(`dsd~${CLEAR}` as RecordingKeepKey)).toBe(true)
		expect(keeps.isCallClearKept?.(`dsd~${CLEAR}`)).toBe(false)
		expect(await listedIds()).toEqual([])
		expect(await fileStatus(`dsd~${CLEAR}`)).toBe(404)
	})
})

describe("recordings keep: the one-time stamp of keeps made before the verdict", () => {
	/** A keep file of an older core: no callClear on any entry. */
	async function legacyKeeps(keepDir: string, names: string[]): Promise<void> {
		await writeFile(
			join(keepDir, "recording-keeps.json"),
			`${JSON.stringify({
				schemaVersion: 1,
				revision: 1,
				keeps: names.map(name => ({
					key: `dsd~${name}`,
					keptAt: "2026-10-16T12:00:00.000Z",
					bytes: BYTES.length,
				})),
			})}\n`,
			{ mode: 0o600 },
		)
	}

	async function keepFile(keepDir: string): Promise<{
		revision: number
		keeps: { key: string; callClear?: true }[]
	}> {
		return JSON.parse(
			await readFile(join(keepDir, "recording-keeps.json"), "utf8"),
		) as { revision: number; keeps: { key: string; callClear?: true }[] }
	}

	it("stamps an admitted keep once the links loaded: it outlives its link; an unproven keep stays hidden", async () => {
		const dsd = await callDir()
		const store = await openStore()
		const keepDir = await tempDir()
		await legacyKeeps(keepDir, [CLEAR, UNPROVEN])
		// Links loaded at open (inline): a clear row links CLEAR, an unproven one UNPROVEN.
		store.admit(callEnd("c-1", "clear"), undefined, {
			id: `dsd~${CLEAR}`,
			durationMs: 2000,
		})
		store.admit(callEnd("c-2", "unproven"), undefined, {
			id: `dsd~${UNPROVEN}`,
			durationMs: 2000,
		})
		const { keeps, inventory } = await mount(dsd, store, keepDir, true)
		await expect
			.poll(() => keeps.isCallClearKept?.(`dsd~${CLEAR}`) ?? false)
			.toBe(true)
		expect(keeps.isCallClearKept?.(`dsd~${UNPROVEN}`)).toBe(false)
		const stamped = await keepFile(keepDir)
		expect(stamped.revision).toBe(2)
		expect(stamped.keeps).toEqual([
			expect.objectContaining({ key: `dsd~${CLEAR}`, callClear: true }),
			expect.not.objectContaining({ callClear: true }),
		])
		// Idempotent: a second load or a link change of these keys writes nothing.
		inventory.linksLoaded?.()
		inventory.linksChanged?.([`dsd~${CLEAR}`, `dsd~${UNPROVEN}`])
		await expect(
			keeps.stampCallClear?.(() => true, [`dsd~${CLEAR}`]),
		).resolves.toBe(0)
		expect((await keepFile(keepDir)).revision).toBe(2)
		// The rows go (pruned): the stamped keep stays listed, served and keepable.
		store.link?.({
			type: "unlink",
			recordingIds: [`dsd~${CLEAR}`, `dsd~${UNPROVEN}`],
		})
		await expect
			.poll(() => store.recordingEventId?.(`dsd~${CLEAR}`) ?? null)
			.toBeNull()
		expect(await listedIds()).toEqual([`dsd:0~${CLEAR}`])
		expect(await fileStatus(`dsd:0~${CLEAR}`)).toBe(200)
		expect(await fileStatus(`dsd~${CLEAR}`)).toBe(200)
		await expect(keeps.keep(`dsd:0~${CLEAR}`)).resolves.toMatchObject({
			kept: true,
			changed: false,
		})
		// The unproven keep: still protected, never listed, served nor answered by Keep.
		expect(keeps.isProtected(`dsd~${UNPROVEN}` as RecordingKeepKey)).toBe(true)
		expect(await fileStatus(`dsd~${UNPROVEN}`)).toBe(404)
		await expect(keeps.keep(`dsd:0~${UNPROVEN}`)).rejects.toMatchObject({
			status: 404,
		})
		expect((await keepFile(keepDir)).keeps[1]).not.toHaveProperty("callClear")
	})

	it("stamps a keep named deep in a links reset (past the keep cap), as a threaded writer sends it", async () => {
		const dsd = await callDir()
		const store = await openStore()
		const keepDir = await tempDir()
		await legacyKeeps(keepDir, [CLEAR])
		const { keeps } = await mount(dsd, store, keepDir, true)
		// A reset names every link, newest first: the old keep's link sits after
		// RECORDING_KEEPS_MAX_ENTRIES other keys.
		const reset = Array.from(
			{ length: RECORDING_KEEPS_MAX_ENTRIES + 10 },
			(_, i) => `dsd~other-${i}.wav`,
		)
		reset.push(`dsd~${CLEAR}`)
		await expect(
			keeps.stampCallClear?.(key => key === `dsd~${CLEAR}`, reset),
		).resolves.toBe(1)
		expect(keeps.isCallClearKept?.(`dsd~${CLEAR}`)).toBe(true)
	})

	it("stamps a keep whose clear link arrives later, and fails closed on a throwing gate", async () => {
		const dsd = await callDir()
		const store = await openStore()
		const keepDir = await tempDir()
		await legacyKeeps(keepDir, [CLEAR])
		store.admit(callEnd("c-1", "clear"))
		const { keeps } = await mount(dsd, store, keepDir, true)
		await expect(
			keeps.stampCallClear?.(() => {
				throw new Error("gate")
			}),
		).resolves.toBe(0)
		expect((await keepFile(keepDir)).revision).toBe(1)
		expect(keeps.isCallClearKept?.(`dsd~${CLEAR}`)).toBe(false)
		store.link?.({
			type: "link-call",
			decoderId: "dsd-a",
			callId: "c-1",
			recording: { id: `dsd~${CLEAR}`, durationMs: 2000 },
		})
		await expect
			.poll(() => keeps.isCallClearKept?.(`dsd~${CLEAR}`) ?? false)
			.toBe(true)
		expect((await keepFile(keepDir)).revision).toBe(2)
	})
})
