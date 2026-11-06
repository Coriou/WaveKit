// Resume on a paused scan outside the Tuner's hold row, with the row's words and its one rule (resumeWithConsent): a
// plain resume first, a takeover in the same click only for the names the button showed, and otherwise a confirm naming
// who it interrupts. Nothing shows when Resume could not work (scanResumable), or for read-only access.
import "./resume-scan.css"

import { useEffect, useState } from "react"
import type { ScanJob } from "@wavekit/api-types"

import { useReadOnly, useServices } from "../../app/context.ts"
import { useStore } from "../../data/index.ts"
import { Button } from "../../ui/Button.tsx"
import {
	consentAction,
	decoderNamer,
	latestRequest,
	resumeApproved,
	resumeWithConsent,
	scanResumable,
} from "../tuner/scan-hold.ts"

export function ResumeScan({ job }: { job: ScanJob }) {
	const { data, decoders } = useServices()
	const readOnly = useReadOnly()
	const [consent, setConsent] = useState<string[] | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [requests] = useState(latestRequest)
	const decoderName = decoderNamer(useStore(decoders, s => s.decoders))

	// the component can be reused for another job: what is in flight answers for the old one
	useEffect(() => {
		requests.cancel()
		setBusy(false)
	}, [requests, job.id])
	// a consent question or an error belongs to the state it was asked in
	useEffect(() => {
		setConsent(null)
		setError(null)
	}, [job.id, job.state, job.reason])

	if (readOnly || !scanResumable(job)) return null

	const approved = resumeApproved(job, consent, decoderName)

	const resume = () => {
		const current = requests.begin()
		setBusy(true)
		setError(null)
		void resumeWithConsent({
			jobId: job.id,
			approved,
			resume: (id, options) => data.scanner.resumeJob(id, options),
			decoderName,
			current,
		}).then(outcome => {
			if (outcome.kind === "superseded") return
			setBusy(false)
			if (outcome.kind === "confirm") setConsent(outcome.names)
			else if (outcome.kind === "error") setError(outcome.message)
			else setConsent(null)
		})
	}

	const ask = approved ? consentAction(approved) : null
	return (
		<span className="wk-resume-scan">
			{error !== null && (
				<span className="wk-resume-scan-err" role="alert" title={error}>
					{error}
				</span>
			)}
			<Button
				variant="amber"
				size="sm"
				disabled={busy}
				title={
					ask?.title ??
					"Carry on where it left off. Asks first if it interrupts anyone."
				}
				onClick={resume}
			>
				{ask?.label ?? "Resume"}
			</Button>
		</span>
	)
}
