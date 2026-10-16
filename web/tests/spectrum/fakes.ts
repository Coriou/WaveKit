import type { DrawParams, SceneRenderer } from "../../src/spectrum/renderer.ts"
import type { TimerApi } from "../../src/spectrum/schedule.ts"

export class FakeRenderer implements SceneRenderer {
	rows: { index: number; first: number; count: number }[] = []
	peaks: number[][] = []
	draws: DrawParams[] = []
	size: [number, number] = [0, 0]
	ramps = 0
	disposed = false
	resize(w: number, h: number): void {
		this.size = [w, h]
	}
	uploadRow(index: number, row: Uint8Array, count: number): void {
		this.rows.push({ index, first: row[0] ?? -1, count })
	}
	uploadPeak(row: Uint8Array, count: number): void {
		this.peaks.push(Array.from(row.subarray(0, count)))
	}
	setRamp(): void {
		this.ramps++
	}
	draw(p: DrawParams): void {
		this.draws.push(p)
	}
	dispose(): void {
		this.disposed = true
	}
}

/** Manual clock and timers. */
export class FakeTimers implements TimerApi {
	t = 0
	private seq = 0
	private queue = new Map<number, { at: number; cb: () => void }>()
	now = (): number => this.t
	setTimeout = (cb: () => void, ms: number): unknown => {
		const id = ++this.seq
		this.queue.set(id, { at: this.t + ms, cb })
		return id
	}
	clearTimeout = (handle: unknown): void => {
		this.queue.delete(handle as number)
	}
	advance(ms: number): void {
		const end = this.t + ms
		for (;;) {
			let next: [number, { at: number; cb: () => void }] | null = null
			for (const entry of this.queue)
				if (entry[1].at <= end && (!next || entry[1].at < next[1].at))
					next = entry
			if (!next) break
			this.queue.delete(next[0])
			this.t = next[1].at
			next[1].cb()
		}
		this.t = end
	}
}

/** Manual animation frames. */
export class FakeFrames {
	private seq = 0
	private pending = new Map<number, () => void>()
	request = (cb: () => void): number => {
		const id = ++this.seq
		this.pending.set(id, cb)
		return id
	}
	cancel = (id: number): void => {
		this.pending.delete(id)
	}
	get count(): number {
		return this.pending.size
	}
	tick(): void {
		const cbs = [...this.pending.values()]
		this.pending.clear()
		for (const cb of cbs) cb()
	}
}
