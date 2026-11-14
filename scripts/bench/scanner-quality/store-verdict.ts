/**
 * Store-backed late-verdict scenes (synthetic, offline): the analog recorder
 * (WidebandAnalogRecorder) on stream time with its voicePrior and decodedLabel lambdas wired to a
 * real DiscoveryStore exactly as scanner-service wires them (store.voicePrior, ownerDecoded), the
 * store fed observations and decodes as the scanner would feed it.
 *
 *   pnpm exec esbuild scripts/bench/scanner-quality/store-verdict.ts --bundle \
 *     --platform=node --format=esm --packages=external \
 *     --outfile=output/bench/store-verdict.mjs
 *   node output/bench/store-verdict.mjs
 *
 * Scenes (one JSON line each):
 * - mixed: one channel carrying analog FM voice without CTCSS and DMR. An earlier analog over left
 *   an analog voice proof (live audio heard voice), a DMR over (decoded) follows, then analog overs
 *   and DMR overs (each decoded, keying up 4 s after the analog over, inside its grace) alternate.
 *   Expected: every analog over kept.
 * - shared: the same with no analog proof at all (a PMR446 channel shared with DMR446).
 *   Expected: every analog over kept.
 * - pager-stored-analog-fm: three 2FSK bursts (1 200 Bd, ±4.5 kHz) whose snapshots read analog-fm,
 *   20 s apart; identify's POCSAG decode of each lands DECODE_AT_S = 8 s after its onset, citing
 *   it. The store's class of the channel is analog-fm too. Expected: bursts 2 and 3 never written;
 *   the first one is kept (a known limit: a fresh channel with no digital prior holds nothing).
 * - pager-stored-fsk2-wide: the same, the store's class of the channel fsk2-wide (the spectrum's
 *   majority vote): the first burst is held, and its decode, citing it inside the grace, discards
 *   it. Expected: no burst kept.
 *
 * Nothing touches the network or a device.
 */
import process from "node:process"
import { ownerDecoded } from "../../../src/core/scanner/channel/voice-veto.js"
import { DiscoveryStore } from "../../../src/core/scanner/store/discovery-store.js"
import {
	counterIds,
	dmrCc,
	evidence,
	makeObs,
} from "../../../tests/mocks/scanner/observations.js"
import {
	CENTRE,
	LOW_FS,
	LOW_OFFSET,
	harness,
	input,
	snapshot,
} from "../../../tests/unit/core/scanner/wideband-recorder-harness.js"
import { FskSource } from "../../../tests/unit/core/scanner/wideband-nfm-fixtures.js"
import type { ScannerClass } from "../../../src/core/scanner/types.js"

const CH = CENTRE + LOW_OFFSET
const DECODE_AT_S = 8

interface Due {
	at: number
	t: { run: () => void; live: boolean }
}

/** The store's prior read; absent on a base without it (the comparison run). */
const priorOf = (store: DiscoveryStore, id: string) =>
	(store as Partial<Pick<DiscoveryStore, "voicePrior">>).voicePrior?.(id)

function rig() {
	let now = () => 0
	const store = new DiscoveryStore({
		maxDiscoveries: 100,
		now: () => now(),
		newId: counterIds(),
		rasters: () => [{ spacingHz: 12_500, firstChannelHz: CH }],
	})
	const h = harness({
		fs: LOW_FS,
		offset: LOW_OFFSET,
		liveClock: true,
		source: { ctcssHz: null, syllables: true },
		decodedLabel: id => ownerDecoded(store, id),
		voicePrior: id => priorOf(store, id) ?? null,
	})
	now = h.now
	const timers = (
		h as { timers?: { ms: number; run: () => void; live: boolean }[] }
	).timers
	const due: Due[] = []
	let seen = 0
	const tick = (): void => {
		if (timers === undefined) return
		for (; seen < timers.length; seen++) {
			const t = timers[seen]!
			due.push({ at: h.now() + t.ms, t })
		}
		for (const d of due.splice(0))
			if (d.at <= h.now()) {
				if (d.t.live) d.t.run()
			} else due.push(d)
	}
	return { h, store, tick }
}

type Rig = ReturnType<typeof rig>

/** Ingests one observation of the channel; returns its discovery. */
function ingest(
	r: Rig,
	id: string,
	cls: ScannerClass,
	seconds: number,
): string | null {
	return (
		r.store.ingest(
			makeObs({
				id,
				centreHz: CH,
				startedAt: r.h.now(),
				durationMs: seconds * 1000,
				cls,
				open: false,
				gate: "passed",
			}),
		).discoveryId ?? null
	)
}

/** One transmission of `seconds` on the channel: snapshots every 25 ms, the close 600 ms late. */
async function transmission(
	r: Rig,
	id: string,
	seconds: number,
	kind: "voice" | "dmr" | "pager",
	stored?: ScannerClass,
): Promise<void> {
	const { h, tick } = r
	const cls: ScannerClass =
		stored ?? (kind === "dmr" ? "fsk4-12k5" : "analog-fm")
	const discoveryId = ingest(r, id, cls, seconds)
	const fsk =
		kind === "voice"
			? null
			: new FskSource({
					fs: h.fs,
					offsetHz: LOW_OFFSET,
					...(kind === "pager"
						? { baud: 1200, levelsHz: [-4500, 4500], preambleSymbols: 576 }
						: {}),
					amp: 0.4,
				})
	const extra =
		kind === "dmr"
			? { analogFm: false, spectralDigital: true, digitalClass: true }
			: {}
	const chunk = h.fs / 40
	const onset = h.engine.liveEdge()
	const end = onset + seconds * h.fs
	const track = (last: number) => snapshot(id, onset, last, { centreHz: CH })
	for (let i = 0; i < Math.round(seconds * 40); i++) {
		h.engine.write(fsk ? fsk.next(chunk, true) : h.src.next(chunk, true))
		const edge = h.engine.liveEdge()
		if (edge - onset >= 0.1 * h.fs)
			h.rec.track(
				input(id, track(Math.min(edge, end)), { discoveryId, ...extra }),
			)
		tick()
		await h.pump()
	}
	await quiet(r, 0.6)
	h.rec.closed(id, track(end), null, {
		analogFm: kind !== "dmr",
		discoveryId,
	})
}

async function quiet(r: Rig, seconds: number): Promise<void> {
	await r.h.feed(seconds, false, r.tick)
}

function decode(
	r: Rig,
	observationId: string,
	protocol: "dmr" | "pocsag",
): void {
	const at = r.h.now()
	const ev = evidence(
		protocol,
		at,
		protocol === "dmr"
			? { identity: dmrCc(1) }
			: { identity: { kind: "pocsag-capcode", value: "1234" } },
	)
	const id = r.store.discoveryIdOf(observationId)
	if (id === undefined) return
	r.store.appendObservationEvidence(observationId, ev)
	r.store.applyEvidence(id, ev)
}

function report(r: Rig, scene: string, extra: Record<string, unknown>) {
	const ids = new Set(
		["v0", "v1", "v2", "v3", "d0", "d1", "d2", "p0", "p1", "p2", "proof"].map(
			o => r.store.discoveryIdOf(o) ?? null,
		),
	)
	ids.delete(null)
	return {
		scene,
		discoveries: [...ids].map(id => {
			const p = priorOf(r.store, id!)
			return {
				id,
				labels: p?.labels,
				class: p?.class,
			}
		}),
		recordings: r.h.ops.map(o => ({
			observationId: o.input.observationId,
			outcome: o.outcome,
			seconds: Math.round((o.frames / 8000) * 10) / 10,
		})),
		decisions: r.h.rec
			.diagnostics()
			.recent.map(d => `${d.observationId ?? "?"}:${d.code}`),
		...extra,
	}
}

async function mixed(proof: boolean): Promise<Record<string, unknown>> {
	const r = rig()
	let proofRecorded = false
	await quiet(r, 1)
	if (proof) {
		// An earlier analog over that live audio heard as voice (an analog voice proof).
		ingest(r, "proof", "analog-fm", 3)
		proofRecorded = r.store.recordAnalog("proof", {
			outcome: "heard",
			mode: "nfm",
			voice: true,
			tone: { ctcssHz: null, dcs: null },
			transport: "live",
			at: r.h.now(),
		})
	}
	// The channel's first transmission is DMR, decoded.
	await transmission(r, "d0", 3, "dmr")
	decode(r, "d0", "dmr")
	await quiet(r, 4)
	const voices = [5, 8, 4, 6]
	for (let k = 0; k < voices.length; k++) {
		await transmission(r, `v${k}`, voices[k]!, "voice")
		// A DMR user keys up within the analog file's grace.
		await quiet(r, 4)
		if (k < 3) {
			await transmission(r, `d${k + 1}`, 3, "dmr")
			decode(r, `d${k + 1}`, "dmr")
		}
		await quiet(r, 4)
	}
	await quiet(r, 30)
	await r.h.rec.stop()
	const kept = r.h.ops.filter(
		o => o.outcome === "finalized" && o.input.observationId.startsWith("v"),
	).length
	const id = r.store.discoveryIdOf("v0")
	return report(r, proof ? "mixed" : "shared", {
		proofRecorded,
		analogVoiceHeard:
			id === undefined ? null : priorOf(r.store, id)?.analogVoice(),
		analogOvers: voices.length,
		analogKept: kept,
		everyAnalogOverKept: kept === voices.length,
	})
}

async function pager(stored: ScannerClass): Promise<Record<string, unknown>> {
	const r = rig()
	await quiet(r, 1)
	for (let k = 0; k < 3; k++) {
		const id = `p${k}`
		let decoded = false
		await transmission(r, id, 4, "pager", stored)
		for (let s = 4.6; s < 20; s += 0.025) {
			if (!decoded && s >= DECODE_AT_S) {
				decode(r, id, "pocsag")
				decoded = true
			}
			await quiet(r, 0.025)
		}
	}
	await quiet(r, 30)
	await r.h.rec.stop()
	return report(r, `pager-stored-${stored}`, {
		bursts: 3,
		decodeAtS: DECODE_AT_S,
		burstsKept: r.h.ops.filter(o => o.outcome === "finalized").length,
	})
}

for (const scene of [
	() => mixed(true),
	() => mixed(false),
	() => pager("analog-fm"),
	() => pager("fsk2-wide"),
])
	process.stdout.write(`${JSON.stringify(await scene())}\n`)
