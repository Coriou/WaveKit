import { randomUUID } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { AnalogRecorder } from "../../../../src/core/scanner/channel/analog-recorder.js"
import type {
	AnalogHandle,
	AnalogReceipt,
} from "../../../../src/core/scanner/store/analog-operations.js"
import { FmAudioDemod } from "../../../../src/core/scanner/channel/fm-audio.js"
function tone(samples: number): Float32Array {
	const iq = new Float32Array(samples * 2)
	let phase = 0
	for (let i = 0; i < samples; i++) {
		phase +=
			(2 * Math.PI * 500 * Math.sin((2 * Math.PI * 1000 * i) / 48000)) / 48000
		iq[i * 2] = Math.cos(phase)
		iq[i * 2 + 1] = Math.sin(phase)
	}
	return iq
}
function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>(done => {
		resolve = done
	})
	return { promise, resolve }
}
function fake() {
	const id = randomUUID()
	const pcm: number[] = []
	const receipt: AnalogReceipt = {
		version: 1,
		operationId: id,
		producerRecordingId: id,
		producerRunId: randomUUID(),
		producerStoreId: null,
		producerId: "scanner-analog",
		discoveryId: null,
		observationId: null,
		alias: null,
		binding: {
			sourceId: null,
			engineInstanceId: null,
			stream: null,
			epoch: null,
			channelId: null,
			channelGeneration: null,
			inputFormat: null,
			inputSampleRateHz: null,
			groupDelayInputSamples: null,
			targetHz: null,
			captureCentreHz: null,
			tuningTrust: null,
		},
		output: {
			format: null,
			sampleRateHz: null,
			channelCount: null,
			outputFrames: null,
			fileBytes: null,
		},
		gaps: [],
		omittedGapCount: 0,
		cutReason: "completed",
		closure: "closed",
		outcome: "aborted",
		artifact: null,
		cleanup: "complete",
		residueBytes: 0,
		errorCode: null,
		durability: {
			mediaFileSync: "not-acknowledged",
			metadata: "not-acknowledged",
			metadataPowerLossDurable: false,
			finalMarkerFileSync: "not-acknowledged",
			finalMarkerDirectorySync: "not-attempted",
		},
	}
	const push = vi.fn(async (input: Int16Array) => {
		pcm.push(...input)
	})
	const cancel = vi.fn()
	const finish = vi.fn(async () => receipt)
	const gap = vi.fn()
	const handle: AnalogHandle = {
		operationId: id,
		ready: Promise.resolve(),
		settled: Promise.resolve(receipt),
		push,
		cancel,
		finish,
		addGap: gap,
	}
	return { handle, pcm, receipt, push, cancel, finish, gap }
}
describe("Task42 bounded internal analog producer", () => {
	it("qualifies overflow at admission across backlog, rejected input and later accepted input", async () => {
		const f = fake(),
			entered = deferred(),
			release = deferred()
		f.push.mockImplementationOnce(async () => {
			entered.resolve()
			await release.promise
		})
		const recorder = new AnalogRecorder({
			operation: f.handle,
			thresholdDbfs: null,
		})
		const first = recorder.push(tone(4800))
		await entered.promise
		await expect(recorder.push(tone(8192))).rejects.toThrow("queue")
		expect(f.gap).toHaveBeenLastCalledWith({
			cause: "queue-overflow",
			inputSampleIndex: 4800,
			droppedInputSamples: 8192,
			outputFrameIndex: null,
		})
		release.resolve()
		await first
		await recorder.push(tone(480))
		await expect(recorder.push(tone(9000))).rejects.toThrow("queue")
		expect(f.gap).toHaveBeenLastCalledWith({
			cause: "queue-overflow",
			inputSampleIndex: 13472,
			droppedInputSamples: 9000,
			outputFrameIndex: null,
		})
		await recorder.push(new Float32Array([1]))
		await expect(recorder.push(new Float32Array(18001))).rejects.toThrow(
			"queue",
		)
		expect(f.gap).toHaveBeenLastCalledWith({
			cause: "queue-overflow",
			inputSampleIndex: null,
			droppedInputSamples: null,
			outputFrameIndex: null,
		})
		await recorder.finish()
	})
	it("provider gaps retain supplied facts and invalidate an inferred future origin", async () => {
		const f = fake(),
			recorder = new AnalogRecorder({
				operation: f.handle,
				thresholdDbfs: null,
			})
		await recorder.push(tone(480))
		recorder.gap({
			cause: "source-gap",
			inputSampleIndex: 10000,
			droppedInputSamples: 100,
			outputFrameIndex: null,
		})
		await expect(recorder.push(tone(9000))).rejects.toThrow("queue")
		expect(f.gap).toHaveBeenLastCalledWith({
			cause: "queue-overflow",
			inputSampleIndex: null,
			droppedInputSamples: 9000,
			outputFrameIndex: null,
		})
		expect(f.gap).toHaveBeenNthCalledWith(1, {
			cause: "source-gap",
			inputSampleIndex: 10000,
			droppedInputSamples: 100,
			outputFrameIndex: null,
		})
		await recorder.finish()
	})

	it("produces exactly the independent FM output in 10 ms PCM pushes across odd chunks", async () => {
		const f = fake()
		const recorder = new AnalogRecorder({
			operation: f.handle,
			thresholdDbfs: null,
		})
		const iq = tone(4800)
		for (let i = 0; i < iq.length; i += 137)
			await recorder.push(iq.subarray(i, i + 137))
		const finish = recorder.finish()
		expect(recorder.finish()).toBe(finish)
		expect(await finish).toBe(f.receipt)
		expect(f.pcm).toEqual([...new FmAudioDemod().process(iq)])
		expect(f.push.mock.calls.every(([chunk]) => chunk.length === 80)).toBe(true)
		await expect(recorder.push(iq)).rejects.toThrow("closed")
	})
	it("bounds admitted input bytes before copying and preserves caller mutation isolation", async () => {
		const f = fake()
		const gate = deferred()
		const entered = deferred()
		const original = f.push.getMockImplementation()!
		f.push.mockImplementationOnce(async pcm => {
			entered.resolve()
			await gate.promise
			await original(pcm)
		})
		const recorder = new AnalogRecorder({
			operation: f.handle,
			thresholdDbfs: null,
			deemphasisUs: null,
		})
		const iq = tone(4800)
		const expected = [...new FmAudioDemod({ deemphasisUs: null }).process(iq)]
		const write = recorder.push(iq)
		iq.fill(0)
		await entered.promise
		await expect(recorder.push(new Float32Array(16_384))).rejects.toThrow(
			"queue",
		)
		expect(recorder.pendingBytes).toBe(38_400)
		gate.resolve()
		await write
		await recorder.finish()
		expect(f.pcm).toEqual(expected)
		expect(recorder.pendingBytes).toBe(0)
		expect(f.gap).toHaveBeenCalledWith(
			expect.objectContaining({
				cause: "queue-overflow",
				inputSampleIndex: 4800,
				droppedInputSamples: 8192,
				outputFrameIndex: null,
			}),
		)
	})
	it("cancel synchronously fences intake and stops after the pending 10 ms block", async () => {
		const f = fake()
		const gate = deferred()
		const entered = deferred()
		f.push.mockImplementationOnce(async () => {
			entered.resolve()
			await gate.promise
		})
		const recorder = new AnalogRecorder({
			operation: f.handle,
			thresholdDbfs: null,
		})
		const write = recorder.push(tone(4800))
		const assertion = expect(write).rejects.toThrow("cancelled")
		await entered.promise
		recorder.cancel("epoch-changed")
		await expect(recorder.push(tone(480))).rejects.toThrow("closed")
		gate.resolve()
		await assertion
		expect(f.push).toHaveBeenCalledTimes(1)
		expect(f.cancel).toHaveBeenCalledWith("epoch-changed")
	})
	it("qualifies complete tail samples and an unmatched odd float as gaps", async () => {
		const f = fake()
		const recorder = new AnalogRecorder({
			operation: f.handle,
			thresholdDbfs: null,
		})
		await recorder.push(new Float32Array([1, 0, 1, 0, 1]))
		await recorder.finish()
		expect(f.gap).toHaveBeenNthCalledWith(1, {
			cause: "unknown",
			inputSampleIndex: null,
			droppedInputSamples: 2,
			outputFrameIndex: null,
		})
		expect(f.gap).toHaveBeenNthCalledWith(2, {
			cause: "unknown",
			inputSampleIndex: null,
			droppedInputSamples: null,
			outputFrameIndex: null,
		})
	})
	it("closed squelch never sends PCM and finish drains admitted work", async () => {
		const f = fake()
		const recorder = new AnalogRecorder({
			operation: f.handle,
			thresholdDbfs: -20,
		})
		const accepted = recorder.push(new Float32Array(4800))
		const finish = recorder.finish()
		await accepted
		await finish
		expect(f.push).not.toHaveBeenCalled()
		expect(f.finish).toHaveBeenCalledTimes(1)
	})
	it("rejects nonfinite input and records writer backpressure with input sample units", async () => {
		const f = fake()
		f.push.mockRejectedValueOnce(new Error("writer full"))
		const recorder = new AnalogRecorder({
			operation: f.handle,
			thresholdDbfs: null,
		})
		await expect(recorder.push(new Float32Array([NaN]))).rejects.toThrow(
			"Nonfinite",
		)
		await expect(recorder.push(tone(480))).rejects.toThrow("writer full")
		expect(f.gap).toHaveBeenCalledWith({
			cause: "writer-backpressure",
			inputSampleIndex: 0,
			droppedInputSamples: 480,
			outputFrameIndex: null,
		})
		expect(f.cancel).toHaveBeenCalledWith("cancelled")
	})
})
