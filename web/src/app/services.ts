// Everything the islands share, built once per app: the data layer and the slice's controllers.
import type { DataLayer, DataLayerOptions } from "../data/index.ts"
import { createDataLayer } from "../data/index.ts"
import type { PreferencesState } from "../data/preferences-store.ts"
import type { ReadableStore } from "../data/store.ts"
import { ActivityController } from "../features/activity/controller.ts"
import { ListenController } from "../features/listen/controller.ts"
import { feedControllerFor } from "../features/receiver/feed.ts"
import { displayStore, type DisplayStore } from "../features/display.ts"
import { DecodersFeed } from "../features/tuned/decoders.ts"
import { TunedActivity } from "../features/tuned/feed.ts"
import { TuningPrefs } from "../features/tuner/prefs.ts"
import { TuningController } from "../features/tuning.ts"

export interface AppServices {
	data: DataLayer
	tuning: TuningController
	prefs: TuningPrefs
	listen: ListenController
	decoders: DecodersFeed
	/** The Activity drawer's search, open event, pinned searches and feed. */
	activity: ActivityController
	/** The tuned card's channel Activity (now and earlier). */
	tuned: TunedActivity
	start(): Promise<void>
	dispose(): void
}

/** Core's units and time format decide while it has operator data; else the device's choice applies. */
export function followDisplay(
	prefs: ReadableStore<PreferencesState>,
	store: DisplayStore = displayStore,
): () => void {
	const apply = (s: PreferencesState) =>
		store.setCore(s.available === true ? s.values : null)
	apply(prefs.get())
	return prefs.subscribe(apply)
}

export function createServices(options: DataLayerOptions = {}): AppServices {
	const data = createDataLayer(options)
	// before the first source rows, so every feed they carry is remembered whatever renders first
	feedControllerFor(data)
	const decoders = new DecodersFeed(data)
	const listen = new ListenController(data.liveAudio)
	const activity = new ActivityController(data)
	const tuned = new TunedActivity(data)
	const offDisplay = followDisplay(data.preferences)
	return {
		data,
		tuning: new TuningController(data),
		prefs: new TuningPrefs(),
		listen,
		decoders,
		activity,
		tuned,
		async start() {
			await Promise.all([data.start(), decoders.load()])
		},
		dispose() {
			offDisplay()
			listen.dispose()
			activity.dispose()
			tuned.dispose()
			decoders.dispose()
			data.dispose()
		},
	}
}
