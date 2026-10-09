/**
 * dsd-fme `-o udp` voice payload format (measured 2026-10-09 on the pinned
 * dsd-fme ed1d1d6 / mbelib 1.3.0, see docs/DIGITAL-VOICE.md):
 *
 * - 8000 Hz signed 16-bit little-endian PCM, no header or framing.
 * - One datagram per 20 ms AMBE/IMBE frame: 160 sample frames.
 * - Stereo (640-byte datagrams) in auto and DMR modes: slot 1 on the left,
 *   slot 2 on the right. A single-slot or non-TDMA call is copied to both
 *   channels; a muted (off or encrypted) slot is zero-filled.
 * - Mono (320-byte datagrams) in the P25 phase 1, YSF, D-STAR, NXDN and
 *   ProVoice modes.
 * - Nothing is sent between calls or for a call muted on every slot: the
 *   stream is bursty and the consumer fills the gaps.
 */

export const DSD_FME_VOICE_SAMPLE_RATE = 8000

/** Sample frames per datagram (one 20 ms vocoder frame). */
export const DSD_FME_DATAGRAM_FRAMES = 160

/**
 * Largest datagram accepted. Observed voice datagrams are 320 or 640 bytes;
 * dsd-fme's largest write in its source is 960 mono samples (1920 bytes).
 * Anything above 4 KiB is not dsd-fme voice.
 */
export const MAX_DSD_FME_DATAGRAM_BYTES = 4096

export type VoiceChannels = 1 | 2

function clamp16(value: number): number {
	return value > 32767 ? 32767 : value < -32768 ? -32768 : value
}

/**
 * Validates one datagram and returns it as mono s16le, or null when it is not
 * a whole number of sample frames (or empty / oversized).
 *
 * Stereo is mixed per datagram: identical channels (one active slot or a
 * non-TDMA call) pass unchanged, a silent channel is ignored, and two active
 * slots are averaged so simultaneous calls cannot clip.
 */
export function downmixDsdFmeDatagram(
	datagram: Buffer,
	channels: VoiceChannels,
): Buffer | null {
	const frameBytes = channels * 2
	if (
		datagram.length === 0 ||
		datagram.length > MAX_DSD_FME_DATAGRAM_BYTES ||
		datagram.length % frameBytes !== 0
	) {
		return null
	}
	if (channels === 1) return Buffer.from(datagram)

	const frames = datagram.length / 4
	let identical = true
	let leftSilent = true
	let rightSilent = true
	for (let i = 0; i < frames; i++) {
		const left = datagram.readInt16LE(i * 4)
		const right = datagram.readInt16LE(i * 4 + 2)
		if (left !== right) identical = false
		if (left !== 0) leftSilent = false
		if (right !== 0) rightSilent = false
	}
	const useLeft = identical || rightSilent
	const useRight = !useLeft && leftSilent
	const mono = Buffer.alloc(frames * 2)
	for (let i = 0; i < frames; i++) {
		const left = datagram.readInt16LE(i * 4)
		const right = datagram.readInt16LE(i * 4 + 2)
		const sample = useLeft
			? left
			: useRight
				? right
				: clamp16(Math.round((left + right) / 2))
		mono.writeInt16LE(sample, i * 2)
	}
	return mono
}
