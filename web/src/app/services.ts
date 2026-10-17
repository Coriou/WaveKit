// Everything the islands share, built once per app: the data layer and the slice's controllers.
import type { DataLayer, DataLayerOptions } from "../data/index.ts"
import { createDataLayer } from "../data/index.ts"
import { ActivityController } from "../features/activity/controller.ts"
import { ListenController } from "../features/listen/controller.ts"
import { DecodersFeed } from "../features/tuned/decoders.ts"
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
	start(): Promise<void>
	dispose(): void
}

export function createServices(options: DataLayerOptions = {}): AppServices {
	const data = createDataLayer(options)
	const decoders = new DecodersFeed(data)
	const listen = new ListenController(data.liveAudio)
	const activity = new ActivityController(data)
	return {
		data,
		tuning: new TuningController(data),
		prefs: new TuningPrefs(),
		listen,
		decoders,
		activity,
		async start() {
			await Promise.all([data.start(), decoders.load()])
		},
		dispose() {
			listen.dispose()
			activity.dispose()
			decoders.dispose()
			data.dispose()
		},
	}
}
