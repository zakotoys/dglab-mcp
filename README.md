# @zakotoys/dglab-mcp

[![npm](https://img.shields.io/npm/v/%40zakotoys%2Fdglab-mcp?logo=npm&logoColor=white)](https://www.npmjs.com/package/@zakotoys/dglab-mcp)
[![CI](https://github.com/zakotoys/dglab-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/zakotoys/dglab-mcp/actions/workflows/ci.yml)
[![License: GPL-3.0-only](https://img.shields.io/badge/license-GPL--3.0-only-blue)](LICENSE)

**English** | [简体中文](README.zh-CN.md) | [日本語](README.ja-JP.md)

Safety-first [Model Context Protocol](https://modelcontextprotocol.io) server for
DG-LAB Coyote V2/V3 hardware. It connects Claude Desktop, Cursor, OpenCode,
Codex, or any MCP client to the DG-LAB 4 V4 WebSocket relay through a local
stdio process.

## Safety first

This software controls a device that delivers real electrical stimulation to a
human body. Use it only with informed consent, active human supervision, and the
physical device within reach.

- Default ceiling: `30/200` (`DGLAB_MAX_INTENSITY`); higher targets are rejected.
- Default step limit: `5` (`DGLAB_MAX_STEP`) for each upward command.
- Watchdog: output is set to zero after 20 seconds without a command or heartbeat.
- Emergency stop: `dglab_emergency_stop` clears every device and queued task.

## Features

- Natural-language control through standard MCP tools.
- QR pairing with the DG-LAB 4 mobile app; no computer Bluetooth is required.
- Live battery, connection, channel, and task telemetry.
- Built-in presets, custom waveforms, and hot-loaded `.pulse` files.
- Hard safety caps, step guards, telemetry gating, per-channel queues, and a
  global control lease.

## Requirements

- Node.js 22 or newer.
- DG-LAB 4 on iOS or Android, with a Coyote V2 or V3 paired over Bluetooth.
- Claude Desktop, Cursor, OpenCode, Codex, MCP Inspector, or another MCP client.

## Quick start

### Claude Desktop, Cursor, OpenCode, or Codex

Use this MCP server command in the client's configuration:

```json
{
  "command": "npx",
  "args": ["-y", "@zakotoys/dglab-mcp@latest"]
}
```

For Windows clients that require it, use `cmd`:

```json
{
  "command": "cmd",
  "args": ["/c", "npx", "-y", "@zakotoys/dglab-mcp@latest"]
}
```

Embed the object above under the client's MCP server map. Examples:

**Claude Desktop** (`claude_desktop_config.json`):

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

**Cursor** (`~/.cursor/mcp.json` or `.cursor/mcp.json`):

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

**OpenCode** (`opencode.json`):

```json
{
  "mcp": {
    "dglab": {
      "type": "local",
      "command": ["npx", "-y", "@zakotoys/dglab-mcp@latest"]
    }
  }
}
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.dglab]
command = "npx"
args = ["-y", "@zakotoys/dglab-mcp@latest"]
```

### MCP Inspector

```bash
npx @modelcontextprotocol/inspector -y @zakotoys/dglab-mcp@latest
```

Connect over stdio, then call `dglab_connect` to display the pairing QR code.

## Pair a device

1. Call `dglab_connect` from your MCP client.
2. Scan the returned QR code with the DG-LAB 4 app, or open its session link.
3. Call `dglab_get_status` and confirm that the Coyote is paired and telemetry is
   current.
4. Start low, for example `dglab_set_intensity` with `target: 3`, then play a
   waveform. Call `dglab_disconnect` when finished; it stops output first.

Multiple apps and devices can be connected. Pass `clientId` and `slotId` when
needed; an omitted target is accepted only when exactly one compatible Coyote is
available.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `dglab_connect` | Start or reuse a relay session and return the QR code. |
| `dglab_disconnect` | Stop all output and destroy the session. |
| `dglab_get_status` | Read relay, safety, device, channel, and task state. |
| `dglab_set_intensity` | Set an A/B channel target after safety validation. |
| `dglab_adjust_intensity` | Apply a signed, safety-checked channel delta. |
| `dglab_list_waveforms` | List built-in and external waveforms. |
| `dglab_play_waveform` | Play a named waveform for a bounded duration. |
| `dglab_play_custom_waveform` | Compile and play ramp/hold/pulse/silence segments. |
| `dglab_stop_channel` | Stop tasks and reset one channel. |
| `dglab_emergency_stop` | Immediately stop every channel and task. |
| `dglab_heartbeat` | Renew the active control lease. |

Nonzero output requires a paired, supported Coyote with known telemetry. Errors
use stable codes such as `NOT_CONNECTED`, `AMBIGUOUS_TARGET`, `SAFETY_LIMIT`, and
`INVALID_WAVEFORM`.

## Configuration

All variables are optional:

| Variable | Default | Description |
| --- | --- | --- |
| `DGLAB_MAX_INTENSITY` | `30` | Absolute output ceiling on the 0-200 scale. |
| `DGLAB_MAX_STEP` | `5` | Maximum upward change per command. |
| `DGLAB_HEARTBEAT_TIMEOUT_MS` | `20000` | Watchdog timeout for the control lease. |
| `DGLAB_MAX_WAVEFORM_DURATION_MS` | `10000` | Maximum waveform duration. |
| `DGLAB_RELAY_URL` | `wss://trex.dungeon-lab.cn/v4` | DG-LAB V4 relay endpoint. |
| `DGLAB_PULSE_DIR` | `~/.dglab-mcp/pulses` | Directory for external `.pulse` files. |

The effective channel ceiling is the minimum of the configured limit and every
limit advertised by the app or device.

## External waveforms

Put official-format `.pulse` files directly in `DGLAB_PULSE_DIR`:

```text
~/.dglab-mcp/pulses/
  waves.pulse
  my-favourite.pulse
```

The directory is rescanned on every list/play call. Files are limited to 64 KiB,
and the catalog accepts at most 100 files. Names match built-in ids and labels
case- and separator-insensitively, but matching is exact rather than fuzzy.

## Development

```bash
npm install
npm run ci          # typecheck, lint, coverage, build, and pack check
npm run build       # compile dist/ and make the CLI executable
npm test
npm run lint:fix
```

The test suite uses a fake V4 relay and fake DG-LAB app, so it does not require
hardware.

## Releases

GitHub Actions publishes matching `vX.Y.Z` tags with npm Trusted Publishing and
provenance. Configure the npm package's Trusted Publisher as:

- Provider: GitHub Actions
- Organization/user: `zakotoys`
- Repository: `dglab-mcp`
- Workflow filename: `publish.yml`
- Environment: blank
- Allowed action: `npm publish`

For a new checkout, bootstrap the scoped public package once while logged in to
the npm organization:

```bash
npm login
npm publish --access public
```

Then release future versions from a clean checkout:

```bash
npm version patch   # or minor / major
git push origin main --follow-tags
```

The workflow runs the full CI suite and publishes only when the tag matches the
version in `package.json`.

## Scope

This project supports Coyote V2/V3 through the DG-LAB 4 V4 relay only. Legacy V3
relay, direct BLE, HTTP transport, GUI, raw frames, and Opossum output control
are outside the current scope.

## License

[GPL-3.0-only](LICENSE)
