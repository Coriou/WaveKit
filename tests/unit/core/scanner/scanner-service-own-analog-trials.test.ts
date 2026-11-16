/**
 * The class by speech reads only the channel's own analog trials (recording-verdict.ts
 * trialsVoiceChannel through VoicePrior.ownAnalogTrials), through the real ScannerService: the
 * prior the service hands its WidebandAnalogRecorder (deps.voicePrior, as built in the service's
 * constructor) over its real DiscoveryStore and TrialMemory. A full recorder file through the
 * service would need a live spectrum engine path (tracks, a ring, strong speech audio) the
 * service harness has no fake for; the recorder side of the same prior (classBySpeech with own
 * against partner trials) is covered in wideband-analog-recorder-speech-class.test.ts. Only the
 * co-channel link itself is stubbed: the store's voicePrior answer is the real one with a
 * partner named (a co-channel split needs a digital identity on both records).
 */
import { rm } from "node:fs/promises"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { VoicePrior } from "../../../../src/core/scanner/channel/recording-verdict.js"
import {
	VOICE_CHANNEL_MIN_HEARD,
	trialsVoiceChannel,
} from "../../../../src/core/scanner/channel/recording-verdict.js"
import type { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { TrialMemory } from "../../../../src/core/scanner/trial-memory.js"
import { makeObs } from "../../../mocks/scanner/observations.js"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"

interface Internal {
	store: DiscoveryStore
	trialMemory: TrialMemory
	widebandAnalog: {
		deps: { voicePrior?: (discoveryId: string) => VoicePrior | null }
	}
}

const harnesses: ReturnType<typeof serviceHarness>[] = []

afterEach(async () => {
	vi.restoreAllMocks()
	for (const h of harnesses.splice(0)) {
		await h.service.stop()
		await rm(h.dir, { recursive: true, force: true })
	}
})

async function boot(): Promise<{
	internal: Internal
	owner: string
	partner: string
}> {
	const h = serviceHarness({ patch: s => void (s.passive.enabled = false) })
	harnesses.push(h)
	await h.service.start()
	const internal = h.service as unknown as Internal
	const t0 = Date.now()
	const owner = internal.store.ingest(
		makeObs({ id: "o_owner", centreHz: 446_000_000, startedAt: t0 }),
	).discoveryId
	const partner = internal.store.ingest(
		makeObs({ id: "o_partner", centreHz: 430_000_000, startedAt: t0 }),
	).discoveryId
	if (owner === null || partner === null) throw new Error("no test discovery")
	expect(owner).not.toBe(partner)
	const real = internal.store.voicePrior.bind(internal.store)
	vi.spyOn(internal.store, "voicePrior").mockImplementation(id => {
		const prior = real(id)
		return prior === undefined || id !== owner
			? prior
			: { ...prior, partnerIds: [partner] }
	})
	return { internal, owner, partner }
}

/** `n` analog FM replay trials of `discoveryId` that heard voice. */
function heard(internal: Internal, discoveryId: string, n: number): void {
	for (let i = 0; i < n; i++)
		expect(
			internal.trialMemory.record(
				discoveryId,
				"analog-fm",
				"analog-demod",
				"heard",
			),
		).toBe(true)
}

describe("ScannerService: the class by speech reads the channel's own analog trials", () => {
	it(`own trials (${VOICE_CHANNEL_MIN_HEARD} heard of ${VOICE_CHANNEL_MIN_HEARD}) enable the class; the prior names the partner`, async () => {
		const { internal, owner, partner } = await boot()
		heard(internal, owner, VOICE_CHANNEL_MIN_HEARD)
		const prior = internal.widebandAnalog.deps.voicePrior!(owner)
		expect(prior?.partnerIds).toEqual([partner])
		expect(prior?.ownAnalogTrials?.()).toMatchObject({
			attempts: VOICE_CHANNEL_MIN_HEARD,
			decoded: VOICE_CHANNEL_MIN_HEARD,
		})
		expect(trialsVoiceChannel(prior)).toBe(true)
	})

	it("a partner's trials alone do not enable it, though the owner-and-partner reader counts them", async () => {
		const { internal, owner, partner } = await boot()
		// The owner's 20 trials heard nothing; the partner's 10 all heard.
		for (let i = 0; i < 20; i++)
			expect(
				internal.trialMemory.record(
					owner,
					"analog-fm",
					"analog-demod",
					"no-sync",
				),
			).toBe(true)
		heard(internal, partner, VOICE_CHANNEL_MIN_HEARD)
		const prior = internal.widebandAnalog.deps.voicePrior!(owner)
		expect(prior?.partnerIds).toEqual([partner])
		// The no-voice check's reader (VoicePrior.analogTrials) adds the partner's heard trials:
		// 10 of 20 (50 %) would clear the speech class's 10 heard and 30 % if it were read...
		expect(prior?.analogTrials?.()).toEqual({ attempts: 20, decoded: 10 })
		// ...but the owner-only reader has 0 of 20, so the class by speech stays off.
		expect(prior?.ownAnalogTrials?.()).toEqual({ attempts: 20, decoded: 0 })
		expect(trialsVoiceChannel(prior)).toBe(false)
	})

	it(`one heard own trial short (${VOICE_CHANNEL_MIN_HEARD - 1}) with the partner's ${VOICE_CHANNEL_MIN_HEARD} still does not enable it`, async () => {
		const { internal, owner, partner } = await boot()
		heard(internal, owner, VOICE_CHANNEL_MIN_HEARD - 1)
		heard(internal, partner, VOICE_CHANNEL_MIN_HEARD)
		const prior = internal.widebandAnalog.deps.voicePrior!(owner)
		expect(trialsVoiceChannel(prior)).toBe(false)
		heard(internal, owner, 1)
		expect(
			trialsVoiceChannel(internal.widebandAnalog.deps.voicePrior!(owner)),
		).toBe(true)
	})
})
