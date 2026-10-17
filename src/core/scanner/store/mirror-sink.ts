/**
 * WG11 req 3.5 (lane SC): the store's `mirror-removal` event. Records that leave the snapshot set
 * without appearing in a journal payload (`deleted` / `removedObservations`): observations trimmed
 * from a discovery's 256-entry window, and the observations of a removed discovery (the payload
 * names only the discovery). Emitted right after the `mutation` entry that caused them, before
 * its `change` events (and after a replayed entry); never for `restore`, which replaces the set.
 */
export interface StoreMirrorRemoval {
	discoveries: string[]
	observations: string[]
}
