/** Optional operator signal; absence retains the arbiter's existing idle clock. */
export interface OperatorActivityPort {
	current(): { audio: boolean; recording: boolean; sourceId?: string | null }
	onChange(callback: () => void): () => void
}
export interface ResumeStatus {
	resumeAt: string | null
	resumeHeldBy: "audio" | "identify" | "recording" | null
}
export class ResumeActivity {
	private previous = { audio: false, recording: false, identify: false }
	private floor = -Infinity
	private audioHangUntil = -Infinity
	/** First time an unchanged elapsed deadline was reported, so it stays stable. */
	private elapsed: { deadline: number; at: number } | null = null

	status(
		activity: { audio: boolean; recording: boolean; identify: boolean },
		idleSince: number | null,
		delay: number,
		now: number,
	): ResumeStatus {
		if (this.previous.audio && !activity.audio) this.audioHangUntil = now + 3000
		if (
			activity.audio ||
			activity.recording ||
			activity.identify ||
			this.previous.recording ||
			this.previous.identify
		)
			this.floor = now
		this.floor = Math.max(this.floor, this.audioHangUntil)
		this.previous = { ...activity }
		const held = activity.recording
			? "recording"
			: activity.identify
				? "identify"
				: activity.audio || now < this.audioHangUntil
					? "audio"
					: null
		if (held !== null || idleSince === null) {
			this.elapsed = null
			return { resumeAt: null, resumeHeldBy: held }
		}
		const deadline = Math.max(idleSince, this.floor) + delay
		if (deadline > now) {
			this.elapsed = null
			return { resumeAt: new Date(deadline).toISOString(), resumeHeldBy: null }
		}
		// A deadline already passed (resume still pending, e.g. the lease is held
		// elsewhere) reads as the moment it was first seen elapsed: never an epoch
		// date, and constant across ticks so unchanged jobs are not re-broadcast.
		if (this.elapsed?.deadline !== deadline)
			this.elapsed = { deadline, at: now }
		return {
			resumeAt: new Date(this.elapsed.at).toISOString(),
			resumeHeldBy: null,
		}
	}
}
