#!/usr/bin/env node
/**
 * WaveKit CLI Entry Point
 *
 * Usage:
 *   wavekit                    # Open interactive dashboard
 *   wavekit --view output      # Show decoded output only
 *   wavekit --view backpressure # Show backpressure monitor
 *   wavekit --help             # Show help
 *
 * Environment:
 *   WAVEKIT_WS_URLS   - Comma-separated WebSocket URLs
 *   WAVEKIT_WS_URL    - Single WebSocket URL
 *   WAVEKIT_API_URL   - HTTP API URL (WS path derived from this)
 */

import { render } from "ink"
import React from "react"
import { App } from "./app.js"
import { parseArgs } from "./utils/args.js"

const args = parseArgs(process.argv.slice(2))

if (args.help) {
	console.log(`
WaveKit CLI Dashboard

Usage:
  wavekit                    Open interactive dashboard
  wavekit --view <view>      Open specific view (output|backpressure|decoders|sources|live-audio)
  wavekit --help             Show this help

Environment:
  WAVEKIT_WS_URLS   Comma-separated WebSocket URLs (default: ws://localhost:9000/ws)
  WAVEKIT_WS_URL    Single WebSocket URL
  WAVEKIT_API_URL   HTTP API URL (WebSocket path derived from this)

Views:
  dashboard     Overview with decoder health, source status, backpressure summary
  decoders      Detailed decoder list with stats
  output        Live decoded message feed
  backpressure  Full backpressure monitor
  sources       Source configuration and metrics
  live-audio    Live demodulation status and streaming info
`)
	process.exit(0)
}

render(React.createElement(App, { initialView: args.view }))
