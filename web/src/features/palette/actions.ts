// Runs the palette's rows against the app (DESIGN.md: after running, the palette closes and a toast confirms with
// Undo for patch-based commands) and applies its live previews (theme, tuning step, volume: local state only;
// anything with hardware or stream side effects runs on Enter, never previewed).
import type { LiveAudioConfig } from "@wavekit/api-types"

import type { AppServices } from "../../app/services.ts"
import { errorMessage } from "../../data/index.ts"
import { shellStore } from "../../shell/store.ts"
import { themeStore, type ThemePrefs } from "../../shell/theme.ts"
import { requestActivitySearchFocus } from "../activity/focus.ts"
import { frequencyToken, token, type SearchToken } from "../activity/search.ts"
import { squelchForModulation } from "../listen/audio.ts"
import { discoveryMode } from "../scanner/drawer/actions.ts"
import { presetOn, presetsFrom, togglePreset } from "../scanner/planner/plan.ts"
import { updateDraft } from "../scanner/planner/draft-store.ts"
import { openPlan } from "../scanner/ui-store.ts"
import { focusSetting } from "../settings/registry.ts"
import { modeSpec } from "../tuner/modes.ts"
import { recallSaved, saveInput } from "../tuner/saved.ts"
import { modulationOf } from "../tuner/modes.ts"
import { bandAt } from "../../data/bandplan-store.ts"
import { promptInstall } from "../../pwa/pwa.ts"
import type { ActivityToken, PaletteAction, Preview } from "./model.ts"

export interface RunResult {
	/** The toast's text; null shows none (navigation speaks for itself). */
	readonly text: string | null
	readonly undo?: () => void
	readonly tone?: "warn"
}

type Services = Pick<
	AppServices,
	"data" | "tuning" | "prefs" | "listen" | "activity"
>

function activityToken(t: ActivityToken): SearchToken {
	if (t.kind === "frequency")
		return frequencyToken(
			t.hz,
			t.bandwidthHz !== undefined && t.bandwidthHz > 0
				? Math.max(1000, Math.round(t.bandwidthHz / 2))
				: undefined,
		)
	return token(t.kind, t.value)
}

/** The live-audio fields `patch` changes, as they are now (for Undo). */
function previousOf(
	config: LiveAudioConfig,
	patch: Partial<LiveAudioConfig>,
): Partial<LiveAudioConfig> {
	const prev: Record<string, unknown> = {}
	for (const k of Object.keys(patch) as (keyof LiveAudioConfig)[])
		prev[k] = config[k]
	return prev as Partial<LiveAudioConfig>
}

/** A modulation change also sends what keeps the squelch valid for it (see squelchForModulation). */
function withSquelchFix(
	config: LiveAudioConfig,
	patch: Partial<LiveAudioConfig>,
): Partial<LiveAudioConfig> {
	return patch.modulation
		? { ...squelchForModulation(config, patch.modulation), ...patch }
		: patch
}

function sourceId(s: Services): string | null {
	return s.data.tuner.state()?.sourceId ?? null
}

async function setAudio(
	s: Services,
	patch: Partial<LiveAudioConfig>,
): Promise<RunResult | null> {
	const config = s.data.liveAudio.get().status?.config
	if (!config) return { text: "Live audio is not available", tone: "warn" }
	const full = withSquelchFix(config, patch)
	const prev = previousOf(config, full)
	try {
		await s.data.liveAudio.setConfig(full)
	} catch (error) {
		return { text: `Not changed: ${errorMessage(error)}`, tone: "warn" }
	}
	return {
		text: null,
		undo: () => void s.data.liveAudio.setConfig(prev).catch(() => undefined),
	}
}

/** Tunes (and sets a mode first when asked); Undo returns to the frequency and mode before. */
async function tune(
	s: Services,
	hz: number,
	mode?: LiveAudioConfig["modulation"],
	bandwidthHz?: number,
): Promise<RunResult | null> {
	const before = s.tuning.displayHz()
	const config = s.data.liveAudio.get().status?.config
	let prevAudio: Partial<LiveAudioConfig> | null = null
	if (config && mode && mode !== config.modulation) {
		const def = modeSpec(mode).bw
		const bw = bandwidthHz ?? def?.[3]
		const patch = withSquelchFix(config, {
			modulation: mode,
			...(bw !== undefined && mode !== "raw" ? { bandwidth: bw } : {}),
		})
		prevAudio = previousOf(config, patch)
		await s.data.liveAudio.setConfig(patch).catch(() => undefined)
	} else if (config && bandwidthHz && bandwidthHz !== config.bandwidth) {
		prevAudio = { bandwidth: config.bandwidth }
		await s.data.liveAudio
			.setConfig({ bandwidth: bandwidthHz })
			.catch(() => undefined)
	}
	await s.tuning.tune(hz)
	const error = s.tuning.get().error
	if (error) return { text: `Could not tune: ${error}`, tone: "warn" }
	return {
		text: null,
		...(before !== null
			? {
					undo: () => {
						if (prevAudio)
							void s.data.liveAudio.setConfig(prevAudio).catch(() => undefined)
						void s.tuning.tune(before)
					},
				}
			: {}),
	}
}

/**
 * Runs one action. `done` is the row's confirmation; the result's text replaces it when something went wrong.
 * Never rejects.
 */
export async function runAction(
	s: Services,
	action: PaletteAction,
	done: string | null,
): Promise<RunResult> {
	const ok = (r: RunResult | null): RunResult =>
		r === null ? { text: done } : { ...r, text: r.text ?? done }
	try {
		switch (action.kind) {
			case "tune":
				return ok(await tune(s, action.hz, action.mode, action.bandwidthHz))
			case "recall": {
				const before = s.tuning.displayHz()
				const config = s.data.liveAudio.get().status?.config
				await recallSaved(
					{
						config: () => s.data.liveAudio.get().status?.config,
						setConfig: patch => s.data.liveAudio.setConfig(patch),
						tune: hz => s.tuning.tune(hz),
					},
					action.saved,
				)
				const error = s.tuning.get().error
				if (error) return { text: `Could not tune: ${error}`, tone: "warn" }
				return ok({
					text: null,
					...(before !== null
						? {
								undo: () => {
									if (config)
										void s.data.liveAudio
											.setConfig({
												modulation: config.modulation,
												bandwidth: config.bandwidth,
											})
											.catch(() => undefined)
									void s.tuning.tune(before)
								},
							}
						: {}),
				})
			}
			case "discovery": {
				const d = s.data.scanner.discovery(action.id)
				if (!d) return { text: "That discovery is gone", tone: "warn" }
				return ok(await tune(s, d.frequencyHz, discoveryMode(d)))
			}
			case "audio":
				return ok(await setAudio(s, action.patch))
			case "gain": {
				const id = sourceId(s)
				const tuner = s.data.tuner.state()
				if (id === null || !tuner) return { text: "No receiver", tone: "warn" }
				const wasAuto = tuner.gainMode === "agc"
				const was = tuner.gain
				const ok1 =
					action.tenthsDb === "auto"
						? await s.data.receiver.write(id, { key: "gainMode", value: "agc" })
						: await s.data.receiver.setManualGain(id, action.tenthsDb)
				if (!ok1) return { text: "The receiver refused the gain", tone: "warn" }
				return ok({
					text: null,
					undo: () =>
						void (wasAuto
							? s.data.receiver.write(id, { key: "gainMode", value: "agc" })
							: s.data.receiver.setManualGain(id, was)),
				})
			}
			case "rate": {
				const id = sourceId(s)
				if (id === null) return { text: "No receiver", tone: "warn" }
				const okRate = await s.data.receiver.write(id, {
					key: "sampleRate",
					value: action.hz,
				})
				return okRate
					? { text: done }
					: { text: "The receiver refused the sample rate", tone: "warn" }
			}
			case "biasTee":
			case "rtlAgc": {
				const id = sourceId(s)
				if (id === null) return { text: "No receiver", tone: "warn" }
				const key = action.kind === "biasTee" ? "biasTee" : "agcMode"
				const okSw = await s.data.receiver.write(id, { key, value: action.on })
				if (!okSw) return { text: "The receiver refused it", tone: "warn" }
				return ok({
					text: null,
					undo: () =>
						void s.data.receiver.write(id, { key, value: !action.on }),
				})
			}
			case "theme": {
				const prev: ThemePrefs = themeStore.getState()
				themeStore.set(action.patch)
				return ok({ text: null, undo: () => themeStore.set(prev) })
			}
			case "step": {
				const prev = s.prefs.get().stepHz
				s.prefs.setStep(action.hz)
				return ok({ text: null, undo: () => s.prefs.setStep(prev) })
			}
			case "volume": {
				const prev = s.listen.get().volume
				s.listen.setVolume(action.value)
				return ok({ text: null, undo: () => s.listen.setVolume(prev) })
			}
			case "listen": {
				if (action.on) await s.listen.start()
				else await s.listen.stop()
				return ok({
					text: null,
					undo: () => void (action.on ? s.listen.stop() : s.listen.start()),
				})
			}
			case "identify": {
				const bw = s.data.liveAudio.get().status?.config.bandwidth
				await s.data.identify.start(action.hz, {
					...(bw !== undefined && bw > 0 ? { bandwidthHz: bw } : {}),
					...(action.protocols ? { protocols: [...action.protocols] } : {}),
				})
				return { text: done }
			}
			case "save": {
				const band = bandAt(s.data.bandplan.get().view, action.hz)
				const input = saveInput(
					{
						hz: action.hz,
						config: action.fromBand
							? null
							: (s.data.liveAudio.get().status?.config ?? null),
						bandMode: modulationOf(band?.band.mode),
					},
					action.name,
					action.group,
				)
				const created = await s.data.savedFrequencies.create(input)
				return ok({
					text: null,
					undo: () =>
						void s.data.savedFrequencies
							.remove(created.id)
							.catch(() => undefined),
				})
			}
			case "view":
				shellStore.setView(action.id)
				return { text: null }
			case "drawer":
				shellStore.openDrawer(action.id)
				return { text: null }
			case "activity":
				if (action.tokens.length === 0) {
					requestActivitySearchFocus()
				} else {
					s.activity.setSearch(action.tokens.map(activityToken), null)
				}
				shellStore.openDrawer("activity")
				return { text: null }
			case "scanPlan": {
				shellStore.openDrawer("scanner")
				openPlan()
				if (action.presetId !== null) {
					const preset = presetsFrom(
						s.data.scanPresets.get().view?.presets ?? null,
						s.data.scanner.get().bandplans,
					).find(p => p.id === action.presetId)
					if (preset)
						updateDraft(d =>
							presetOn(preset, d.ranges) ? d : togglePreset(d, preset),
						)
				}
				return { text: null }
			}
			case "scanJob": {
				const job = s.data.scanner.get().sweep
				if (!job) return { text: "No scan is running", tone: "warn" }
				if (action.op === "pause") await s.data.scanner.pauseJob(job.id)
				else if (action.op === "resume") await s.data.scanner.resumeJob(job.id)
				else await s.data.scanner.cancelJob(job.id)
				return { text: done }
			}
			case "setting": {
				const e = action.entry
				focusSetting(e.id)
				if (e.place.kind === "settings") shellStore.openDrawer("settings")
				else shellStore.openPanel(e.place.id)
				return { text: null }
			}
			case "copy":
				await navigator.clipboard.writeText(action.text)
				return { text: action.label }
			case "install":
				return (await promptInstall())
					? { text: "Installing WaveKit" }
					: { text: null }
		}
	} catch (error) {
		return { text: `Not done: ${errorMessage(error)}`, tone: "warn" }
	}
}

// ---- live preview

/** Applies a preview and returns what puts things back. */
export function applyPreview(
	s: Pick<AppServices, "prefs" | "listen">,
	p: Preview,
): () => void {
	switch (p.kind) {
		case "theme": {
			const prev = themeStore.getState()
			themeStore.set(p.patch)
			return () => themeStore.set(prev)
		}
		case "step": {
			const prev = s.prefs.get().stepHz
			s.prefs.setStep(p.hz)
			return () => s.prefs.setStep(prev)
		}
		case "volume": {
			const prev = s.listen.get().volume
			s.listen.setVolume(p.value)
			return () => s.listen.setVolume(prev)
		}
	}
}
