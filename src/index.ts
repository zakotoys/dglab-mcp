#!/usr/bin/env node
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type CliOptions, parseCliArgs } from "./cli.js";
import { type Config, loadConfig } from "./config.js";
import { log } from "./log.js";
import { syncPreset } from "./presets.js";
import { DglabService } from "./service.js";
import { registerTools } from "./tools.js";

const require = createRequire(import.meta.url);
const SERVER_VERSION = (require("../package.json") as { version: string }).version;
const SHUTDOWN_BUDGET_MS = 2000;

function loadConfigOrExit(): Config {
  try {
    return loadConfig();
  } catch (error) {
    process.stderr.write(`dglab-mcp: invalid configuration: ${(error as Error).message}\n`);
    process.exit(1);
  }
}

function loadCliOptionsOrExit(): CliOptions {
  try {
    return parseCliArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`dglab-mcp: invalid arguments: ${(error as Error).message}\n`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const options = loadCliOptionsOrExit();
  const config = loadConfigOrExit();

  if (options.presetSource !== undefined) {
    const result = await syncPreset(options.presetSource, config.pulseDir);
    log("preset synchronization complete", { ...result });
  }

  const service = new DglabService(config);
  const server = new McpServer({ name: "dglab-mcp", version: SERVER_VERSION });
  registerTools(server, service, config);

  let shuttingDown = false;
  const shutdown = async (reason: string, exitCode: number): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log(`shutting down (${reason})`);
    try {
      await Promise.race([
        service.emergencyStop("shutdown"),
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_BUDGET_MS).unref()),
      ]);
    } catch (error) {
      log("best-effort emergency stop during shutdown failed", { error: String(error) });
    }
    service.session.destroy(1000, "shutdown");
    try {
      await server.close();
    } catch {
      // Transport may already be gone when stdin EOF triggered the shutdown.
    }
    log("shutdown complete");
    process.exit(exitCode);
  };

  process.on("unhandledRejection", (reason) => {
    log("unhandled rejection", { reason: String(reason) });
  });
  process.on("uncaughtException", (error) => {
    log("uncaught exception; exiting", { error: error.stack ?? String(error) });
    process.exit(1);
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT", 0);
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM", 0);
  });

  const transport = new StdioServerTransport();
  transport.onclose = () => {
    void shutdown("stdin closed", 0);
  };
  await server.connect(transport);
  log(`dglab-mcp ${SERVER_VERSION} ready`, {
    relayUrl: config.relayUrl,
    maxIntensity: config.maxIntensity,
    maxStep: config.maxStep,
    heartbeatTimeoutMs: config.heartbeatTimeoutMs,
    maxWaveformDurationMs: config.maxWaveformDurationMs,
    pulseDir: config.pulseDir,
  });
}

main().catch((error) => {
  process.stderr.write(`dglab-mcp: fatal: ${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});
