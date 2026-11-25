/** Audio not written yet, oldest first (views of the demodulated arrays, no copies). */
export class PcmQueue {
	private readonly parts: Int16Array[] = []
	length = 0
	push(pcm: Int16Array): void {
		if (pcm.length === 0) return
		this.parts.push(pcm)
		this.length += pcm.length
	}
	/** Removes the oldest `n` frames (a copy only when parts are joined). */
	take(n: number): Int16Array {
		const want = Math.min(n, this.length)
		const head = this.parts[0]
		if (head && head.length >= want) {
			this.length -= want
			if (head.length === want) this.parts.shift()
			else this.parts[0] = head.subarray(want)
			return head.subarray(0, want)
		}
		const out = new Int16Array(want)
		let o = 0
		while (o < want) {
			// Whole head parts only: each take below is the single-part case.
			const part = this.take(Math.min(this.parts[0]!.length, want - o))
			out.set(part, o)
			o += part.length
		}
		return out
	}
	/** A copy of the oldest `n` frames (at most `length`); the queue is unchanged. */
	peek(n: number): Int16Array {
		const out = new Int16Array(Math.max(0, Math.min(n, this.length)))
		let o = 0
		for (const part of this.parts) {
			if (o >= out.length) break
			const k = Math.min(part.length, out.length - o)
			out.set(part.subarray(0, k), o)
			o += k
		}
		return out
	}
	/** Puts `pcm` back at the head, before the oldest frames (a replacement of what `take` took). */
	unshift(pcm: Int16Array): void {
		if (pcm.length === 0) return
		this.parts.unshift(pcm)
		this.length += pcm.length
	}
	/** Removes the newest `n` frames, oldest first. */
	takeTail(n: number): Int16Array[] {
		const out: Int16Array[] = []
		let excess = Math.min(n, this.length)
		while (excess > 0) {
			const part = this.parts.at(-1)!
			if (part.length <= excess) {
				out.unshift(part)
				this.parts.pop()
				excess -= part.length
				this.length -= part.length
				continue
			}
			const cut = part.length - excess
			out.unshift(part.subarray(cut))
			this.parts[this.parts.length - 1] = part.subarray(0, cut)
			this.length -= excess
			excess = 0
		}
		return out
	}
}
