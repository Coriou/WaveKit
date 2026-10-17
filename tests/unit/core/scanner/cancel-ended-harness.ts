/**
 * WG11 lane ID test harness: an in-window JobRunner with counting fakes (persistence, change
 * events, end actions, probe pool). No sockets, no timers of its own.
 */
import pino from "pino"
import type { KnownProtocolMemory } from "../../../../src/core/scanner/known-protocol-contract.js"
import {
	JobRunner,
	type JobRecord,
	type LiveObservation,
} from "../../../../src/core/scanner/job-runner.js"
import type {
	ProbeRequest,
	ProbeState,
	ProbeStatus,
} from "../../../../src/core/scanner/probes/probe-pool.js"
import type {
	JobState,
	ScannerProtocol,
} from "../../../../src/core/scanner/types.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"
import {
	makeHopPlan,
	makeNormalisedSpec,
} from "../../../mocks/scanner/job-spec.js"

export const flush = (): Promise<void> =>
	new Promise(resolve => setImmediate(resolve))

export interface HarnessOptions {
	state?: JobState
	knownProtocols?: KnownProtocolMemory
	/** Probe requests are deferred with this reason instead of started. */
	defer?: "budget" | "cpu"
	passive?: boolean
	/** Passive offset probes on (testSettings has them off). */
	offsetProbes?: boolean
}

export function jobHarness(opts: HarnessOptions = {}) {
	const calls: string[] = []
	const probes = new Map<string, ProbeStatus>()
	const requests: ProbeRequest[] = []
	let nextProbe = 0
	const record = {
		id: "j_end",
		name: null,
		passive: opts.passive === true,
		rawSpec: { sourceId: "rtl", mode: "in-window" },
		spec: makeNormalisedSpec({ sourceId: "rtl", mode: "in-window" }),
		plan: makeHopPlan([450_000_000]),
		issues: [],
		impact: null,
		consentedImpact: null,
		state: opts.state ?? "pending",
		createdAt: 0,
		updatedAt: 0,
		unrestorable: [],
		counts: { observations: 0, transients: 0 },
	} as unknown as JobRecord
	let lease: object | null = null
	const engine = {
		currentEpoch: () => ({
			stream: 0,
			epoch: 1,
			startSample: 0,
			centreHz: 450_000_000,
			sampleRateHz: 1_024_000,
			gainKey: "m:496",
			tuningTrust: "commanded",
			settleMode: "none",
		}),
		config: () => ({
			integrationMs: 50,
			sampleRateHz: 1_024_000,
			fftSize: 2048,
		}),
		stats: () => ({ observedSamples: 1, settledSamples: 1 }),
	}
	const runner = new JobRunner({
		record,
		arbiter: {
			acquire: (jobId: string, sourceId: string) => {
				calls.push("acquire")
				lease = {
					jobId,
					sourceId,
					acquiredAt: 0,
					snapshot: {},
					changedFields: new Set(),
				}
				return { ok: true, lease }
			},
			retune: () => new Promise(() => undefined),
			release: () => {
				calls.push("release")
				lease = null
				return Promise.resolve({ restored: [], unrestorable: [] })
			},
			setAgc: () => Promise.resolve(),
			holder: () => lease ?? undefined,
			holderPriority: () => undefined,
			operatorIdleSince: () => null,
		} as never,
		probes: {
			request: (req: ProbeRequest) => {
				requests.push(req)
				if (opts.defer) return { deferred: opts.defer }
				const probeId = `p${nextProbe++}`
				probes.set(probeId, {
					probeId,
					decoderId: `d_${probeId}`,
					jobId: req.jobId,
					sourceId: req.sourceId,
					trackId: req.trackId,
					observationId: req.observationId,
					discoveryId: req.discoveryId,
					targetHz: req.targetHz,
					epoch: req.epoch,
					protocol: req.protocols[0] ?? "dmr",
					decoderType: "dsd-fme",
					transport: "offset",
					state: "confirming",
					startedAt: 0,
					cores: 0.1,
				} as ProbeStatus)
				return { started: probeId }
			},
			release: (probeId: string) => {
				calls.push(`releaseProbe:${probeId}`)
				probes.delete(probeId)
				return Promise.resolve()
			},
			releaseJob: () => {
				calls.push("releaseJob")
				probes.clear()
				return Promise.resolve()
			},
			follow: () => undefined,
			status: () => [...probes.values()],
			startLatencyMs: () => 0,
		},
		decoders: {
			holdSource: () => {
				calls.push("holdSource")
				return Promise.resolve()
			},
			releaseSource: () => {
				calls.push("releaseSource")
				return Promise.resolve()
			},
		},
		settings: () => {
			const st = testSettings()
			return opts.offsetProbes === true
				? { ...st, passive: { ...st.passive, offsetProbes: true } }
				: st
		},
		openEngine: () => {
			calls.push("openEngine")
			return Promise.resolve(engine as never)
		},
		closeEngine: () => {
			calls.push("closeEngine")
			return Promise.resolve()
		},
		engine: () => engine as never,
		refreshTuning: () => Promise.resolve(),
		impact: () => ({
			liveAudioClients: 0,
			digitalVoiceListeners: 0,
			runningDecoders: [],
			pinnedDecoders: [],
			scannerJobs: [],
			unrestorable: [],
		}),
		undecoded: () => undefined,
		discoveryCounts: () => ({
			activity: 0,
			candidate: 0,
			classified: 0,
			decoded: 0,
		}),
		awaitRestoredCaps: () => Promise.resolve(),
		persist: () => calls.push(`persist:${record.state}`),
		changed: kind => calls.push(`changed:${kind}`),
		logger: pino({ level: "silent" }),
		now: () => 0,
		...(opts.knownProtocols ? { knownProtocols: opts.knownProtocols } : {}),
	})

	const setProbeState = (probeId: string, state: ProbeState): void => {
		const p = probes.get(probeId)
		if (p) probes.set(probeId, { ...p, state })
	}
	const setProbeProtocol = (
		probeId: string,
		protocol: ScannerProtocol,
	): void => {
		const p = probes.get(probeId)
		if (p) probes.set(probeId, { ...p, protocol })
	}
	/** The pool dropped the probe by itself (decoder exit, preemption): it is gone from status. */
	const dropProbe = (probeId: string): void => {
		probes.delete(probeId)
	}
	return {
		runner,
		record,
		calls,
		requests,
		probes,
		setProbeState,
		setProbeProtocol,
		dropProbe,
	}
}

let seq = 0
export function makeTrack(over: Partial<TrackSnapshot> = {}): TrackSnapshot {
	seq += 1
	return {
		trackId: `t${seq}`,
		sourceId: "rtl",
		stream: 0,
		epoch: 1,
		startSample: 0,
		lastSample: 0,
		centreHz: 450_012_500,
		obwHz: 9_000,
		obwMethod: "-20dB",
		peakDbfs: -40,
		meanDbfs: -45,
		snrDb: 20,
		floorDbfs: -80,
		thresholdDb: 8,
		blocks: 10,
		maxBlockSnrDb: 22,
		dutyCycle: 0.5,
		spectralShape: "flat",
		flags: {} as TrackSnapshot["flags"],
		tuningTrust: "commanded",
		...over,
	}
}

export function makeLive(
	track: TrackSnapshot,
	over: Partial<LiveObservation> = {},
): LiveObservation {
	return {
		observationId: `o_${track.trackId}`,
		sourceId: "rtl",
		trackId: track.trackId,
		epoch: 1,
		jobIds: ["j_end"],
		discoveryId: "d_1",
		startedAt: 0,
		classification: { class: "tdma-ms", hypotheses: [], tier: "spectral" },
		probeIds: new Set(),
		lastActivityAt: 0,
		lastIngestAt: 0,
		lastTrack: track,
		decoded: true,
		encrypted: false,
		...over,
	}
}
