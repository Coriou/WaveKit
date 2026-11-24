import { describe, expect, it } from "vitest"
import {
	TX_ALIASES_MAX,
	TX_ALIASES_PER_KIND,
	TX_ALIAS_TX_MAX,
	TX_BARE_CLOSED_MAX,
	TX_CLOSED_MAX,
	TX_CLOSED_TTL_MS,
	TX_GROUP_GAP_MS,
	TX_ID,
	TX_MAX_MS,
	TX_OPEN_MAX,
	TX_OPEN_PER_SOURCE,
	TX_ROLLOVER_HOLD_MS,
	TransmissionRegistry,
	TransmissionRefSchema,
	deriveTone,
	type TxClaim,
} from "../../../../src/core/transmissions/index.js"

let seq = 0
function obs(hz: number, atMs: number, extra: Partial<TxClaim> = {}): TxClaim {
	seq++
	return {
		origin: "scanner-observation",
		kind: "voice-analog",
		sourceId: "src-a",
		hz,
		halfWidthHz: 6_000,
		epoch: 1,
		stream: 0,
		atMs,
		alias: `obs:o_${seq}`,
		...extra,
	}
}

function live(hz: number, atMs: number, extra: Partial<TxClaim> = {}): TxClaim {
	seq++
	return {
		origin: "live-demod",
		kind: "voice-analog",
		sourceId: "src-a",
		hz,
		halfWidthHz: 6_250,
		atMs,
		alias: `evt:e_${seq}`,
		...extra,
	}
}

function dv(lane: 0 | 1 | 2, atMs: number, run = "dsd#1"): TxClaim {
	seq++
	return {
		origin: "dv-call",
		kind: "voice-digital",
		sourceId: "src-a",
		dvKey: "dv:dsd",
		lane,
		run,
		atMs,
		alias: `call:c_${seq}`,
	}
}

const HZ = 100_000_000

describe("TransmissionRegistry", () => {
	it("mints a tx_ ULID and returns it by id and alias", () => {
		const r = new TransmissionRegistry({ now: () => 0 })
		const c = obs(HZ, 1_000)
		const res = r.claim(c)!
		expect(res.txId).toMatch(TX_ID)
		expect(r.get(res.txId)?.state).toBe("open")
		expect(r.byAlias(c.alias)?.id).toBe(res.txId)
		expect(r.openTxOf(c.alias)).toBe(res.txId)
		expect(TransmissionRefSchema.safeParse(res.txId).success).toBe(true)
	})

	it("joins a matching claim of another origin and closes ended when the last ends", () => {
		const r = new TransmissionRegistry()
		const a = r.claim(obs(HZ, 0))!
		const b = r.claim(live(HZ + 1_000, 10))!
		expect(b.txId).toBe(a.txId)
		r.end(a.claimant, 100)
		expect(r.get(a.txId)?.state).toBe("open")
		r.end(b.claimant, 200)
		const v = r.get(a.txId)!
		expect(v.state).toBe("closed")
		expect(v.close).toBe("ended")
		expect(v.complete).toBe(true)
		expect(v.endedAtMs).toBe(200)
	})

	it("never joins a channel 12.5 kHz or 6.25 kHz away (strict)", () => {
		const r = new TransmissionRegistry()
		const a = r.claim(obs(HZ, 0))!
		const b = r.claim(obs(HZ + 12_500, 0))!
		const c = r.claim(obs(HZ + 6_250, 0, { halfWidthHz: 20_000 }))!
		expect(new Set([a.txId, b.txId, c.txId]).size).toBe(3)
	})

	it("joins just inside the match bound and not at it", () => {
		const r = new TransmissionRegistry()
		const a = r.claim(obs(HZ, 0, { halfWidthHz: 20_000 }))!
		expect(r.claim(obs(HZ + 6_249, 0, { halfWidthHz: 20_000 }))!.txId).toBe(
			a.txId,
		)
		expect(r.claim(obs(HZ - 6_250, 0, { halfWidthHz: 20_000 }))!.txId).not.toBe(
			a.txId,
		)
	})

	it("does not join across epochs or streams, or a closed entry (no hang)", () => {
		const r = new TransmissionRegistry()
		const a = r.claim(obs(HZ, 0))!
		expect(r.claim(obs(HZ, 0, { epoch: 2 }))!.txId).not.toBe(a.txId)
		expect(r.claim(obs(HZ, 0, { stream: 1 }))!.txId).not.toBe(a.txId)
		const r2 = new TransmissionRegistry()
		const x = r2.claim(obs(HZ, 0))!
		r2.end(x.claimant, 100)
		expect(r2.claim(obs(HZ, 101))!.txId).not.toBe(x.txId)
	})

	it("opens a new ambiguous entry when a claim matches two", () => {
		const r = new TransmissionRegistry()
		const a = r.claim(obs(HZ - 3_000, 0, { halfWidthHz: 4_000 }))!
		const b = r.claim(obs(HZ + 3_000, 10, { halfWidthHz: 4_000 }))!
		expect(a.txId).not.toBe(b.txId)
		const c = r.claim(live(HZ, 20))!
		expect([a.txId, b.txId]).not.toContain(c.txId)
		const v = r.get(c.txId)!
		expect(v.ambiguous).toBe(true)
		expect(v.groupId).toBe(r.get(b.txId)!.groupId)
		expect(r.stats().ambiguous).toBe(1)
	})

	it("a split never joins the held entry and shares its group", () => {
		const r = new TransmissionRegistry()
		const held = r.claim(live(HZ, 0))!
		r.end(held.claimant, 50)
		const next = r.claim(live(HZ, 50, { splitFrom: held.txId }))!
		expect(next.txId).not.toBe(held.txId)
		expect(r.get(next.txId)!.groupId).toBe(r.get(held.txId)!.groupId)
	})

	it("a split excludes its held entry even while it is open", () => {
		const r = new TransmissionRegistry()
		const held = r.claim(live(HZ, 0))!
		const next = r.claim(live(HZ, 10, { splitFrom: held.txId }))!
		expect(next.txId).not.toBe(held.txId)
	})

	it("holds a scanner max-duration end for its continues, then closes max-duration", () => {
		const r = new TransmissionRegistry()
		const a = r.claim(obs(HZ, 0))!
		r.end(a.claimant, 1_000, "max-duration")
		expect(r.get(a.txId)!.state).toBe("hang")
		// any claim without continues does not join a held entry
		expect(r.claim(obs(HZ, 1_010))!.txId).not.toBe(a.txId)
		const b = r.claim(obs(HZ, 1_020, { continues: a.txId }))!
		expect(b.txId).toBe(a.txId)
		expect(r.get(a.txId)!.state).toBe("open")
		r.end(b.claimant, 2_000, "max-duration")
		r.sweep(2_000 + TX_ROLLOVER_HOLD_MS)
		const v = r.get(a.txId)!
		expect(v.state).toBe("closed")
		expect(v.close).toBe("max-duration")
		expect(v.complete).toBe(false)
	})

	it("a continues past the hold opens a new id in the same group", () => {
		const r = new TransmissionRegistry()
		const a = r.claim(obs(HZ, 0))!
		r.end(a.claimant, 1_000, "max-duration")
		const b = r.claim(
			obs(HZ, 1_000 + TX_ROLLOVER_HOLD_MS, { continues: a.txId }),
		)!
		expect(b.txId).not.toBe(a.txId)
		expect(r.get(a.txId)!.close).toBe("max-duration")
		expect(r.get(b.txId)!.groupId).toBe(r.get(a.txId)!.groupId)
	})

	it("closes hop, retune and source-lost, and a late end is a counted no-op", () => {
		for (const reason of ["hop", "retune", "source-lost"] as const) {
			const r = new TransmissionRegistry()
			const a = r.claim(obs(HZ, 0))!
			if (reason === "hop") r.end(a.claimant, 10, "hop")
			else r.closeSource("src-a", reason, 10)
			expect(r.get(a.txId)!.close).toBe(reason)
			expect(r.get(a.txId)!.complete).toBe(false)
			const before = r.stats().lateWrites
			r.end(a.claimant, 20)
			r.noteLiveTone(a.claimant, { ctcssHz: 88.5, dcs: null })
			r.noteRefusal(a.txId, "noise")
			expect(r.stats().lateWrites).toBe(before + 3)
			const v = r.get(a.txId)!
			expect(v.liveTone).toBeNull()
			expect(v.refusal).toBeNull()
			expect(v.state).toBe("closed")
		}
	})

	it("closeSource with epochNot keeps entries of that epoch and those without one", () => {
		const r = new TransmissionRegistry()
		const keep = r.claim(obs(HZ, 0, { epoch: 3 }))!
		const drop = r.claim(obs(HZ + 50_000, 0, { epoch: 2 }))!
		const noEpoch = r.claim(live(HZ + 100_000, 0))!
		expect(r.closeSource("src-a", "retune", 5, { epochNot: 3 })).toBe(1)
		expect(r.get(keep.txId)!.state).toBe("open")
		expect(r.get(drop.txId)!.close).toBe("retune")
		expect(r.get(noEpoch.txId)!.state).toBe("open")
	})

	it("an operator stop closes ended, never complete", () => {
		const r = new TransmissionRegistry()
		const a = r.claim(live(HZ, 0))!
		r.end(a.claimant, 10, "stopped")
		expect(r.get(a.txId)!.close).toBe("ended")
		expect(r.get(a.txId)!.complete).toBe(false)
	})

	it("closes max-duration at TX_MAX_MS and the next claim opens a new id in the same group", () => {
		const r = new TransmissionRegistry()
		const a = r.claim(live(HZ, 0))!
		r.sweep(TX_MAX_MS - 1)
		expect(r.get(a.txId)!.state).toBe("open")
		r.sweep(TX_MAX_MS)
		expect(r.get(a.txId)!.close).toBe("max-duration")
		const b = r.claim(live(HZ, TX_MAX_MS + 1))!
		expect(b.txId).not.toBe(a.txId)
		expect(r.get(b.txId)!.groupId).toBe(r.get(a.txId)!.groupId)
		r.end(a.claimant, TX_MAX_MS + 2)
		expect(r.stats().lateWrites).toBe(1)
	})

	it("groups a new over on the channel within the gap and not past it", () => {
		const r = new TransmissionRegistry()
		const a = r.claim(obs(HZ, 0))!
		r.end(a.claimant, 100)
		const b = r.claim(obs(HZ, 100 + TX_GROUP_GAP_MS))!
		r.end(b.claimant, 200 + TX_GROUP_GAP_MS)
		const c = r.claim(obs(HZ, 201 + 2 * TX_GROUP_GAP_MS))!
		expect(r.get(b.txId)!.groupId).toBe(r.get(a.txId)!.groupId)
		expect(r.get(c.txId)!.groupId).not.toBe(r.get(a.txId)!.groupId)
	})

	it("a hop return within 120 s joins the hop's group", () => {
		const r = new TransmissionRegistry()
		const a = r.claim(obs(HZ, 0))!
		r.end(a.claimant, 100, "hop")
		const b = r.claim(obs(HZ, 100 + 100_000, { epoch: 7 }))!
		expect(r.get(b.txId)!.groupId).toBe(r.get(a.txId)!.groupId)
	})

	it("DV: one id per promotion and lane, a new promotion ends the lane's previous call", () => {
		const r = new TransmissionRegistry()
		const s1 = r.claim(dv(1, 0))!
		const s2 = r.claim(dv(2, 0))!
		expect(s1.txId).not.toBe(s2.txId)
		const s1b = r.claim(dv(1, 10))!
		expect(s1b.txId).not.toBe(s1.txId)
		expect(r.get(s1.txId)!.close).toBe("ended")
		expect(r.get(s1.txId)!.complete).toBe(false)
		expect(r.get(s2.txId)!.state).toBe("open")
	})

	it("DV: retireRun closes decoder-restart and refuses the run's later claims", () => {
		const r = new TransmissionRegistry()
		const a = r.claim(dv(1, 0, "dsd#1"))!
		r.retireRun("dsd#1", 5)
		expect(r.get(a.txId)!.close).toBe("decoder-restart")
		expect(r.claim(dv(1, 6, "dsd#1"))).toBeNull()
		expect(r.stats().retiredRun).toBe(1)
		expect(r.claim(dv(1, 6, "dsd#2"))).not.toBeNull()
	})

	it("refuses and counts a claim at the per-source cap, never evicting a live entry", () => {
		const r = new TransmissionRegistry()
		const ids: string[] = []
		for (let i = 0; i < TX_OPEN_PER_SOURCE; i++)
			ids.push(r.claim(obs(HZ + i * 100_000, 0))!.txId)
		expect(r.openOn("src-a")).toBe(TX_OPEN_PER_SOURCE)
		expect(r.claim(obs(HZ - 1e6, 0))).toBeNull()
		expect(r.stats().refusedCap).toBe(1)
		// a join at the cap is no new entry
		expect(r.claim(obs(HZ, 1))!.txId).toBe(ids[0])
		for (const id of ids) expect(r.get(id)!.state).toBe("open")
	})

	it("refuses and counts a claim at the total cap", () => {
		const r = new TransmissionRegistry()
		const sources = TX_OPEN_MAX / TX_OPEN_PER_SOURCE
		for (let s = 0; s < sources; s++)
			for (let i = 0; i < TX_OPEN_PER_SOURCE; i++)
				expect(
					r.claim(obs(HZ + i * 100_000, 0, { sourceId: `src-${s}` })),
				).not.toBeNull()
		expect(r.stats().open).toBe(TX_OPEN_MAX)
		expect(r.claim(obs(HZ, 0, { sourceId: "src-new" }))).toBeNull()
		expect(r.stats().refusedCap).toBe(1)
	})

	it("evicts the bare closed ring oldest first at and past its cap", () => {
		const r = new TransmissionRegistry()
		const ids: string[] = []
		for (let i = 0; i < TX_BARE_CLOSED_MAX + 2; i++) {
			const res = r.claim(obs(HZ, i * 10))!
			r.end(res.claimant, i * 10 + 1)
			ids.push(res.txId)
			if (i === TX_BARE_CLOSED_MAX - 1) {
				expect(r.stats().bareClosed).toBe(TX_BARE_CLOSED_MAX)
				expect(r.stats().evicted).toBe(0)
			}
		}
		expect(r.stats().bareClosed).toBe(TX_BARE_CLOSED_MAX)
		expect(r.stats().evicted).toBe(2)
		expect(r.get(ids[0]!)).toBeNull()
		expect(r.get(ids[1]!)).toBeNull()
		expect(r.get(ids[2]!)).not.toBeNull()
	})

	it("evicts the artefact ring oldest first at and past its cap, and by TTL", () => {
		const r = new TransmissionRegistry()
		const ids: string[] = []
		for (let i = 0; i < TX_CLOSED_MAX + 1; i++) {
			const res = r.claim(live(HZ, i))!
			r.end(res.claimant, i)
			ids.push(res.txId)
		}
		expect(r.stats().closed).toBe(TX_CLOSED_MAX)
		expect(r.get(ids[0]!)).toBeNull()
		expect(r.byAlias("evt:does-not-exist")).toBeNull()
		r.sweep(TX_CLOSED_MAX + TX_CLOSED_TTL_MS - 1)
		expect(r.get(ids[1]!)).toBeNull()
		expect(r.get(ids.at(-1)!)).not.toBeNull()
		r.sweep(TX_CLOSED_MAX + TX_CLOSED_TTL_MS)
		expect(r.stats().closed).toBe(0)
	})

	it("a bare entry that gains a recording moves to the artefact ring", () => {
		const r = new TransmissionRegistry()
		const a = r.claim(obs(HZ, 0))!
		r.end(a.claimant, 1)
		expect(r.stats().bareClosed).toBe(1)
		expect(r.attach(a.txId, "rec:scan:d~f.wav")).toBe(true)
		expect(r.stats().bareClosed).toBe(0)
		expect(r.stats().closed).toBe(1)
		expect(r.get(a.txId)!.aliases.rec).toEqual(["rec:scan:d~f.wav"])
	})

	it("the TTL sweep does not stall behind a younger entry ahead of a moved one", () => {
		const r = new TransmissionRegistry()
		// B closes bare at 1; F closes with an artefact at 1 000; B then gains a recording and
		// joins the artefact ring behind F with its older close.
		const b = r.claim(obs(HZ, 0))!
		r.end(b.claimant, 1)
		const f = r.claim(live(HZ + 100_000, 999))!
		r.end(f.claimant, 1_000)
		expect(r.attach(b.txId, "rec:scan:d~old.wav")).toBe(true)
		expect(r.stats().closed).toBe(2)
		// one millisecond before B's TTL both stay
		r.sweep(1 + TX_CLOSED_TTL_MS - 1)
		expect(r.get(b.txId)).not.toBeNull()
		// at B's TTL B goes although F (ahead of it) is still young
		r.sweep(1 + TX_CLOSED_TTL_MS)
		expect(r.get(b.txId)).toBeNull()
		expect(r.get(f.txId)).not.toBeNull()
		r.sweep(1_000 + TX_CLOSED_TTL_MS)
		expect(r.get(f.txId)).toBeNull()
	})

	it("caps aliases per kind, per alias and in all", () => {
		const r = new TransmissionRegistry()
		const a = r.claim(live(HZ, 0))!
		for (let i = 1; i < TX_ALIASES_PER_KIND; i++)
			expect(r.attach(a.txId, `evt:x${i}`)).toBe(true)
		expect(r.get(a.txId)!.aliases.evt).toHaveLength(TX_ALIASES_PER_KIND)
		expect(r.attach(a.txId, "evt:over")).toBe(false)
		expect(r.stats().aliasOverflow).toBe(1)
		// one alias names at most TX_ALIAS_TX_MAX transmissions
		const ids: string[] = []
		for (let i = 0; i < TX_ALIAS_TX_MAX + 1; i++)
			ids.push(r.claim(live(HZ + (i + 1) * 100_000, 0))!.txId)
		for (let i = 0; i < TX_ALIAS_TX_MAX; i++)
			expect(r.attach(ids[i]!, "rec:scan:d~shared.wav")).toBe(true)
		expect(r.attach(ids[TX_ALIAS_TX_MAX]!, "rec:scan:d~shared.wav")).toBe(false)
		expect(r.txIdsOf("rec:scan:d~shared.wav")).toEqual(
			ids.slice(0, TX_ALIAS_TX_MAX),
		)
	})

	it("caps the global alias index at TX_ALIASES_MAX", () => {
		const r = new TransmissionRegistry()
		let entries = 0
		let attached = 0
		let res = r.claim(live(HZ, 0))!
		while (attached < TX_ALIASES_MAX) {
			if (r.get(res.txId)!.aliases.rec.length >= TX_ALIASES_PER_KIND) {
				entries++
				res = r.claim(
					live(HZ + entries * 100_000, 0, { sourceId: `s${entries % 8}` }),
				)!
			}
			if (r.attach(res.txId, `rec:k${attached}`)) attached++
			// the claims' own evt: aliases count too
			if (r.stats().aliases >= TX_ALIASES_MAX) break
		}
		expect(r.stats().aliases).toBe(TX_ALIASES_MAX)
		const before = r.stats().aliasOverflow
		expect(r.attach(res.txId, "evt:past")).toBe(false)
		expect(r.stats().aliasOverflow).toBe(before + 1)
	})

	it("derives noAudioReason and keeps the first refusal", () => {
		const r = new TransmissionRegistry()
		const c = obs(HZ, 0)
		const a = r.claim(c)!
		r.noteRefusal(c.alias, "refused:slots")
		r.noteRefusal(c.alias, "noise")
		expect(r.get(a.txId)!.refusal).toBe("refused:slots")
		expect(r.get(a.txId)!.noAudioReason).toBe("refused:slots")
		r.attach(a.txId, "rec:scan:d~f.wav")
		expect(r.get(a.txId)!.noAudioReason).toBeNull()
	})

	it("closed entries never change attributes", () => {
		const r = new TransmissionRegistry()
		const a = r.claim(live(HZ, 0))!
		r.noteLiveTone(a.claimant, { ctcssHz: 88.5, dcs: null })
		r.end(a.claimant, 10)
		const before = JSON.stringify(r.get(a.txId))
		r.end(a.claimant, 20)
		r.noteLiveTone(a.claimant, { ctcssHz: 100, dcs: null })
		r.noteRefusal(a.txId, "noise")
		r.closeSource("src-a", "source-lost", 30)
		expect(JSON.stringify(r.get(a.txId))).toBe(before)
	})

	it("10 000 claims against 528 open entries of one source scan only nearby claimants", () => {
		const r = new TransmissionRegistry()
		for (let i = 0; i < TX_OPEN_PER_SOURCE; i++)
			r.claim(obs(HZ + i * 25_000, 0))
		// Another source's open entries on the same channels are never candidates.
		for (let i = 0; i < 64; i++)
			r.claim(obs(HZ + i * 25_000, 0, { sourceId: "src-b" }))
		const before = r.claimScanStats()
		for (let i = 0; i < 10_000; i++) {
			const res = r.claim(obs(HZ + (i % TX_OPEN_PER_SOURCE) * 25_000, 1))
			if (res) r.end(res.claimant, 2)
		}
		const after = r.claimScanStats()
		expect(after.claims - before.claims).toBe(10_000)
		// Each claim joins its one entry: one claimant compared (its own channel), no expiry scan.
		expect(after.matchCandidates - before.matchCandidates).toBe(10_000)
		expect(after.expiryCandidates - before.expiryCandidates).toBe(0)
		expect(r.openOn("src-a")).toBe(TX_OPEN_PER_SOURCE)
	})

	it("an over-age scan runs only when the source's earliest start allows one", () => {
		const r = new TransmissionRegistry()
		for (let i = 0; i < 100; i++) r.claim(obs(HZ + i * 25_000, 0))
		const before = r.claimScanStats()
		r.claim(obs(HZ + 200 * 25_000, TX_MAX_MS - 1))
		expect(r.claimScanStats().expiryCandidates).toBe(before.expiryCandidates)
		r.claim(obs(HZ + 201 * 25_000, TX_MAX_MS))
		// 101 open entries examined once; the 100 over-age ones closed max-duration.
		expect(r.claimScanStats().expiryCandidates - before.expiryCandidates).toBe(
			101,
		)
		expect(r.openOn("src-a")).toBe(2)
	})
})

describe("deriveTone", () => {
	it("heard wins over none and not measured; recorder none wins over not measured", () => {
		expect(deriveTone(null, []).state).toBe("not-measured")
		expect(deriveTone(null, [undefined]).state).toBe("not-measured")
		expect(deriveTone(null, [null]).state).toBe("none")
		expect(deriveTone({ ctcssHz: null, dcs: null }, []).state).toBe("none")
		const heard = deriveTone({ ctcssHz: null, dcs: null }, [
			null,
			{ kind: "ctcss", hz: 88.5 },
		])
		expect(heard).toMatchObject({
			state: "heard",
			ctcssHz: 88.5,
			source: "recorder",
			dcsChecked: true,
		})
		expect(
			deriveTone({ ctcssHz: null, dcs: { code: "023", polarity: "normal" } }, [
				null,
			]),
		).toMatchObject({ state: "heard", dcs: "023", source: "live-demod" })
	})

	it("two different heard tones read the recorder's, ambiguous", () => {
		const t = deriveTone({ ctcssHz: 100, dcs: null }, [
			{ kind: "ctcss", hz: 88.5 },
		])
		expect(t).toMatchObject({
			ctcssHz: 88.5,
			source: "recorder",
			ambiguous: true,
		})
		expect(
			deriveTone({ ctcssHz: 88.5, dcs: null }, [{ kind: "ctcss", hz: 88.5 }])
				.ambiguous,
		).toBe(false)
	})
})

describe("TransmissionRefSchema", () => {
	it("takes tx_, rec:, evt:, obs: refs and refuses others", () => {
		for (const ok of ["rec:scan:d~f.wav", "evt:abc", "obs:o_1"])
			expect(TransmissionRefSchema.safeParse(ok).success).toBe(true)
		for (const bad of [
			"tx_lower",
			"call:x",
			"rec:",
			"rec:a b",
			"x".repeat(521),
		])
			expect(TransmissionRefSchema.safeParse(bad).success).toBe(false)
		expect(
			TransmissionRefSchema.safeParse(`obs:${"a".repeat(512)}`).success,
		).toBe(true)
		expect(
			TransmissionRefSchema.safeParse(`obs:${"a".repeat(513)}`).success,
		).toBe(false)
	})
})
