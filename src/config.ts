import { homedir } from "node:os";
import path from "node:path";

export interface Config {
  /** Absolute upper power ceiling applied to every channel (0-200 scale). */
  maxIntensity: number;
  /** Hard limit on upward intensity change per single command. */
  maxStep: number;
  /** Control-lease length; output stops when no command renews it in time. */
  heartbeatTimeoutMs: number;
  /** Ceiling for any compiled or requested waveform playback length. */
  maxWaveformDurationMs: number;
  /** DG-LAB 4 V4 WebSocket relay endpoint. */
  relayUrl: string;
  /** Directory scanned for external `.pulse` waveform files. */
  pulseDir: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function readInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new ConfigError(`${name} must be an integer, got "${raw}"`);
  }
  if (value < min || value > max) {
    throw new ConfigError(`${name} must be between ${min} and ${max}, got ${value}`);
  }
  return value;
}

function readRelayUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.DGLAB_RELAY_URL;
  if (raw === undefined || raw === "") {
    return "wss://trex.dungeon-lab.cn/v4";
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError(`DGLAB_RELAY_URL must be a valid URL, got "${raw}"`);
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new ConfigError(
      `DGLAB_RELAY_URL must use the ws: or wss: scheme, got "${parsed.protocol}"`,
    );
  }
  return raw.replace(/\/+$/, "");
}

export function expandTilde(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const maxIntensity = readInt(env, "DGLAB_MAX_INTENSITY", 30, 1, 200);
  const maxStep = readInt(env, "DGLAB_MAX_STEP", 5, 1, 200);
  const heartbeatTimeoutMs = readInt(env, "DGLAB_HEARTBEAT_TIMEOUT_MS", 20000, 1000, 600000);
  const maxWaveformDurationMs = readInt(env, "DGLAB_MAX_WAVEFORM_DURATION_MS", 10000, 100, 30000);
  const relayUrl = readRelayUrl(env);
  const pulseDir =
    expandTilde(env.DGLAB_PULSE_DIR ?? "~/.dglab-mcp/pulses") || "~/.dglab-mcp/pulses";
  return { maxIntensity, maxStep, heartbeatTimeoutMs, maxWaveformDurationMs, relayUrl, pulseDir };
}
