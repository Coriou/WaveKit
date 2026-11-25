/**
 * Rule six on the recordings routes: a non-DMR digital call file (YSF, D-STAR) is listed by
 * GET /api/recordings and served by its file route only while a stored call row that proves its
 * call clear links that exact file, the transmissions DTO's gate (callLinkAdmits). Real Activity
 * store (inline SQLite) and its link index, real catalogue over a temporary dsd-fme directory, real
 * routes, wired as src/index.ts wires them (activityEventId → the store's recordingEventId). Rows
 * are admitted with their link directly, as a core written before the trust rule stored them.
 * Synthetic files and rows only.
 */
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Fastify from "fastify"
import type { FastifyInstance } from "fastify"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import type { RecordingInventoryPage } from "@wavekit/api-types"
import {
	recordingRoutes,
	type RecordingRoutesOptions,
} from "../../../src/api/routes/recordings.js"
import type { ActivityStoreHandle } from "../../../src/core/activity/storage/contract.js"
import { createRecordingInventory } from "../../../src/core/recordings/inventory.js"
import type { DecodeEnvelope } from "../../../src/core/activity/types.js"
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
const ENCRYPTED = "20261016_120003_01233_DSTAR_1_GROUP_TGT_100_SRC_2003.wav"
const UNLINKED = "20261016_120004_01234_YSF_1_GROUP_TGT_100_SRC_2004.wav"

type Trust = "clear" | "unproven" | "encrypted"

/** A dsd-fme call_end row of a YSF or D-STAR call, with the trust fields the decoder writes. */
function callEnd(
	callId: string,
	protocol: string,
	trust: Trust,
): DecodeEnvelope {
	const base = envelope({
		decoderId: "dsd-a",
		outputType: "call_end",
		protocol,
		category: "voice",
		entityKey: "talkgroup:100",
		title: `${protocol} TG 100`,
		fields: [{ key: "talkgroup", label: "Talkgroup", value: 100 }],
		decodedData: {
			callId,
			protocol,
			talkgroup: 100,
			duration: 2000,
			// YSF and D-STAR carry no privacy field: clear unless the decoder said it cannot tell.
			...(trust === "unproven" ? { encryptionKnown: false } : {}),
			...(trust === "encrypted"
				? { encrypted: true, encryptionKnown: true }
				: {}),
		},
	})
	return { ...base, refs: { callId } }
}

let app: FastifyInstance | undefined
afterEach(async () => {
	await app?.close()
	app = undefined
	await Promise.all(
		stores.splice(0).map(store => store.close().catch(() => undefined)),
	)
	await Promise.all(
		roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
	)
})

async function callDir(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "wk-call-gate-"))
	roots.push(root)
	const dsd = join(root, "dsd")
	await mkdir(dsd)
	const old = (Date.now() - 60_000) / 1000
	for (const name of [CLEAR, UNPROVEN, ENCRYPTED, UNLINKED]) {
		await writeFile(join(dsd, name), BYTES)
		await utimes(join(dsd, name), old, old)
	}
	return dsd
}

async function mount(dsd: string, store: ActivityStoreHandle): Promise<void> {
	const inventory = createRecordingInventory({
		dsdFmeDirs: () => [{ decoderId: "dsd-a", dir: dsd }],
		scannerRecordingsDir: () => null,
		logger,
		// As src/index.ts: the catalogue reads the store's link index (recordingLinks wiring).
		activityEventId: key => store.recordingEventId?.(key) ?? null,
	})
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
}

async function listed(): Promise<RecordingInventoryPage> {
	const res = await app!.inject({ method: "GET", url: "/api/recordings" })
	expect(res.statusCode).toBe(200)
	return res.json<RecordingInventoryPage>()
}

async function fileStatus(id: string): Promise<number> {
	const res = await app!.inject({
		method: "GET",
		url: `/api/recordings/${encodeURIComponent(id)}/file`,
	})
	if (res.statusCode !== 200) {
		for (const name of [UNPROVEN, ENCRYPTED, UNLINKED])
			expect(res.body).not.toContain(name)
	}
	return res.statusCode
}

/** Clear, unproven and encrypted rows, each linked to its own file; UNLINKED has no row. */
function admitRows(store: ActivityStoreHandle): void {
	store.admit(callEnd("c-1", "ysf", "clear"), undefined, {
		id: `dsd~${CLEAR}`,
		durationMs: 2000,
	})
	store.admit(callEnd("c-2", "ysf", "unproven"), undefined, {
		id: `dsd~${UNPROVEN}`,
		durationMs: 2000,
	})
	store.admit(callEnd("c-3", "dstar", "encrypted"), undefined, {
		id: `dsd~${ENCRYPTED}`,
		durationMs: 2000,
	})
}

async function expectGate(): Promise<void> {
	const page = await listed()
	// Only the clear, linked call's file: no name, key or count of the others.
	expect(page.items.map(i => i.id)).toEqual([`dsd:0~${CLEAR}`])
	expect(page.items[0]?.key).toBe(`dsd~${CLEAR}`)
	expect(page.scannedFiles).toBe(1)
	expect(page.matched).toBe(1)
	expect(page.counts?.total).toBe(1)
	expect(page.counts?.bytes).toBe(BYTES.length)
	expect(page.counts?.byKind["dsd-fme-call"]).toBe(1)
	const body = JSON.stringify(page)
	for (const name of [UNPROVEN, ENCRYPTED, UNLINKED])
		expect(body).not.toContain(name)
	// Clear and linked: served by its id and by its stable key.
	expect(await fileStatus(`dsd:0~${CLEAR}`)).toBe(200)
	expect(await fileStatus(`dsd~${CLEAR}`)).toBe(200)
	// Unproven, encrypted, unlinked: 404, as an unknown recording.
	for (const name of [UNPROVEN, ENCRYPTED, UNLINKED]) {
		expect(await fileStatus(`dsd:0~${name}`)).toBe(404)
		expect(await fileStatus(`dsd~${name}`)).toBe(404)
	}
}

describe("recordings routes: a digital call file only with its clear call's link", () => {
	it("lists and serves only the file a clear call row links, as stored", async () => {
		const dsd = await callDir()
		const store = await openStore()
		admitRows(store)
		await mount(dsd, store)
		await expectGate()
		// The refused links stay in the index (the sweep still drops them with their file).
		expect(store.linkedRecordings?.()).toEqual(
			expect.arrayContaining([`dsd~${UNPROVEN}`, `dsd~${ENCRYPTED}`]),
		)
	})

	it("answers the same after a reopen, from the links loaded from the store", async () => {
		const dsd = await callDir()
		const stateDir = await tempDir()
		const first = await openStore({ stateDir })
		admitRows(first)
		await first.close()
		const second = await openStore({ stateDir })
		await mount(dsd, second)
		await expectGate()
	})

	it("serves no call file at all with Activity off (no link index)", async () => {
		const dsd = await callDir()
		const inventory = createRecordingInventory({
			dsdFmeDirs: () => [{ decoderId: "dsd-a", dir: dsd }],
			scannerRecordingsDir: () => null,
			logger,
		})
		const page = await inventory.list({})
		expect(page.items).toEqual([])
		expect(page.counts?.total).toBe(0)
		expect(await inventory.open(`dsd:0~${CLEAR}`)).toBeNull()
		expect(await inventory.resolve(`dsd~${CLEAR}`)).toBeNull()
	})
})
