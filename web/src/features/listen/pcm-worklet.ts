// The live-audio AudioWorklet: plays Float32 PCM posted by pcm-player.ts out of a PcmRing, resampling
// from the stream rate to the context rate. Bundled by Vite (`?worker&url`) and loaded with addModule.
import { PcmRing, WORKLET_NAME } from "./pcm.ts"
import type { FromWorklet, ToWorklet } from "./pcm.ts"

// AudioWorkletGlobalScope (not in the DOM lib)
declare const sampleRate: number
declare const currentTime: number
declare class AudioWorkletProcessor {
	readonly port: MessagePort
}
declare function registerProcessor(
	name: string,
	ctor: new () => AudioWorkletProcessor & {
		process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean
	},
): void

const STATS_EVERY_S = 0.25

class PcmProcessor extends AudioWorkletProcessor {
	private readonly ring = new PcmRing({ rate: sampleRate })
	private wasPlaying = false
	private lastStats = 0

	constructor() {
		super()
		this.port.onmessage = (event: MessageEvent<ToWorklet>) => {
			const msg = event.data
			if (msg.type === "pcm") this.ring.push(msg.samples)
			else if (msg.type === "format") this.ring.setRate(msg.rate)
			else this.ring.reset()
		}
	}

	process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
		const out = outputs[0]?.[0]
		if (!out) return true
		this.ring.render(out, this.ring.sampleRate / sampleRate)
		for (let c = 1; c < (outputs[0]?.length ?? 0); c++) outputs[0]?.[c]?.set(out)
		const playing = this.ring.playing
		if (playing !== this.wasPlaying || currentTime - this.lastStats >= STATS_EVERY_S) {
			this.wasPlaying = playing
			this.lastStats = currentTime
			const msg: FromWorklet = { type: "stats", ...this.ring.stats() }
			this.port.postMessage(msg)
		}
		return true
	}
}

registerProcessor(WORKLET_NAME, PcmProcessor)
