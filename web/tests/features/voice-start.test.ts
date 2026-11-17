// The `voice-start` condition (src/features/listen/voice-start.ts): a late start result after listening stopped
// is ignored, and listening that no longer needs decoded voice clears it.
import { describe, expect, it } from "vitest"

import { syncVoiceStart } from "../../src/features/listen/voice-start.ts"
import { NoticeService } from "../../src/shell/notices/service.ts"

const NEEDS = { wanted: true, voiceRunning: false, needsVoice: true }

function deferred() {
	let reject: (e: unknown) => void = () => undefined
	let resolve: () => void = () => undefined
	const promise = new Promise<void>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

const flush = () => new Promise<void>(r => queueMicrotask(r))

describe("voice-start condition", () => {
	it("raises a failed start once, while still live", async () => {
		const svc = new NoticeService()
		const d = deferred()
		syncVoiceStart(NEEDS, () => d.promise, svc)
		d.reject(new Error("busy"))
		await flush()
		expect(svc.conditions.get().get("voice-start")?.text).toBe(
			"Decoded voice could not start: busy",
		)
		expect(svc.shown.get()?.key).toBe("voice-start")
	})

	it("ignores a rejection that lands after listening stopped", async () => {
		const svc = new NoticeService()
		const d = deferred()
		const cleanup = syncVoiceStart(NEEDS, () => d.promise, svc)
		cleanup()
		syncVoiceStart({ ...NEEDS, wanted: false }, () => d.promise, svc)
		d.reject(new Error("late"))
		await flush()
		expect(svc.conditions.get().has("voice-start")).toBe(false)
		expect(svc.shown.get()).toBeNull()
	})

	it("clears it when listening no longer needs decoded voice (Source Analog)", async () => {
		const svc = new NoticeService()
		const cleanup = syncVoiceStart(
			NEEDS,
			() => Promise.reject(new Error("busy")),
			svc,
		)
		await flush()
		expect(svc.conditions.get().has("voice-start")).toBe(true)
		cleanup()
		let started = false
		syncVoiceStart(
			{ ...NEEDS, needsVoice: false },
			() => {
				started = true
				return Promise.resolve()
			},
			svc,
		)
		expect(started).toBe(false)
		expect(svc.conditions.get().has("voice-start")).toBe(false)
	})
})
