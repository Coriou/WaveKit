/**
 * Drag state of the plot's grab handles (handles.ts) and the writes they make. A drag shows its value at
 * once (a preview) and writes through the same paths as the islands: the plot's tuneTo for the VFO, the
 * live-audio bandwidth PATCH of the Tuner island, and the manual squelch PATCH of the Listen island.
 * Writes are coalesced: one in flight per handle, only the latest value queued, the last one always sent.
 * A preview stays until the drag has ended and its last write has settled, so the line never jumps back.
 */

import type { LiveAudioState } from "../data/live-audio-store.ts"
import { Store } from "../data/index.ts"
import { squelchSetting, squelchThreshold } from "../features/listen/audio.ts"
import type { HandleKind } from "./handles.ts"

export interface HandleState {
	/** The handle being dragged, null when none. */
	active: HandleKind | null
	/** Values to draw instead of the core's until the write settles; null: show the core's. */
	vfoHz: number | null
	bandwidthHz: number | null
	squelchDbfs: number | null
}

export interface HandleActions {
	/** Tune the VFO (the plot's tuneTo: offset inside the capture, recentre past its edge). */
	tune(hz: number): Promise<unknown>
	/** Live-audio channel bandwidth (Hz). */
	setBandwidth(hz: number): Promise<unknown>
	/** Manual squelch at `dbfs` (switches Auto to manual). */
	setSquelch(dbfs: number): Promise<unknown>
}

export const IDLE_HANDLES: HandleState = {
	active: null,
	vfoHz: null,
	bandwidthHz: null,
	squelchDbfs: null,
}

type Channel = "vfo" | "bandwidth" | "squelch"
type PreviewKey = "vfoHz" | "bandwidthHz" | "squelchDbfs"

const PREVIEW: Readonly<Record<Channel, PreviewKey>> = {
	vfo: "vfoHz",
	bandwidth: "bandwidthHz",
	squelch: "squelchDbfs",
}

export function channelOf(kind: HandleKind): Channel {
	return kind === "vfo" ? "vfo" : kind === "squelch" ? "squelch" : "bandwidth"
}

/** Runs one write at a time; while one runs only the latest value waits. */
export class LatestWriter<T> {
	private readonly run: (value: T) => Promise<unknown>
	private readonly onIdle: () => void
	private next: { value: T } | null = null
	private running = false

	constructor(run: (value: T) => Promise<unknown>, onIdle: () => void) {
		this.run = run
		this.onIdle = onIdle
	}

	get busy(): boolean {
		return this.running || this.next !== null
	}

	push(value: T): void {
		this.next = { value }
		if (!this.running) void this.drain()
	}

	private async drain(): Promise<void> {
		this.running = true
		while (this.next !== null) {
			const { value } = this.next
			this.next = null
			try {
				await this.run(value)
			} catch {
				// the store keeps the error; the preview goes back to the core's value
			}
		}
		this.running = false
		this.onIdle()
	}
}

export class HandleController {
	readonly store = new Store<HandleState>(IDLE_HANDLES)
	private readonly writers: Readonly<Record<Channel, LatestWriter<number>>>

	constructor(actions: HandleActions) {
		this.writers = {
			vfo: new LatestWriter(
				hz => actions.tune(hz),
				() => this.settle("vfo"),
			),
			bandwidth: new LatestWriter(
				hz => actions.setBandwidth(hz),
				() => this.settle("bandwidth"),
			),
			squelch: new LatestWriter(
				db => actions.setSquelch(db),
				() => this.settle("squelch"),
			),
		}
	}

	/** A press on a handle: it owns the pointer until end(). */
	begin(kind: HandleKind): void {
		this.store.update(s => ({ ...s, active: kind }))
	}

	/** A drag (or a key) to a new value of `channel`; repeated values send nothing. */
	set(channel: Channel, value: number): void {
		const key = PREVIEW[channel]
		if (this.store.get()[key] === value) return
		this.store.update(s => ({ ...s, [key]: value }))
		this.writers[channel].push(value)
	}

	dragVfo(hz: number): void {
		this.set("vfo", Math.round(hz))
	}

	setBandwidth(hz: number): void {
		this.set("bandwidth", Math.round(hz))
	}

	setSquelch(dbfs: number): void {
		this.set("squelch", Math.round(dbfs))
	}

	/** The drag is over (released or cancelled): previews whose writes are done clear now. */
	end(): void {
		const s = this.store.get()
		if (s.active === null) return
		const next: HandleState = { ...s, active: null }
		for (const channel of ["vfo", "bandwidth", "squelch"] as const)
			if (!this.writers[channel].busy) next[PREVIEW[channel]] = null
		this.store.set(next)
	}

	private settle(channel: Channel): void {
		const s = this.store.get()
		if (s.active !== null && channelOf(s.active) === channel) return
		const key = PREVIEW[channel]
		if (s[key] !== null) this.store.set({ ...s, [key]: null })
	}
}

/**
 * The threshold the squelch line shows, dBFS, as the Listen island's bar: the live threshold while
 * running (in Auto the effective one), else a manual setting; null when squelch is off, noise squelch,
 * or Auto while stopped. Rounded to 0.5 dB so level events do not redraw the line for noise.
 */
export function squelchLineDbfs(
	state: Pick<LiveAudioState, "status" | "level">,
): number | null {
	const status = state.status
	const running = status?.running === true
	const db = squelchThreshold(
		squelchSetting(status),
		running ? (state.level?.thresholdDbfs ?? null) : null,
	)
	return db === null || !Number.isFinite(db) ? null : Math.round(db * 2) / 2
}
