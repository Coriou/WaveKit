/** WG11 lane IQ: capture service and replay queue (shapes in ./shapes.js: imported by the scanner, which hands them over with `setShapes`). */
export {
	captureBandwidthHz,
	createIqCaptureService,
	type IqCaptureConfig,
	type IqCaptureEngine,
	type IqCaptureService,
	type IqCaptureServiceCounters,
	type IqCaptureServiceOptions,
	type IqCaptureServiceState,
	type IqCaptureSourceAttach,
	type IqReplayDecoderType,
	type IqReplayShape,
	type IqReplayShapes,
} from "./service.js"
export {
	createIqReplayQueue,
	IQ_REPLAY_DEFER_RETRY_MS,
	IQ_REPLAY_QUEUE_HOLDER,
	type IqReplayProbeAnswer,
	type IqReplayProbeRequest,
	type IqReplayProbeRun,
	type IqReplayProbes,
	type IqReplayQueue,
	type IqReplayQueueCounters,
	type IqReplayQueueDeps,
	type IqReplayQueuePort,
} from "./replay-queue.js"
export { sweepCaptureDir, type SweepResult } from "./sweep.js"
