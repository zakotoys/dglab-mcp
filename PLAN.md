# Build `dglab-mcp`

## Summary

Create a publish-ready, local TypeScript MCP server that connects desktop AI clients to Coyote V2/V3 hardware through the DG-LAB 4 V4 WebSocket relay. Use Node.js 22+, ESM, the current [`@modelcontextprotocol/server`](https://github.com/modelcontextprotocol/typescript-sdk) stdio API, [`dglab-kit`](https://github.com/dungeonlab-open/dglab-kit), and Zod.

The server will support multiple paired apps and devices, while automatically selecting the target when exactly one compatible Coyote is available.

## Implementation

- Build a session manager around one idempotent `DglabSocket` V4 connection. Track relay state, clients, device snapshots, incremental telemetry, task state, and pairing metadata.
- Generate the official app socket URL, session link, and a PNG QR code returned as MCP image content. Reconnect explicitly through `dglab_connect` after relay idle timeout.
- Normalize Coyote telemetry into battery, Bluetooth state, A/B intensity, channel condition, mute state, comfort limits, device ceiling, and bridge-started waveform tasks.
- Serialize intensity operations per device/channel. Resolve nonzero V4 "set" operations from current telemetry into relative increases or decreases because V4 only supports absolute reset-to-zero.
- Return physical commands promptly after dispatch. Track long-running pulse promises asynchronously by request ID so status can report completion, replacement, clearing, cancellation, or failure.
- Keep stdout exclusively for MCP JSON-RPC; diagnostics and safety events go to stderr. Handle stdin EOF, `SIGINT`, and `SIGTERM` with bounded best-effort emergency shutdown.

### Safety Controller

- Validate configuration strictly at startup:
  - `DGLAB_MAX_INTENSITY=30`
  - `DGLAB_MAX_STEP=5`
  - `DGLAB_HEARTBEAT_TIMEOUT_MS=20000`
  - `DGLAB_MAX_WAVEFORM_DURATION_MS=10000`
  - `DGLAB_RELAY_URL=wss://trex.dungeon-lab.cn/v4`
  - `DGLAB_PULSE_DIR=~/.dglab-mcp/pulses`
- Calculate the effective channel ceiling as the minimum of the software cap and every numeric limit advertised by the app/device.
- Reject, rather than silently clamp, upward steps over 5 or targets above the effective ceiling. Always permit reductions, channel stops, zero resets, and emergency stop.
- Require connected-device telemetry before any nonzero operation. Reject output if the device is absent, disconnected, ambiguous, unsupported, or its current intensity is unknown.
- Arm a global 20-second control lease whenever an output command succeeds. Only further output commands or `dglab_heartbeat` renew it; read-only tools do not.
- On lease expiry, clear every known task and reset both channels on every attached device. Record the trip reason in status; the next explicit output command may begin a fresh lease.
- Emergency stop bypasses normal command queues, invalidates pending command generations, dispatches clear/reset requests concurrently, and cannot be undone by stale completions.

### Waveform System

- Expose all Coyote presets from `dglab-kit`, indexed by enum key plus normalized English and Chinese labels. Name matching is case/separator-insensitive but not fuzzy; collisions return an ambiguity error.
- Rescan `DGLAB_PULSE_DIR` on every list or play request so added or changed `.pulse` files are available without restart.
- Parse `Dungeonlab+pulse:` files with `@dg-kit/waveforms`; accept only direct regular `.pulse` files, cap files at 64 KiB and the catalog at 100 files, and report invalid files without disabling valid presets.
- Compile custom `ramp`, `hold`, `pulse`, and `silence` segments on a 25 ms grid. Inputs use `frequencyHz` from 1-100 and `widthPercent` from 0-100.
- Group four semantic frames into each V3 100 ms octet, pad the final group with silence, and enforce the 10-second total-duration ceiling.
- Do not expose arbitrary hexadecimal or protocol-level frames in v1.
- Named playback may repeat or truncate a waveform to an optional requested duration. Playback uses replacement semantics on the selected channel and never changes channel intensity implicitly.

## MCP Interface

Every targetable tool accepts optional `clientId` and `slotId`. Omitted identifiers resolve only when exactly one compatible device remains; otherwise the result lists candidates without sending anything.

| Tool | Contract |
|---|---|
| `dglab_connect` | Start or reuse the V4 relay session; return state, target ID, app URL, session link, and PNG QR code. |
| `dglab_disconnect` | Emergency-stop all devices, then destroy the relay session and cached state. |
| `dglab_get_status` | Optionally refresh and filter telemetry; return relay, safety lease, clients, devices, channels, and active tasks. |
| `dglab_set_intensity` | Set one A/B channel to an integer target on the 0-200 scale after cap and step validation. |
| `dglab_adjust_intensity` | Apply a signed integer delta; positive deltas obey the step and ceiling guards. |
| `dglab_list_waveforms` | Rescan and return built-in/external waveform IDs, labels, source, and natural duration. |
| `dglab_play_waveform` | Play a named waveform on a channel, optionally for a bounded `durationMs`; require current nonzero safe intensity. |
| `dglab_play_custom_waveform` | Validate, compile, and play semantic waveform segments on one channel. |
| `dglab_stop_channel` | Clear tasks and reset intensity for one channel. |
| `dglab_emergency_stop` | Immediately stop all channels and tasks across all paired clients and devices. |
| `dglab_heartbeat` | Renew an active control lease and return its new expiry; otherwise succeed as an idle no-op. |

All tools return an object-shaped `structuredContent` result plus equivalent concise text for older clients. Failures use `isError: true` and stable codes such as `NOT_CONNECTED`, `AMBIGUOUS_TARGET`, `DEVICE_NOT_READY`, `SAFETY_LIMIT`, `INVALID_WAVEFORM`, and `RELAY_ERROR`. Add accurate MCP read-only, destructive, idempotent, and open-world annotations.

## Tests And Release

- Unit-test configuration bounds, target resolution, telemetry normalization, effective caps, jump rejection, downward operations, missing telemetry, per-channel serialization, and stale-command invalidation.
- Test the lease with fake timers: arm, renew, expire, global stop, status reporting, disarm at zero, and recovery through the next control command.
- Golden-test preset, `.pulse`, and semantic waveform conversion, including frequency encoding, padding, duration limits, malformed files, collisions, and live rescans.
- Exercise `dglab-kit` against a local fake V4 relay covering hello, pairing, snapshots, patches, device RPC responses, disconnects, and partial emergency-stop failures.
- Run MCP integration tests through linked in-memory transports and a compiled stdio subprocess. Verify tool schemas, structured/text results, error envelopes, QR PNG bytes, and clean stdout.
- Add TypeScript checks, Biome checks, Vitest coverage, build, and `npm pack --dry-run` to CI on Node.js 22.
- Package as scoped `@zakotoys/dglab-mcp` version `0.1.0` with a `dglab-mcp` executable, lockfile, shebang-preserving ESM build, `prepublishOnly` verification, and `GPL-3.0-only` licensing.
- Publish from GitHub Actions on matching `vX.Y.Z` tags with npm Trusted Publishing (OIDC) and provenance after the full CI suite passes.
- Expand the README with safety warnings, environment reference, pairing workflow, waveform directory format, Inspector usage, and platform-specific `npx -y @zakotoys/dglab-mcp@latest` configurations for Claude Desktop and Cursor.
- Complete a manual hardware checklist with both Coyote generations: QR pairing, battery/status updates, A/B control, presets, custom curves, hot-loaded files, enforced limits, watchdog cutoff, emergency stop, and graceful client shutdown.

## Assumptions

- V1 controls Coyote V2/V3 through the DG-LAB 4 V4 relay only.
- Legacy V3 relay, direct BLE, HTTP transport, GUI, raw frames, and Opossum output control are intentionally excluded.
- Other connected DG-LAB devices remain visible in telemetry and are included in best-effort emergency clearing, but normal output tools reject them.
- Pairing sessions and task state are process-local and are not persisted across MCP server restarts.
- npm credentials are kept out of GitHub; publication uses a configured npm Trusted Publisher for the `zakotoys/dglab-mcp` GitHub Actions workflow.
