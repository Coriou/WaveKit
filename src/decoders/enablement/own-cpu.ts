/**
 * The core's own CPU: the cgroup v2 `usage_usec` of its container, the decoder
 * efficiency gate's only CPU evidence against a decoder. Host CPU (CpuMeter) only
 * explains drops; a host CPU hog never sheds a decoder.
 *
 * Read only inside a private cgroup namespace (`/proc/self/cgroup` is exactly
 * `0::/`): there `/sys/fs/cgroup/cpu.stat` is the whole container, hierarchical and
 * counting exited children, so the core, its workers, the channelizer and every
 * decoder process are in it. Anywhere else (macOS, a host shell's systemd scope, a
 * child cgroup that would miss sibling decoders, cgroup v1) there is no own reading
 * and the gate sheds for CPU nowhere.
 */
import { readFileSync } from "node:fs"
import type { CpuReaders } from "../../core/scanner/cpu-meter.js"
import { hostCpuCapacity } from "./budget-settings.js"
import { EFFICIENCY_SAMPLE_MS } from "./contract.js"

export type CpuSampleLabel =
	| "own-over"
	| "host-busy"
	| "calm"
	| "host-busy-unattributed"
	| "unknown"

export interface CpuClassification {
	label: CpuSampleLabel
	/** Own CPU over the guard share of capacity: decoder-cost evidence. */
	ownOver: boolean
	/** Host CPU over the guard: excuses drops only, never sheds. */
	hostCpu: boolean
	/** Own CPU as a percentage of capacity; null when unknown. */
	ownPercent: number | null
}

const validPercent = (v: unknown): v is number =>
	typeof v === "number" && Number.isFinite(v) && v >= 0

/**
 * One efficiency sample's CPU label (S1 rows C1-C5). `hostPercent` H is host CPU,
 * `ownCores` O the container's cores in use, `capacityCores` C its capacity,
 * `guardPercent` G the guard. Own over is O / C × 100 > G; host busy is H > G. The
 * bounds are strict: exactly G is neither. NaN, negative, null or a non-positive
 * capacity is unknown.
 */
export function classifyCpuSample(
	hostPercent: number | null | undefined,
	ownCores: number | null | undefined,
	capacityCores: number | null | undefined,
	guardPercent: number,
): CpuClassification {
	if (!validPercent(guardPercent))
		return {
			label: "unknown",
			ownOver: false,
			hostCpu: false,
			ownPercent: null,
		}
	const hostCpu = validPercent(hostPercent) && hostPercent > guardPercent
	const ownPercent =
		validPercent(ownCores) &&
		typeof capacityCores === "number" &&
		Number.isFinite(capacityCores) &&
		capacityCores > 0
			? (ownCores / capacityCores) * 100
			: null
	if (ownPercent !== null && ownPercent > guardPercent)
		return { label: "own-over", ownOver: true, hostCpu, ownPercent }
	if (ownPercent !== null)
		return {
			label: hostCpu ? "host-busy" : "calm",
			ownOver: false,
			hostCpu,
			ownPercent,
		}
	return {
		label: hostCpu ? "host-busy-unattributed" : "unknown",
		ownOver: false,
		hostCpu,
		ownPercent: null,
	}
}

export interface OwnCpuReading {
	/** Container cores in use over the interval since the last good reading; null when unknown. */
	ownCores: number | null
	/** The capacity own CPU is judged against; null when unknown. */
	capacityCores: number | null
	/** False when this process has no own reading at all (no private cgroup namespace). */
	available: boolean
}

export interface OwnCpuSource {
	/** One reading per efficiency sample, at the monitor's evidence time (ms). */
	sample(atMono: number): OwnCpuReading
}

/** A reading never spans more than two efficiency samples (4000 ms). */
export const OWN_CPU_MAX_GAP_MS = 2 * EFFICIENCY_SAMPLE_MS

const USAGE_USEC = /^usage_usec\s+(\d+)\s*$/m

function readProcSelfCgroup(): string | null {
	try {
		return readFileSync("/proc/self/cgroup", "utf8")
	} catch {
		return null
	}
}

function readCgroupRoot(file: "cpu.stat" | "cpu.max"): string | null {
	try {
		return readFileSync(`/sys/fs/cgroup/${file}`, "utf8")
	} catch {
		return null
	}
}

/** True only for a private cgroup v2 namespace: the one line `0::/`. */
export function privateCgroupNamespace(content: string | null): boolean {
	if (content === null) return false
	const lines = content.split("\n").filter(line => line !== "")
	return lines.length === 1 && lines[0] === "0::/"
}

export class OwnCpuMeter implements OwnCpuSource {
	private readonly readProcCgroup: () => string | null
	private readonly readCgroup: NonNullable<CpuReaders["readCgroup"]>
	private readonly readCapacity: () => number
	private privateNs: boolean | null = null
	private capacity: number | null | undefined
	private base: { usageUsec: number; at: number } | null = null

	constructor(
		opts: {
			readProcCgroup?: () => string | null
			readCgroup?: CpuReaders["readCgroup"]
			capacity?: () => number
		} = {},
	) {
		this.readProcCgroup = opts.readProcCgroup ?? readProcSelfCgroup
		this.readCgroup = opts.readCgroup ?? readCgroupRoot
		this.readCapacity = opts.capacity ?? hostCpuCapacity
	}

	get available(): boolean {
		if (this.privateNs === null) {
			try {
				this.privateNs = privateCgroupNamespace(this.readProcCgroup())
			} catch {
				this.privateNs = false
			}
		}
		return this.privateNs
	}

	private capacityCores(): number | null {
		if (this.capacity === undefined) {
			try {
				const value = this.readCapacity()
				this.capacity = Number.isFinite(value) && value > 0 ? value : null
			} catch {
				this.capacity = null
			}
		}
		return this.capacity
	}

	sample(atMono: number): OwnCpuReading {
		const capacityCores = this.capacityCores()
		if (!this.available)
			return { ownCores: null, capacityCores, available: false }
		const none = { ownCores: null, capacityCores, available: true }
		if (!Number.isFinite(atMono)) return none
		let usageUsec: number | null = null
		try {
			const stat = this.readCgroup("cpu.stat")
			const match = stat === null ? null : USAGE_USEC.exec(stat)
			const value = match ? Number(match[1]) : NaN
			if (Number.isSafeInteger(value)) usageUsec = value
		} catch {
			/* Unreadable: no reading, the last good base is kept. */
		}
		// A failed read keeps the last good base; the next reading spans the gap
		// only when it is at most OWN_CPU_MAX_GAP_MS long.
		if (usageUsec === null) return none
		const base = this.base
		this.base = { usageUsec, at: atMono }
		if (
			base === null ||
			atMono <= base.at ||
			atMono - base.at > OWN_CPU_MAX_GAP_MS ||
			usageUsec < base.usageUsec
		)
			return none
		return {
			ownCores: (usageUsec - base.usageUsec) / ((atMono - base.at) * 1000),
			capacityCores,
			available: true,
		}
	}
}
