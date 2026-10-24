# WaveKit documentation

Plain Markdown, written to be read on GitHub by people and by coding agents. Start at the top.

## Use WaveKit

| Page                                                                                    | What it covers                                                             |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [Using the web app](WEB-APP.md)                                                         | Spectrum, listening, Activity, Scanner, Map, Messages, Settings, shortcuts |
| [Docker runtime](DOCKER-RUNTIME.md)                                                     | Run the core with Docker, with a Raspberry Pi or a USB dongle              |
| [SDR host setup](SDR-HOST-SETUP.md) and [fresh-card Pi](../packages/sdr-host/README.md) | Prepare a Raspberry Pi as the receiver                                     |
| [Native development](LOCAL-SETUP.md)                                                    | Run the core without Docker                                                |
| [CLI dashboard](CLI.md)                                                                 | The terminal dashboard                                                     |
| [ADS-B](ADSB.md), [digital voice](DIGITAL-VOICE.md), [scanner](SCANNER.md)              | Feature guides                                                             |
| [Security](SECURITY.md)                                                                 | Access, pairing, version pinning                                           |

## Reference

| Page                                | What it covers                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| [API](API.md)                       | REST and WebSocket contract                                                     |
| [Core reference](CORE-REFERENCE.md) | Tuner control, RTL-TCP relay, live audio, configuration, RTL-SDR, Docker images |
| [Docker setup](DOCKER-SETUP.md)     | Compose profiles and image builds                                               |

## Build on WaveKit

| Page                                 | What it covers                                        |
| ------------------------------------ | ----------------------------------------------------- |
| [Contributing](../CONTRIBUTING.md)   | Setup, checks, and keeping docs in step with the code |
| [Architecture](ARCHITECTURE.md)      | How the core is put together                          |
| [Adding a decoder](DECODER-GUIDE.md) | Decoder adapters                                      |
| [Performance rules](PERFORMANCE.md)  | Hot-path rules for IQ, DSP and audio                  |
| [Web app design](web/DESIGN.md)      | The web app's design system and decisions             |
| [Roadmap](ROADMAP.md)                | Reliability and portable receiver roadmap             |

## Engineering notes

Working material for the people building WaveKit. Dated and not kept current.

- [`specs/`](specs/README.md): feature specs (requirements, design, tasks).
- [`engineering/`](engineering/): measurements and investigations.
- `RESEARCH-*`, `CAPACITY-*`, `REVIEW-*` in this folder, and [decoder status](DECODER_STATUS.md):
  dated studies.
- [`web/CORE-GAPS.md`](web/CORE-GAPS.md): what the web app needs from the core.
- [`CLI-COORDINATION.md`](CLI-COORDINATION.md): requests between the core and the front ends.
- [`superpowers/`](superpowers/): earlier designs and plans, frozen.

## Keeping these pages true

When you change what users see, update the page that describes it in the same commit.
[`doc-map.json`](doc-map.json) says which page covers which code, and
`node scripts/check-docs.mjs` checks links and flags code that changed without its page. Details
in [Contributing](../CONTRIBUTING.md#documentation).
