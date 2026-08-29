# @zakotoys/dglab-mcp

[![npm](https://img.shields.io/npm/v/%40zakotoys%2Fdglab-mcp?logo=npm&logoColor=white)](https://www.npmjs.com/package/@zakotoys/dglab-mcp)
[![CI](https://github.com/zakotoys/dglab-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/zakotoys/dglab-mcp/actions/workflows/ci.yml)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

[English](README.md) | **简体中文** | [日本語](README.ja-JP.md)

面向安全的 [Model Context Protocol](https://modelcontextprotocol.io) 服务，让
Claude Desktop、Cursor、OpenCode、Codex 或其他 MCP 客户端通过本地 stdio 进程，
经 DG-LAB 4 V4 WebSocket 中继控制 DG-LAB Coyote V2/V3 设备。

## 先阅读安全须知

本软件控制的设备会向人体施加真实电刺激。只应在获得明确知情同意、有人持续
监督，并且实体设备始终触手可及的情况下使用。

- 默认上限：`30/200`（`DGLAB_MAX_INTENSITY`），超过的目标会被拒绝。
- 默认步长：每次增加最多 `5`（`DGLAB_MAX_STEP`）。
- 看门狗：连续 20 秒没有指令或心跳时，所有输出自动归零。
- 紧急停止：`dglab_emergency_stop` 会清除所有设备和排队任务。

## 功能

- 通过标准 MCP 工具进行自然语言控制。
- 使用 DG-LAB 4 手机 App 扫码配对；电脑不需要蓝牙。
- 实时查看电量、连接状态、通道强度和任务状态。
- 支持内置预设、自定义波形和动态加载 `.pulse` 文件。
- 提供硬件安全上限、步长保护、遥测校验、通道队列和全局控制租约。

## 环境要求

- Node.js 22 或更高版本。
- iOS 或 Android 版 DG-LAB 4，且已通过蓝牙配对 Coyote V2 或 V3。
- Claude Desktop、Cursor、OpenCode、Codex、MCP Inspector 或其他 MCP 客户端。

## 快速开始

### Claude Desktop、Cursor、OpenCode 或 Codex

在客户端配置中使用下面的 MCP 服务命令。macOS 和 Linux：

```json
{
  "command": "npx",
  "args": ["-y", "@zakotoys/dglab-mcp@latest"]
}
```

Windows 客户端需要时使用 `cmd`：

```json
{
  "command": "cmd",
  "args": ["/c", "npx", "-y", "@zakotoys/dglab-mcp@latest"]
}
```

把上面的对象放入客户端的 MCP 服务映射中。示例：

**Claude Desktop**（`claude_desktop_config.json`）：

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

**Cursor**（`~/.cursor/mcp.json` 或 `.cursor/mcp.json`）：

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

**OpenCode**（`opencode.json`）：

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

**Codex**（`~/.codex/config.toml`）：

```toml
[mcp_servers.dglab]
command = "npx"
args = ["-y", "@zakotoys/dglab-mcp@latest"]
```

### MCP Inspector

```bash
npx @modelcontextprotocol/inspector -y @zakotoys/dglab-mcp@latest
```

选择 stdio 连接，然后调用 `dglab_connect` 查看配对二维码。

## 配对设备

1. 在 MCP 客户端调用 `dglab_connect`。
2. 使用 DG-LAB 4 App 扫描返回的二维码，或打开返回的会话链接。
3. 调用 `dglab_get_status`，确认 Coyote 已配对且遥测数据是最新的。
4. 从低强度开始，例如调用 `dglab_set_intensity` 设置 `target: 3`，再播放
   波形。结束时调用 `dglab_disconnect`，它会先停止输出。

可以同时连接多个 App 和设备。需要时传入 `clientId`、`slotId`；省略目标时，
只有在恰好存在一个兼容 Coyote 时才会执行操作。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `dglab_connect` | 创建或复用中继会话并返回二维码。 |
| `dglab_disconnect` | 停止所有输出并销毁会话。 |
| `dglab_get_status` | 查看中继、安全、设备、通道和任务状态。 |
| `dglab_set_intensity` | 通过安全校验后设置 A/B 通道目标值。 |
| `dglab_adjust_intensity` | 通过安全校验后按增量调整通道。 |
| `dglab_list_waveforms` | 列出内置和外部波形。 |
| `dglab_play_waveform` | 在限定时长内播放命名波形。 |
| `dglab_play_custom_waveform` | 编译并播放 ramp/hold/pulse/silence 片段。 |
| `dglab_stop_channel` | 停止任务并重置一个通道。 |
| `dglab_emergency_stop` | 立即停止所有通道和任务。 |
| `dglab_heartbeat` | 续期当前控制租约。 |

非零输出必须满足：Coyote 已配对、设备受支持，并且遥测数据已知。错误使用
`NOT_CONNECTED`、`AMBIGUOUS_TARGET`、`SAFETY_LIMIT`、`INVALID_WAVEFORM` 等稳定代码。

## 配置

所有变量都是可选的：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DGLAB_MAX_INTENSITY` | `30` | 0-200 强度刻度上的绝对上限。 |
| `DGLAB_MAX_STEP` | `5` | 每条指令允许增加的最大值。 |
| `DGLAB_HEARTBEAT_TIMEOUT_MS` | `20000` | 控制租约的看门狗超时时间。 |
| `DGLAB_MAX_WAVEFORM_DURATION_MS` | `10000` | 波形允许的最大时长。 |
| `DGLAB_RELAY_URL` | `wss://trex.dungeon-lab.cn/v4` | DG-LAB V4 中继地址。 |
| `DGLAB_PULSE_DIR` | `~/.dglab-mcp/pulses` | 外部 `.pulse` 文件目录。 |

通道实际可用上限取配置上限与 App/设备公布的全部限制中的最小值。

## 外部波形

将官方格式的 `.pulse` 文件直接放入 `DGLAB_PULSE_DIR`：

```text
~/.dglab-mcp/pulses/
  waves.pulse
  my-favourite.pulse
```

每次列出或播放波形时都会重新扫描目录。单文件上限为 64 KiB，目录最多加载
100 个文件。名称支持对大小写和分隔符不敏感的精确匹配，不进行模糊匹配。

## 开发

```bash
npm install
npm run ci          # 类型检查、Lint、覆盖率、构建和打包检查
npm run build       # 编译 dist/ 并设置 CLI 可执行权限
npm test
npm run lint:fix
```

测试使用模拟的 V4 中继和 DG-LAB App，不需要真实硬件。

## 发布版本

GitHub Actions 会在匹配的 `vX.Y.Z` tag 上，通过 npm Trusted Publishing 和
provenance 发布，然后创建 GitHub Release 并自动生成 changelog。重复运行
workflow 时，已有的 Release 会保持不变。npm 包的 Trusted Publisher 配置如下：

- Provider：GitHub Actions
- Organization/user：`zakotoys`
- Repository：`dglab-mcp`
- Workflow filename：`publish.yml`
- Environment：留空
- Allowed action：`npm publish`

如果 scoped 包尚未存在，先在已登录 npm 组织的本地终端执行一次：

```bash
npm login
npm publish --access public
```

之后从干净工作区发布新版本：

```bash
npm version patch   # 或 minor / major
git push origin main --follow-tags
```

Workflow 会执行完整 CI，只有 tag 与 `package.json` 版本一致时才会发布。

## 项目范围

当前仅支持通过 DG-LAB 4 V4 中继控制 Coyote V2/V3。旧版 V3 中继、直接 BLE、
HTTP 传输、GUI、原始帧和 Opossum 输出控制不在范围内。

## 许可证

[GPL-3.0](LICENSE)
