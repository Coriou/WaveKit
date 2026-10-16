// Everything the islands share, built once per app: the data layer and the slice's controllers.
import type { DataLayer, DataLayerOptions } from "../data/index.ts"
import { createDataLayer } from "../data/index.ts"
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
	start(): Promise<void>
	dispose(): void
}

export function createServices(options: DataLayerOptions = {}): AppServices {
	const data = createDataLayer(options)
	const decoders = new DecodersFeed(data)
	const listen = new ListenController(data.liveAudio)
	return {
		data,
		tuning: new TuningController(data),
		prefs: new TuningPrefs(),
		listen,
		decoders,
		async start() {
			await Promise.all([data.start(), decoders.load()])
		},
		dispose() {
			listen.dispose()
			decoders.dispose()
			data.dispose()
		},
	}
}
