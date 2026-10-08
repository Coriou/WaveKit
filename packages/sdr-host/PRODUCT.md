# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Static HTML, CSS and ES-module JavaScript served directly by the SDR-host Fastify
API. No build step, framework or external assets: the page must be cheap to serve
from a Raspberry Pi 3 and work with no internet access.

## Users

The person operating a WaveKit receiver: they set up and run the Raspberry Pi
that acquires RTL-SDR IQ and relays it to WaveKit on their computer. They check the
page on a phone beside the Pi (while plugging in a dongle, power supply or battery)
and in a laptop browser next to WaveKit, equally often.

## Product Purpose

A read-only operator page served by the Pi itself, reachable on the local network
without the computer's WaveKit core or a cloud account. It answers, at a glance,
whether IQ samples are really flowing from the dongle, and if not, why: the dongle,
power, receiver processes, host resources or the network. Success means the
operator no longer needs SSH to find out what is wrong.

## Positioning

It reports evidence, not presence. A USB device and running processes do not
prove sampling; only fresh upstream byte counts at the expected rate do. Stale,
missing and unmeasurable values are shown as such, never as healthy.

## Operating Context

- Pi acquires IQ via rtl_tcp and fans it out with rtlmux; WaveKit (Docker on the
  computer) does decoding. Zero downstream clients means delivery is idle, not
  that sampling stopped.
- Setup is an unattended first boot from a flashed SD card; progress may be in
  flight when the page is first opened.
- Pi 3 hardware is often under-powered; active undervoltage and dropped samples
  are the most common real faults. Wi-Fi is the usual link.

## Capabilities and Constraints

- Read-only. Reboot/shutdown controls are deliberately absent until
  authentication, authorization and origin/CSRF protections exist.
- Runs in a non-privileged container with host networking: some host facts are
  unavailable and must stay labelled unavailable rather than guessed.
- Host measurements and container measurements must be distinguished.
- Must not imply battery charge or power draw can be measured.

## Product Principles

1. Evidence over presence: claim sampling only from fresh upstream data.
2. Every value carries its freshness; stale and unavailable are first-class states.
3. Lead with the one answer (is IQ flowing?), then the reasons.
4. Diagnose without SSH, without becoming a generic metrics wall.
5. Cost the Pi almost nothing to serve and to poll.

## Accessibility & Inclusion

Readable in bright and dim light on a phone; state never conveyed by colour
alone; accessible names for live values; respects reduced motion.
