import type { Logger } from "../../utils/logger.js"
import { createBurstAbsorber } from "./absorber.js"
import { createIngestRecorder } from "./recorder.js"
import { createEventLoopMeter } from "./loop-meter.js"
import type { EventLoopMeter, LinkBurstFactories } from "./contract.js"

export function composeLinkBurst(deps: {
	log: Logger
	monoNow?: () => number
}): {
	factories: LinkBurstFactories
	loopMeter: EventLoopMeter
	dispose(): void
} {
	const monoNow = deps.monoNow ?? (() => performance.now())
	const loopMeter = createEventLoopMeter({ monoNow })
	return {
		factories: {
			monoNow,
			createRecorder: () => createIngestRecorder(),
			createAbsorber: (_id, absorberDeps) =>
				createBurstAbsorber({ ...absorberDeps, log: deps.log, monoNow }),
		},
		loopMeter,
		dispose: () => loopMeter.dispose(),
	}
}
