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
		return {
			resumeAt:
				held !== null || idleSince === null
					? null
					: new Date(Math.max(idleSince, this.floor) + delay).toISOString(),
			resumeHeldBy: held,
		}
	}
}
