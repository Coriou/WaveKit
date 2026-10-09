import type { ViewId } from "../ui/actions.js"
import { decodersView } from "./decoders.js"
import { messagesView } from "./messages.js"
import { overviewView } from "./overview.js"
import { receiverView } from "./receiver.js"
import { systemView } from "./system.js"
import type { ViewModule } from "./types.js"

/** Every view the shell can show, keyed by id (spec §14). */
export const VIEWS: Record<ViewId, ViewModule> = {
	overview: overviewView,
	decoders: decodersView,
	messages: messagesView,
	receiver: receiverView,
	system: systemView,
}
