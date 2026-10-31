import { useEffect, useState } from "react"
import type { LiveAudioStatus, TunerState } from "@wavekit/api-types"

import { useServices } from "../app/context.ts"
import { tunedHz, useStore } from "../data/index.ts"
import type { TunerStoreState } from "../data/index.ts"
import { receiverSourceIdOf, shownSourceFor } from "./receiver/feed.ts"

const firstTuner = (s: TunerStoreState): TunerState | undefined => {
	const id = Object.keys(s.bySource)[0]
	return id === undefined ? undefined : s.bySource[id]
}

/** The tuner-controlled source's state (the first one). */
export function useTunerState(): TunerState | undefined {
	return useStore(useServices().data.tuner, firstTuner)
}

const firstTunerId = (s: TunerStoreState): string | null =>
	Object.keys(s.bySource)[0] ?? null

/**
 * The receiver the Receiver island and the palette act on: the source the plot shows, else the first tuner's
 * source, else the first source (receiverSourceIdOf; the P key reads the same through receiverSourceId).
 */
export function useReceiverSourceId(): string | null {
	const { data } = useServices()
	const shown = useStore(shownSourceFor(data))
	const firstTuner = useStore(data.tuner, firstTunerId)
	const firstSource = useStore(data.sources, s => s.sources[0]?.id ?? null)
	return receiverSourceIdOf(shown, firstTuner, firstSource)
}

export function useLiveStatus(): LiveAudioStatus | null {
	return useStore(useServices().data.liveAudio, s => s.status)
}

/** The tuned frequency to show: the target while a tune is in flight, else centre + offset. */
export function useTunedHz(): number | null {
	const target = useStore(useServices().tuning, s => s.targetHz)
	const tuner = useTunerState()
	const status = useLiveStatus()
	return target ?? tunedHz(tuner, status)
}

/** The settled tuned frequency (ignores in-flight targets). */
export function useSettledHz(): number | null {
	return tunedHz(useTunerState(), useLiveStatus())
}

/** Date.now(), refreshed every `ms` while `active`. */
export function useNow(active: boolean, ms = 250): number {
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		if (!active) return
		setNow(Date.now())
		const id = setInterval(() => setNow(Date.now()), ms)
		return () => clearInterval(id)
	}, [active, ms])
	return now
}
