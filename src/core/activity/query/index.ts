export {
	ActivityCursorGapError,
	ActivityCursorInvalidError,
	ActivityQueryBusyError,
	ActivityQueryClosedError,
	ActivityQueryError,
	ActivityQueryInvalidError,
	ActivityQueryTimeoutError,
	ActivityReaderFailedError,
	ActivitySnapshotResetError,
} from "./errors.js"
export type { ActivityCursorReason } from "./errors.js"
export {
	createActivityQueryService,
	defaultActivityQueryWorkerUrl,
	withActivityClient,
	DEFAULT_ACTIVITY_QUERY_LIMITS,
} from "./service.js"
export type {
	ActivityQueryLimits,
	ActivityQueryServiceOptions,
	ActivityStoreQueryHandle,
} from "./service.js"
export type { ReaderHostEvent } from "./reader-host.js"
export { DEFAULT_TRAILS_READ_LIMITS, readTrails } from "./trails.js"
export type { TrailsReadInput, TrailsReadLimits } from "./trails.js"
export {
	DEFAULT_AGGREGATES_READ_LIMITS,
	readBandMap,
	readTimeline,
} from "./aggregates.js"
export type {
	AggregatesReadLimits,
	BandMapReadInput,
	TimelineReadInput,
} from "./aggregates.js"
export { normaliseBandMapQuery, normaliseTimelineQuery } from "./validate.js"
