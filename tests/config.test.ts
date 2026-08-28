import { describe, expect, it } from "vitest";
import { expandTilde, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies documented defaults", () => {
    const config = loadConfig({});
    expect(config).toEqual({
      maxIntensity: 30,
      maxStep: 5,
      heartbeatTimeoutMs: 20000,
      maxWaveformDurationMs: 10000,
      relayUrl: "wss://trex.dungeon-lab.cn/v4",
      pulseDir: expect.stringContaining(".dglab-mcp"),
    });
  });

  it("accepts valid overrides", () => {
    const config = loadConfig({
      DGLAB_MAX_INTENSITY: "100",
      DGLAB_MAX_STEP: "1",
      DGLAB_HEARTBEAT_TIMEOUT_MS: "5000",
      DGLAB_MAX_WAVEFORM_DURATION_MS: "30000",
      DGLAB_RELAY_URL: "ws://localhost:9999/v4/",
      DGLAB_PULSE_DIR: "/tmp/pulses",
    });
    expect(config.maxIntensity).toBe(100);
    expect(config.maxStep).toBe(1);
    expect(config.heartbeatTimeoutMs).toBe(5000);
    expect(config.maxWaveformDurationMs).toBe(30000);
    expect(config.relayUrl).toBe("ws://localhost:9999/v4");
    expect(config.pulseDir).toBe("/tmp/pulses");
  });

  it.each([
    ["DGLAB_MAX_INTENSITY", "abc"],
    ["DGLAB_MAX_INTENSITY", "3.5"],
    ["DGLAB_MAX_INTENSITY", "0"],
    ["DGLAB_MAX_INTENSITY", "201"],
    ["DGLAB_MAX_STEP", "0"],
    ["DGLAB_MAX_STEP", "-5"],
    ["DGLAB_HEARTBEAT_TIMEOUT_MS", "999"],
    ["DGLAB_HEARTBEAT_TIMEOUT_MS", "600001"],
    ["DGLAB_MAX_WAVEFORM_DURATION_MS", "50"],
    ["DGLAB_MAX_WAVEFORM_DURATION_MS", "30001"],
  ])("rejects %s=%s", (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(new RegExp(name));
  });

  it.each(["ftp://example.com", "not a url", "https://example.com"])(
    "rejects relay url %s",
    (value) => {
      expect(() => loadConfig({ DGLAB_RELAY_URL: value })).toThrow(/DGLAB_RELAY_URL/);
    },
  );

  it("expands ~ in the pulse directory", () => {
    const config = loadConfig({ DGLAB_PULSE_DIR: "~/my-pulses" });
    expect(config.pulseDir).not.toMatch(/^~/);
    expect(config.pulseDir).toContain("my-pulses");
  });

  it("expandTilde handles bare ~ and non-tilde paths", () => {
    expect(expandTilde("~")).not.toMatch(/^~/);
    expect(expandTilde("C:\\pulses")).toBe("C:\\pulses");
  });
});
