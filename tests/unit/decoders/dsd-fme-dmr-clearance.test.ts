/**
 * The DMR clearance state machine (dsd-fme-dmr-clearance.ts), driven
 * directly: one test per row of its state x event table. Lines are
 * modelled on dsd-fme's prints (ids synthetic).
 */
import { describe, expect, it } from "vitest"
import {
	classifyDmrLine,
	DmrClearance,
	dmrLineClearAlg,
	dmrLineErrored,
	dmrLineNeutral,
	dmrLinePrivacy,
	newDmrRoute,
	type DmrCallView,
	type DmrDecision,
	type DmrLane,
} from "../../../src/decoders/builtin/dsd-fme-dmr-clearance.js"

const TIMEOUT_MS = 4000
const MS = (burst: string) =>
	`00:00:01 Sync: +DMR MS/DM MODE/MONO | Color Code=01 | ${burst} `
const BS = (slot: 1 | 2, burst: string) =>
	slot === 1
		? `00:00:01 Sync: +DMR  [SLOT1]  slot2  | Color Code=01 | ${burst} `
		: `00:00:01 Sync: +DMR   slot1  [SLOT2] | Color Code=01 | ${burst} `
const BRACKETLESS = (burst: string) =>
	`00:00:01 Sync: +DMR   slot1   slot2  | Color Code=01 | ${burst} `
const LC = (slot = 1, tg = 9001, src = 91, extra = "") =>
	` SLOT ${slot} TGT=${tg} SRC=${src} Group Call ${extra} `
const K = "9001/91"

/** Drives the machine as the adapter does: line, then the lane's call. */
class Harness {
	readonly m = new DmrClearance(TIMEOUT_MS)
	private route = newDmrRoute()
	private seq = 0
	readonly decisions: DmrDecision[] = []
	/** The adapter's call per lane, reported after each line of its lane. */
	readonly calls = new Map<DmrLane, DmrCallView | null>()

	line(text: string, atMs = this.seq * 10): DmrLane | "foreign" {
		const seq = ++this.seq
		const event = classifyDmrLine(text, this.route)
		this.decisions.push(...this.m.line(event, seq, atMs))
		if (event.type === "foreign") return "foreign"
		const view = this.calls.get(event.lane)
		if (event.lane !== "x" && view !== undefined)
			this.decisions.push(...this.m.call(event.lane, view, seq, atMs))
		return event.lane
	}

	/** The adapter opens (or names) the lane's call; reported with the next line. */
	open(lane: DmrLane, callId = "c1", key: string | null = K): void {
		this.calls.set(lane, { callId, key })
	}

	end(lane: DmrLane): void {
		const view = this.calls.get(lane)
		if (view) this.m.ended(view.callId)
		this.calls.set(lane, null)
	}

	trust(callId = "c1") {
		return this.m.trust(callId)
	}

	cleared(callId = "c1") {
		return this.decisions.some(d => d.callId === callId && d.trust === "clear")
	}
}

/** A call opened on a clean header and its LC (voice-header pending). */
function headerCall(h: Harness, lane: DmrLane = "ms"): void {
	h.line(lane === "ms" ? MS("VLC") : BS(1, "VLC"))
	h.open(lane)
	h.line(LC())
}

/**
 * A named call-first call, not known clear: two voice bursts, a naming LC
 * (its naming-link proof), then a late error line that kills that proof.
 */
function namedCall(h: Harness): void {
	h.line(MS("VC*"))
	h.open("ms", "c1", null)
	h.line(MS("VC*"))
	h.open("ms", "c1", K)
	h.line(LC())
	expect(h.m.evidence("c1")).toMatchObject({ kind: "naming-link" })
	h.line(" (FEC ERR) ")
	h.line(MS("VC*"))
	expect(h.trust()).toBe("unknown")
}

describe("DMR clearance: classification", () => {
	it("reads errors and privacy fields first, each on its own", () => {
		expect(dmrLineErrored(" SLCO CRC ERR")).toBe(false)
		expect(dmrLineErrored(" AMBE 0123 err = [0] [0] (FEC ERR)")).toBe(true)
		expect(dmrLineErrored("Sync:  DMR | VOICE CACH/EMB ERR")).toBe(true)
		expect(
			dmrLineErrored("Sync:  DMR  [SLOT1]  slot2  | Frame Sync Err: 7"),
		).toBe(true)
		expect(dmrLinePrivacy(LC(1, 9001, 91, "SVC=0x40"))).toBe(true)
		expect(dmrLinePrivacy(LC(1, 9001, 91, "SVC=0x10"))).toBe(false)
		expect(dmrLinePrivacy(" ALG ID: 21; KEY ID: 00;")).toBe(true)
		expect(dmrLinePrivacy(" ALG ID: 00; KEY ID: 05;")).toBe(true)
		expect(dmrLinePrivacy(" ALG ID: 00; KEY ID: 00;")).toBe(false)
		expect(dmrLinePrivacy(LC(1, 9001, 91, "Encrypted (CRC ERR)"))).toBe(true)
		const neutral = classifyDmrLine(" AMBE 01 err = [0] [0] (FEC ERR)", {
			format: "ms",
			slot: "1",
		})
		// An allowlisted prefix carrying an error is an error first.
		expect(neutral).toMatchObject({ type: "line", errored: true })
		expect(dmrLineNeutral(" AMBE 01 err = [0] [0] ")).toBe(true)
		expect(dmrLineClearAlg(" Slot 1 DMR PI H- ALG ID: 00; KEY ID: 00;")).toBe(
			true,
		)
		// A PI header is its own burst kind (a clear-algorithm proof may open there).
		expect(
			classifyDmrLine(
				"00:00:01 Sync: +DMR  [SLOT1]  slot2  | Color Code=01 | PI ",
				newDmrRoute(),
			),
		).toMatchObject({ type: "sync", burst: "pi" })
	})

	it("routes bracketed slots, MS/DM and unplaced lines to their own lanes", () => {
		const route = newDmrRoute()
		expect(classifyDmrLine(LC(), route)).toMatchObject({ lane: "x" })
		expect(classifyDmrLine(BS(2, "VC1"), route)).toMatchObject({ lane: "2" })
		expect(classifyDmrLine(LC(1), route)).toMatchObject({ lane: "1" })
		expect(classifyDmrLine(" SLCO NULL", route)).toMatchObject({ lane: "2" })
		expect(classifyDmrLine(BRACKETLESS("TLC"), route)).toMatchObject({
			lane: "x",
		})
		expect(classifyDmrLine(LC(1), route)).toMatchObject({ lane: "x" })
		expect(classifyDmrLine("Sync: +DMR", route)).toMatchObject({
			lane: "x",
			burst: "bare",
		})
		expect(classifyDmrLine(MS("VC*"), route)).toMatchObject({ lane: "ms" })
		expect(classifyDmrLine(LC(2), route)).toMatchObject({ lane: "ms" })
		expect(classifyDmrLine("Sync: +DSTAR VOICE", route)).toEqual({
			type: "foreign",
		})
		expect(classifyDmrLine(LC(1), route)).toMatchObject({ lane: "x" })
	})
})

describe("DMR clearance: state x event rows", () => {
	it("a clean VLC sync with no call opens a burst and proves nothing", () => {
		const h = new Harness()
		h.line(MS("VLC"))
		expect(h.decisions).toEqual([])
	})

	it("a clean LC after a clean VLC opens the call pending (voice-header), not clear", () => {
		const h = new Harness()
		headerCall(h)
		expect(h.trust()).toBe("pending")
		expect(h.m.evidence("c1")).toMatchObject({
			kind: "voice-header",
			openingBurstKind: "vlc",
			burstClean: true,
		})
		expect(h.cleared()).toBe(false)
	})

	it("an LC after a dirty VLC opens nothing pending (candidate ids only)", () => {
		const h = new Harness()
		h.line(MS("VLC  (FEC ERR)"))
		h.open("ms")
		h.line(LC())
		expect(h.trust()).toBe("unknown")
		h.line(MS("VC*"))
		expect(h.cleared()).toBe(false)
	})

	it("a call opened on voice frames is unknown and its first voice burst is set", () => {
		const h = new Harness()
		h.line(MS("VC*"))
		h.open("ms", "c1", null)
		h.line(MS("VC*"))
		expect(h.trust()).toBe("unknown")
	})

	it("an LC after a TLC, a bare sync or an unplaced line proves nothing", () => {
		for (const sync of [MS("TLC"), MS("CSBK"), "Sync: +DMR"]) {
			const h = new Harness()
			h.line(sync)
			h.open(sync === "Sync: +DMR" ? "x" : "ms")
			h.line(LC())
			h.line(MS("VC*"))
			expect(h.cleared()).toBe(false)
		}
	})

	it("a voice sync of the call sets its first voice burst once; a dirty one spoils a pending proof", () => {
		const h = new Harness()
		headerCall(h)
		h.line(MS("VC*  (FEC ERR)"))
		expect(h.trust()).toBe("unknown")
		expect(h.cleared()).toBe(false)
	})

	it("the first clean LC after a frames call's first voice burst names and proves it; a later naming LC does not", () => {
		const h = new Harness()
		h.line(MS("VC*"))
		h.open("ms", "c1", null)
		h.line(MS("VC*"))
		h.open("ms", "c1", K)
		h.line(LC())
		expect(h.m.evidence("c1")).toMatchObject({ kind: "naming-link" })
		h.line(MS("VC*"))
		expect(h.trust()).toBe("clear")
		// Not the first LC after its first voice burst (an errored one came first).
		const late = new Harness()
		late.line(MS("VC*"))
		late.open("ms", "c1", null)
		late.line(MS("VC*"))
		late.line(LC(1, 9001, 91, "(CRC ERR)"))
		late.line(MS("VC*"))
		late.open("ms", "c1", K)
		late.line(LC())
		late.line(MS("VC*"))
		expect(late.cleared()).toBe(false)
	})

	it("a clear algorithm print opens no proof in an idle, CSBK or terminator burst", () => {
		for (const burst of ["IDLE", "CSBK", "TLC"]) {
			const h = new Harness()
			h.line(MS("VC*"))
			h.open("ms", "c1", null)
			h.line(MS("VC*"))
			h.line(MS(burst))
			h.line(" Slot 1 DMR PI H- ALG ID: 00; KEY ID: 00;")
			expect(h.m.evidence("c1")).toBeUndefined()
			h.line(MS("VC*"))
			expect(h.cleared()).toBe(false)
		}
		// A PI header burst is one.
		const pi = new Harness()
		pi.line(MS("VC*"))
		pi.open("ms", "c1", null)
		pi.line(MS("VC*"))
		pi.line(MS("PI "))
		pi.line(" Slot 1 DMR PI H- ALG ID: 00; KEY ID: 00;")
		pi.line(MS("VC*"))
		expect(pi.trust()).toBe("clear")
	})

	it("another talker's encrypted link control goes to the next call when it splits, else to this call", () => {
		const split = new Harness()
		headerCall(split)
		split.line(MS("VC*"))
		// The adapter splits on this line: the lane's call is c2 after it.
		split.open("ms", "c2", "9002/92")
		split.line(LC(1, 9002, 92, "Encrypted"))
		expect(split.trust("c2")).toBe("encrypted")
		expect(
			split.decisions.some(d => d.callId === "c1" && d.trust === "encrypted"),
		).toBe(false)
		const single = new Harness()
		headerCall(single)
		single.line(MS("VC*"))
		single.line(LC(1, 9002, 92, "Encrypted"))
		expect(single.trust()).toBe("encrypted")
	})

	it("an ended call's encryption is forgotten with it", () => {
		const h = new Harness()
		headerCall(h)
		h.line(LC(1, 9001, 91, "Encrypted"))
		expect(h.trust()).toBe("encrypted")
		h.end("ms")
		expect(h.trust()).toBe("unknown")
	})

	it("clear algorithm: a clean clear ALG print in a clean burst is settled like an LC; a late error kills it", () => {
		const run = (tail: string[]) => {
			const h = new Harness()
			h.line(MS("VC*"))
			h.open("ms", "c1", null)
			h.line(MS("VC*"))
			h.line(" Slot 1 DMR PI H- ALG ID: 00; KEY ID: 00;")
			for (const line of tail) h.line(line)
			return h
		}
		const settled = run([MS("VC*")])
		expect(settled.trust()).toBe("clear")
		expect(run([" (FEC ERR) ", MS("VC*")]).cleared()).toBe(false)
		expect(run([MS("VC*  (FEC ERR)")]).cleared()).toBe(false)
	})

	it("a named call's own LC after its voice is link-after-voice, settled by the next clean sync", () => {
		const h = new Harness()
		namedCall(h)
		h.line(MS("VC*"))
		h.line(LC())
		expect(h.m.evidence("c1")).toMatchObject({ kind: "link-after-voice" })
		h.line(MS("VC*"))
		expect(h.trust()).toBe("clear")
		expect(h.cleared()).toBe(true)
	})

	it("an error line or dirty print in the burst drops the proof at settlement", () => {
		for (const line of [" (FEC ERR)", " AMBE 0123 err = [0] [0] (FEC ERR)"]) {
			const h = new Harness()
			namedCall(h)
			h.line(MS("VC*"))
			h.line(LC())
			h.line(line)
			h.line(MS("VC*"))
			expect(h.cleared()).toBe(false)
		}
	})

	it("allowlisted prints with no error leave the proof pending", () => {
		const h = new Harness()
		namedCall(h)
		h.line(MS("VC*"))
		h.line(LC())
		for (const line of [
			" SLCO CRC ERR",
			" SLCO NULL ",
			" Activity Update TS1: Group Voice; Hash: 1; TS2: Idle; Hash: 0;",
			" DMR PDU Payload [00][01]",
			" AMBE 0123 err = [0] [0] ",
			"",
		])
			h.line(line)
		expect(h.trust()).toBe("pending")
		h.line(MS("VC*"))
		expect(h.trust()).toBe("clear")
	})

	it("any other non-sync line (CSBK text, a second LC, a sync-loss print) drops the proof", () => {
		for (const line of [
			" Channel Timing CSBK (CT_CSBK) ",
			LC(),
			"Sync: no sync",
		]) {
			const h = new Harness()
			namedCall(h)
			h.line(MS("VC*"))
			h.line(LC())
			h.line(line)
			h.line(MS("CSBK"))
			expect(h.cleared()).toBe(false)
		}
	})

	it("the next clean same-lane same-mode sync clears a call opened on its voice header", () => {
		const h = new Harness()
		headerCall(h)
		h.line(MS("VC*"))
		expect(h.trust()).toBe("clear")
	})

	it("a dirty sync drops; another lane's line has no effect", () => {
		const dirty = new Harness()
		headerCall(dirty, "1")
		dirty.line(BS(1, "VC1  (FEC ERR)"))
		expect(dirty.trust()).toBe("unknown")
		const other = new Harness()
		headerCall(other, "1")
		other.line(BS(2, "IDLE  (FEC ERR)"))
		other.line("00:00:01 Sync:  DMR   slot1  [SLOT2] | Frame Sync Err: 7")
		expect(other.trust()).toBe("pending")
		other.line(BS(1, "VC1"))
		expect(other.trust()).toBe("clear")
	})

	it("a bracketless line never settles, and its error spoils every open burst", () => {
		const clean = new Harness()
		headerCall(clean, "1")
		clean.line(BRACKETLESS("IDLE"))
		expect(clean.trust()).toBe("pending")
		clean.line(BS(1, "VC1"))
		expect(clean.trust()).toBe("clear")
		const dirty = new Harness()
		headerCall(dirty, "1")
		dirty.line(BRACKETLESS("VC3  (FEC ERR)"))
		dirty.line(BS(1, "VC1"))
		expect(dirty.cleared()).toBe(false)
	})

	it("a privacy field on any line of the lane makes the call encrypted, for good", () => {
		for (const line of [
			LC(1, 9001, 91, "Encrypted (CRC ERR)"),
			LC(1, 9001, 91, "SVC=0x40"),
			" Slot 1 DMR PI H- ALG ID: 21; KEY ID: 01;",
			LC(1, 9002, 92, "Encrypted"),
		]) {
			const h = new Harness()
			headerCall(h)
			h.line(MS("VC*"))
			expect(h.trust()).toBe("clear")
			h.line(line)
			expect(h.trust()).toBe("encrypted")
			h.line(MS("VC*"))
			h.line(LC())
			h.line(MS("VC*"))
			expect(h.trust()).toBe("encrypted")
		}
	})

	it("the first checked rival copy after voice revokes a clear call at once", () => {
		const h = new Harness()
		headerCall(h)
		h.line(MS("VC*"))
		h.line(MS("VC*"))
		h.line(LC(1, 9002, 92))
		expect(h.trust()).toBe("unknown")
		expect(h.decisions.at(-1)).toEqual({ callId: "c1", trust: "unknown" })
	})

	it("a split call (the rival's second copy) inherits nothing", () => {
		const h = new Harness()
		headerCall(h)
		h.line(MS("VC*"))
		h.line(LC(1, 9002, 92))
		h.line(MS("VC*"))
		h.end("ms")
		h.open("ms", "c2", "9002/92")
		h.line(LC(1, 9002, 92))
		expect(h.trust("c2")).toBe("unknown")
		h.line(MS("VC*"))
		expect(h.cleared("c2")).toBe(false)
	})

	it("the call's own key again in a later burst may prove it again (link-after-voice)", () => {
		const h = new Harness()
		headerCall(h)
		h.line(MS("VC*"))
		h.line(LC(1, 9002, 92))
		h.line(MS("VC*"))
		h.line(LC())
		h.line(MS("VC*"))
		expect(h.trust()).toBe("clear")
	})

	it("a named call's clean TLC and its trailer are terminator, settled by the next clean same-format sync", () => {
		const h = new Harness()
		namedCall(h)
		h.line(MS("TLC"))
		h.line(LC())
		expect(h.m.evidence("c1")).toMatchObject({ kind: "terminator" })
		h.line(MS("CSBK"))
		expect(h.trust()).toBe("clear")
	})

	it("an ending call settles on nothing else: another protocol, a bracketless line, an error, an unlisted line", () => {
		const tails: string[][] = [
			["Sync: +DSTAR VOICE"],
			[BRACKETLESS("IDLE")],
			[" (CRC ERR) ", MS("CSBK")],
			[" Channel Timing CSBK (CT_CSBK) ", MS("CSBK")],
		]
		for (const tail of tails) {
			const h = new Harness()
			namedCall(h)
			h.line(MS("TLC"))
			h.line(LC())
			for (const line of tail) h.line(line)
			expect(h.cleared()).toBe(false)
		}
	})

	it("an unnamed call's trailer gives ids as metadata only", () => {
		const h = new Harness()
		h.line(MS("VC*"))
		h.open("ms", "c1", null)
		h.line(MS("VC*"))
		h.line(MS("TLC"))
		h.open("ms", "c1", K)
		h.line(LC())
		h.line(MS("CSBK"))
		expect(h.cleared()).toBe(false)
	})

	it("a dirty TLC gives no terminator", () => {
		const h = new Harness()
		namedCall(h)
		h.line(MS("TLC  (FEC ERR)"))
		h.line(LC())
		h.line(MS("CSBK"))
		expect(h.cleared()).toBe(false)
	})

	it("a call timeout kills the lane's burst context and proof", () => {
		const h = new Harness()
		headerCall(h)
		h.m.timeout(["ms", "x"])
		h.line(MS("VC*"))
		expect(h.cleared()).toBe(false)
	})

	it("another protocol's sync drops every lane's proof and burst", () => {
		const h = new Harness()
		headerCall(h)
		h.line("Sync: +DSTAR VOICE")
		h.line(MS("VC*"))
		expect(h.cleared()).toBe(false)
	})

	it("a BS/MS change bumps the mode generation", () => {
		const h = new Harness()
		headerCall(h, "1")
		h.line(MS("VC*"))
		h.line(BS(1, "VC1"))
		expect(h.cleared()).toBe(false)
	})

	it("a restart kills every proof (decoder generation)", () => {
		const h = new Harness()
		headerCall(h)
		h.m.restart()
		h.line(MS("VC*"))
		expect(h.cleared()).toBe(false)
	})

	it("a TLC + LC train with no call proves nothing", () => {
		const h = new Harness()
		for (let i = 0; i < 5; i++) {
			h.line(BS(1, "TLC"))
			h.line(LC())
		}
		expect(h.decisions).toEqual([])
	})

	it("expiry: a proof older than the call timeout at its settling sync is dropped, at the bound it settles", () => {
		const run = (settleAt: number) => {
			const h = new Harness()
			h.line(MS("VLC"), 0)
			h.open("ms")
			h.line(LC(), 1)
			h.line(MS("VC*"), settleAt)
			return h.trust()
		}
		// expiresAt = LC at 1 ms + 4 000 = 4 001.
		expect(run(1 + TIMEOUT_MS)).toBe("clear")
		expect(run(2 + TIMEOUT_MS)).toBe("unknown")
	})
})
