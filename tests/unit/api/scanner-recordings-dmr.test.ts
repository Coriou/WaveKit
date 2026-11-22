/**
 * Scanner probes run dsd-fme in auto mode, so a probe may write DMR per-call files into a
 * discovery's dv folder. While DMR recordings are off, such a file (and one whose name carries
 * no protocol) is never served, linked or listed by the scanner; it stays on disk. So is a P25,
 * NXDN, dPMR or ProVoice call file: such a call is clear only on its own clear print, which the
 * file does not carry. YSF and D-STAR call files and analog recordings are unchanged.
 */
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Fastify from "fastify"
import { afterEach, describe, expect, it } from "vitest"
import {
	scannerRoutes,
	type ScannerRouteService,
} from "../../../src/api/routes/scanner.js"
import { DiscoveryStore } from "../../../src/core/scanner/store/discovery-store.js"
import { EvidenceStore } from "../../../src/core/scanner/store/evidence-store.js"
import type { StorageCaps } from "../../../src/core/scanner/store/evidence-store.js"
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

/** A probe folder holding DMR, protocol-less, P25 and YSF call files of one discovery's calls. */
async function linkedProbe(root: string, store: EvidenceStore) {
	const dmr = call(T0 + 1_000, "DMR_CC_1", "1234")
	const unnamed = call(T0 + 2_000, "", "1235")
	const ysf = call(T0 + 3_000, "YSF", "1236")
	const p25 = call(T0 + 4_000, "P25_1A3", "1237")
	const probe = join(root, "recordings", "dv", "probe-scn-abc-auto-1")
	await mkdir(probe, { recursive: true })
	for (const f of [dmr, ysf, p25])
		await writeFile(join(probe, f), Buffer.alloc(1_000, 1))
	const result = await store.linkProbeRecordings(
		probe,
		[
			{ id: "o-dmr", src: "1234", at: T0 + 500 },
			{ id: "o-ysf", src: "1236", at: T0 + 2_500 },
			{ id: "o-p25", src: "1237", at: T0 + 3_500 },
		].map(o => ({
			observationId: o.id,
			discoveryId: "d_1",
			talkgroup: "9",
			source: o.src,
			startedAt: o.at,
			endedAt: o.at + 1_000,
			encrypted: false,
		})),
	)
	// A protocol-less call file is never moved out of a probe folder; one already in the
	// discovery's folder (an older core) is refused all the same.
	await writeFile(
		join(root, "recordings", "dv", "d_1", unnamed),
		Buffer.alloc(1_000, 1),
	)
	return { dmr, unnamed, p25, ysf, result }
}

describe("scanner DMR probe call files", () => {
	it("are never resolved by the evidence store, though moved and kept on disk; a P25 call file neither, YSF resolves", async () => {
		const root = await tempRoot()
		const store = evidence(root)
		const { dmr, unnamed, p25, ysf, result } = await linkedProbe(root, store)
		// The store moves every call; the service links only an id recordingPath resolves.
		expect(result.linked.map(l => l.observationId).sort()).toEqual([
			"o-dmr",
			"o-p25",
			"o-ysf",
		])
		const folder = join(root, "recordings", "dv", "d_1")
		for (const name of [dmr, unnamed, p25]) {
			expect(store.recordingPath(`d_1~${name}`)).toBeNull()
			expect(existsSync(join(folder, name))).toBe(true)
		}
		expect(store.recordingPath(`d_1~${ysf}`)).toBe(join(folder, ysf))
	})

	it("GET /api/scanner/recordings/:recordingId answers 404 for a DMR, P25 or protocol-less call, 200 for YSF", async () => {
		const root = await tempRoot()
		const store = evidence(root)
		const { dmr, unnamed, p25, ysf } = await linkedProbe(root, store)
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
			expect((await get(dmr)).statusCode).toBe(404)
			expect((await get(unnamed)).statusCode).toBe(404)
			expect((await get(p25)).statusCode).toBe(404)
			const ok = await get(ysf)
			expect(ok.statusCode).toBe(200)
			expect(ok.headers["content-type"]).toContain("audio/wav")
			expect(ok.rawPayload.length).toBe(1_000)
		} finally {
			await app.close()
		}
	})

	it("a discovery's observations list no DMR, P25 or protocol-less call recording id", () => {
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
		expect(first?.recordingIds).toEqual([`${a}~${ysf}`, `${a}~${analog}`])
		expect(first?.recording).toBe("linked")
		const [second] = store.observations(b, null, 100).items
		expect(second?.recordingIds).toEqual([])
		expect(second?.recording).toBe("none")
	})
})
