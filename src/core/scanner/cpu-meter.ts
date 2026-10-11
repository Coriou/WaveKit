/**
 * Normalised host CPU for the probe admission guard (spec § 9): `1 − idle` over `os.cpus()` deltas,
 * or cgroup v2 `usage_usec` over the quota's cores inside a CPU-limited container. `null` when no
 * metric is available (admission is then budget-only).
 */
import { readFileSync } from "node:fs"
import { cpus } from "node:os"
import { performance } from "node:perf_hooks"

export interface CpuReaders {
	cpus?: () => readonly {
		times: {
			user: number
			nice: number
			sys: number
			idle: number
			irq: number
		}
	}[]
	readCgroup?: (file: "cpu.stat" | "cpu.max") => string | null
	now?: () => number
}

const CGROUP_ROOT = "/sys/fs/cgroup"
const USAGE_USEC = /^usage_usec\s+(\d+)\s*$/m

function readCgroupFile(file: "cpu.stat" | "cpu.max"): string | null {
	try {
		return readFileSync(`${CGROUP_ROOT}/${file}`, "utf8")
	} catch {
		return null
	}
}

const clampPercent = (v: number): number => Math.min(100, Math.max(0, v))

export class CpuMeter {
	private readonly sampleMs: number
	private readonly requested: "os" | "cgroup" | undefined
	private readonly readCpus: NonNullable<CpuReaders["cpus"]>
	private readonly readCgroup: NonNullable<CpuReaders["readCgroup"]>
	private readonly clock: NonNullable<CpuReaders["now"]>
	private timer: NodeJS.Timeout | null = null
	private prevOs: { busy: number; total: number } | null = null
	private prevCgroup: { usageUsec: number; at: number } | null = null
	private value: number | null = null

	constructor(opts: {
		sampleMs: number
		source?: "os" | "cgroup"
		readers?: CpuReaders
	}) {
		this.sampleMs = opts.sampleMs
		this.requested = opts.source
		this.readCpus = opts.readers?.cpus ?? cpus
		this.readCgroup = opts.readers?.readCgroup ?? readCgroupFile
		this.clock = opts.readers?.now ?? (() => performance.now())
	}

	get mode(): "os" | "cgroup" {
		return this.requested ?? (this.quotaCores() !== null ? "cgroup" : "os")
	}

	get normalisedPercent(): number | null {
		return this.value
	}

	start(): void {
		if (this.timer !== null) return
		this.sample()
		this.timer = setInterval(() => this.sample(), this.sampleMs)
		this.timer.unref()
	}

	stop(): void {
		if (this.timer !== null) clearInterval(this.timer)
		this.timer = null
	}

	sample(): void {
		if (this.mode === "cgroup") this.sampleCgroup()
		else this.sampleOs()
	}

	private sampleOs(): void {
		const list = this.readCpus()
		if (list.length === 0) {
			this.value = null
			this.prevOs = null
			return
		}
		let busy = 0
		let total = 0
		for (const c of list) {
			const t = c.times
			const all = t.user + t.nice + t.sys + t.idle + t.irq
			total += all
			busy += all - t.idle
		}
		const prev = this.prevOs
		this.prevOs = { busy, total }
		if (prev === null) return
		const dTotal = total - prev.total
		if (dTotal <= 0) return
		this.value = clampPercent((100 * (busy - prev.busy)) / dTotal)
	}

	private sampleCgroup(): void {
		const stat = this.readCgroup("cpu.stat")
		const match = stat === null ? null : USAGE_USEC.exec(stat)
		const cores = this.quotaCores() ?? this.readCpus().length
		if (match === null || cores <= 0) {
			this.value = null
			this.prevCgroup = null
			return
		}
		const usageUsec = Number(match[1])
		const at = this.clock()
		const prev = this.prevCgroup
		this.prevCgroup = { usageUsec, at }
		if (prev === null) return
		const wallMs = at - prev.at
		if (wallMs <= 0) return
		this.value = clampPercent(
			(100 * (usageUsec - prev.usageUsec)) / (wallMs * 1000 * cores),
		)
	}

	/** Cores granted by cgroup v2 `cpu.max` ("<quota> <period>"), or null without a quota. */
	private quotaCores(): number | null {
		const max = this.readCgroup("cpu.max")
		if (max === null) return null
		const [quota, period] = max.trim().split(/\s+/)
		if (quota === undefined || quota === "max") return null
		const q = Number(quota)
		const p = Number(period ?? "100000")
		return Number.isFinite(q) && Number.isFinite(p) && q > 0 && p > 0
			? q / p
			: null
	}
}
