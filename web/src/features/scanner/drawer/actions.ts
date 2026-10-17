// What the open discovery's actions do: Listen (tunes first when it is outside the capture), Save
// frequency (a saved frequency prefilled from the discovery), Identify again (in the tuned span only),
// Keep, Ignore (the core's lockout, with Undo), Delete and Copy; results land in the app toast.
import type {
	Discovery,
	SavedFrequencyInput,
	ScanJob,
} from "@wavekit/api-types"

import type { AppServices } from "../../../app/services.ts"
import {
	bandAt,
	discoveryTitle,
	errorMessage,
	isApiError,
} from "../../../data/index.ts"
import { dismissAppToast, showAppToast } from "../../../shell/toast.ts"
import { formatMHz } from "../../format.ts"
import { skipPatch, unskipPatch } from "../../tuner/scan-hold.ts"
import { defaultGroup } from "../../tuner/saved.ts"
import { modeSpec, type Modulation } from "../../tuner/modes.ts"

// ---- pure

/** The mode a discovery is heard in: AM for AM voice, else narrow FM (digital voice decodes from it). */
export function discoveryMode(d: Pick<Discovery, "protocol">): Modulation {
	return d.protocol === "analog-am" ? "am" : "nfm"
}

/** The saved frequency "Save frequency" creates: name (label, else the discovery's title), mode, width, tone. */
export function discoverySaveInput(
	d: Discovery,
	group: string | null,
): SavedFrequencyInput {
	const mode = discoveryMode(d)
	const spec = modeSpec(mode)
	const [min, max, , fallback] = spec.bw ?? [0, 0, 0, 0]
	const measured = Math.round(d.bandwidthHz)
	const bandwidthHz =
		measured > 0 ? Math.min(max, Math.max(min, measured)) : fallback
	const label = d.operator?.label?.trim()
	const title = discoveryTitle(d)
	// an identity names it ("DMR · CC 1"); "Heard" or "Maybe DMR" alone needs the frequency
	const name = (
		label || (d.identity ? title : `${title} ${formatMHz(d.frequencyHz)}`)
	).slice(0, 128)
	const ctcss = d.metadata.ctcssHz
	const tone: SavedFrequencyInput["tone"] =
		mode === "nfm" && ctcss !== undefined && ctcss >= 60 && ctcss <= 300
			? { kind: "ctcss", frequencyTenthsHz: Math.round(ctcss * 10) }
			: { kind: "none" }
	const input: SavedFrequencyInput = {
		name,
		frequencyHz: Math.round(d.frequencyHz),
		mode,
		bandwidthHz,
		tone,
	}
	if (group) input.group = group
	return input
}

/** Whether `hz` lies inside the receiver's capture (Identify never moves the receiver). */
export function inCapture(
	hz: number,
	tuner: { frequency: number; sampleRate: number } | undefined,
	marginHz = 0,
): boolean {
	if (!tuner || !(tuner.sampleRate > 0)) return false
	const half = tuner.sampleRate / 2 - marginHz
	return Math.abs(hz - tuner.frequency) <= half
}

// ---- toast: the app's one toast (src/shell/toast.ts), above the dock in the free plot area

export const showToast = showAppToast
export const dismissToast = dismissAppToast

// ---- runners (talk to the core; failures land in the toast)

const f3 = (hz: number) => formatMHz(hz)

/**
 * Listen: the core retargets live audio when the discovery is in the current window; otherwise the
 * receiver tunes there first (which pauses a running sweep), then the core is asked again.
 */
export async function listenTo(
	services: AppServices,
	d: Discovery,
): Promise<void> {
	const { data, tuning, listen } = services
	if (!listen.get().wanted) void listen.start()
	try {
		await data.scanner.listenDiscovery(d.id)
	} catch (error) {
		if (!isApiError(error) || error.code !== "OUT_OF_WINDOW") {
			showToast(`Could not listen: ${errorMessage(error)}`, { tone: "warn" })
			return
		}
		await tuning.tune(d.frequencyHz + d.measuredOffsetHz)
		const tuneError = tuning.get().error
		if (tuneError) {
			showToast(`Could not tune: ${tuneError}`, { tone: "warn" })
			return
		}
		try {
			await data.scanner.listenDiscovery(d.id)
		} catch {
			// tuned there: live audio follows the tuned frequency anyway
		}
	}
	showToast(`Listening to ${f3(d.frequencyHz)}`)
}

/** The saved frequency at the discovery's frequency, if any. */
export function savedAt(services: AppServices, d: Discovery) {
	return services.data.savedFrequencies.at(d.frequencyHz)
}

export async function toggleSaved(
	services: AppServices,
	d: Discovery,
): Promise<void> {
	const store = services.data.savedFrequencies
	const have = savedAt(services, d)
	try {
		if (have) {
			await store.remove(have.id)
			showToast(`Removed ${f3(d.frequencyHz)} from saved frequencies`)
			return
		}
		const band = bandAt(services.data.bandplan.get().view, d.frequencyHz)
		const input = discoverySaveInput(d, defaultGroup(band?.band.group))
		await store.create(input)
		showToast(
			`Saved ${f3(d.frequencyHz)} as “${input.name}” · mode and width filled in`,
		)
	} catch (error) {
		showToast(`Could not save: ${errorMessage(error)}`, { tone: "warn" })
	}
}

export async function identifyAgain(
	services: AppServices,
	d: Discovery,
): Promise<void> {
	try {
		const opts =
			d.bandwidthHz > 0 ? { bandwidthHz: Math.round(d.bandwidthHz) } : {}
		await services.data.identify.start(d.frequencyHz, opts)
		showToast(`Identifying ${f3(d.frequencyHz)} on the tuned card`)
	} catch (error) {
		showToast(`Could not identify: ${errorMessage(error)}`, { tone: "warn" })
	}
}

export async function setKeep(
	services: AppServices,
	d: Discovery,
	keep: boolean,
): Promise<void> {
	try {
		await services.data.scanner.patchDiscovery(d.id, { keep })
		showToast(
			keep
				? `Keeping ${f3(d.frequencyHz)} · never aged out`
				: `${f3(d.frequencyHz)} ages out like the rest`,
		)
	} catch (error) {
		showToast(`Could not change it: ${errorMessage(error)}`, { tone: "warn" })
	}
}

export async function setIgnored(
	services: AppServices,
	d: Discovery,
	lockout: boolean,
): Promise<void> {
	const scanner = services.data.scanner
	try {
		await scanner.patchDiscovery(d.id, { lockout })
		if (lockout)
			showToast(
				`Ignored ${f3(d.frequencyHz)} · never probed, recorded or scanned again`,
				{
					undo: () => {
						dismissToast()
						void setIgnored(services, d, false)
					},
				},
			)
		else showToast(`${f3(d.frequencyHz)} is back in probes and scans`)
	} catch (error) {
		showToast(`Could not change it: ${errorMessage(error)}`, { tone: "warn" })
	}
}

/** Skip (this scan only, from the hit log): the sweep stops visiting its channel; again puts it back. */
export async function setSkipped(
	services: AppServices,
	job: ScanJob,
	d: Discovery,
	skip: boolean,
): Promise<void> {
	const scanner = services.data.scanner
	try {
		await scanner.patchJob(
			job.id,
			skip
				? skipPatch(job, d.frequencyHz, d.bandwidthHz)
				: unskipPatch(job, d.frequencyHz),
		)
		if (skip)
			showToast(`Skipping ${f3(d.frequencyHz)} for the rest of this scan`, {
				undo: () => {
					dismissToast()
					const now = scanner.get().jobs.get(job.id)
					if (now) void setSkipped(services, now, d, false)
				},
			})
		else showToast(`${f3(d.frequencyHz)} is back in this scan`)
	} catch (error) {
		showToast(`Could not change the scan: ${errorMessage(error)}`, {
			tone: "warn",
		})
	}
}

export async function deleteDiscovery(
	services: AppServices,
	d: Discovery,
): Promise<void> {
	try {
		await services.data.scanner.deleteDiscovery(d.id)
		showToast(
			`Deleted ${f3(d.frequencyHz)} · it comes back if it is heard again`,
		)
	} catch (error) {
		showToast(`Could not delete: ${errorMessage(error)}`, { tone: "warn" })
	}
}

export async function copyFrequency(d: Discovery): Promise<void> {
	const text = (Math.round(d.frequencyHz) / 1e6).toFixed(6)
	try {
		await navigator.clipboard.writeText(text)
		showToast(`Copied ${text}`)
	} catch {
		showToast("Could not copy: the browser refused the clipboard", {
			tone: "warn",
		})
	}
}

/** Saves the label or the note when it changed (on blur or Enter). */
export async function saveOperatorText(
	services: AppServices,
	d: Discovery,
	field: "label" | "notes",
	value: string,
): Promise<void> {
	const before =
		(field === "label" ? d.operator?.label : d.operator?.notes) ?? ""
	if (value.trim() === before.trim()) return
	try {
		await services.data.scanner.patchDiscovery(d.id, { [field]: value.trim() })
	} catch (error) {
		showToast(
			`Could not save the ${field === "label" ? "label" : "note"}: ${errorMessage(error)}`,
			{
				tone: "warn",
			},
		)
	}
}
