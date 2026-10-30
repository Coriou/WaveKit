import { EventEmitter } from "node:events"
import { expect, it } from "vitest"
import { createEfficiencyMonitor } from "../../../../src/decoders/enablement/efficiency-monitor.js"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import type { DropReader } from "../../../../src/decoders/enablement/efficiency-gate.js"
import type {
	LateDropWindow,
	RunningPlacement,
	WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"
import { decoderSummary } from "../../../../src/api/routes/decoder-summary.js"

/**
 * Regression of a live retune (one source; synthetic ids): the operator
 * tunes from a pager band to the ADS-B band and the rate change reconnects
 * the source. The ADS-B placement is the only one whose band holds the tuned
 * frequency; one untuned placement keeps running. Observed before the fix:
 * the ADS-B placement waited about 60 s for the source's clear window, and
 * at about t+188 s late drops shed it although an untuned placement ran.
 *
 * The monitor and the gate read one fake monotonic clock (`mono`), the
 * gate's own time source; samples are taken on it every 2000 ms.
 */
const placement = (
	key: string,
	costCores: number,
	tuned: boolean,
): WantedPlacement => ({
	key,
	decoderId: key,
	sourceId: "s",
	reach: "raw",
	channelHz: null,
	costCores,
	origin: "band",
	primary: true,
	sampleRateHz: 2_400_000,
	...(tuned ? { tunedBand: true as const } : {}),
})
const running = (p: WantedPlacement, at: number): RunningPlacement => ({
	key: p.key,
	sourceId: p.sourceId,
	reach: p.reach,
	costCores: p.costCores,
	sampleRateHz: p.sampleRateHz,
	admittedAtMs: at,
	mode: "auto",
	startMode: "auto",
	...(p.tunedBand ? { tunedBand: true as const } : {}),
})

const TUNE_MS = 100_000
// Late drops are condemned from this point on (late-drop detection itself is
// out of scope here: the windows are supplied as the monitor would report).
const LATE_FROM_MS = TUNE_MS + 188_000

function retune(tuned: boolean) {
	const events = new EventEmitter()
	let mono = 0
	const counters = { droppedBytesTotal: 0, droppedChunksTotal: 0 }
	const monitor = createEfficiencyMonitor({
		sourceEvents: events,
		sources: () => ["s"],
		branchCounters: () => new Map([["raw", counters]]),
		topology: () => "raw",
		cpu: { normalisedPercent: 10 },
		now: () => mono,
		monoNow: () => mono,
		setInterval: () => ({ cancel() {} }),
	})
	const lateWindows = (): readonly LateDropWindow[] =>
		mono >= LATE_FROM_MS
			? [
					{
						startMono: mono - 20_000,
						endMono: mono - 10_000,
						condemning: true,
						linkOrUnknownDrops: false,
					},
					{
						startMono: mono - 10_000,
						endMono: mono,
						condemning: true,
						linkOrUnknownDrops: false,
					},
				]
			: []
	const drops: DropReader = { ...monitor, lateWindows }
	const gate = createEfficiencyGate(
		{ budgetCores: 1.5, cpuGuardPercent: 90 },
		{ drops },
	)
	const tick = (at: number) => {
		mono = at
		gate.record(monitor.sampleNow())
	}
	const other = placement("other", 0.3, false)
	const adsb = placement("adsb", 0.25, tuned)
	let live: RunningPlacement[] = []
	let adsbAdmittedAt: number | null = null
	const shed: { key: string; detail: string; at: number }[] = []
	monitor.start()
	try {
		for (let at = 2000; at <= 66_000; at += 2000) tick(at)
		expect(gate.admit(other, [], mono)).toEqual({ admit: true })
		live = [running(other, mono)]
		for (let at = 68_000; at < TUNE_MS; at += 2000) {
			tick(at)
			gate.probation(live, mono)
		}
		// The retune: the source drops (rate unknown) and delivers again 1 s later.
		mono = TUNE_MS
		events.emit("disconnected", "s")
		mono = TUNE_MS + 1000
		events.emit("data", "s", Buffer.alloc(1))
		for (let at = TUNE_MS + 2000; at <= TUNE_MS + 300_000; at += 2000) {
			tick(at)
			if (adsbAdmittedAt === null && !shed.some(s => s.key === "adsb")) {
				const decision = gate.admit(adsb, live, mono)
				if (decision.admit) {
					adsbAdmittedAt = mono
					live = [...live, running(adsb, mono)]
				}
			}
			for (const verdict of gate.probation(live, mono)) {
				shed.push({ ...verdict, at: mono })
				gate.noteSuspended(verdict.key, verdict.detail, mono)
				live = live.filter(p => p.key !== verdict.key)
			}
		}
	} finally {
		monitor.stop()
	}
	return { adsbAdmittedAt, shed }
}

it("a tuned-band decoder starts as soon as the reconnected source runs clean", () => {
	const before = retune(false)
	const after = retune(true)
	// Before: the clear window. Reconnect data at t+1 s, delivery settles one
	// 2000 ms sample later, then 60 000 ms of clean run earn "ok".
	expect(before.adsbAdmittedAt! - TUNE_MS).toBeGreaterThanOrEqual(60_000)
	// After: admitted at the first sample with a clean run under way, within
	// three samples (6000 ms) of the reconnect; no fixed 60 s hold.
	expect(after.adsbAdmittedAt! - TUNE_MS).toBeLessThanOrEqual(6000)
})

it("late drops shed the untuned decoder first and the tuned-band one only when it is alone", () => {
	const before = retune(false)
	const after = retune(true)
	// Before the fix the newest eligible placement, the ADS-B one, went first.
	expect(before.shed[0]).toMatchObject({ key: "adsb", detail: "late-drops" })
	// After: the untuned placement is shed first, at the first late verdict.
	expect(after.shed[0]).toMatchObject({ key: "other", detail: "late-drops" })
	expect(after.shed[0]!.at).toBeGreaterThanOrEqual(LATE_FROM_MS)
	// Alone and still condemned after the 30 s cooldown, it is shed too...
	const alone = after.shed.find(s => s.key === "adsb")
	expect(alone).toMatchObject({ detail: "late-drops" })
	expect(alone!.at).toBeGreaterThanOrEqual(after.shed[0]!.at + 30_000)
	// ...and the summary says so plainly, with a code and actions.
	const now = Date.parse("2026-10-01T12:00:00Z")
	const summary = decoderSummary(
		{
			id: "adsb",
			type: "readsb",
			running: false,
			health: "running",
			uptime: 0,
			stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
			restartCount: 0,
			mode: "auto",
			desiredRunning: true,
			suspended: true,
			suspension: { reasonCode: "efficiency-budget", since: new Date(now) },
			efficiency: { detail: "late-drops" },
		},
		now,
	)
	expect(summary.verdict).toMatchObject({
		code: "efficiency-late-drops",
		actions: expect.arrayContaining(["turn-off-others"]),
	})
	expect(summary.verdict.text).toMatch(/^ADS-B paused/)
})
