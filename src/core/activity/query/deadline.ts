import {
	ActivityQueryTimeoutError,
	ActivityReaderFailedError,
} from "./errors.js"

/**
 * Races one admitted read against its deadline. The caller arms this only after admission
 * and reader startup, so queue wait never counts against `deadlineMs`; the queue is bounded
 * separately by QueryAdmission (count caps that refuse with 429).
 *
 * The timer lives on the main thread, and a reply from the reader worker is delivered in
 * the event loop's poll phase, after timers. When the main thread is blocked past the
 * deadline (a burst of decoder output parsed in one I/O callback), the timer would run
 * first and throw away a reply that is already waiting. So an expired timer grants one
 * more loop turn: `setImmediate` runs after the next poll phase, which delivers any reply
 * already posted. Only a read still unanswered after that turn calls `onExpire` (which
 * terminates the reader) and rejects with ActivityQueryTimeoutError. The grace costs one
 * loop turn on a read that really is late, never a fixed extra delay.
 */
export function raceDeadline<T>(
	work: Promise<T>,
	deadlineMs: number,
	onExpire: () => void,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false
		let grace: ReturnType<typeof setImmediate> | undefined
		const timer = setTimeout(() => {
			grace = setImmediate(() => {
				if (settled) return
				settled = true
				onExpire()
				reject(new ActivityQueryTimeoutError())
			})
		}, deadlineMs)
		timer.unref()
		const finish = (): boolean => {
			if (settled) return false
			settled = true
			clearTimeout(timer)
			if (grace !== undefined) clearImmediate(grace)
			return true
		}
		work.then(
			value => {
				if (finish()) resolve(value)
			},
			(error: unknown) => {
				if (finish())
					reject(
						error instanceof Error ? error : new ActivityReaderFailedError(),
					)
			},
		)
	})
}
