/**
 * TunerWriteOptions.onReceipt on the controller: one call, one callback, whatever the call
 * wrote (no frame, a frame refused part-way, band-gain frames around a REST retune).
 */
import { describe, expect, it, vi } from "vitest"
import pino from "pino"
import { TunerController } from "../../../src/core/tuner-controller.js"
import {
	BandGainSettingsService,
	type BandGainFs,
} from "../../../src/core/band-gain.js"
import type {
	SourceCaps,
	SourceManager,
} from "../../../src/core/source-manager.js"
import type {
	ReceiptCallback,
	TuningReceipt,
} from "../../../src/core/tuning-ledger.js"

const logger = pino({ level: "silent" })
const SET_FREQUENCY = 0x01
const SET_GAIN = 0x04
const ISM = 868_100_000
const UHF = 455_500_000

const settle = () => new Promise<void>(resolve => setImmediate(resolve))

async function flushAll(): Promise<void> {
	for (let i = 0; i < 20; i++) await settle()
}

const FIELDS: Record<number, TuningReceipt["field"]> = {
	1: "frequency",
	2: "sampleRate",
	3: "gainMode",
	4: "gain",
	8: "agcMode",
} as Record<number, TuningReceipt["field"]>

function setup(opts: { refuseCommand?: number } = {}) {
	const writes: [number, number][] = []
	let seq = 0
	let commands = 0
	const sourceManager = {
		assertTunerCommandActive: () => {
			commands += 1
			if (commands === opts.refuseCommand) throw new Error("command aborted")
		},
		// Every frame is receipted at "flush", on a later turn.
		writeToSource: vi.fn(
			(
				_id: string,
				payload: Buffer,
				_writer?: unknown,
				onReceipt?: ReceiptCallback,
			) => {
				const cmd = payload.readUInt8(0)
				const value = payload.readUInt32BE(1)
				writes.push([cmd, value])
				const receipt: TuningReceipt = {
					session: 1,
					seq: ++seq,
					field: FIELDS[cmd] ?? "frequency",
					value,
					writer: "operator",
					pos: seq * 100,
					at: 0,
				}
				if (onReceipt) setImmediate(() => onReceipt(receipt))
				return true
			},
		),
		isRtlTcpSource: () => true,
		updateSourceCaps: vi.fn(),
		getCaps: () => undefined,
	}
	const controller = new TunerController(
		logger,
		sourceManager as unknown as SourceManager,
	)
	const caps: SourceCaps = {
		kind: "iq",
		sampleRate: 2_048_000,
		format: "U8_IQ",
		exclusive: false,
		centerFreq: UHF,
	}
	controller.initializeSource("rtl", caps)
	return { controller, writes }
}

function memoryFs(): BandGainFs {
	const files = new Map<string, string>()
	return {
		readFile: path => {
			const text = files.get(path)
			return text === undefined
				? Promise.reject(
						Object.assign(new Error("missing"), { code: "ENOENT" }),
					)
				: Promise.resolve(Buffer.from(text))
		},
		atomicWrite: (path, data) => {
			files.set(path, data)
			return Promise.resolve()
		},
	}
}

describe("TunerController onReceipt: once per call", () => {
	it("a configure that writes no frame reports one null", async () => {
		const { controller, writes } = setup()
		const calls: (TuningReceipt | null)[] = []
		await controller.configure("rtl", {}, { onReceipt: r => calls.push(r) })
		await flushAll()
		expect(writes).toEqual([])
		expect(calls).toEqual([null])
	})

	it("a configure whose second frame is refused part-way reports exactly one null", async () => {
		const { controller, writes } = setup({ refuseCommand: 2 })
		const calls: (TuningReceipt | null)[] = []
		await expect(
			controller.configure(
				"rtl",
				{ frequency: ISM, sampleRate: 1_024_000 },
				{ onReceipt: r => calls.push(r) },
			),
		).rejects.toThrow("command aborted")
		await flushAll()
		// The first frame went out and was receipted; the call as a whole did not take effect.
		expect(writes.length).toBeGreaterThanOrEqual(1)
		expect(calls).toEqual([null])
	})

	it("a REST retune with band gain applied reports exactly one receipt, the call's last frame's", async () => {
		const { controller, writes } = setup()
		const bandGain = new BandGainSettingsService({
			stateDir: "/state",
			config: {
				applyToMyTuning: true,
				entries: [{ minHz: 863_000_000, maxHz: 870_000_000, gain: 297 }],
			},
			logger,
			fs: memoryFs(),
		})
		await bandGain.load()
		controller.setBandGain(bandGain)
		// A known operator gain first: only a gain that can be restored is replaced by the band's.
		await controller.setGainMode("rtl", "manual", { origin: "rest" })
		await controller.setGain("rtl", 100, { origin: "rest" })
		await flushAll()
		writes.length = 0
		const calls: (TuningReceipt | null)[] = []
		await controller.setFrequency("rtl", ISM, {
			origin: "rest",
			onReceipt: r => calls.push(r),
		})
		await flushAll()
		// The retune wrote its frequency and the band's gain (more than one frame).
		expect(writes).toContainEqual([SET_FREQUENCY, ISM])
		expect(writes).toContainEqual([SET_GAIN, 297])
		expect(writes.length).toBeGreaterThan(1)
		expect(calls).toHaveLength(1)
		expect(calls[0]).toMatchObject({ field: "gain", value: 297 })
	})
})

/** Microtask turns until `p` settles (the counting loop costs the same for every call). */
async function ticks(p: Promise<unknown>): Promise<number> {
	let done = false
	void p.then(
		() => {
			done = true
		},
		() => {
			done = true
		},
	)
	let n = 0
	while (!done && n < 1000) {
		await Promise.resolve()
		n += 1
	}
	return n
}

describe("TunerController withReceiptOnce without onReceipt (review: no extra tick)", () => {
	it("a call without onReceipt settles on the same turn as its body", async () => {
		const { controller } = setup()
		const inner = controller as unknown as {
			configureNow(
				id: string,
				updates: Record<string, unknown>,
				opts: object,
			): Promise<void>
			applyTuneNow(
				id: string,
				values: Record<string, unknown>,
				opts: object,
				applied: () => void,
				leftAgc: boolean,
			): Promise<void>
			setFrequencyNow(id: string, hz: number, opts: object): Promise<void>
		}
		expect(await ticks(controller.configure("rtl", { ppm: 1 }))).toBe(
			await ticks(inner.configureNow("rtl", { ppm: 2 }, {})),
		)
		expect(
			await ticks(
				controller.applyTune("rtl", { gain: 100 }, {}, () => undefined),
			),
		).toBe(
			await ticks(
				inner.applyTuneNow("rtl", { gain: 200 }, {}, () => undefined, false),
			),
		)
		// setFrequency was async before the receipt scope: one async layer over its body, still.
		expect(await ticks(controller.setFrequency("rtl", UHF + 1))).toBe(
			await ticks((async () => inner.setFrequencyNow("rtl", UHF + 2, {}))()),
		)
	})
})
