import { StringDecoder } from "node:string_decoder"
import type { Readable } from "node:stream"

/** Bounded per-instance observations shared by all decoder integration patterns. */
export class DecoderObservability {
	private readonly rateBuckets = new Map<number, number>()
	private readonly logLines: Array<{
		stream: "stdout" | "stderr"
		line: string
	}> = []

	constructor(private readonly wallClock: () => number = Date.now) {}
	countOutput(): Date {
		const now = this.wallClock()
		this.getRateHistory()
		const minute = Math.floor(now / 60_000)
		this.rateBuckets.set(minute, (this.rateBuckets.get(minute) ?? 0) + 1)
		return new Date(now)
	}

	/** Oldest first, including the current partial minute; gaps count as zero. */
	getRateHistory(): number[] {
		const minute = Math.floor(this.wallClock() / 60_000)
		for (const key of this.rateBuckets.keys()) {
			if (key < minute - 14 || key > minute) this.rateBuckets.delete(key)
		}
		return Array.from(
			{ length: 15 },
			(_, index) => this.rateBuckets.get(minute - 14 + index) ?? 0,
		)
	}

	/** Raw decoder output only: never process configuration or environment. */
	getLog(lines = 200): Array<{ stream: "stdout" | "stderr"; line: string }> {
		const count = Number.isFinite(lines)
			? Math.min(500, Math.max(1, Math.floor(lines)))
			: 200
		return this.logLines.slice(-count).map(entry => ({ ...entry }))
	}

	captureLog(stream: Readable, source: "stdout" | "stderr"): void {
		const decoder = new StringDecoder("utf8")
		let pending = ""
		const append = (): void => {
			this.logLines.push({ stream: source, line: pending.replace(/\r$/, "") })
			if (this.logLines.length > 500) this.logLines.shift()
			pending = ""
		}
		stream.on("data", (chunk: Buffer | string) => {
			const parts = (
				typeof chunk === "string" ? chunk : decoder.write(chunk)
			).split("\n")
			for (let index = 0; index < parts.length; index++) {
				pending = (pending + (parts[index] ?? "")).slice(0, 4096)
				if (index < parts.length - 1) append()
			}
		})
		stream.on("end", () => {
			pending = (pending + decoder.end()).slice(0, 4096)
			if (pending) append()
		})
	}
}
