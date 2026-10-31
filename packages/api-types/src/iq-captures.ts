/**
 * Named IQ captures: a few seconds of the current tuning written as CU8 into the private
 * state directory, listed, downloaded and deleted by name. Protected access only.
 */

/** The capture routes mount only in protected access mode (like the IQ snapshot). */
export const IQ_CAPTURES_REQUIRES_ACCESS = true
export const IQ_CAPTURES_ROUTE = "/api/iq/captures"
/** `:name` is an IQ_CAPTURE_NAME. */
export const IQ_CAPTURE_ROUTE = "/api/iq/captures/:name"

/**
 * 1 to 64 characters: lower-case letters, digits, `-` and `_`, starting with a letter or
 * digit. No dot, slash or upper case, so a name is never a path, a hidden file, a suffix
 * of another capture's file, or a case-folded duplicate on a case-insensitive disk.
 */
export const IQ_CAPTURE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
/** Whole seconds per capture, inclusive. */
export const IQ_CAPTURE_SECONDS_MIN = 1
export const IQ_CAPTURE_SECONDS_MAX = 10
/** The highest RTL-SDR sample rate the tuner accepts, samples per second. */
export const IQ_CAPTURE_MAX_SAMPLE_RATE = 3_200_000
/** 10 s × 3,200,000 complex samples/s × 2 CU8 bytes = 64,000,000 bytes per capture. */
export const IQ_CAPTURE_MAX_BYTES =
	IQ_CAPTURE_SECONDS_MAX * IQ_CAPTURE_MAX_SAMPLE_RATE * 2
/** Eight full-length captures at the top rate: 8 × 64,000,000 = 512,000,000 bytes. */
export const IQ_CAPTURES_QUOTA_BYTES = 8 * IQ_CAPTURE_MAX_BYTES
/** Stored captures at most (bounds the listing). */
export const IQ_CAPTURES_MAX_COUNT = 32
/** Free space the filesystem keeps after a capture: 256 MiB = 268,435,456 bytes. */
export const IQ_CAPTURES_MIN_FREE_BYTES = 256 * 1024 * 1024

/** POST /api/iq/captures. `sourceId` may be omitted when exactly one source is configured. */
export interface IqCaptureRequest {
	name: string
	seconds: number
	sourceId?: string
}

/** One stored capture. Every value is what the source reported when the capture started. */
export interface IqCapture {
	name: string
	sourceId: string
	format: "cu8"
	centerHz: number
	sampleRate: number
	/** Manual gain in tenths of a dB; null under AGC or when the tuner state is unknown. */
	gain: number | null
	/** ISO time of the first stored chunk. */
	startedAt: string
	durationS: number
	bytes: number
}

/** GET /api/iq/captures, newest first. */
export interface IqCaptureList {
	captures: IqCapture[]
	usedBytes: number
	quotaBytes: number
	maxCount: number
}

export type IqCaptureErrorCode =
	| "IQ_CAPTURE_NOT_FOUND"
	| "IQ_CAPTURE_EXISTS"
	| "IQ_CAPTURE_BUSY"
	| "IQ_CAPTURE_UNSUPPORTED"
	| "IQ_CAPTURE_QUOTA"
	| "IQ_CAPTURE_DISK_FULL"
	| "IQ_CAPTURE_SOURCE_CHANGED"
	| "IQ_CAPTURE_INTERRUPTED"
	| "IQ_CAPTURES_UNAVAILABLE"
	| "SOURCE_NOT_FOUND"
	| "SOURCE_DISCONNECTED"

export interface IqCaptureErrorBody {
	error: string
	code: IqCaptureErrorCode
	message: string
}
