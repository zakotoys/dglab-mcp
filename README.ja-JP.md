# @zakotoys/dglab-mcp

[![npm](https://img.shields.io/npm/v/%40zakotoys%2Fdglab-mcp?logo=npm&logoColor=white)](https://www.npmjs.com/package/@zakotoys/dglab-mcp)
[![CI](https://github.com/zakotoys/dglab-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/zakotoys/dglab-mcp/actions/workflows/ci.yml)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

[English](README.md) | [简体中文](README.zh-CN.md) | **日本語**

安全性を重視した [Model Context Protocol](https://modelcontextprotocol.io) サーバーです。
Claude Desktop、Cursor、OpenCode、Codex、その他の MCP クライアントから、ローカル stdio
プロセスを通じて DG-LAB 4 V4 WebSocket リレー経由で Coyote V2/V3 を操作できます。

## 最初に安全上の注意

本ソフトウェアは人体に実際の電気刺激を与える機器を操作します。明確な同意、
継続的な人による監督、そして手の届く場所にある実機がある場合に限り使用してください。

- 初期上限：`30/200`（`DGLAB_MAX_INTENSITY`）。超える目標値は拒否されます。
- 初期ステップ上限：上昇操作ごとに `5`（`DGLAB_MAX_STEP`）。
- ウォッチドッグ：20 秒間コマンドまたは heartbeat がなければ全出力をゼロにします。
- 緊急停止：`dglab_emergency_stop` が全デバイスとキュー内タスクを停止します。

## 機能

- 標準 MCP ツールによる自然言語操作。
- DG-LAB 4 モバイルアプリとの QR ペアリング。コンピューター側の Bluetooth は不要です。
- バッテリー、接続、チャンネル、タスクのリアルタイム telemetry。
- 内蔵プリセット、カスタム波形、動的に読み込む `.pulse` ファイル。
- ハードウェア上限、ステップ保護、telemetry 検証、チャンネルキュー、制御リース。

## 必要環境

- Node.js 22 以降。
- iOS または Android の DG-LAB 4 と、Bluetooth ペアリング済みの Coyote V2/V3。
- Claude Desktop、Cursor、OpenCode、Codex、MCP Inspector、または別の MCP クライアント。

## クイックスタート

### Claude Desktop、Cursor、OpenCode、または Codex

クライアントの設定で次の MCP サーバーコマンドを使用します。macOS と Linux：

```json
{
  "command": "npx",
  "args": ["-y", "@zakotoys/dglab-mcp@latest"]
}
```

対応するソースから `.pulse` ファイルをインストールするには、`--preset`（または `-p`）と
ソースを指定します。たとえば、GitHub tree を再帰的にインポートできます：

```json
{
  "command": "npx",
  "args": [
    "-y",
    "@zakotoys/dglab-mcp@latest",
    "--preset",
    "https://github.com/zakotoys/dglab-pulse-collect/tree/main/pulses/pulse-001"
  ]
}
```

既定では、ダウンロードした `.pulse` ファイルのいずれかが無効な場合、同期は失敗します。
`--skip-invalid-presets` を指定すると無効な波形を無視し、各ソースから有効なファイルだけを
インポートします。ダウンロード失敗、サイズ超過、その他のソースエラーは引き続き同期を失敗させます。

Windows クライアントで必要な場合は `cmd` を使用します：

```json
{
  "command": "cmd",
  "args": ["/c", "npx", "-y", "@zakotoys/dglab-mcp@latest"]
}
```

上のオブジェクトをクライアントの MCP サーバー一覧に入れます。例：

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

**Cursor**（`~/.cursor/mcp.json` または `.cursor/mcp.json`）：

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

stdio で接続し、`dglab_connect` を呼び出すとペアリング QR コードが表示されます。

## デバイスをペアリングする

1. MCP クライアントから `dglab_connect` を呼び出します。
2. DG-LAB 4 アプリで返された QR コードを読み取るか、セッションリンクを開きます。
3. `dglab_get_status` を呼び出し、Coyote がペアリング済みで telemetry が最新であることを確認します。
4. まず `target: 3` など低い値で `dglab_set_intensity` を呼び出し、その後に波形を再生します。
   終了時は `dglab_disconnect` を呼び出してください。先に出力を停止します。

複数のアプリやデバイスを同時に接続できます。必要に応じて `clientId` と `slotId` を指定してください。
省略した場合、互換性のある Coyote がちょうど 1 台のときだけ実行されます。

## MCP ツール

| ツール | 用途 |
| --- | --- |
| `dglab_connect` | リレーセッションを開始または再利用し、QR コードを返します。 |
| `dglab_disconnect` | 全出力を停止してセッションを破棄します。 |
| `dglab_get_status` | リレー、安全、デバイス、チャンネル、タスク状態を取得します。 |
| `dglab_set_intensity` | 安全検証後に A/B チャンネルの目標値を設定します。 |
| `dglab_adjust_intensity` | 安全検証後にチャンネルを差分調整します。 |
| `dglab_list_waveforms` | 内蔵および外部波形を一覧表示します。 |
| `dglab_play_waveform` | 名前付き波形を指定時間内で再生します。 |
| `dglab_play_custom_waveform` | ramp/hold/pulse/silence セグメントをコンパイルして再生します。 |
| `dglab_stop_channel` | 1 チャンネルのタスクを停止してリセットします。 |
| `dglab_emergency_stop` | 全チャンネルとタスクを直ちに停止します。 |
| `dglab_heartbeat` | 現在の制御リースを更新します。 |

ゼロ以外の出力には、ペアリング済みで対応済みの Coyote と既知の telemetry が必要です。
エラーには `NOT_CONNECTED`、`AMBIGUOUS_TARGET`、`SAFETY_LIMIT`、`INVALID_WAVEFORM` などの
安定したコードを使用します。

## 設定

すべての変数は省略可能です：

| 変数 | 初期値 | 説明 |
| --- | --- | --- |
| `DGLAB_MAX_INTENSITY` | `30` | 0-200 強度スケールの絶対上限。 |
| `DGLAB_MAX_STEP` | `5` | 1 回のコマンドで増加できる最大値。 |
| `DGLAB_HEARTBEAT_TIMEOUT_MS` | `20000` | 制御リースのウォッチドッグ時間。 |
| `DGLAB_MAX_WAVEFORM_DURATION_MS` | `10000` | 波形の最大再生時間。 |
| `DGLAB_RELAY_URL` | `wss://trex.dungeon-lab.cn/v4` | DG-LAB V4 リレーエンドポイント。 |
| `DGLAB_PULSE_DIR` | `~/.dglab-mcp/pulses` | 外部 `.pulse` ファイルのディレクトリ。 |

実際のチャンネル上限は、設定値とアプリ/デバイスが提示するすべての上限の最小値です。

## 外部波形

公式形式の `.pulse` ファイルを `DGLAB_PULSE_DIR` 以下に置きます：

```text
~/.dglab-mcp/pulses/
  waves.pulse
  favourites/
    my-favourite.pulse
```

一覧または再生を呼び出すたびに再帰的にスキャンします。1 ファイルは 64 KiB 以下、カタログは最大 100 ファイルです。
名前は大文字小文字と区切り文字を区別しない完全一致で、あいまい検索は行いません。

起動時に `--preset <source>...` または `-p <source>...` を指定すると、`npx skills` と同じソース形式を
使用できます。ローカルパス、GitHub/GitLab リポジトリまたは tree、GitHub の短縮形（`owner/repo`）、
直接の `.pulse` ダウンロード、HTTP(S) ディレクトリ一覧に対応します。GitHub と GitLab のリポジトリツリーは
各 API で走査され、通常の HTTP ディレクトリは同一オリジン内で再帰的にクロールされます。`.pulse` を含む
直接 git clone ソースにも対応します。アーカイブ URL は download ソースとして認識されますが展開されないため、直接の
`.pulse` URL を指定してください。複数のソースはコマンドラインの順序で順番に同期され、
`--preset`/`-p` を繰り返して追加できます。`DGLAB_PULSE_DIR` 内の `manifest.json` には、ソース、ローカルパス、
SHA-256 ハッシュが記録されます。次回以降はローカルファイルが manifest と一致すれば
ネットワークリクエストを行わず、欠落または変更された管理対象ファイルだけを再ダウンロード
します。診断は stderr にのみ出力されるため、stdout は MCP JSON-RPC 専用のままです。

## 開発

```bash
npm install
npm run ci          # 型チェック、lint、coverage、build、pack チェック
npm run build       # dist/ を生成し CLI を実行可能にする
npm test
npm run lint:fix
```

テストは偽の V4 リレーと DG-LAB アプリを使用するため、実機は必要ありません。

## リリース

GitHub Actions は一致する `vX.Y.Z` tag を npm Trusted Publishing と provenance 付きで公開し、
自動生成された changelog を含む GitHub Release も作成します。workflow を再実行した場合、
既存の Release は変更しません。npm パッケージの Trusted Publisher は次のように設定します：

- Provider：GitHub Actions
- Organization/user：`zakotoys`
- Repository：`dglab-mcp`
- Workflow filename：`publish.yml`
- Environment：空欄
- Allowed action：`npm publish`

scoped パッケージがまだ存在しない場合は、npm 組織にログインしたローカル端末で一度だけ実行します：

```bash
npm login
npm publish --access public
```

以降はクリーンなワークツリーから公開します：

```bash
npm version patch   # または minor / major
git push origin main --follow-tags
```

Workflow は完全な CI を実行し、tag と `package.json` のバージョンが一致した場合だけ公開します。

## 対応範囲

現在は DG-LAB 4 V4 リレー経由の Coyote V2/V3 のみをサポートします。旧 V3 リレー、直接 BLE、
HTTP 通信、GUI、生フレーム、Opossum の出力制御は対象外です。

## ライセンス

[GPL-3.0](LICENSE)
