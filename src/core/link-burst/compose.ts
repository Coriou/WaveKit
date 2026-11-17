import type { Logger } from "../../utils/logger.js"
import { createBurstAbsorber } from "./absorber.js"
import { createIngestRecorder } from "./recorder.js"
import { createEventLoopMeter } from "./loop-meter.js"
import type { EventLoopMeter, LinkBurstFactories } from "./contract.js"
import { createCoreLoadSignal } from "../core-load.js"
import type { CoreLoadSignal } from "../core-load.js"

export function composeLinkBurst(deps: {
	log: Logger
	monoNow?: () => number
}): {
	factories: LinkBurstFactories
	loopMeter: EventLoopMeter
	/** THE core main-thread load signal, over this process's one loop meter. */
	coreLoad: CoreLoadSignal
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
		coreLoad: createCoreLoadSignal({ loopMeter }),
		dispose: () => loopMeter.dispose(),
	}
}
