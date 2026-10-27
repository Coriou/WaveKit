import type { JournalEntry } from "../../../src/core/scanner/store/discovery-store.js"
import { DiscoveryStore } from "../../../src/core/scanner/store/discovery-store.js"
import { DecodeEvidenceSchema } from "../../../src/core/scanner/store/schemas.js"
import { counterIds, makeObs } from "../../mocks/scanner/observations.js"
import { readFileSync } from "node:fs"
import pino from "pino"
import fc from "fast-check"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DsdFmeDecoder } from "../../../src/decoders/builtin/dsd-fme.js"
import type { DsdFmeLinkLine } from "../../../src/decoders/builtin/dsd-fme-link.js"
import {
	type DsdFmeDecodeEvidence,
	guardDsdFmeEvidence,
	interpretDsdFme,
} from "../../../src/core/scanner/probes/confirm/dsd-fme.js"
import { createInterpreterState } from "../../../src/core/scanner/probes/confirm/double-match.js"
import {
	deriveProof,
	evidenceLevelOf,
} from "../../../src/core/scanner/proof.js"
import { DQ_DC_ADMIT_HZ } from "../../../src/core/scanner/detection-quality-contract.js"
import type { DecodeEvidence } from "../../../src/core/scanner/types.js"

const T0 = Date.parse("2026-10-23T12:00:00.123Z")
const HZ = 1_000_003
const bs = (cc: string, burst: string) =>
	`21:49:48 Sync: +DMR  [slot1]  slot2  | Color Code=${cc} | ${burst}`
const lc = " SLOT 1 TGT=9 SRC=123 Group Call "

function rig() {
	const decoder = new DsdFmeDecoder(
		{ id: "fake", type: "dsd-fme", enabled: true, options: {} },
		pino({ level: "silent" }),
	)
	const state = createInterpreterState({ epoch: 3, origin: "probe" })
	const links: DsdFmeLinkLine[] = []
	const evidence: DsdFmeDecodeEvidence[] = []
	decoder.on("link", (line: DsdFmeLinkLine) => {
		links.push(line)
		evidence.push(...interpretDsdFme({ kind: "link", line }, state))
	})
	return {
		decoder,
		links,
		evidence,
		feed(text: string, at = T0 + links.length * 1003.7) {
			vi.setSystemTime(at)
			;(
				decoder as unknown as { handleOutputLine(line: string): void }
			).handleOutputLine(text)
		},
	}
}

function proof(ev: DecodeEvidence) {
	return deriveProof({
		observationId: "synthetic",
		decodes: [
			{
				protocol: ev.protocol,
				at: ev.at,
				transport: "live",
				encrypted: ev.encrypted === true,
				...(ev.identity ? { identity: ev.identity } : {}),
				...(ev.contentVerified &&
				ev.metadata.talkgroups?.length &&
				ev.metadata.sources?.length
					? { tgSrcVerified: true }
					: {}),
				...(ev.unverifiedCc !== undefined
					? { unverifiedCc: ev.unverifiedCc }
					: {}),
			},
		],
		trials: [],
		analog: [],
		unavailable: [],
		trust: "commanded",
		digitalPlanComplete: false,
	})
}

describe("dsd-fme content verification", () => {
	beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }))
	afterEach(() => vi.useRealTimers())

	it.each(["VC*", "VC1", "VC6", "IDLE", "R12U", ""])(
		"150 %s syncs never prove an identity",
		burst => {
			const r = rig()
			for (let i = 0; i < 150; i++) r.feed(bs("03", burst), T0 + i * 1003.7)
			expect(r.links.every(l => l.verified === false)).toBe(true)
			expect(r.evidence).toHaveLength(150)
			for (const ev of r.evidence) {
				expect(ev.identity).toBeUndefined()
				const p = proof(ev)!
				expect(p.kind).toBe("digital-undecoded")
				expect(p.summary).toBe(
					"Digital, DMR-like sync, CC 3 (unverified), not decoded",
				)
				expect(evidenceLevelOf({ proof: p })).toBe("weak")
				expect(proof(guardDsdFmeEvidence(ev, HZ, HZ))?.kind).toBe(
					"digital-undecoded",
				)
			}
		},
	)

	it("keeps the most frequent unverified CC as a hint, including the exact slot2 format", () => {
		const r = rig()
		r.feed("21:49:48 Sync: +DMR   slot1  [slot2] | Color Code=07 | IDLE ")
		for (const cc of ["03", "03", "07", "03", "10", "XX"])
			r.feed(bs(cc, "IDLE"))
		expect(r.evidence.at(-1)).toMatchObject({ unverifiedCc: 3 })
		expect(r.evidence.every(e => !e.identity)).toBe(true)
	})

	it("never verifies four clean MBCC continuations", () => {
		const r = rig()
		for (let i = 0; i < 4; i++) r.feed(bs("05", "MBCC"), T0 + i * 93.7)
		expect(r.links).toHaveLength(4)
		expect(r.links.every(l => !l.verified)).toBe(true)
		expect(
			r.evidence.every(
				e => !e.identity && evidenceLevelOf({ proof: proof(e)! }) === "weak",
			),
		).toBe(true)
	})

	it.each(["VLC -RAS ", "CSBK -RAS "])("rejects RAS output %s", burst => {
		const r = rig()
		for (let i = 0; i < 4; i++) r.feed(bs("05", burst), T0 + i * 93.7)
		expect(r.links.every(l => !l.verified)).toBe(true)
		expect(r.evidence.every(e => !e.identity)).toBe(true)
	})

	it("rejects a deferred RAS error", () => {
		const r = rig()
		r.feed(bs("05", "VLC"), T0 + 3.7)
		r.feed(" -RAS ", T0 + 31.3)
		r.feed(bs("05", "IDLE"), T0 + 69.1)
		expect(r.links.every(l => !l.verified)).toBe(true)
	})

	it.each([
		" Key: 0000000000000000 0000000000000000 (CRC ERR)",
		" Key: 0000000000000000 error",
		" SLOT 1 FLCO FEC ERR",
		" SLCO CRC ERR",
		" (FEC ERR)",
		" -RAS ",
		"Sync: no sync",
		"Sync: +P25p1",
		"| Frame Sync Err: 7",
	])("rejects voice LC with a later burst failure: %s", continuation => {
		const r = rig()
		for (let i = 0; i < 2; i++) {
			const at = T0 + i * 311.7
			r.feed(bs("05", "VLC"), at + 3.7)
			r.feed(" SLOT 1 TGT=9 SRC=123 Group Encrypted", at + 19.1)
			expect(r.links.some(l => l.voiceLc)).toBe(false)
			r.feed(continuation, at + 31.3)
			r.feed(bs("05", "IDLE"), at + 69.1)
		}
		expect(
			r.links.every(l => !l.verified && !l.voiceLc && !l.tg && !l.src),
		).toBe(true)
		expect(
			r.evidence.every(
				e =>
					!e.contentVerified &&
					!e.identity &&
					!e.voiceLc &&
					!e.metadata.talkgroups?.length &&
					!e.metadata.sources?.length,
			),
		).toBe(true)
	})

	it("verifies voice LC only after a clean burst continuation closes", () => {
		const r = rig()
		for (let i = 0; i < 2; i++) {
			const at = T0 + i * 311.7
			r.feed(bs("05", "VLC"), at + 3.7)
			r.feed(" SLOT 1 TGT=9 SRC=123 Group Encrypted", at + 19.1)
			r.feed(" Key: 0000000000000000 0000000000000000", at + 31.3)
			expect(r.links.filter(l => l.voiceLc)).toHaveLength(i)
			r.feed(bs("05", "IDLE"), at + 69.1)
		}
		expect(
			r.evidence.some(
				e =>
					e.contentVerified &&
					e.voiceLc &&
					e.identity?.value === "5" &&
					e.metadata.talkgroups?.[0] === "9" &&
					e.metadata.sources?.[0] === "123",
			),
		).toBe(true)
	})

	it("rejects MS header CC when the closing checked burst prints another CC", () => {
		const r = rig()
		r.feed("Sync: +DMR MS/DM MODE/MONO | Color Code=05 | VLC", T0 + 3.7)
		r.feed("Sync: +DMR MS/DM MODE/MONO | Color Code=07 | VLC", T0 + 69.1)
		expect(r.links[0]).toMatchObject({ cc: 5, verified: false })
		expect(r.evidence.every(e => !e.identity)).toBe(true)
	})

	it.each([
		"Sync: +DMR MS/DM MODE/MONO | Color Code=07 | IDLE",
		"Sync: +DMR MS/DM MODE/MONO | Color Code=05 | IDLE",
		"Sync: no sync",
	])("never lends a pending MS header CC to checked LC before %s", closing => {
		const r = rig()
		for (let i = 0; i < 2; i++) {
			const at = T0 + i * 311.7
			r.feed("Sync: +DMR MS/DM MODE/MONO | Color Code=05 | VLC", at + 3.7)
			r.feed(lc, at + 31.3)
			expect(
				r.links.filter(l => l.voiceLc).every(l => l.cc === undefined),
			).toBe(true)
			r.feed(closing, at + 69.1)
		}
		const voice = r.evidence.filter(e => e.voiceLc)
		expect(voice.length).toBe(closing === "Sync: no sync" ? 0 : 1)
		for (const ev of voice) {
			expect(ev).toMatchObject({
				contentVerified: true,
				metadata: { talkgroups: ["9"], sources: ["123"] },
			})
			expect(ev.identity).toBeUndefined()
			expect(proof(ev)?.summary).toBe("DMR voice, TG/SRC verified, CC unknown")
		}
		if (!closing.includes("Color Code=05"))
			expect(r.evidence.every(e => !e.identity)).toBe(true)
	})

	it("describes checked voice LC without a slot CC and preserves it on restore", () => {
		const r = rig()
		r.feed("Sync: +DMR [slot2] slot1 | Color Code=05 | IDLE", T0 + 3.7)
		r.feed(lc, T0 + 31.3)
		r.feed(lc, T0 + 93.7)
		r.feed("Sync: +DMR [slot2] slot1 | Color Code=05 | IDLE", T0 + 131.9)
		const ev = r.evidence.filter(e => e.voiceLc).at(-1)!
		expect(ev.identity).toBeUndefined()
		expect(ev.voiceLc).toBe(true)
		expect(proof(ev)).toMatchObject({
			kind: "digital-undecoded",
			tgSrcVerified: true,
			summary: "DMR voice, TG/SRC verified, CC unknown",
		})
		expect(evidenceLevelOf({ proof: proof(ev)! })).toBe("weak")
		const store = new DiscoveryStore({
			maxDiscoveries: 10,
			now: () => T0,
			newId: counterIds(),
		})
		const obs = makeObs({
			id: "unknown-cc",
			centreHz: HZ,
			startedAt: T0,
			open: true,
		})
		const id = store.ingest(obs).discoveryId!
		const publicEv = guardDsdFmeEvidence(
			{ ...ev, epoch: obs.track.epoch },
			HZ,
			HZ,
		)
		store.appendObservationEvidence(obs.id, publicEv)
		store.applyEvidence(id, publicEv)
		const hint = { ...r.evidence.at(-1)!, epoch: obs.track.epoch }
		store.appendObservationEvidence(obs.id, hint)
		store.applyEvidence(id, hint)
		store.restore(store.snapshot())
		expect(store.get(id)).toMatchObject({
			evidenceLevel: "weak",
			proof: {
				tgSrcVerified: true,
				summary: "DMR voice, TG/SRC verified, CC unknown",
			},
		})
	})

	it("bounds checked TG/SRC pairs at 256, evicting the oldest", () => {
		const state = createInterpreterState({ epoch: 3, origin: "probe" })
		for (let i = 0; i < 257; i++) {
			for (let j = 0; j < 2; j++)
				interpretDsdFme(
					{
						kind: "link",
						line: {
							protocol: "dmr",
							verified: true,
							voiceLc: true,
							crcErr: false,
							cc: 5,
							tg: String(i + 1),
							src: String(i + 1001),
							at: T0 + i * 93.7 + j * 31.3,
						},
					},
					state,
				)
		}
		const call = (i: number) =>
			interpretDsdFme(
				{
					kind: "call_start",
					at: T0 + 25_137.3,
					call: {
						callId: `fake-${i}`,
						protocol: "dmr",
						talkgroup: i + 1,
						source: i + 1001,
					},
				},
				state,
			)[0]
		expect(call(0)?.voiceLc).toBeUndefined()
		expect(call(1)?.voiceLc).toBe(true)
		expect(call(256)?.voiceLc).toBe(true)
		expect([...state.accepted.keys()].some(k => k.includes(":lc:"))).toBe(false)
	})

	it.each(["VLC", "CSBK", "PI", "TLC", "MBCH", "DATA", "USBD"])(
		"requires two clean %s contents",
		burst => {
			const r = rig()
			r.feed(bs("10", burst), T0 + 3.7)
			expect(r.evidence).toEqual([])
			r.feed(bs("10", burst), T0 + 63.1)
			r.feed(bs("10", burst), T0 + 119.3)
			expect(r.evidence.at(-1)?.identity).toEqual({
				kind: "dmr-cc",
				value: "10",
			})
			expect(proof(r.evidence.at(-1)!)?.kind).toBe("decoded")
		},
	)

	it.each([
		"Sync: +P25p1",
		"Sync: NXDN96",
		"Sync: +YSF",
		"Sync: no sync",
		"| Frame Sync Err: 7",
		"Frame Sync Err",
	])("discards pending checked bursts and slot CCs on %s", boundary => {
		const r = rig()
		for (let i = 0; i < 2; i++) {
			r.feed(bs("10", "CSBK"), T0 + i * 311.7 + 3.7)
			r.feed(boundary, T0 + i * 311.7 + 61.3)
		}
		expect(r.links.filter(l => l.protocol === "dmr")).toHaveLength(2)
		expect(
			r.links.filter(l => l.protocol === "dmr").every(l => !l.verified),
		).toBe(true)
		expect(r.evidence.every(e => e.identity === undefined)).toBe(true)
		// Re-enter on slot 2: slot 1 must have lost its old CC.
		r.feed("Sync: +DMR slot1 [slot2] | Color Code=07 | IDLE", T0 + 703.7)
		r.feed(lc, T0 + 719.3)
		r.feed(lc, T0 + 781.1)
		expect(r.links.filter(l => l.voiceLc).every(l => l.cc === undefined)).toBe(
			true,
		)
		expect(r.evidence.every(e => e.identity === undefined)).toBe(true)
	})

	it.each([
		"Sync: +DMR [slot1] slot2 | Color Code=03 | IDLE",
		"Sync: -DMR slot1 [slot2] | Color Code=03 | IDLE",
		"Sync: +DMR MS/DM MODE/MONO | Color Code=03 | VC*",
		"Sync: -DMR MS/DM MODE/MONO | Color Code=03 | VC*",
	])("accepts a following DMR burst boundary: %s", boundary => {
		const r = rig()
		r.feed(bs("10", "CSBK"), T0 + 3.7)
		r.feed(bs("10", "CSBK"), T0 + 61.3)
		r.feed(boundary, T0 + 127.1)
		expect(r.links.filter(l => l.cc === 10).every(l => l.verified)).toBe(true)
		expect(r.evidence.some(e => e.identity?.value === "10")).toBe(true)
	})

	it("keeps checked CSBK identities across interleaved slot-2 IDLE bursts", () => {
		const r = rig()
		for (let i = 0; i < 2; i++) {
			r.feed(bs("03", "CSBK"), T0 + i * 137.7 + 3.7)
			r.feed(
				"Sync: +DMR slot1 [slot2] | Color Code=10 | IDLE",
				T0 + i * 137.7 + 61.3,
			)
		}
		expect(r.links.filter(l => l.verified).map(l => l.cc)).toEqual([3, 3])
		expect(r.evidence.filter(e => e.identity).map(e => e.identity)).toEqual([
			{ kind: "dmr-cc", value: "3" },
		])
	})

	it.each(["1", "2"])(
		"lends only slot %s's most recent CC to voice LC",
		slot => {
			const r = rig()
			const other = slot === "1" ? "2" : "1"
			r.feed(
				`Sync: +DMR [slot${slot}] slot${other} | Color Code=03 | VC*`,
				T0 + 3.7,
			)
			r.feed(
				`Sync: +DMR slot${slot} [slot${other}] | Color Code=10 | IDLE`,
				T0 + 61.3,
			)
			for (const at of [127.1, 193.7])
				r.feed(` SLOT ${slot} TGT=9 SRC=123`, T0 + at)
			r.feed(bs("10", "IDLE"), T0 + 211.9)
			expect(r.links.filter(l => l.voiceLc).map(l => l.cc)).toEqual([3, 3])
			expect(r.evidence.filter(e => e.voiceLc).at(-1)?.identity).toEqual({
				kind: "dmr-cc",
				value: "3",
			})
			// A newer burst with unknown CC supersedes that slot's older CC.
			r.feed(
				`Sync: +DMR [slot${slot}] slot${other} | Color Code=XX | VC*`,
				T0 + 251.3,
			)
			r.feed(` SLOT ${slot} TGT=9 SRC=123`, T0 + 317.1)
			r.feed(bs("10", "IDLE"), T0 + 351.9)
			expect(r.links.filter(l => l.voiceLc).at(-1)?.cc).toBeUndefined()
		},
	)

	it("does not borrow another slot's CC when its own slot has no burst", () => {
		const r = rig()
		r.feed("Sync: +DMR slot1 [slot2] | Color Code=10 | IDLE", T0 + 3.7)
		r.feed(lc, T0 + 61.3)
		r.feed(lc, T0 + 127.1)
		r.feed(bs("10", "IDLE"), T0 + 151.9)
		expect(r.links.filter(l => l.voiceLc).map(l => l.cc)).toEqual([
			undefined,
			undefined,
		])
		expect(r.evidence.every(e => e.identity === undefined)).toBe(true)
	})

	it("keeps MS color codes on a separate single-channel key", () => {
		const r = rig()
		r.feed(bs("10", "IDLE"), T0 + 3.7)
		r.feed("Sync: -DMR MS/DM MODE/MONO | Color Code=03 | VC*", T0 + 61.3)
		r.feed(" SLOT 2 TGT=9 SRC=123", T0 + 127.1)
		r.feed(lc, T0 + 193.7)
		r.feed("Sync: -DMR MS/DM MODE/MONO | Color Code=03 | IDLE", T0 + 211.9)
		expect(r.links.filter(l => l.voiceLc).map(l => l.cc)).toEqual([3, 3])
		expect(r.evidence.filter(e => e.voiceLc).at(-1)?.identity).toEqual({
			kind: "dmr-cc",
			value: "3",
		})
	})

	it.each([
		"CSBK (CRC ERR) ",
		"CSBK (FEC ERR)",
		"VLC (CRC ERR) ",
		"VLC (FEC ERR)",
	])("rejects %s", burst => {
		const r = rig()
		for (let i = 0; i < 5; i++) r.feed(bs("10", burst))
		r.feed(" SLOT 1 FLCO FEC ERR ")
		expect(r.evidence).toEqual([])
	})

	it.each(["PI", "VLC", "TLC", "CSBK", "MBCH", "DATA", "USBD"])(
		"rejects multiline failures throughout a %s burst",
		burst => {
			for (const error of [
				" SLOT 1 FLCO FEC ERR",
				" SLCO CRC ERR",
				" USBD - Reserved 3 (CRC ERR)",
				" (FEC ERR)",
				" Slot 1 - Multi Block Control Message CRC16 ERR",
			]) {
				const r = rig()
				for (let i = 0; i < 3; i++) {
					r.feed(bs("10", burst), T0 + i * 173.7)
					r.feed(" payload continuation", T0 + i * 173.7 + 7.3)
					expect(r.links.some(l => l.verified)).toBe(false)
					r.feed(error, T0 + i * 173.7 + 19.1)
				}
				r.feed(bs("10", "IDLE"), T0 + 600.7)
				expect(r.links.some(l => l.verified)).toBe(false)
				expect(r.evidence.every(e => e.identity === undefined)).toBe(true)
			}
		},
	)

	it.each([
		["stop", false],
		["timeout", false],
		["late-sync", false],
		["stop", true],
		["timeout", true],
		["late-sync", true],
	] as const)(
		"flushes an unfinished burst unverified on %s (voice LC: %s)",
		async (end, voice) => {
			const r = rig()
			r.feed(bs("10", voice ? "VC*" : "VLC"), T0 + 3.7)
			if (voice) r.feed(lc, T0 + 19.1)
			const before = r.links.length
			if (end === "stop") await r.decoder.stop()
			else {
				vi.setSystemTime(T0 + 5009.3)
				if (end === "timeout")
					(
						r.decoder as unknown as { checkCallTimeoutAsync(): void }
					).checkCallTimeoutAsync()
				else r.feed(bs("10", "VLC"), T0 + 5009.3)
			}
			expect(r.links).toHaveLength(before + 1)
			expect(r.links.at(-1)).toMatchObject({ verified: false })
			expect(r.links.at(-1)?.voiceLc).toBeUndefined()
			expect(r.links.at(-1)?.tg).toBeUndefined()
			expect(r.links.at(-1)?.src).toBeUndefined()
		},
	)

	it("CACH errors produce no link or evidence; XX and sync loss cannot lend a stale CC to LC", () => {
		const r = rig()
		r.feed("21:49:48 Sync: +DMR  [slot1]  slot2  | CACH/Burst FEC ERR")
		expect(r.links).toEqual([])
		r.feed(bs("03", "VC*"))
		r.feed("Sync: no sync")
		r.feed(lc)
		r.feed(bs("XX", "VC*"))
		r.feed(lc)
		expect(r.links.filter(l => l.voiceLc).every(l => l.cc === undefined)).toBe(
			true,
		)
		expect(r.evidence.every(e => !e.identity)).toBe(true)
	})

	it("DC guard downgrades checked headers but allows paired TG+SRC voice LC at centre", () => {
		const r = rig()
		r.feed(bs("03", "CSBK"))
		r.feed(bs("03", "CSBK"))
		r.feed(bs("03", "CSBK"))
		const header = r.evidence.at(-1)!
		expect(proof(guardDsdFmeEvidence(header, HZ, HZ))?.kind).toBe(
			"digital-undecoded",
		)
		expect(
			proof(guardDsdFmeEvidence(header, HZ + DQ_DC_ADMIT_HZ, HZ))?.kind,
		).toBe("digital-undecoded")
		expect(
			proof(guardDsdFmeEvidence(header, HZ + DQ_DC_ADMIT_HZ + 1, HZ))?.kind,
		).toBe("decoded")
		r.feed(lc)
		r.feed(bs("03", "VC*"))
		r.feed(lc)
		r.feed(bs("03", "IDLE"))
		const voice = r.evidence.filter(e => e.voiceLc).at(-1)!
		expect(voice).toMatchObject({
			voiceLc: true,
			metadata: { talkgroups: ["9"], sources: ["123"] },
		})
		expect(proof(guardDsdFmeEvidence(voice, HZ, HZ))?.kind).toBe("decoded")
		r.feed(bs("03", "IDLE"))
		expect(r.evidence.at(-1)?.identity).toBeUndefined()
	})

	it("publishes and restores the lower DMR class with an unverified CC hint", () => {
		const r = rig()
		for (let i = 0; i < 5; i++) r.feed(bs("03", "IDLE"))
		const store = new DiscoveryStore({
			maxDiscoveries: 10,
			now: () => T0,
			newId: counterIds(),
		})
		const obs = makeObs({
			id: "fake-observation",
			centreHz: HZ,
			startedAt: T0,
			open: true,
		})
		const id = store.ingest(obs).discoveryId!
		const ev: DecodeEvidence = {
			...r.evidence.at(-1)!,
			epoch: obs.track.epoch,
		}
		expect(DecodeEvidenceSchema.safeParse(ev).success).toBe(true)
		store.appendObservationEvidence(obs.id, ev)
		store.applyEvidence(id, ev)
		expect(store.get(id)).toMatchObject({
			protocol: "dmr",
			confidence: "activity",
			evidenceLevel: "weak",
			proof: { kind: "digital-undecoded", unverifiedCc: 3 },
		})
		expect(store.get(id)?.identity).toBeUndefined()
		const restored = new DiscoveryStore({
			maxDiscoveries: 10,
			now: () => T0,
			newId: counterIds(),
		})
		restored.restore(
			JSON.parse(JSON.stringify(store.snapshot())) as ReturnType<
				typeof store.snapshot
			>,
		)
		expect(restored.get(id)?.proof?.summary).toContain("CC 3 (unverified)")
		expect(restored.get(id)?.evidenceLevel).toBe("weak")
	})

	it.each([undefined, false, "true", 1])(
		"downgrades legacy persisted identity without explicit provenance (%s)",
		provenance => {
			const store = new DiscoveryStore({
				maxDiscoveries: 10,
				now: () => T0,
				newId: counterIds(),
			})
			const obs = makeObs({
				id: "legacy",
				centreHz: HZ,
				startedAt: T0,
				open: true,
			})
			const id = store.ingest(obs).discoveryId!
			const ev: DecodeEvidence = {
				protocol: "dmr",
				identity: { kind: "dmr-cc", value: "3" },
				crcClean: true,
				metadata: {},
				at: T0 + 3.7,
				epoch: obs.track.epoch,
				origin: "probe",
			}
			store.appendObservationEvidence(obs.id, ev)
			store.applyEvidence(id, ev)
			const snapshot = store.snapshot()
			for (const row of snapshot.observations[0]?.decode ?? [])
				Object.assign(row, { contentVerified: provenance })
			store.restore(snapshot)
			expect(store.get(id)).toMatchObject({
				confidence: "activity",
				evidenceLevel: "weak",
				proof: { kind: "digital-undecoded", unverifiedCc: 3 },
			})
			expect(store.get(id)?.identity).toBeUndefined()
		},
	)

	it.each(["dmr", "pocsag"] as const)(
		"normalizes snapshot plus legacy %s journal replay",
		protocol => {
			const store = new DiscoveryStore({
				maxDiscoveries: 10,
				now: () => T0,
				newId: counterIds(),
			})
			const obs = makeObs({
				id: "journal-legacy",
				centreHz: HZ,
				startedAt: T0,
				open: true,
			})
			const id = store.ingest(obs).discoveryId!
			const snapshot = store.snapshot()
			const entries: JournalEntry[] = []
			store.on("mutation", (e: Omit<JournalEntry, "seq">) =>
				entries.push({ ...e, seq: entries.length + 1 }),
			)
			const ev: DecodeEvidence = {
				protocol,
				identity:
					protocol === "dmr"
						? { kind: "dmr-cc", value: "3" }
						: { kind: "pocsag-capcode", value: "123" },
				crcClean: true,
				metadata: {},
				at: T0 + 3.7,
				epoch: obs.track.epoch,
				origin: "probe",
			}
			store.appendObservationEvidence(obs.id, ev)
			store.applyEvidence(id, ev)
			store.restore(snapshot)
			for (const entry of entries) store.replay(entry)
			if (protocol === "dmr") {
				expect(store.get(id)).toMatchObject({
					confidence: "activity",
					evidenceLevel: "weak",
					proof: { kind: "digital-undecoded" },
				})
				expect(store.get(id)?.identity).toBeUndefined()
				expect(store.snapshot().observations[0]?.decode?.[0]).toMatchObject({
					contentVerified: false,
					unverifiedCc: 3,
				})
			} else {
				expect(store.get(id)?.identity).toEqual(ev.identity)
				expect(store.get(id)?.proof?.kind).toBe("decoded")
				expect(store.get(id)?.evidenceLevel).toBe("proven")
			}
		},
	)

	it.each([
		["p25p1", "p25-nac", "123"],
		["p25p2", "p25-nac", "123"],
		["nxdn48", "nxdn-ran", "3"],
		["nxdn96", "nxdn-ran", "3"],
		["ysf", "ysf-dgid", "3"],
		["dstar", "dstar-call", "TEST123"],
		["dpmr", "dpmr-cc", "3"],
	] as const)(
		"downgrades legacy %s identities too",
		(protocol, kind, value) => {
			const store = new DiscoveryStore({
				maxDiscoveries: 10,
				now: () => T0,
				newId: counterIds(),
			})
			const obs = makeObs({
				id: "legacy-family",
				centreHz: HZ,
				startedAt: T0,
				open: true,
			})
			const id = store.ingest(obs).discoveryId!
			const ev: DecodeEvidence = {
				protocol,
				identity: { kind, value },
				crcClean: true,
				metadata: {},
				at: T0 + 3.7,
				epoch: obs.track.epoch,
				origin: "probe",
			}
			store.appendObservationEvidence(obs.id, ev)
			store.applyEvidence(id, ev)
			store.restore(store.snapshot())
			expect(store.get(id)?.proof?.kind).toBe("digital-undecoded")
			expect(store.get(id)?.evidenceLevel).toBe("weak")
			expect(store.get(id)?.identity).toBeUndefined()
		},
	)

	it("preserves new content verification through schema and snapshot restore", () => {
		const r = rig()
		r.feed(bs("03", "CSBK"))
		r.feed(bs("03", "CSBK"))
		r.feed(bs("03", "CSBK"))
		expect(r.evidence.at(-1)?.contentVerified).toBe(true)
		const store = new DiscoveryStore({
			maxDiscoveries: 10,
			now: () => T0,
			newId: counterIds(),
		})
		const obs = makeObs({
			id: "checked",
			centreHz: HZ,
			startedAt: T0,
			open: true,
		})
		const id = store.ingest(obs).discoveryId!
		const ev: DecodeEvidence = {
			...r.evidence.at(-1)!,
			epoch: obs.track.epoch,
		}
		expect(DecodeEvidenceSchema.parse(ev).contentVerified).toBe(true)
		store.appendObservationEvidence(obs.id, ev)
		store.applyEvidence(id, ev)
		store.restore(store.snapshot())
		expect(store.get(id)).toMatchObject({
			identity: { kind: "dmr-cc", value: "3" },
			evidenceLevel: "proven",
			proof: { kind: "decoded" },
		})
	})

	it("replays the two-PTT fixture with checked TG+SRC and a CC identity", () => {
		const r = rig()
		const fixture = readFileSync(
			new URL(
				"../../mocks/fixtures/dsd-fme/dmr-ms-two-ptt.txt",
				import.meta.url,
			),
			"utf8",
		)
		for (const row of fixture.split("\n")) {
			if (!/^\d+\t/.test(row)) continue
			const tab = row.indexOf("\t")
			r.feed(row.slice(tab + 1), T0 + Number(row.slice(0, tab)) + 3.7)
		}
		expect(
			r.evidence.some(
				e =>
					e.voiceLc &&
					e.identity?.kind === "dmr-cc" &&
					e.identity.value === "1" &&
					e.metadata.talkgroups?.[0] === "9" &&
					e.metadata.sources?.[0] === "2060945",
			),
		).toBe(true)
	})

	it.each([
		["P25p1", "NAC: 123; LDU1", false],
		["P25p1", "NAC: 123; duid:EE", false],
		["P25p1", "NAC/CC: 123; LDU1", false],
		["P25p1", "NAC/CC: 123; duid:EE", false],
		["P25p1", "NAC/CC: 123;", false],
		["P25p1", "nac: [123] src: [123] tg: [9]", false],
		["NXDN48", " RAN 03  FACCH2", true],
		["NXDN96", " RAN 03  FACCH2", true],
		["NXDN96", "         FACCH2", false],
		["NXDN96", " RAN 03 UDCH", true],
		["NXDN96", " RAN=03 TGT=9 SRC=123", false],
		["NXDN96", " RAN 03 PF 1/4", false],
		["DSTAR", " MY: TEST123 UR: CQCQCQ", false],
		[
			"YSF",
			"Sync: +YSF FN: 10/10 FICH (CRC ERR) DCH (CRC ERR) DCH (CRC ERR)",
			false,
		],
		["dPMR", " TG=9 Src=123 Channel Code=03", false],
	] as const)(
		"%s only trusts checked output: %s",
		(protocol, line, verified) => {
			const r = rig()
			r.feed(`Sync: ${protocol.startsWith("NXDN") ? "" : "+"}${protocol} `)
			r.feed(line)
			r.feed(line)
			expect(r.links.at(-1)?.verified ?? false).toBe(verified)
			expect(r.evidence.some(e => e.identity !== undefined)).toBe(verified)
		},
	)

	// Feature: digital-voice-proof, Property 1: sync-only DMR never supplies an identity
	// Validates: Requirements R2, R5
	it("never accepts any random sequence of sync-only CCs and burst labels", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						cc: fc.integer({ min: 0, max: 15 }),
						label: fc.constantFrom(
							"VC*",
							"VC1",
							"VC2",
							"VC3",
							"VC4",
							"VC5",
							"VC6",
							"IDLE",
							"R12U",
							"",
						),
					}),
					{ maxLength: 180 },
				),
				lines => {
					const r = rig()
					lines.forEach((l, i) =>
						r.feed(bs(String(l.cc).padStart(2, "0"), l.label), T0 + i * 1003.7),
					)
					expect(r.evidence.every(e => e.identity?.kind !== "dmr-cc")).toBe(
						true,
					)
				},
			),
			{ numRuns: 100 },
		)
	})
})
