import { describe, expect, it } from "vitest"
import type { LiveAudioLevel, LiveAudioStatus } from "@wavekit/api-types"
import {
	HandleController,
	IDLE_HANDLES,
	LatestWriter,
	squelchLineDbfs,
} from "../../src/plot/handle-controller.ts"

/** Actions whose promises the test settles by hand. */
function setup() {
	const calls: string[] = []
	const pending: { resolve: () => void; reject: () => void }[] = []
	const later = (label: string) => {
		calls.push(label)
		return new Promise<void>((resolve, reject) => {
			pending.push({ resolve, reject: () => reject(new Error("409")) })
		})
	}
	const c = new HandleController({
		tune: hz => later(`tune ${hz}`),
		setBandwidth: hz => later(`bw ${hz}`),
		setSquelch: db => later(`sq ${db}`),
	})
	const settle = async (fail = false) => {
		const p = pending.shift()
		if (fail) p?.reject()
		else p?.resolve()
		// let the writer's await and its loop run
		for (let i = 0; i < 4; i++) await Promise.resolve()
	}
	return { c, calls, pending, settle }
}

describe("HandleController", () => {
	it("starts idle", () => {
		expect(setup().c.store.get()).toEqual(IDLE_HANDLES)
	})

	it("a VFO drag previews at once and coalesces tunes to one in flight, latest last", async () => {
		const { c, calls, settle } = setup()
		c.begin("vfo")
		expect(c.store.get().active).toBe("vfo")
		c.dragVfo(161_112_500)
		c.dragVfo(161_125_000)
		c.dragVfo(161_137_500)
		expect(c.store.get().vfoHz).toBe(161_137_500)
		expect(calls).toEqual(["tune 161112500"])
		await settle()
		// the middle value was dropped
		expect(calls).toEqual(["tune 161112500", "tune 161137500"])
		await settle()
		// still dragging: the preview stays
		expect(c.store.get().vfoHz).toBe(161_137_500)
		c.end()
		expect(c.store.get()).toEqual(IDLE_HANDLES)
	})

	it("repeated values send nothing", () => {
		const { c, calls } = setup()
		c.begin("vfo")
		c.dragVfo(161_112_500)
		c.dragVfo(161_112_500)
		expect(calls).toEqual(["tune 161112500"])
	})

	it("keeps the preview after release until the last write settles", async () => {
		const { c, settle } = setup()
		c.begin("edge-right")
		c.setBandwidth(16_000)
		c.end()
		expect(c.store.get()).toEqual({
			...IDLE_HANDLES,
			bandwidthHz: 16_000,
		})
		await settle()
		expect(c.store.get().bandwidthHz).toBeNull()
	})

	it("a failed write still clears the preview (the core's value shows again)", async () => {
		const { c, settle } = setup()
		c.begin("squelch")
		c.setSquelch(-70)
		c.end()
		await settle(true)
		expect(c.store.get().squelchDbfs).toBeNull()
	})

	it("a squelch drag rounds to whole dB and writes the manual threshold", () => {
		const { c, calls } = setup()
		c.begin("squelch")
		c.setSquelch(-63.4)
		expect(c.store.get().squelchDbfs).toBe(-63)
		expect(calls).toEqual(["sq -63"])
	})

	it("keys write without a drag and clear once written", async () => {
		const { c, calls, settle } = setup()
		c.setBandwidth(13_000)
		expect(c.store.get().bandwidthHz).toBe(13_000)
		expect(calls).toEqual(["bw 13000"])
		await settle()
		expect(c.store.get().bandwidthHz).toBeNull()
	})

	it("a write settling during a drag of another handle clears its own preview only", async () => {
		const { c, settle } = setup()
		c.setSquelch(-80)
		c.begin("edge-left")
		c.setBandwidth(9000)
		await settle() // the squelch write
		expect(c.store.get().squelchDbfs).toBeNull()
		expect(c.store.get().bandwidthHz).toBe(9000)
		expect(c.store.get().active).toBe("edge-left")
	})

	it("end() without a drag changes nothing", () => {
		const { c } = setup()
		const before = c.store.get()
		c.end()
		expect(c.store.get()).toBe(before)
	})
})

describe("LatestWriter", () => {
	it("reports busy while running or queued and calls onIdle once drained", async () => {
		let release: () => void = () => undefined
		let idle = 0
		const seen: number[] = []
		const w = new LatestWriter<number>(
			v => {
				seen.push(v)
				return new Promise<void>(r => {
					release = r
				})
			},
			() => idle++,
		)
		expect(w.busy).toBe(false)
		w.push(1)
		w.push(2)
		w.push(3)
		expect(w.busy).toBe(true)
		release()
		for (let i = 0; i < 4; i++) await Promise.resolve()
		expect(seen).toEqual([1, 3])
		release()
		for (let i = 0; i < 4; i++) await Promise.resolve()
		expect(w.busy).toBe(false)
		expect(idle).toBe(1)
	})
})

describe("squelchLineDbfs", () => {
	const status = (
		config: Partial<LiveAudioStatus["config"]>,
		running = true,
	): LiveAudioStatus =>
		({
			running,
			config: {
				modulation: "nfm",
				bandwidth: 12_500,
				squelch: -60,
				...config,
			},
		}) as LiveAudioStatus
	const level = (thresholdDbfs: number) => ({ thresholdDbfs }) as LiveAudioLevel

	it("shows a manual threshold, running or not", () => {
		expect(
			squelchLineDbfs({
				status: status({ squelchMode: "manual" }),
				level: null,
			}),
		).toBe(-60)
		expect(
			squelchLineDbfs({
				status: status({ squelchMode: "manual" }, false),
				level: null,
			}),
		).toBe(-60)
	})

	it("shows Auto's effective threshold from level events, rounded to 0.5 dB", () => {
		expect(
			squelchLineDbfs({
				status: status({ squelchMode: "auto", autoMarginDb: 6 }),
				level: level(-81.37),
			}),
		).toBe(-81.5)
		// stopped: no effective threshold to show
		expect(
			squelchLineDbfs({
				status: status({ squelchMode: "auto" }, false),
				level: level(-81),
			}),
		).toBeNull()
	})

	it("hides with squelch off (0) or noise squelch", () => {
		expect(
			squelchLineDbfs({ status: status({ squelch: 0 }), level: level(0) }),
		).toBeNull()
		expect(
			squelchLineDbfs({
				status: status({ squelchMode: "noise" }),
				level: level(-60),
			}),
		).toBeNull()
		expect(squelchLineDbfs({ status: null, level: null })).toBeNull()
	})
})
