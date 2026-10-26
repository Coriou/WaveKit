import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import type { ScannerIdentifyEventData } from "@wavekit/api-types"
import fc from "fast-check"
import {
	ambientTrustFromBinding,
	type AmbientEvidence,
	type AmbientEvidenceEvent,
	type AmbientTrustBinding,
} from "../../../../src/core/scanner/probes/ambient.js"
import { CONFIRM_MIN_SEPARATION_MS } from "../../../../src/core/scanner/probes/confirm/confirm-memory.js"
import type { TuningTrust } from "../../../../src/core/spectrum/types.js"
import type {
	DecoderConfig,
	DecoderStatus,
} from "../../../../src/decoders/types.js"
import {
	FS,
	feedTone,
	serviceHarness,
	tick,
} from "../../../mocks/scanner/service-fakes.js"
import {
	addInto,
	analogFm,
	gaussianNoise,
	mulberry32,
	packCu8,
} from "../../../mocks/scanner/signals.js"

// WG7 AMB: the scanner service wires ambient targets, trust and coverage into identify.

const AIS_A = 161_975_000
const AIS_B = 162_025_000
/** Source centre 100 kHz below AIS channel A: both AIS channels lie in the 1.024 Msps window. */
// WG11 req 1.3: the 446/162 MHz test band plans list 6.25 kHz rasters, so identify first adds the
// narrow digital trials (dpmr, dstar, nxdn48) ahead of the ambient one. Their outcome is timing
// dependent (pending, running, no-sync), so only their identity is asserted. Scanner-redesign
// 3.12: the narrowest covering range (marine VHF) sets the priors, so the broader land-mobile
// range no longer lifts nxdn48.
const NARROW_TRIALS = [
	expect.objectContaining({ protocol: "analog-fm", outcome: "unsupported" }),
	expect.objectContaining({ protocol: "dpmr", transport: "offset" }),
	expect.objectContaining({ protocol: "dstar", transport: "offset" }),
	expect.objectContaining({ protocol: "nxdn48", transport: "offset" }),
]

const CENTRE_AIS = AIS_A - 100_000

const aisConfig = (id = "ais"): DecoderConfig => ({
	id,
	type: "ais-catcher",
	enabled: true,
	sourceId: "rtl",
	options: {},
})

const status = (id: string, type: string): DecoderStatus =>
	({
		id,
		type,
		owner: "config",
		running: true,
		health: "running",
		suspended: false,
	}) as unknown as DecoderStatus

const ship = (mmsi: string) => ({
	type: "ship",
	data: { mmsi, channel: "A" },
	timestamp: new Date(),
})

async function until(pred: () => boolean, ms = 10_000): Promise<void> {
	const end = Date.now() + ms
	while (!pred() && Date.now() < end) await tick(20)
}

interface Rig {
	h: ReturnType<typeof serviceHarness>
	statuses: Map<string, DecoderStatus>
	configs: Map<string, DecoderConfig>
	instances: Map<string, EventEmitter | { caps: { input: string } }>
	ambient: () => AmbientEvidence
}

/** A harness whose fake manager reports config-owned decoders (startup or runtime). */
function rig(opts: {
	trust?:
		| ((id: string, hz: number, sourceId: string) => TuningTrust | undefined)
		| null
	startup?: DecoderConfig[]
}): Rig {
	const h = serviceHarness({
		patch: s => {
			s.passive.enabled = false
		},
		centreHz: CENTRE_AIS,
		decoderConfigs: opts.startup ?? [],
		...(opts.trust ? { ambientTrust: opts.trust } : {}),
	})
	const statuses = new Map<string, DecoderStatus>()
	const configs = new Map<string, DecoderConfig>()
	const instances = new Map<
		string,
		EventEmitter | { caps: { input: string } }
	>()
	for (const c of opts.startup ?? []) {
		statuses.set(c.id, status(c.id, c.type))
		configs.set(c.id, c)
		instances.set(c.id, { caps: { input: "iq" } })
	}
	const d = h.decoders as unknown as Record<string, unknown>
	const probeDecoder = h.decoders.getDecoder.bind(h.decoders)
	d["getAllStatus"] = () => [...statuses.values()]
	d["getStatus"] = (id: string) => statuses.get(id)
	d["getDecoder"] = (id: string) => instances.get(id) ?? probeDecoder(id)
	d["getConfiguredDecoderConfigs"] = () => [...configs.values()]
	return {
		h,
		statuses,
		configs,
		instances,
		ambient: () =>
			(h.service as unknown as { ambient: AmbientEvidence }).ambient,
	}
}

async function identifyAisTarget(r: Rig, timeoutMs: number): Promise<string> {
	const job = await r.h.service.identify({
		sourceId: "rtl",
		target: { frequencyHz: AIS_A, bandwidthHz: 25_000 },
		timeoutMs,
		record: false,
	})
	feedTone(r.h.fanout, 2, AIS_A - CENTRE_AIS)
	return job.id
}

const firstTarget = (r: Rig, jobId: string): ScannerIdentifyEventData =>
	r.h.service.getJob(jobId)?.identify?.targets[0] ??
	({ trials: [] } as unknown as ScannerIdentifyEventData)

describe("ScannerService ambient identify (WG7)", () => {
	it("identifies an AIS target from a config-owned AIS decoder on the same source with commanded trust", async () => {
		const seen: [string, number, string][] = []
		const r = rig({
			startup: [aisConfig()],
			// The startup wiring: the decoder's provenance binding, proven for both AIS channels.
			trust: (id, hz, sourceId) => {
				seen.push([id, hz, sourceId])
				return ambientTrustFromBinding(
					id === "ais"
						? {
								sourceId: "rtl",
								targetFrequenciesHz: [AIS_A, AIS_B],
								tuningTrust: "commanded",
							}
						: null,
					hz,
					sourceId,
				)
			},
		})
		await r.h.service.start()
		try {
			const evidence: AmbientEvidenceEvent[] = []
			r.ambient().on("evidence", (e: AmbientEvidenceEvent) => evidence.push(e))
			// WG11 batch review R1 4: the ambient decode resets the known-protocol memory exactly once.
			const recordDecode = vi.spyOn(
				(
					r.h.service as unknown as {
						knownProtocols: { recordDecode(id: string): void }
					}
				).knownProtocols,
				"recordDecode",
			)
			const jobId = await identifyAisTarget(r, 60_000)
			await until(() =>
				(firstTarget(r, jobId).trials ?? []).some(
					t => t.transport === "ambient" && t.outcome === "running",
				),
			)
			expect(firstTarget(r, jobId).trials).toEqual([
				...NARROW_TRIALS,
				expect.objectContaining({
					protocol: "ais",
					decoder: "ais-catcher",
					transport: "ambient",
					outcome: "running",
				}),
			])
			r.h.decoders.emitOutput("ais", ship("244123456"))
			// two decodes of one MMSI pair only 2 s or more apart.
			await tick(CONFIRM_MIN_SEPARATION_MS + 100)
			r.h.decoders.emitOutput("ais", ship("244123456"))
			await until(() => r.h.service.getJob(jobId)?.state === "completed")
			const target = firstTarget(r, jobId)
			expect(target.state).toBe("identified")
			expect(target.trials).toEqual([
				...NARROW_TRIALS,
				expect.objectContaining({
					protocol: "ais",
					transport: "ambient",
					outcome: "decoded",
				}),
			])
			expect(target.result).toMatchObject({ protocol: "ais" })
			expect(recordDecode).toHaveBeenCalledTimes(1)
			// The trust lookup got the decode's own frequency and the target's source.
			expect(seen).toContainEqual(["ais", AIS_A, "rtl"])
			// Real decodes at 161.975 MHz: evidence at that frequency; the second carries the H2 identity.
			expect(evidence.map(e => e.hz)).toEqual([AIS_A, AIS_A])
			expect(evidence.at(-1)).toEqual(
				expect.objectContaining({
					decoderId: "ais",
					sourceId: "rtl",
					hz: AIS_A,
					ev: expect.objectContaining({
						protocol: "ais",
						origin: "ambient",
						crcClean: true,
						identity: expect.objectContaining({
							kind: "ais-mmsi",
							value: "244123456",
						}),
					}),
				}),
			)
		} finally {
			await r.h.service.stop()
		}
	}, 30_000)

	it("names a narrow track inside the AIS channel but off its centre", async () => {
		// 8 kHz above channel A: outside the former 1 kHz tolerance, inside half the 25 kHz channel.
		const OFF_HZ = AIS_A + 8_000
		const r = rig({ startup: [aisConfig()], trust: () => "commanded" })
		await r.h.service.start()
		try {
			const job = await r.h.service.identify({
				sourceId: "rtl",
				target: { frequencyHz: OFF_HZ, bandwidthHz: 25_000 },
				timeoutMs: 60_000,
				record: false,
			})
			feedTone(r.h.fanout, 2, OFF_HZ - CENTRE_AIS)
			await until(() =>
				(firstTarget(r, job.id).trials ?? []).some(
					t => t.transport === "ambient" && t.outcome === "running",
				),
			)
			r.h.decoders.emitOutput("ais", ship("244123456"))
			// two decodes of one MMSI pair only 2 s or more apart.
			await tick(CONFIRM_MIN_SEPARATION_MS + 100)
			r.h.decoders.emitOutput("ais", ship("244123456"))
			await until(() => r.h.service.getJob(job.id)?.state === "completed")
			const target = firstTarget(r, job.id)
			expect(target.state).toBe("identified")
			expect(target.result).toMatchObject({ protocol: "ais" })
		} finally {
			await r.h.service.stop()
		}
	}, 30_000)

	it("ignores AIS decodes whose trust is unverified: no evidence, the ambient trial times out", async () => {
		const r = rig({ startup: [aisConfig()], trust: () => "unverified" })
		await r.h.service.start()
		try {
			const evidence: unknown[] = []
			r.ambient().on("evidence", e => evidence.push(e))
			const jobId = await identifyAisTarget(r, 3_000)
			await until(() =>
				(firstTarget(r, jobId).trials ?? []).some(
					t => t.transport === "ambient",
				),
			)
			r.h.decoders.emitOutput("ais", ship("244123456"))
			r.h.decoders.emitOutput("ais", ship("244123456"))
			await until(() => r.h.service.getJob(jobId)?.state === "completed")
			expect(evidence).toEqual([])
			expect(r.ambient().trustDropCount).toBe(2)
			const target = firstTarget(r, jobId)
			expect(target.state).not.toBe("identified")
			expect(target.trials).toEqual([
				...NARROW_TRIALS,
				expect.objectContaining({
					protocol: "ais",
					transport: "ambient",
					outcome: "timeout",
				}),
			])
		} finally {
			await r.h.service.stop()
		}
	}, 30_000)

	it("without an ambientTrust dep plans no ambient trial and AIS decodes change nothing (as before WG7)", async () => {
		const r = rig({ startup: [aisConfig()], trust: null })
		await r.h.service.start()
		try {
			const evidence: unknown[] = []
			r.ambient().on("evidence", e => evidence.push(e))
			const jobId = await identifyAisTarget(r, 60_000)
			r.h.decoders.emitOutput("ais", ship("244123456"))
			r.h.decoders.emitOutput("ais", ship("244123456"))
			await until(() => r.h.service.getJob(jobId)?.state === "completed")
			expect(evidence).toEqual([])
			const target = firstTarget(r, jobId)
			expect(target.state).toBe("unidentified")
			expect(target.trials).toEqual(NARROW_TRIALS)
		} finally {
			await r.h.service.stop()
		}
	}, 30_000)

	it("watches decoders created after start, drops removed ones, and detaches every listener on stop", async () => {
		const r = rig({ trust: () => "commanded" })
		const events = ["decoder:output", "decoder:created", "decoder:removed"]
		const before = events.map(e => r.h.decoders.listenerCount(e))
		await r.h.service.start()
		try {
			expect(r.ambient().watchedDecoderIds).toEqual([])
			// Created at runtime: not in the startup configs, only in the manager's view.
			r.configs.set("ais", aisConfig())
			r.statuses.set("ais", status("ais", "ais-catcher"))
			r.instances.set("ais", { caps: { input: "iq" } })
			r.h.decoders.emit("decoder:created", "ais")
			expect(r.ambient().watchedDecoderIds).toEqual(["ais"])
			expect(r.ambient().coverageAt("rtl", AIS_A, 1_000)).toEqual([
				{ decoderId: "ais", type: "ais-catcher", protocol: "ais" },
			])
			// A runtime dsd-fme decoder gets exactly one link listener, even when re-created.
			const dsd = new EventEmitter()
			r.statuses.set("dsd", status("dsd", "dsd-fme"))
			r.instances.set("dsd", dsd)
			r.h.decoders.emit("decoder:created", "dsd")
			r.h.decoders.emit("decoder:created", "dsd")
			expect(dsd.listenerCount("link")).toBe(1)
			// Scanner probes are never watched.
			r.statuses.set("probe", {
				...status("probe", "ais-catcher"),
				owner: "scanner",
			} as DecoderStatus)
			r.h.decoders.emit("decoder:created", "probe")
			expect(r.ambient().watchedDecoderIds).toEqual(["ais", "dsd"])

			r.statuses.delete("ais")
			r.configs.delete("ais")
			r.h.decoders.emit("decoder:removed", "ais")
			r.h.decoders.emit("decoder:removed", "dsd")
			expect(r.ambient().watchedDecoderIds).toEqual([])
			expect(dsd.listenerCount("link")).toBe(0)
			expect(r.ambient().coverageAt("rtl", AIS_A, 1_000)).toEqual([])

			r.h.decoders.emit("decoder:created", "dsd")
			expect(dsd.listenerCount("link")).toBe(1)
		} finally {
			await r.h.service.stop()
		}
		const dsd = r.instances.get("dsd") as EventEmitter
		expect(dsd.listenerCount("link")).toBe(0)
		expect(r.ambient().watchedDecoderIds).toEqual([])
		const own = r.ambient() as unknown as Record<string, unknown>
		for (const [e, fn] of [
			["decoder:output", own["onOutput"]],
			["decoder:created", own["onCreated"]],
			["decoder:removed", own["onRemoved"]],
		] as const)
			expect(r.h.decoders.listeners(e)).not.toContain(fn)
		for (const [i, e] of events.entries())
			expect(r.h.decoders.listenerCount(e)).toBeLessThanOrEqual(before[i]!)
		// After stop a created decoder is not watched.
		r.h.decoders.emit("decoder:created", "dsd")
		expect(dsd.listenerCount("link")).toBe(0)
	}, 30_000)

	it("never names a wide track near channel A from a channel-A decode (centre outside the channel)", async () => {
		const WIDE_HZ = 162_000_000
		const r = rig({ startup: [aisConfig()], trust: () => "commanded" })
		await r.h.service.start()
		try {
			const evidence: AmbientEvidenceEvent[] = []
			r.ambient().on("evidence", (e: AmbientEvidenceEvent) => evidence.push(e))
			const job = await r.h.service.identify({
				sourceId: "rtl",
				// Tolerance 50 kHz: the AIS decoder's channel A target is covered.
				target: { frequencyHz: WIDE_HZ, bandwidthHz: 100_000 },
				timeoutMs: 3_000,
				record: false,
			})
			// Wide FM (RMS deviation 20 kHz) centred on 162.000 MHz.
			const rng = mulberry32(5)
			const n = FS / 20
			for (let i = 0; i < 40; i++) {
				const iq = addInto(
					gaussianNoise(rng, n, 0.05),
					analogFm(rng, n, FS, WIDE_HZ - CENTRE_AIS, 0.5, {
						rmsDeviationHz: 20_000,
						audioHighHz: 15_000,
						ctcssHz: null,
					}),
				)
				r.h.fanout.write(Buffer.from(packCu8(iq.re, iq.im)))
			}
			await until(() =>
				(firstTarget(r, job.id).trials ?? []).some(
					t => t.transport === "ambient",
				),
			)
			const track = (
				r.h.service as unknown as {
					live: Map<string, { lastTrack?: { centreHz: number; obwHz: number } }>
				}
			).live
			const wide = [...track.values()].find(
				o => o.lastTrack && Math.abs(o.lastTrack.centreHz - WIDE_HZ) < 5_000,
			)
			// The track is wide enough that the former max(1500, OBW/2) pairing reached 161.975 MHz.
			expect(wide?.lastTrack?.obwHz ?? 0).toBeGreaterThan(2 * (WIDE_HZ - AIS_A))
			r.h.decoders.emitOutput("ais", ship("244123456"))
			r.h.decoders.emitOutput("ais", ship("244123456"))
			await until(() => r.h.service.getJob(job.id)?.state === "completed")
			// The decodes are evidence; they just name no wide track.
			expect(evidence.map(e => e.hz)).toEqual([AIS_A, AIS_A])
			const target = firstTarget(r, job.id)
			expect(target.state).not.toBe("identified")
			// Scanner-redesign 3.12: the wideband class now lists analog-fm, so its trial leads.
			expect(target.trials).toEqual([
				...NARROW_TRIALS,
				expect.objectContaining({
					protocol: "ais",
					transport: "ambient",
					outcome: "timeout",
				}),
			])
		} finally {
			await r.h.service.stop()
		}
	}, 30_000)
})

describe("ambientTrustFromBinding (WG7 req 1.3)", () => {
	const binding = (
		patch: Partial<AmbientTrustBinding> = {},
	): AmbientTrustBinding => ({
		sourceId: "rtl",
		targetFrequenciesHz: [AIS_A, AIS_B],
		tuningTrust: "commanded",
		...patch,
	})

	it("trusts only commanded/relay on the same source within 1 kHz of a binding target", () => {
		expect(ambientTrustFromBinding(binding(), AIS_A, "rtl")).toBe("commanded")
		expect(
			ambientTrustFromBinding(
				binding({ tuningTrust: "relay" }),
				AIS_B + 1_000,
				"rtl",
			),
		).toBe("relay")
		expect(
			ambientTrustFromBinding(binding(), AIS_A + 1_001, "rtl"),
		).toBeUndefined()
		expect(
			ambientTrustFromBinding(
				binding({ tuningTrust: "unverified" }),
				AIS_A,
				"rtl",
			),
		).toBeUndefined()
		expect(ambientTrustFromBinding(binding(), AIS_A, "sdrpp")).toBeUndefined()
		expect(
			ambientTrustFromBinding(
				binding({ targetFrequenciesHz: [] }),
				AIS_A,
				"rtl",
			),
		).toBeUndefined()
		expect(ambientTrustFromBinding(null, AIS_A, "rtl")).toBeUndefined()
		// No source on the binding = an external-input decoder: never trusted.
		expect(
			ambientTrustFromBinding(binding({ sourceId: null }), AIS_A, "rtl"),
		).toBeUndefined()
	})

	// Feature: web-gaps-7, Property: ambient trust is fail-closed
	// Validates: Requirements 1.3
	it("returns a trust only when every condition holds (property)", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(
					"commanded",
					"relay",
					"unverified",
				) as fc.Arbitrary<TuningTrust>,
				fc.constantFrom("rtl", "sdrpp", null),
				fc.array(fc.integer({ min: 161_000_000, max: 163_000_000 }), {
					maxLength: 4,
				}),
				fc.integer({ min: 161_000_000, max: 163_000_000 }),
				fc.constantFrom("rtl", "sdrpp"),
				(trust, bound, targets, hz, sourceId) => {
					const got = ambientTrustFromBinding(
						{
							sourceId: bound,
							targetFrequenciesHz: targets,
							tuningTrust: trust,
						},
						hz,
						sourceId,
					)
					const ok =
						(trust === "commanded" || trust === "relay") &&
						bound === sourceId &&
						targets.some(t => Math.abs(t - hz) <= 1_000)
					expect(got).toBe(ok ? trust : undefined)
				},
			),
			{ numRuns: 200 },
		)
	})
})
