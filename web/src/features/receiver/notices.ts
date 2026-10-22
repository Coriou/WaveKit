// What the core changes on the receiver by itself, in words: the 1090 MHz rate policy (a sample-rate raise for
// ADS-B, its restore, a raise it skipped) and the link-capacity advisory. Formatters are pure; watchReceiverNotices
// turns `tuner:rate-policy` and the `link-capacity` resource alert into the app toast.
import type {
	LinkAdvisory,
	ResourceAlert,
	TunerCommandOrigin,
	TunerRatePolicyEventData,
	TunerState,
} from "@wavekit/api-types"

import type { EventsClient } from "../../data/events-client.ts"
import { showAppToast } from "../../shell/toast.ts"
import { formatRate } from "../format.ts"

/** Who wrote a tuner setting. */
export const TUNER_ORIGINS: Readonly<Record<TunerCommandOrigin, string>> = {
	rest: "you",
	scanner: "the scanner",
	replay: "the reconnect",
	config: "the configuration",
	"decoder-rate": "the 1090 MHz rate policy",
}

/** The note under Sample rate while the policy holds a raise: "Raised from 2 MS/s by the 1090 MHz rate policy …". */
export function ratePolicyNote(tuner: TunerState | undefined): string | null {
	const p = tuner?.ratePolicy
	if (!p) return null
	return `Raised from ${formatRate(p.raisedFromHz)} by ${TUNER_ORIGINS["decoder-rate"]} for ADS-B; it goes back once ADS-B no longer needs it.`
}

/** The link advisory in words, or null when the link keeps up. */
export function linkText(link: LinkAdvisory | undefined): string | null {
	if (!link || link.level === "none") return null
	if (link.level === "unproven")
		return "The link to the receiver has not proven it carries this rate."
	const short =
		link.shortfallPercent !== null
			? ` (${Math.round(link.shortfallPercent)} % short)`
			: ""
	return `The link to the receiver is losing samples${short}: try a lower sample rate.`
}

/** A rate-policy event as a toast, or null when there is nothing to say (already above the rate). */
export function ratePolicyToast(
	e: TunerRatePolicyEventData,
): { text: string; warn: boolean } | null {
	const link = linkText(e.link)
	switch (e.action) {
		case "raised": {
			const text = `Sample rate raised to ${formatRate(e.toHz)} for ADS-B (1090 MHz)`
			return link
				? { text: `${text}. ${link}`, warn: true }
				: { text, warn: false }
		}
		case "restored":
			return { text: `Sample rate back to ${formatRate(e.toHz)}`, warn: false }
		case "skipped":
			if (e.skipped === "external-control")
				return {
					text: `ADS-B needs ${formatRate(e.toHz)}, but another client has the tuner`,
					warn: true,
				}
			if (e.skipped === "write-failed")
				return {
					text: `The receiver refused ${formatRate(e.toHz)} for ADS-B`,
					warn: true,
				}
			return null
	}
}

/** The `link-capacity` resource alert as a toast; other alerts are not this module's. */
export function linkAlertToast(a: ResourceAlert): string | null {
	if (a.type !== "link-capacity") return null
	return a.severity === "critical"
		? "Samples are being lost on the link to the receiver: try a lower sample rate"
		: "The link to the receiver may be too slow for this sample rate"
}

/** A raise toast that already spoke of the link covers the alert sent with it. */
const ALERT_QUIET_MS = 5000

export function watchReceiverNotices(
	events: EventsClient,
	toast: typeof showAppToast = showAppToast,
	now: () => number = Date.now,
): () => void {
	let linkSaidAt = -Infinity
	const offs = [
		events.subscribe(["resources"]),
		events.on("tuner:rate-policy", e => {
			const t = ratePolicyToast(e)
			if (!t) return
			if (linkText(e.link)) linkSaidAt = now()
			toast(t.text, t.warn ? { tone: "warn" } : {})
		}),
		events.on("resources:alert", a => {
			const text = linkAlertToast(a)
			if (!text || now() - linkSaidAt < ALERT_QUIET_MS) return
			toast(text, { tone: "warn" })
		}),
	]
	return () => {
		for (const off of offs.splice(0)) off()
	}
}
