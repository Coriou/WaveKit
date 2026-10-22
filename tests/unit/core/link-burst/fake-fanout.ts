import { EventEmitter } from "node:events"
import type { AbsorberFanoutPort } from "../../../../src/core/link-burst/contract.js"

export class FakeFanout extends EventEmitter implements AbsorberFanoutPort {
	readonly active = new Set(["a", "b"])
	readonly congested = new Set<string>()
	readonly delivered: Buffer[] = []
	readonly ticks: number[] = []
	readonly drops = new Map<string, number>()
	tick = 0
	readonly script: ((chunk: Buffer) => void)[] = []
	distributionDepth = 0
	maxDistributionDepth = 0
	distribute(chunk: Buffer): void {
		this.distributionDepth++
		this.maxDistributionDepth = Math.max(
			this.maxDistributionDepth,
			this.distributionDepth,
		)
		this.delivered.push(chunk)
		this.ticks.push(this.tick)
		for (const id of this.active)
			if (this.congested.has(id))
				this.drops.set(id, (this.drops.get(id) ?? 0) + chunk.length)
		try {
			this.script.shift()?.(chunk)
		} finally {
			this.distributionDepth--
		}
	}
	activeBranchIds(out: Set<string>): void {
		out.clear()
		for (const id of this.active) out.add(id)
	}
	congestedBranchIds(out: Set<string>): void {
		out.clear()
		for (const id of this.congested) if (this.active.has(id)) out.add(id)
	}
	congest(id: string): void {
		this.congested.add(id)
		this.emit("backpressure", id)
	}
	drain(id: string): void {
		this.congested.delete(id)
		this.emit("drain", id)
	}
}
