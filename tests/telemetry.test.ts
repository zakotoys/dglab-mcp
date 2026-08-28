import { describe, expect, it } from "vitest";
import { effectiveCeiling, normalizeDevice } from "../src/telemetry.js";

function coyoteInfo(overrides: Record<string, unknown> = {}) {
  return {
    slotId: "slot-1",
    name: "Coyote",
    type: "COYOTE_030",
    props: {
      power: 76,
      connectState: "connected",
      intensityA: 5,
      intensityB: 0,
      channelAStatus: 2,
      channelBStatus: 4,
      ...overrides,
    },
    slotState: {
      hasDevice: true,
      markLight: "green",
      channelA: {
        isMuted: false,
        warmUpScale: 1,
        intensityMax: 100,
        comfortLimit: { mode: "simple", comfortMax: 40, absoluteMax: 100, overheat: false },
      },
      channelB: { isMuted: true, intensityMax: 80 },
    },
  };
}

describe("normalizeDevice", () => {
  it("normalizes a full Coyote V3 snapshot", () => {
    const telemetry = normalizeDevice("app-1", coyoteInfo());
    expect(telemetry.clientId).toBe("app-1");
    expect(telemetry.slotId).toBe("slot-1");
    expect(telemetry.supported).toBe(true);
    expect(telemetry.connected).toBe(true);
    expect(telemetry.battery).toBe(76);
    expect(telemetry.channels.A).toMatchObject({
      intensity: 5,
      muted: false,
      intensityMax: 100,
      outputStatus: 2,
    });
    expect(telemetry.channels.A.comfortLimit).toMatchObject({ comfortMax: 40, absoluteMax: 100 });
    expect(telemetry.channels.B).toMatchObject({
      intensity: 0,
      muted: true,
      intensityMax: 80,
      outputStatus: 4,
    });
  });

  it("marks non-Coyote devices as unsupported", () => {
    expect(
      normalizeDevice("app-1", { slotId: "s", name: "Opossum", type: "OVC_1" }).supported,
    ).toBe(false);
    expect(
      normalizeDevice("app-1", { slotId: "s", name: "Coyote V2", type: "COYOTE_020" }).supported,
    ).toBe(true);
  });

  it("treats missing telemetry as unknown, not false", () => {
    const telemetry = normalizeDevice("app-1", { slotId: "s", name: "X", type: "COYOTE_020" });
    expect(telemetry.connected).toBeNull();
    expect(telemetry.battery).toBeNull();
    expect(telemetry.channels.A.intensity).toBeNull();
  });

  it("maps connectState disconnected to false", () => {
    expect(normalizeDevice("a", coyoteInfo({ connectState: "disconnected" })).connected).toBe(
      false,
    );
  });

  it("falls back to slotState.hasDevice when connectState is absent", () => {
    const info = coyoteInfo();
    delete (info.props as Record<string, unknown>).connectState;
    expect(normalizeDevice("a", info).connected).toBe(true);
  });

  it("merges a partial slots.patch onto a previous snapshot", () => {
    const first = normalizeDevice("a", coyoteInfo());
    const patched = normalizeDevice(
      "a",
      {
        slotId: "slot-1",
        name: "Coyote",
        type: "COYOTE_030",
        props: { intensityA: 9 },
        slotState: { channelB: { isMuted: false } },
      },
      first,
    );
    expect(patched.channels.A.intensity).toBe(9);
    expect(patched.channels.B.intensity).toBe(0);
    expect(patched.channels.B.muted).toBe(false);
    expect(patched.battery).toBe(76);
    expect(patched.channels.A.comfortLimit?.comfortMax).toBe(40);
  });
});

describe("effectiveCeiling", () => {
  it("is the minimum of the software cap and every advertised limit", () => {
    const telemetry = normalizeDevice("a", coyoteInfo());
    // Advertised: intensityMax 100, comfortMax 40, absoluteMax 100.
    expect(effectiveCeiling(30, telemetry, "A")).toBe(30);
    expect(effectiveCeiling(50, telemetry, "A")).toBe(40);
    expect(effectiveCeiling(200, telemetry, "B")).toBe(80);
  });

  it("falls back to the software cap when nothing is advertised", () => {
    const telemetry = normalizeDevice("a", { slotId: "s", name: "X", type: "COYOTE_020" });
    expect(effectiveCeiling(30, telemetry, "A")).toBe(30);
  });

  it("never returns less than zero", () => {
    const info = coyoteInfo();
    (info.slotState.channelA as Record<string, unknown>).intensityMax = 0;
    const telemetry = normalizeDevice("a", info);
    expect(effectiveCeiling(30, telemetry, "A")).toBe(0);
  });
});
