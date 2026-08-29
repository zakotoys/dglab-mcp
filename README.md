# @zakotoys/dglab-mcp

[![License: GPL-3.0-only](https://img.shields.io/badge/license-GPL--3.0--only-blue)](LICENSE)

**`dglab-mcp` is a zero-setup, local [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that lets desktop AI tools — Claude Desktop, Cursor, and any MCP client — monitor and control [DG-LAB](https://www.dungeon-lab.com/) e-stim hardware through natural language, behind a hardcoded hardware safety layer.**

It translates MCP tool calls into the DG-LAB 4 **V4 WebSocket relay** protocol via [`dglab-kit`](https://github.com/dungeonlab-open/dglab-kit), so your AI agent can pair with the DG-LAB mobile app, read live device telemetry, adjust channel intensities, and play waveforms — while a safety controller enforces physical limits on every command before it ever reaches the hardware.

---

## ⚠️ Safety First — Read This

This software controls a device that delivers **real electrical stimulation to a real human body**. LLM agents are not trustworthy operators: they hallucinate, misread units, and act on stale context. `dglab-mcp` exists to make that safe, but you must do your part:

- **The default intensity cap is 30/200 (15%).** Agents cannot raise a channel above `DGLAB_MAX_INTENSITY`, no matter what they claim or intend.
- **Steps are rate-limited** (`DGLAB_MAX_STEP`, default 5 per command). Large jumps are rejected, not clamped.
- **A watchdog is always armed while output is active.** If the client goes silent for `DGLAB_HEARTBEAT_TIMEOUT_MS` (default 20 s), every channel on every device is dropped to zero automatically.
- **Emergency stop is always available** (`dglab_emergency_stop`) and bypasses all queues. Keep it in mind — and keep the physical device within arm's reach regardless.
- **Consent and supervision.** Only use this with the informed consent of the person connected to the hardware, and with a human present who can stop output independently of any software.

## Project Overview

`dglab-mcp` acts as a local security bridge between desktop AI tools and DG-LAB hardware:

- **Agent-Enabled Control** — LLMs interact with DG-LAB devices based on natural language, interactive games, or external triggers.
- **Safety Abstraction Layer** — Hardcoded physical safety limits (ceiling caps, step-rate limiters, heartbeat stops) are enforced before commands reach the hardware.
- **Protocol Translation** — Standardized MCP tool calls (JSON-RPC over stdio) become low-level DG-LAB pulse sequences and WebSocket relay payloads.

## Requirements

- **Node.js 22+**
- The **DG-LAB 4 mobile app** (iOS/Android) with your Coyote V2/V3 paired over Bluetooth. The phone acts as the bridge; your computer never needs Bluetooth.
- An MCP client (Claude Desktop, Cursor, Claude Code, Inspector, …)

## Quick Start

### Claude Desktop

Add to your Claude Desktop config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "dglab": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@zakotoys/dglab-mcp@latest"]
    }
  }
}
```

On macOS or Linux, use this form instead:

```json
{
  "mcpServers": {
    "dglab": {
      "command": "npx",
      "args": ["-y", "@zakotoys/dglab-mcp@latest"]
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "dglab": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@zakotoys/dglab-mcp@latest"]
    }
  }
}
```

On macOS or Linux:

```json
{
  "mcpServers": {
    "dglab": {
      "command": "npx",
      "args": ["-y", "@zakotoys/dglab-mcp@latest"]
    }
  }
}
```

### MCP Inspector

Explore and debug the server interactively:

```bash
npx @modelcontextprotocol/inspector -y @zakotoys/dglab-mcp@latest
```

Inspector opens a browser UI; connect over **stdio**, then call `dglab_connect` from the Tools tab to see the pairing QR code rendered inline.

## Pairing Workflow

1. The client (or you) calls **`dglab_connect`**. The server joins the DG-LAB 4 V4 relay, receives a target id, and returns a **PNG QR code** plus a `https://dungeon-lab.cn/s/...` session link.
2. Open the **DG-LAB 4 app**, choose scan/QR pairing, and scan the code (or open the link on the phone).
3. The app attaches to your session and immediately reports its devices. The server state becomes `paired`.
4. Call **`dglab_get_status`** to confirm battery, Bluetooth state, and channel intensities.
5. Set a modest intensity first (`dglab_set_intensity`, e.g. `target: 3`), then play waveforms (`dglab_play_waveform`).
6. Relay sessions idle out after ~5 minutes without a paired app; call `dglab_connect` again to reconnect. Fully finish with `dglab_disconnect` (it emergency-stops everything first).

Multiple apps and multiple devices may be attached at once. Tools that target a device accept optional `clientId`/`slotId`; if omitted, the target resolves **only when exactly one compatible Coyote remains** — otherwise the result lists candidates and sends nothing.

## Environment Reference

All variables are optional; defaults shown.

| Variable | Default | Meaning |
|---|---|---|
| `DGLAB_MAX_INTENSITY` | `30` | Absolute output ceiling (0–200 scale). Targets above the effective ceiling are **rejected**. |
| `DGLAB_MAX_STEP` | `5` | Maximum upward change per single command. Reductions of any size are always allowed. |
| `DGLAB_HEARTBEAT_TIMEOUT_MS` | `20000` | Control-lease length. Output auto-stops if no output command or `dglab_heartbeat` occurs within the window. |
| `DGLAB_MAX_WAVEFORM_DURATION_MS` | `10000` | Maximum length of any waveform playback (named, repeated, or custom-compiled). |
| `DGLAB_RELAY_URL` | `wss://trex.dungeon-lab.cn/v4` | V4 relay endpoint. Point at your own deployment if desired (`ws:`/`wss:`). |
| `DGLAB_PULSE_DIR` | `~/.dglab-mcp/pulses` | Directory scanned for external `.pulse` waveform files. Invalid values fail fast at startup. |

The **effective ceiling** for a channel is `min(DGLAB_MAX_INTENSITY, every numeric limit the app/device advertises)` — including the channel's `intensityMax` and the comfort limit's `comfortMax`/`absoluteMax`.

## Waveform Directory Format

Drop DG-LAB app exports (or any file in the official text format) into `DGLAB_PULSE_DIR`:

```
~/.dglab-mcp/pulses/
  waves.pulse
  my-favourite.pulse
```

- Only **direct regular `.pulse` files** are loaded (no subdirectories).
- Files are capped at **64 KiB**; the external catalog is capped at **100 files**.
- The directory is **rescanned on every list/play call** — new or changed files are picked up without restarting the server.
- Unreadable files are reported by `dglab_list_waveforms` and skipped; valid presets keep working.

Waveform names resolve case- and separator-insensitively across ids, English labels, and Chinese labels: `AIR_WAVES`, `air waves`, and `气泡` all find the same preset. Matching is exact — never fuzzy. If an external file's name collides with a preset, the ambiguity is reported rather than silently resolved.

## MCP Tools

| Tool | Contract |
|---|---|
| `dglab_connect` | Start or reuse the V4 relay session; return state, target id, app URL, session link, and PNG QR code. |
| `dglab_disconnect` | Emergency-stop all devices, then destroy the relay session and cached state. |
| `dglab_get_status` | Optionally refresh and filter telemetry; return relay, safety lease, clients, devices, channels, and active tasks. |
| `dglab_set_intensity` | Set one A/B channel to an integer target on the 0–200 scale after cap and step validation. |
| `dglab_adjust_intensity` | Apply a signed integer delta; positive deltas obey the step and ceiling guards. |
| `dglab_list_waveforms` | Rescan and return built-in/external waveform ids, labels, source, and natural duration. |
| `dglab_play_waveform` | Play a named waveform on a channel, optionally for a bounded `durationMs`; requires a current safe nonzero intensity. |
| `dglab_play_custom_waveform` | Validate, compile, and play semantic `ramp`/`hold`/`pulse`/`silence` segments on one channel. |
| `dglab_stop_channel` | Clear tasks and reset intensity for one channel. |
| `dglab_emergency_stop` | Immediately stop all channels and tasks across all paired clients and devices. |
| `dglab_heartbeat` | Renew an active control lease and return its new expiry; otherwise succeed as an idle no-op. |

Every tool returns structured JSON (`structuredContent`) plus a concise text summary. Failures use `isError: true` with stable codes: `NOT_CONNECTED`, `AMBIGUOUS_TARGET`, `DEVICE_NOT_READY`, `SAFETY_LIMIT`, `INVALID_WAVEFORM`, `RELAY_ERROR`.

Notes on semantics:

- V4 has **no absolute nonzero set** — nonzero targets are computed from telemetry (or the last locally-dispatched value, whichever is fresher) and sent as relative changes. Only reset-to-zero is absolute.
- Waveform playback uses **replacement semantics** and never changes intensity implicitly. A channel must already be at a safe nonzero intensity before anything will play.
- Long-running pulse tasks are tracked asynchronously: `dglab_get_status` reports each task as `running`, then `completed`, `replaced`, `cleared`, `cancelled`, or `failed`.

## Safety Model

1. **Startup validation** — configuration is parsed strictly; bad values abort the process.
2. **Ceiling** — targets above the effective ceiling are rejected, even when reducing from a higher value.
3. **Step guard** — any upward move larger than `DGLAB_MAX_STEP` is rejected. Downward moves, channel stops, zero resets, and emergency stop are never blocked.
4. **Telemetry gating** — nonzero output requires a connected, supported Coyote whose current intensity is known. Unsupported devices (e.g. Opossum) remain visible in telemetry and receive best-effort emergency clearing, but normal output tools reject them.
5. **Control lease** — every successful output command arms a global watchdog. Only further output commands or `dglab_heartbeat` renew it. On expiry the server clears all tasks and resets both channels on every attached device, records the trip reason, and allows the next explicit command to start fresh.
6. **Emergency stop** — bypasses all per-channel command queues, invalidates pending queued commands by generation, dispatches clears/resets concurrently, verifies the result once more after 500 ms, and cannot be undone by stale completions.

## Development

```bash
npm install
npm run ci          # typecheck + lint + coverage + build + pack dry-run
npm run build       # tsc → dist/ (bin executable on Unix)
npm test            # vitest (unit + integration + MCP)
npm run lint:fix    # biome autofix
```

## Automated npm releases

Releases are published by GitHub Actions from version tags. The workflow runs the
full CI suite, checks that the tag matches `package.json`, and publishes with npm
provenance through OpenID Connect (OIDC); no long-lived npm token is stored in
GitHub.

One-time setup:

1. If `@zakotoys/dglab-mcp` does not exist on npm yet, bootstrap the package once from a
   local terminal while logged in to the npm owner account:

   ```bash
   npm login
   npm publish --access public
   ```

   This is the only manual publish; the command runs the package's
   `prepublishOnly` checks first.
2. On npmjs.com, open the `@zakotoys/dglab-mcp` package settings and add a **Trusted
   Publisher** for **GitHub Actions**. Set owner to `zakotoys`, repository to
   `dglab-mcp`, and workflow filename to `publish.yml`.
3. Add the `zakotoys` npm team as a maintainer of `@zakotoys/dglab-mcp` in the package's
   **Access** settings. Team members then inherit publish and release access.
4. Ensure the GitHub repository's Actions are enabled and that the default
   branch is `main`.

To release a version from a clean checkout:

```bash
npm version patch   # or minor / major; updates package.json and package-lock.json
git push origin main --follow-tags
```

Pushing the generated `vX.Y.Z` tag starts the workflow. Monitor it under the
repository's **Actions** tab; a failed version check or CI run blocks publication.
The package is public, so users can install it with `npx -y @zakotoys/dglab-mcp@latest`.
The package is scoped to the `zakotoys` npm organization, so organization access
and Trusted Publishing are managed directly on `@zakotoys/dglab-mcp`.

The test suite includes a fake V4 relay and a fake DG-LAB app (`tests/helpers.ts`) that speak the real protocol, so pairing, telemetry, task lifecycles, safety cutoffs, and both in-memory and stdio MCP transports are exercised end to end without hardware.

### Manual Hardware Checklist

Before publishing a release, verify manually with **both a Coyote V2 and a Coyote V3**:

- [ ] QR pairing works from Inspector and from Claude Desktop/Cursor
- [ ] Battery and connection-state updates appear in `dglab_get_status`
- [ ] Independent A/B intensity control honors the configured ceiling and step limits
- [ ] Built-in presets play and can be replaced mid-playback
- [ ] A custom `ramp`/`hold`/`pulse` waveform compiles and plays
- [ ] A `.pulse` file dropped into `DGLAB_PULSE_DIR` appears in `dglab_list_waveforms` and plays without restart
- [ ] Rising above `DGLAB_MAX_INTENSITY` or taking steps above `DGLAB_MAX_STEP` is rejected with `SAFETY_LIMIT`
- [ ] Killing the client's output for > `DGLAB_HEARTBEAT_TIMEOUT_MS` trips the watchdog and zeroes both channels
- [ ] `dglab_emergency_stop` stops output instantly, even during playback
- [ ] Closing the MCP client shuts the server down gracefully (bounded emergency stop, clean exit)

## Assumptions & Scope

- V1 controls **Coyote V2/V3 through the DG-LAB 4 V4 relay only**. Legacy V3 relay, direct BLE, HTTP transport, GUI, raw frame exposure, and Opossum output control are intentionally excluded.
- Pairing sessions and task state are process-local and are **not persisted** across MCP server restarts.
- Publication uses the GitHub Actions workflow described in [Automated npm releases](#automated-npm-releases).

## License

[GPL-3.0-only](LICENSE)
