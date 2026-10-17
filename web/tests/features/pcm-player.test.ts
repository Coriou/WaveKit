import { afterEach, describe, expect, it, vi } from "vitest"
import { PcmPlayer } from "../../src/features/listen/pcm-player.ts"
import type { RingStats } from "../../src/features/listen/pcm.ts"

// An AudioContext as a plain-http page outside localhost has it: no audioWorklet (secure context only).
class FakeScriptNode {
	onaudioprocess: ((e: { outputBuffer: FakeBuffer }) => void) | null = null
	connect = vi.fn()
	disconnect = vi.fn()
}
class FakeBuffer {
	readonly numberOfChannels = 1
	readonly data = new Float32Array(2048)
	getChannelData() {
		return this.data
	}
}
const nodes: FakeScriptNode[] = []
class InsecureAudioContext {
	readonly sampleRate = 16_000
	readonly currentTime = 0
	readonly baseLatency = 0
	readonly outputLatency = 0
	state: AudioContextState = "running"
	readonly destination = {}
	createGain() {
		return { gain: { value: 1 }, connect: vi.fn() }
	}
	createScriptProcessor() {
		const node = new FakeScriptNode()
		nodes.push(node)
		return node
	}
	resume = () => Promise.resolve()
	suspend = () => Promise.resolve()
	close = () => Promise.resolve()
}

afterEach(() => {
	vi.unstubAllGlobals()
	nodes.length = 0
})

describe("PcmPlayer without AudioWorklet (plain-http page)", () => {
	it("plays the stream through a ScriptProcessorNode instead of connecting forever", async () => {
		vi.stubGlobal("isSecureContext", false)
		vi.stubGlobal("AudioContext", InsecureAudioContext)
		// 0.5 s of s16le at 16 kHz, value 0x4000 (0.5)
		const pcm = new Uint8Array(16_000)
		for (let i = 0; i < pcm.length; i += 2) pcm[i + 1] = 0x40
		vi.stubGlobal(
			"fetch",
			vi.fn(() =>
				Promise.resolve(
					new Response(pcm, {
						headers: { "X-Audio-Format": "s16le", "X-Sample-Rate": "16000" },
					}),
				),
			),
		)
		const stats: RingStats[] = []
		const ended: string[] = []
		const player = new PcmPlayer({
			onStats: s => void stats.push(s),
			onEnded: r => void ended.push(r),
			onBlocked: () => undefined,
		})
		player.unlock(16_000)
		player.play({
			url: "http://pi.local:8081/stream",
			format: "s16le",
			rate: 16_000,
		})
		await vi.waitFor(() => expect(ended).toHaveLength(1))
		const node = nodes[0]
		expect(node).toBeDefined()
		const out = new FakeBuffer()
		node?.onaudioprocess?.({ outputBuffer: out })
		expect(stats.at(-1)?.playing).toBe(true)
		expect(out.data[100]).toBeCloseTo(0.5, 3)
		expect(player.outputLatencyMs()).toBeCloseTo(128, 0)
		player.dispose()
		expect(node?.disconnect).toHaveBeenCalled()
	})
})
