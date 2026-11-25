/**
 * Scanner probes run dsd-fme in auto mode and write one per-call file per call into the probe's
 * folder. Nothing on disk records whether a clear call (callTrustAdmits) matched a file: a P25
 * phase 1 or NXDN call is clear only with clearEvidence, P25 phase 2, dPMR, ProVoice, EDACS and
 * M17 never prove it, a call_end may omit encryptionKnown, and DMR is parked. So no probe call
 * file is linked, listed or served (fail closed): linking parks a matched clear one in its
 * discovery's folder (on disk, under the scanner retention, unnamed by any observation), deletes
 * an encrypted one, and every one there (parked, or left by an older core) is refused on every
 * route. Analog recordings are unchanged.
 */
import { existsSync } from "node:fs"
import {
	mkdir,
	mkdtemp,
	readdir,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Fastify from "fastify"
import { afterEach, describe, expect, it } from "vitest"
import {
	scannerRoutes,
	type ScannerRouteService,
} from "../../../src/api/routes/scanner.js"
import { DiscoveryStore } from "../../../src/core/scanner/store/discovery-store.js"
import type { RecordingInventoryPage } from "@wavekit/api-types"
import {
	recordingRoutes,
	type RecordingRoutesOptions,
} from "../../../src/api/routes/recordings.js"
import { createRecordingInventory } from "../../../src/core/recordings/inventory.js"
import {
	EvidenceStore,
	probeLinkCandidates,
} from "../../../src/core/scanner/store/evidence-store.js"
import type {
	ProbeLinkCall,
	StorageCaps,
} from "../../../src/core/scanner/store/evidence-store.js"
import { createLogger } from "../../../src/utils/logger.js"
import { counterIds, makeObs } from "../../mocks/scanner/observations.js"

const logger = createLogger({ level: "fatal" })
const MIB = 1024 * 1024
const CAPS: StorageCaps = {
	maxRecordingsMb: 512,
	maxEvidenceMb: 64,
	maxAgeDays: 30,
	minFreeDiskMb: 2048,
}
const plentyOfDisk = async () => ({ freeBytes: 100 * 1024 * MIB })

const pad = (n: number): string => String(n).padStart(2, "0")
function localStamp(ms: number): string {
	const d = new Date(ms)
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}
// 2026-10-17 08:15:00 local, whole second so file stamps are exact
const T0 = new Date(2026, 9, 17, 8, 15, 0).getTime()
const call = (ms: number, system: string, src: string): string =>
	`${localStamp(ms)}_12345_${system}_GROUP_TGT_9_SRC_${src}.wav`

const roots: string[] = []
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map(r => rm(r, { recursive: true, force: true })),
	)
})

async function tempRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "wk-scan-dmr-"))
	roots.push(root)
	return root
}

function evidence(root: string): EvidenceStore {
	return new EvidenceStore({
		dir: root,
		caps: CAPS,
		logger,
		now: () => T0 + 60_000,
		statfs: plentyOfDisk,
	})
}

const ANALOG = "analog-00000000-0000-4000-8000-000000000001.wav"

/**
 * A probe folder holding DMR, YSF (a call_end without encryptionKnown, which the old rule kept),
 * P25 (an encrypted call) and D-STAR call files of one discovery's calls, linked with the
 * candidates the scanner builds (probeLinkCandidates): the clear matches are parked in the
 * discovery's dv folder (aged past the catalogue's in-progress delay, so only the gate hides them).
 * Then an older core's YSF, D-STAR and protocol-less call files sit there too, and an analog file
 * in its own folder.
 */
async function linkedProbe(root: string, store: EvidenceStore) {
	const dmr = call(T0 + 1_000, "DMR_CC_1", "1234")
	const unnamed = call(T0 + 2_000, "", "1235")
	const ysf = call(T0 + 3_000, "YSF", "1236")
	const p25 = call(T0 + 4_000, "P25_1A3", "1237")
	const dstar = call(T0 + 5_000, "DSTAR", "1238")
	// An older core's files (it moved clear-matched call files in and listed them).
	const oldYsf = call(T0 + 7_000, "YSF", "1240")
	const oldDstar = call(T0 + 8_000, "DSTAR", "1241")
	const probe = join(root, "recordings", "dv", "probe-scn-abc-auto-1")
	await mkdir(probe, { recursive: true })
	for (const f of [dmr, ysf, p25, dstar])
		await writeFile(join(probe, f), Buffer.alloc(1_000, 1))
	const observation = {
		observationId: "o-1",
		discoveryId: "d_1",
		talkgroup: "9",
		source: "1238",
		startedAt: T0,
		endedAt: T0 + 6_000,
		encrypted: false,
	}
	const at = (n: number) => ({ startedAt: T0 + n, endedAt: T0 + n + 900 })
	const calls: ProbeLinkCall[] = [
		{ talkgroup: "9", source: "1234", ...at(1_000), encrypted: false },
		// The probe pool's flag for a call_end with no encryptionKnown field: not encrypted.
		{ talkgroup: "9", source: "1236", ...at(3_000), encrypted: false },
		{ talkgroup: "9", source: "1237", ...at(4_000), encrypted: true },
	]
	const result = await store.linkProbeRecordings(
		probe,
		probeLinkCandidates([observation], calls),
	)
	const folder = join(root, "recordings", "dv", "d_1")
	const parkedOnDisk = existsSync(folder) ? (await readdir(folder)).sort() : []
	await mkdir(folder, { recursive: true })
	const analog = join(root, "recordings", "analog", "d_1")
	await mkdir(analog, { recursive: true })
	const old = (Date.now() - 60_000) / 1000
	for (const f of [
		join(folder, unnamed),
		join(folder, oldYsf),
		join(folder, oldDstar),
		join(analog, ANALOG),
	])
		await writeFile(f, Buffer.alloc(1_000, 1))
	for (const name of [...parkedOnDisk, unnamed, oldYsf, oldDstar])
		await utimes(join(folder, name), old, old)
	await utimes(join(analog, ANALOG), old, old)
	const names = [dmr, unnamed, p25, ysf, dstar, oldYsf, oldDstar]
	return { dmr, ysf, dstar, names, probe, parkedOnDisk, result }
}

describe("scanner probe call files", () => {
	it("are parked from a probe, never linked, and never resolved by the evidence store", async () => {
		const root = await tempRoot()
		const store = evidence(root)
		const { dmr, ysf, dstar, names, probe, parkedOnDisk, result } =
			await linkedProbe(root, store)
		// No observation names a parked file (so no recordingIds carries it).
		expect(result.linked).toEqual([])
		// The clear matches stay on disk in the discovery's folder; the encrypted P25 one is gone.
		expect(parkedOnDisk).toEqual([dmr, dstar, ysf].sort())
		// The encrypted P25 call is still reported as such.
		expect(result.droppedEncrypted).toEqual(["o-1"])
		expect(existsSync(probe)).toBe(false)
		for (const name of names)
			expect(store.recordingPath(`d_1~${name}`)).toBeNull()
	})

	it("GET /api/scanner/recordings/:recordingId answers 404 for every probe call file", async () => {
		const root = await tempRoot()
		const store = evidence(root)
		const { names } = await linkedProbe(root, store)
		const app = Fastify({ logger: false })
		try {
			await app.register(scannerRoutes, {
				scanner: {
					recordingPath: (id: string) => store.recordingPath(id),
				} as unknown as ScannerRouteService,
			})
			const get = (name: string) =>
				app.inject({
					url: `/api/scanner/recordings/${encodeURIComponent(`d_1~${name}`)}`,
				})
			for (const name of names) expect((await get(name)).statusCode).toBe(404)
		} finally {
			await app.close()
		}
	})

	it("GET /api/recordings lists none of them and its file route serves none; analog is unchanged", async () => {
		const root = await tempRoot()
		const store = evidence(root)
		const { names, parkedOnDisk } = await linkedProbe(root, store)
		expect(parkedOnDisk).toHaveLength(3)
		const inventory = createRecordingInventory({
			// Not the gate under test: every dsd-fme call file counts as linked by a clear row.
			callFileLinked: () => true,
			dsdFmeDirs: () => [],
			scannerRecordingsDir: () => join(root, "recordings"),
			logger,
		})
		const app = Fastify({ logger: false })
		await app.register(recordingRoutes, {
			inventory,
			authorize: () => undefined,
			access: {
				leaseDownload: () => ({
					kind: "attached",
					active: () => true,
					release: () => undefined,
				}),
			},
		} as unknown as RecordingRoutesOptions)
		try {
			const list = await app.inject({ url: "/api/recordings" })
			expect(list.statusCode).toBe(200)
			expect(list.json<RecordingInventoryPage>().items.map(i => i.id)).toEqual([
				`scan:d_1~${ANALOG}`,
			])
			for (const name of names) expect(list.body).not.toContain(name)
			const file = (name: string) =>
				app.inject({
					url: `/api/recordings/${encodeURIComponent(`scan:d_1~${name}`)}/file`,
				})
			for (const name of names) expect((await file(name)).statusCode).toBe(404)
			expect((await file(ANALOG)).statusCode).toBe(200)
		} finally {
			await app.close()
		}
	})

	it("a discovery's observations list no dsd-fme call recording id", () => {
		const store = new DiscoveryStore({
			maxDiscoveries: 1_000,
			now: () => T0,
			newId: counterIds(),
			logger,
		})
		const ingest = (n: number): string =>
			store.ingest(
				makeObs({
					id: `o${n}`,
					centreHz: 430_000_000 + n * 100_000,
					startedAt: T0 + n * 1_000,
					cls: "analog-fm",
					open: false,
					gate: "passed",
				}),
			).discoveryId ?? ""
		const a = ingest(1)
		const b = ingest(2)
		expect(a).not.toBe("")
		expect(b).not.toBe("")
		const dmr = call(T0, "DMR_CC_1", "1234")
		const unnamed = call(T0, "", "1235")
		const p25 = call(T0, "P25_1A3", "1236")
		const ysf = call(T0, "YSF", "1237")
		const analog = "analog-00000000-0000-4000-8000-000000000001.wav"
		// Recording ids a store written before this rule may already hold.
		expect(
			store.attachRecordings(
				"o1",
				[
					`${a}~${dmr}`,
					`${a}~${p25}`,
					`${a}~${ysf}`,
					`${a}~${unnamed}`,
					`${a}~${analog}`,
				],
				"linked",
			),
		).toBe(true)
		expect(
			store.attachRecordings(
				"o2",
				[`${b}~${dmr}`, `${b}~${unnamed}`],
				"linked",
			),
		).toBe(true)
		const [first] = store.observations(a, null, 100).items
		expect(first?.recordingIds).toEqual([`${a}~${analog}`])
		expect(first?.recording).toBe("linked")
		const [second] = store.observations(b, null, 100).items
		expect(second?.recordingIds).toEqual([])
		expect(second?.recording).toBe("none")
	})
})
