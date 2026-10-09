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

/** Expected datagram size: one 20 ms frame of `channels` channels. */
export function dsdFmeDatagramBytes(channels: VoiceChannels): number {
	return DSD_FME_DATAGRAM_FRAMES * channels * 2
}

export interface DownmixOptions {
	/**
	 * Stereo only: silence this TDMA slot's channel (1 = left, 2 = right)
	 * before mixing, e.g. an encrypted call. A datagram whose channels are
	 * identical carries one slot copied to both and is silenced entirely.
	 */
	muteSlot?: 1 | 2 | undefined
}

/**
 * Validates one datagram and returns it as mono s16le, or null when it is not
 * a whole number of sample frames (or empty / oversized).
 *
 * Stereo mix (per datagram, so each slot keeps a stable level): identical
 * channels (dsd-fme copies a lone active slot to both, or a non-TDMA call)
 * pass through once; otherwise the channels are summed and clamped. A muted
 * slot is zero-filled by dsd-fme, so a lone call keeps its level when the
 * other slot joins or leaves; two loud simultaneous calls may clip.
 */
export function downmixDsdFmeDatagram(
	datagram: Buffer,
	channels: VoiceChannels,
	options: DownmixOptions = {},
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
	for (let i = 0; i < frames && identical; i++) {
		if (datagram.readInt16LE(i * 4) !== datagram.readInt16LE(i * 4 + 2)) {
			identical = false
		}
	}
	const mono = Buffer.alloc(frames * 2)
	if (identical) {
		if (options.muteSlot !== undefined) return mono
		for (let i = 0; i < frames; i++) {
			mono.writeInt16LE(datagram.readInt16LE(i * 4), i * 2)
		}
		return mono
	}
	const keepLeft = options.muteSlot !== 1
	const keepRight = options.muteSlot !== 2
	for (let i = 0; i < frames; i++) {
		const left = keepLeft ? datagram.readInt16LE(i * 4) : 0
		const right = keepRight ? datagram.readInt16LE(i * 4 + 2) : 0
		mono.writeInt16LE(clamp16(left + right), i * 2)
	}
	return mono
}
