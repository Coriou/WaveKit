/**
 * PROVISIONAL decoder line timings for the truth scorecard's digital voice
 * scenes (scripts/bench/scanner-quality/truth-dv.ts): for DMR scenes of
 * dv-plan.mjs, the dsd-fme lines a decoder would print and when, modelled on
 * what is known of the current chain, not measured. The in-image baseline of
 * tests/integration/dv-capture.test.ts (its recorded lines) replaces them:
 * the DMR scenes are recorded now, so only the noise-sync seed is written.
 *
 *   node scripts/fixtures/dv-latency-seeds.mjs [OUTDIR]
 *
 * writes `dv-latency-<scene>.json` (default OUTDIR
 * tests/mocks/fixtures/synthetic/; run `pnpm exec prettier --write` on them
 * after: tests/unit/fixtures/dv-plan.test.ts compares the parsed files with
 * this model). The model, per over:
 * - the first burst (the Voice LC header) is lost: dsd-fme locks on it;
 * - one sync line per voice superframe, at its A burst;
 * - the IDs come from the embedded LC: a SLOT line after burst E of each
 *   superframe whose bursts B to E were all sent; in direct mode every other
 *   one is lost, the first included (44 to 56 % of link controls lost in
 *   direct mode, so the call starts one superframe later still);
 * - the terminator prints its TLC sync line and its SLOT line;
 * - a repeater prints an IDLE sync line per idle burst while keyed (the
 *   hang-time idles and the idle slot);
 * - every line arrives LINE_LATENCY_MS after its burst ends.
 * Plus one scene of noise syncs only, no over (noiseSeed): the false-call
 * bar (dvFalse 0).
 */
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { DMR_FRAME_MS, dmrPlanDibits } from "./dmr-4fsk.mjs"
import { DV_SCENES, PAD_SYMBOLS, scenePlan } from "./dv-plan.mjs"

/** Burst end to line arrival (sox and dsd-fme buffering): a guess until measured. */
export const LINE_LATENCY_MS = 40
/** A fictional channel for the scenes (no real frequency). */
export const DV_SEED_FREQUENCY_HZ = 454_906_250
/**
 * The DMR scenes the scorecard replays from this model. None now: every DMR
 * scene it modelled has a recorded seed (tests/integration/dv-capture.test.ts,
 * WAVEKIT_DVCAP_LINES), and a modelled seed beside a recorded one would mix
 * modelled timings with measured ones. `dmrSeed` stays for a new scene with
 * no recording yet.
 */
export const DV_SEED_SCENES = []

const BURST_MS = 27.5
const HALF_MS = DMR_FRAME_MS / 2
const PAD_MS = (PAD_SYMBOLS / 4800) * 1000

const clock = ms => {
	const s = Math.floor(ms / 1000)
	const two = n => String(n).padStart(2, "0")
	return `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`
}

/** The sync line of a burst of `type` on `slot` (1, 2). */
function syncLine(atMs, mode, slot, type) {
	const where =
		mode === "repeater"
			? slot === 1
				? " [slot1]  slot2 "
				: "  slot1  [slot2]"
			: "MS/DM MODE/MONO"
	return `${clock(atMs)} Sync: +DMR ${where} | Color Code=01 | ${type} `
}

const slotLine = (slot, o) =>
	` SLOT ${slot} TGT=${o.talkgroup} SRC=${o.source} Group Call `

/** The seed of one DMR scene of dv-plan.mjs. */
export function dmrSeed(scene) {
	const mode = scene.dmrMode ?? "direct"
	const truth = scenePlan(scene, { trace: false })
	const inputs = scene.overs.map(o => ({
		talkgroup: 4321,
		source: 1_234_567,
		...o,
		...o.ids,
	}))
	const raw = dmrPlanDibits(inputs, { mode, hangMs: scene.hangMs ?? 0 })
	const lines = []
	const at = burstStartMs => burstStartMs + PAD_MS + BURST_MS + LINE_LATENCY_MS
	const busy = [new Set(), new Set()]
	raw.overs.forEach((o, i) => {
		const input = inputs[i]
		const headers = input.lateEntry ? 0 : (input.headers ?? 1)
		const first = o.startMs
		for (let k = 0; k < o.bursts; k++)
			busy[o.slot - 1].add(
				Math.round((first - (o.slot - 1) * HALF_MS) / DMR_FRAME_MS) + k,
			)
		let index = input.lateEntry ?? 0
		let seen = new Set()
		let complete = 0
		const voice = o.bursts - headers - (o.terminator ? 1 : 0)
		for (let v = 0; v < voice; v++) {
			const t = first + (headers + v) * DMR_FRAME_MS
			if (index === 0)
				lines.push({ atMs: at(t), text: syncLine(at(t), mode, o.slot, "VC*") })
			seen.add(index)
			if (index === 4 && [1, 2, 3, 4].every(n => seen.has(n))) {
				const lost = mode === "direct" && complete % 2 === 0
				complete++
				if (!lost) lines.push({ atMs: at(t), text: slotLine(o.slot, o) })
			}
			index = (index + 1) % 6
			if (index === 0) seen = new Set()
		}
		if (o.terminator) {
			const t = first + (o.bursts - 1) * DMR_FRAME_MS
			lines.push({ atMs: at(t), text: syncLine(at(t), mode, o.slot, "TLC") })
			lines.push({ atMs: at(t), text: slotLine(o.slot, o) })
		}
	})
	if (mode === "repeater") {
		const hang = Math.round((scene.hangMs ?? 0) / DMR_FRAME_MS)
		const keyed = new Set()
		for (const o of raw.overs) {
			const f0 = Math.floor(o.startMs / DMR_FRAME_MS)
			const f1 = Math.floor((o.endMs - 1) / DMR_FRAME_MS) + hang
			for (let f = f0; f <= f1; f++) keyed.add(f)
		}
		for (const f of [...keyed].sort((a, b) => a - b))
			for (const slot of [1, 2])
				if (!busy[slot - 1].has(f)) {
					const t = f * DMR_FRAME_MS + (slot - 1) * HALF_MS
					lines.push({ atMs: at(t), text: syncLine(at(t), mode, slot, "IDLE") })
				}
	}
	lines.sort((a, b) => a.atMs - b.atMs)
	return {
		version: 1,
		provisional: true,
		note: "Modelled, not measured (scripts/fixtures/dv-latency-seeds.mjs): replace with the in-image capture baseline.",
		scene: scene.name,
		protocol: "dmr",
		frequencyHz: DV_SEED_FREQUENCY_HZ,
		overs: truth.overs.map(o => ({
			index: o.index,
			protocol: o.protocol,
			slot: o.slot,
			startMs: Math.round(o.startMs * 10) / 10,
			endMs: Math.round(o.endMs * 10) / 10,
			frames: o.frames,
			terminator: o.terminator,
			clear: true,
			ids: o.ids,
			nominalMs: o.nominalMs,
		})),
		lines: lines.map(l => ({
			atMs: Math.round(l.atMs * 10) / 10,
			text: l.text,
		})),
	}
}

/** The scenes of noise syncs only (noiseSeed). */
export const DV_NOISE_SCENES = ["noise-sync"]

/** Noise bursts this far apart: past every chain window (D-STAR's 880 ms is the longest). */
const NOISE_APART_MS = 1500

/**
 * Analog FM and noise that dsd-fme hears as stray syncs, never an over, so
 * no call may start: unchecked direct-mode DMR voice syncs in pairs 700 ms
 * apart (one SYNC_CHAIN_MS window), D-STAR voice syncs in pairs one 420 ms
 * superframe apart, a P25 HDU and LDU1 180 ms apart, and runs of errored
 * DMR syncs with one clean among them. Lines only, no over: scored by its
 * false calls (dvFalse).
 */
export function noiseSeed() {
	const lines = []
	let t = 1000
	const push = (atMs, text) => lines.push({ atMs, text })
	const dstar = at => `${clock(at)} Sync: +DSTAR VOICE `
	const p25 = (at, duid) => `${clock(at)} Sync: +P25p1 NAC/CC: 2A5;  ${duid}`
	for (let round = 0; round < 6; round++) {
		push(t, syncLine(t, "direct", 1, "VC*"))
		push(t + 700, syncLine(t + 700, "direct", 1, "VC*"))
		t += 700 + NOISE_APART_MS
		push(t, dstar(t))
		push(t + 420, dstar(t + 420))
		t += 420 + NOISE_APART_MS
		push(t, p25(t, "HDU"))
		push(t + 180, p25(t + 180, "LDU1"))
		t += 180 + NOISE_APART_MS
		for (let k = 0; k < 4; k++) {
			const at = t + k * 360
			push(at, syncLine(at, "direct", 1, k === 2 ? "VC*" : "VC* (FEC ERR)"))
		}
		t += 3 * 360 + NOISE_APART_MS
	}
	return {
		version: 1,
		provisional: true,
		note: "Modelled, not measured (scripts/fixtures/dv-latency-seeds.mjs): stray syncs of analog FM and noise, no over; no call may start.",
		scene: "noise-sync",
		protocol: "dmr",
		frequencyHz: DV_SEED_FREQUENCY_HZ,
		overs: [],
		lines,
	}
}

/** Every seed, by file name. */
export function dvSeeds() {
	return [
		...DV_SEED_SCENES.map(name => {
			const scene = DV_SCENES.find(s => s.name === name)
			if (scene === undefined) throw new Error(`no scene ${name}`)
			return { file: `dv-latency-${name}.json`, seed: dmrSeed(scene) }
		}),
		{ file: "dv-latency-noise-sync.json", seed: noiseSeed() },
	]
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const dir = process.argv[2] ?? "tests/mocks/fixtures/synthetic"
	for (const { file, seed } of dvSeeds())
		writeFileSync(join(dir, file), `${JSON.stringify(seed, null, "\t")}\n`)
}
