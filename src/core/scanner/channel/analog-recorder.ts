/** Bounded internal cf32 producer adapter. It does not acquire or adopt channel capability. */
import { ChannelSquelch } from "../../channel-squelch.js"
import { WaveKitError } from "../../../utils/errors.js"
import type {
	AnalogCut,
	AnalogGap,
	AnalogHandle,
	AnalogReceipt,
} from "../store/analog-operations.js"
import { FmAudioDemod } from "./fm-audio.js"

const BLOCK_FLOATS = 960 // 480 complex samples, 10 ms at the realized 48 kHz.
const MAX_QUEUE_BYTES = 65_536
const MAX_QUEUE_CHUNKS = 64

export class AnalogRecorder {
	private readonly demod: FmAudioDemod
	private readonly squelch: ChannelSquelch
	private readonly block = new Float32Array(BLOCK_FLOATS)
	private filled = 0
	private accepting = true
	private cancelled = false
	private queuedBytes = 0
	private queuedChunks = 0
	private tail: Promise<void> = Promise.resolve()
	private terminal: Promise<AnalogReceipt> | null = null
	private failure: unknown = null
	private inputSamples = 0
	constructor(
		private readonly opts: {
			operation: AnalogHandle
			thresholdDbfs: number | null
			hangMs?: number
			deemphasisUs?: number | null
		},
	) {
		if (
			(opts.thresholdDbfs !== null && !Number.isFinite(opts.thresholdDbfs)) ||
			(opts.hangMs !== undefined &&
				(!Number.isFinite(opts.hangMs) || opts.hangMs < 0))
		)
			throw new WaveKitError(
				"Invalid analog gate settings",
				"SCANNER_ANALOG_INVALID_BINDING",
			)
		this.demod = new FmAudioDemod({
			...(opts.deemphasisUs !== undefined
				? { deemphasisUs: opts.deemphasisUs }
				: {}),
		})
		this.squelch = new ChannelSquelch({
			sampleRate: 48_000,
			thresholdDbfs: opts.thresholdDbfs,
			hangMs: opts.hangMs ?? 300,
			hysteresisDb: 2,
			blockMs: 10,
		})
	}
	get pendingBytes(): number {
		return this.queuedBytes
	}
	get pendingChunks(): number {
		return this.queuedChunks
	}
	push(cf32: Float32Array): Promise<void> {
		if (!this.accepting || this.failure)
			return Promise.reject(
				new WaveKitError(
					"Analog recorder intake closed",
					"SCANNER_ANALOG_WRITE_FAILED",
				),
			)
		if (
			cf32.byteLength > MAX_QUEUE_BYTES - this.queuedBytes ||
			this.queuedChunks === MAX_QUEUE_CHUNKS
		) {
			this.gap({
				cause: "queue-overflow",
				inputSampleIndex: this.inputSamples,
				droppedInputSamples: Math.floor(cf32.length / 2),
				outputFrameIndex: null,
			})
			return Promise.reject(
				new WaveKitError(
					"Analog recorder queue full",
					"SCANNER_ANALOG_WRITE_FAILED",
				),
			)
		}
		for (const value of cf32)
			if (!Number.isFinite(value))
				return Promise.reject(
					new WaveKitError(
						"Nonfinite analog cf32",
						"SCANNER_ANALOG_INVALID_BINDING",
					),
				)
		if (!cf32.length) return Promise.resolve()
		const input = new Float32Array(cf32)
		this.queuedBytes += input.byteLength
		this.queuedChunks++
		const run = this.tail
			.then(async () => {
				await this.opts.operation.ready
				for (let offset = 0; offset < input.length; ) {
					if (this.cancelled || this.failure)
						throw new WaveKitError(
							"Analog recorder cancelled",
							"SCANNER_ANALOG_WRITE_FAILED",
						)
					const take = Math.min(
						BLOCK_FLOATS - this.filled,
						input.length - offset,
					)
					this.block.set(input.subarray(offset, offset + take), this.filled)
					this.filled += take
					offset += take
					if (this.filled !== BLOCK_FLOATS) continue
					this.filled = 0
					this.inputSamples += BLOCK_FLOATS / 2
					const blocks = this.squelch.process(Buffer.from(this.block.buffer))
					const gated = blocks[0]
					if (!gated) continue
					const pcm = this.demod.process(
						new Float32Array(
							gated.buffer,
							gated.byteOffset,
							gated.byteLength / 4,
						),
					)
					if (this.squelch.open) {
						try {
							await this.opts.operation.push(pcm)
						} catch (cause) {
							this.gap({
								cause: "writer-backpressure",
								inputSampleIndex: this.inputSamples - BLOCK_FLOATS / 2,
								droppedInputSamples: BLOCK_FLOATS / 2,
								outputFrameIndex: null,
							})
							throw cause
						}
					}
				}
			})
			.catch((cause: unknown) => {
				this.failure = cause
				this.accepting = false
				this.opts.operation.cancel("cancelled")
				throw cause
			})
			.finally(() => {
				this.queuedBytes -= input.byteLength
				this.queuedChunks--
			})
		this.tail = run.catch(() => undefined)
		return run
	}
	gap(gap: AnalogGap): void {
		this.opts.operation.addGap(gap)
	}
	finish(cut: AnalogCut = "completed"): Promise<AnalogReceipt> {
		this.accepting = false
		this.terminal ??= this.tail.then(() => {
			if (this.filled >= 2)
				this.gap({
					cause: "unknown",
					inputSampleIndex: this.inputSamples,
					droppedInputSamples: Math.floor(this.filled / 2),
					outputFrameIndex: null,
				})
			if (this.filled % 2)
				this.gap({
					cause: "unknown",
					inputSampleIndex: null,
					droppedInputSamples: null,
					outputFrameIndex: null,
				})
			this.filled = 0
			return this.opts.operation.finish(cut)
		})
		return this.terminal
	}
	cancel(cut: AnalogCut = "cancelled"): void {
		this.accepting = false
		this.cancelled = true
		this.opts.operation.cancel(cut)
		this.filled = 0
	}
}
