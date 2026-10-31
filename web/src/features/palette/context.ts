// The palette's snapshot of the app (PaletteContext), read from the stores with hooks.
import { useEffect, useMemo } from "react"

import { useReadOnly, useServices } from "../../app/context.ts"
import { useStore } from "../../data/index.ts"
import { pwaState } from "../../pwa/pwa.ts"
import { useShell, useTheme } from "../../shell/hooks.ts"
import { browserStorage } from "../../shell/theme.ts"
import { useReceiverSourceId, useTunedHz } from "../hooks.ts"
import { receiverLock, sampleRateOptions } from "../receiver/controls.ts"
import { feedControllerFor, feedOf, restoreCentreHz } from "../receiver/feed.ts"
import { gainSteps } from "../receiver/gain.ts"
import { presetsFrom } from "../scanner/planner/plan.ts"
import { effectiveStep } from "../tuner/prefs.ts"
import type { FeedContext, PaletteContext, ReceiverContext } from "./model.ts"
import { RecentList } from "./rank.ts"

/** The page's recent list (per browser). */
export const recentList = new RecentList(browserStorage())

export function usePaletteContext(recentVersion: number): PaletteContext {
	const { data, prefs, listen } = useServices()
	const readOnly = useReadOnly()
	const tunedHz = useTunedHz()
	// the receiver commands act on the source the plot shows (one rule with the island and the P key)
	const sourceId = useReceiverSourceId()
	const tuner = useStore(data.tuner, s =>
		sourceId === null ? undefined : s.bySource[sourceId],
	)
	const status = useStore(data.liveAudio, s => s.status)
	const listening = useStore(listen, s => s.wanted)
	const volume = useStore(listen, s => s.volume)
	const chosenStepHz = useStore(prefs, s => s.stepHz)
	const bandplan = useStore(data.bandplan, s => s.view)
	const savedState = useStore(data.savedFrequencies)
	const byId = useStore(data.scanner, s => s.discoveries.byId)
	const bandplans = useStore(data.scanner, s => s.bandplans)
	const presetList = useStore(data.scanPresets, s => s.view?.presets ?? null)
	const sweep = useStore(data.scanner, s => s.sweep)
	const shell = useShell()
	const theme = useTheme()
	const source = useStore(data.sources, s =>
		sourceId === null ? undefined : s.sources.find(x => x.id === sourceId),
	)
	const caps = useStore(data.receiver, s =>
		sourceId === null ? null : (s.caps[sourceId]?.caps ?? null),
	)
	const relay = useStore(data.receiver, s => s.relay)
	const accessMode = useStore(data.access, s => s.access?.mode ?? null)
	const pwa = useStore(pwaState)
	const feedEntry = useStore(feedControllerFor(data), s =>
		source ? s.bySource[source.id] : undefined,
	)

	// scan presets and receiver capabilities, once
	useEffect(() => {
		void data.scanner.loadBandplans()
		void data.scanPresets.ensure()
		void data.receiver.loadRelay()
		if (sourceId !== null) void data.receiver.loadCaps(sourceId)
	}, [data, sourceId])

	const feed = useMemo((): FeedContext | null => {
		const f = feedOf(source, feedEntry)
		if (!source || f === null) return null
		return {
			sourceId: source.id,
			state: f.state,
			busy: (feedEntry?.pending ?? null) !== null,
			restoreHz: restoreCentreHz(f),
		}
	}, [source, feedEntry])

	const receiver = useMemo((): ReceiverContext | null => {
		if (!tuner) return null
		const paused = feed !== null && feed.state !== "live"
		const lock = receiverLock({ tuner, source, readOnly, relay, paused })
		return {
			gainAuto: tuner.gainMode === "agc",
			gainTenthsDb: tuner.gain,
			gainSteps: gainSteps(caps).valuesTenthsDb,
			sampleRateHz: tuner.sampleRate,
			rates: sampleRateOptions(caps, tuner.sampleRate),
			biasTee: tuner.biasTee,
			rtlAgc: tuner.agcMode,
			lockReason: lock.locked ? lock.reason : null,
		}
	}, [tuner, source, readOnly, relay, caps, feed])

	const discoveries = useMemo(() => [...byId.values()], [byId])
	const presets = useMemo(
		() => presetsFrom(presetList, bandplans),
		[presetList, bandplans],
	)
	const saved =
		savedState.status === "unavailable" ||
		(savedState.status === "idle" && savedState.items.length === 0)
			? null
			: savedState.items

	return useMemo(() => {
		const now = Date.now()
		return {
			tunedHz,
			config: status?.config ?? null,
			listening,
			volume,
			stepHz: effectiveStep(chosenStepHz, bandplan, tunedHz),
			chosenStepHz,
			receiver,
			readOnly,
			accessMode,
			theme,
			saved,
			bandplan,
			discoveries,
			presets,
			sweep,
			shell,
			recent: recentList.ids(now),
			boost: (id: string) => recentList.boost(id, now),
			pwa,
			feed,
		}
		// recentVersion: the list changed (a row ran)
	}, [
		tunedHz,
		status,
		listening,
		volume,
		chosenStepHz,
		bandplan,
		receiver,
		readOnly,
		accessMode,
		theme,
		saved,
		discoveries,
		presets,
		sweep,
		shell,
		recentVersion,
		pwa,
		feed,
	])
}
