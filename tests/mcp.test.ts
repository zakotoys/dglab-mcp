import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { DglabService } from "../src/service.js";
import { registerTools } from "../src/tools.js";
import { delay, FakeDglabApp, FakeV4Relay } from "./helpers.js";

const SERVER_ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const require = createRequire(import.meta.url);
const PACKAGE_VERSION = (require("../package.json") as { version: string }).version;

interface World {
  relay: FakeV4Relay;
  service: DglabService;
  app: FakeDglabApp;
  pulseDir: string;
  server: McpServer;
}

const worlds: World[] = [];

async function startLinkedWorld(): Promise<{ world: World; client: Client }> {
  const relay = new FakeV4Relay();
  const url = await relay.start();
  const pulseDir = await fs.mkdtemp(path.join(os.tmpdir(), "dglab-mcp-pulses-"));
  const config = loadConfig({
    DGLAB_RELAY_URL: url,
    DGLAB_PULSE_DIR: pulseDir,
  });
  const service = new DglabService(config);
  const server = new McpServer({ name: "dglab-mcp", version: PACKAGE_VERSION });
  registerTools(server, service, config);
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = await InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const app = new FakeDglabApp(relay, "unpaired", [
    { slotId: "slot-1", name: "Coyote V3", type: "COYOTE_030" },
  ]);
  const world: World = { relay, service, app, pulseDir, server };
  worlds.push(world);
  return { world, client };
}

/** Pair the fake app with the world's relay session via dglab_connect. */
async function pair(world: World, client: Client): Promise<void> {
  const connect = await client.callTool({ name: "dglab_connect", arguments: {} });
  const targetId = (connect.structuredContent as Record<string, unknown>).targetId as string;
  world.app.tid = targetId;
  await world.app.connect();
  await delay(80);
}

function textOf(result: { content: Array<Record<string, unknown>> }): string {
  return String(result.content[0]!.text);
}

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    world.app.close();
    await world.relay.stop();
    await fs.rm(world.pulseDir, { recursive: true, force: true });
  }
});

describe("MCP server over in-memory transport", () => {
  it("exposes all eleven tools with accurate annotations", async () => {
    const { client } = await startLinkedWorld();
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "dglab_adjust_intensity",
      "dglab_connect",
      "dglab_disconnect",
      "dglab_emergency_stop",
      "dglab_get_status",
      "dglab_heartbeat",
      "dglab_list_waveforms",
      "dglab_play_custom_waveform",
      "dglab_play_waveform",
      "dglab_set_intensity",
      "dglab_stop_channel",
    ]);
    const status = tools.find((tool) => tool.name === "dglab_get_status")!;
    expect(status.annotations?.readOnlyHint).toBe(true);
    const estop = tools.find((tool) => tool.name === "dglab_emergency_stop")!;
    expect(estop.annotations?.destructiveHint).toBe(true);
    expect(estop.annotations?.idempotentHint).toBe(true);
    const adjust = tools.find((tool) => tool.name === "dglab_adjust_intensity")!;
    expect(adjust.annotations?.idempotentHint).toBe(false);
  });

  it("dglab_connect returns pairing info and a PNG QR code, idempotently", async () => {
    const { client } = await startLinkedWorld();
    const result = await client.callTool({ name: "dglab_connect", arguments: {} });
    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.ok).toBe(true);
    expect(structured.state).toBe("waiting_for_peer");
    expect(String(structured.appSocketUrl)).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/v4\?tid=/);
    expect(String(structured.sessionLink)).toContain("dungeon-lab.cn");
    expect(result.content[0]?.type).toBe("image");
    const image = result.content.find((block) => block.type === "image") as Record<string, unknown>;
    expect(image.mimeType).toBe("image/png");
    const png = Buffer.from(image.data as string, "base64");
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(png.length).toBeGreaterThan(100);

    const again = await client.callTool({ name: "dglab_connect", arguments: {} });
    expect((again.structuredContent as Record<string, unknown>).targetId).toBe(structured.targetId);
  });

  it("carries a full pairing through MCP tool calls", async () => {
    const { world, client } = await startLinkedWorld();
    await pair(world, client);

    const status = await client.callTool({
      name: "dglab_get_status",
      arguments: { refresh: true },
    });
    const structured = status.structuredContent as Record<string, unknown>;
    expect(structured.ok).toBe(true);
    expect(structured.clients as unknown[]).toHaveLength(1);
    expect(textOf(status)).toMatch(/Relay paired/);

    await client.callTool({ name: "dglab_set_intensity", arguments: { channel: "A", target: 5 } });
    const play = await client.callTool({
      name: "dglab_play_waveform",
      arguments: { channel: "A", name: "bubble" },
    });
    expect((play.structuredContent as Record<string, unknown>).ok).toBe(true);
    expect(textOf(play)).toMatch(/playing on channel A/);

    const stop = await client.callTool({ name: "dglab_stop_channel", arguments: { channel: "A" } });
    expect((stop.structuredContent as Record<string, unknown>).runningTasksCleared).toBe(1);
  });

  it("returns stable error envelopes with isError before any session", async () => {
    const { client } = await startLinkedWorld();
    const result = await client.callTool({
      name: "dglab_set_intensity",
      arguments: { channel: "A", target: 100 },
    });
    expect(result.isError).toBe(true);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.ok).toBe(false);
    expect(structured.code).toBe("NOT_CONNECTED");
    expect(textOf(result)).toMatch(/^NOT_CONNECTED:/);
  });

  it("surfaces safety rejections with effective-ceiling details", async () => {
    const { world, client } = await startLinkedWorld();
    await pair(world, client);
    const result = await client.callTool({
      name: "dglab_set_intensity",
      arguments: { channel: "A", target: 100 },
    });
    expect(result.isError).toBe(true);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.code).toBe("SAFETY_LIMIT");
    expect(structured.ceiling).toBe(30);
  });

  it("dglab_play_custom_waveform compiles frequencyHz segments through the schema", async () => {
    const { world, client } = await startLinkedWorld();
    await pair(world, client);
    await client.callTool({ name: "dglab_set_intensity", arguments: { channel: "A", target: 5 } });
    const result = await client.callTool({
      name: "dglab_play_custom_waveform",
      arguments: {
        channel: "A",
        segments: [
          { type: "hold", intensity: 50, durationMs: 100, frequencyHz: 20 },
          { type: "silence", durationMs: 100 },
        ],
      },
    });
    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as Record<string, unknown>;
    // 200ms of segments -> two 100ms octets.
    expect(structured.octetCount).toBe(2);
    expect(structured.durationMs).toBe(200);
  });

  it("dglab_heartbeat works as an idle no-op", async () => {
    const { client } = await startLinkedWorld();
    const result = await client.callTool({ name: "dglab_heartbeat", arguments: {} });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toMatch(/nothing to renew/);
  });

  it("dglab_list_waveforms lists presets and file errors", async () => {
    const { world, client } = await startLinkedWorld();
    await fs.writeFile(path.join(world.pulseDir, "zwave.pulse"), "garbage", "utf8");
    const result = await client.callTool({ name: "dglab_list_waveforms", arguments: {} });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.ok).toBe(true);
    expect(structured.builtin as unknown[]).toHaveLength(24);
    expect(structured.errors as unknown[]).toHaveLength(1);
    expect(textOf(result)).toContain("zwave.pulse");
  });

  it("dglab_disconnect stops everything and tears down the session", async () => {
    const { world, client } = await startLinkedWorld();
    await pair(world, client);
    await client.callTool({ name: "dglab_set_intensity", arguments: { channel: "A", target: 5 } });
    const result = await client.callTool({ name: "dglab_disconnect", arguments: {} });
    expect((result.structuredContent as Record<string, unknown>).devices).toBe(1);
    expect(world.app.intensityOf("slot-1", "A")).toBe(0);
    const after = await client.callTool({ name: "dglab_get_status", arguments: {} });
    expect(
      ((after.structuredContent as Record<string, unknown>).session as Record<string, unknown>)
        .state,
    ).toBe("idle");
  });
});

describe("dglab-mcp stdio subprocess", () => {
  it("speaks clean JSON-RPC on stdout and exits 0 on stdin EOF", async () => {
    const relay = new FakeV4Relay();
    const url = await relay.start();
    const pulseDir = await fs.mkdtemp(path.join(os.tmpdir(), "dglab-stdio-pulses-"));
    try {
      const child = spawn(process.execPath, [SERVER_ENTRY], {
        env: { ...process.env, DGLAB_RELAY_URL: url, DGLAB_PULSE_DIR: pulseDir },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: string[] = [];
      const stderr: string[] = [];
      child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
      child.stderr.on("data", (chunk) => stderr.push(String(chunk)));

      const send = (message: Record<string, unknown>) => {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      };
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "raw-test", version: "0.0.1" },
        },
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      await delay(600);

      // Close stdin: the server must perform its bounded shutdown and exit 0.
      child.stdin.end();
      const code = await new Promise<number | null>((resolve) => {
        child.on("exit", (exitCode) => resolve(exitCode));
      });

      expect(code).toBe(0);
      const lines = stdout
        .join("")
        .split("\n")
        .filter((line) => line.trim() !== "");
      expect(lines.length).toBeGreaterThanOrEqual(2);
      const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      for (const frame of parsed) {
        expect(frame.jsonrpc).toBe("2.0");
      }
      const toolsResponse = parsed.find((frame) => frame.id === 2);
      const toolCount = Number(
        (toolsResponse as { result?: { tools?: unknown[] } })?.result?.tools?.length ?? 0,
      );
      expect(toolCount).toBe(11);
      expect(stderr.join("")).toContain("dglab-mcp");
    } finally {
      await relay.stop();
      await fs.rm(pulseDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("runs a full tool session through StdioClientTransport", async () => {
    const relay = new FakeV4Relay();
    const url = await relay.start();
    const pulseDir = await fs.mkdtemp(path.join(os.tmpdir(), "dglab-stdio2-pulses-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_ENTRY],
      env: { ...process.env, DGLAB_RELAY_URL: url, DGLAB_PULSE_DIR: pulseDir },
    });
    const client = new Client({ name: "stdio-test", version: "0.0.1" });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.length).toBe(11);

      const connect = await client.callTool({ name: "dglab_connect", arguments: {} });
      expect((connect.structuredContent as Record<string, unknown>).ok).toBe(true);
      const image = connect.content.find((block) => block.type === "image");
      expect(image).toBeDefined();

      const app = new FakeDglabApp(
        relay,
        (connect.structuredContent as Record<string, unknown>).targetId as string,
        [{ slotId: "slot-1", name: "Coyote V3", type: "COYOTE_030" }],
      );
      await app.connect();
      await delay(80);

      const status = await client.callTool({ name: "dglab_get_status", arguments: {} });
      expect((status.structuredContent as Record<string, unknown>).clients).toHaveLength(1);

      const estop = await client.callTool({ name: "dglab_emergency_stop", arguments: {} });
      expect((estop.structuredContent as Record<string, unknown>).devices).toBe(1);
      app.close();
    } finally {
      await client.close();
      await relay.stop();
      await fs.rm(pulseDir, { recursive: true, force: true });
    }
  }, 30_000);
});
