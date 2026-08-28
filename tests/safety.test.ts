import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DglabError } from "../src/errors.js";
import { SafetyController, validateDelta, validateTarget } from "../src/safety.js";

describe("SafetyController lease", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts inactive", () => {
    const controller = new SafetyController(1000, () => {});
    expect(controller.lease()).toEqual({ active: false, expiresAt: null, remainingMs: null });
    expect(controller.lastTrip).toBeNull();
  });

  it("arms with the configured timeout and reports remaining time", () => {
    vi.setSystemTime(100_000);
    const controller = new SafetyController(20_000, () => {});
    const lease = controller.arm();
    expect(lease).toEqual({ active: true, expiresAt: 120_000, remainingMs: 20_000 });
    vi.advanceTimersByTime(10_000);
    expect(controller.lease().remainingMs).toBe(10_000);
  });

  it("renewal extends the expiry; renew with no lease returns null", () => {
    vi.setSystemTime(0);
    const controller = new SafetyController(10_000, () => {});
    expect(controller.renew()).toBeNull();
    controller.arm();
    vi.advanceTimersByTime(5_000);
    const renewed = controller.renew();
    expect(renewed?.expiresAt).toBe(15_000);
  });

  it("fires the cutoff exactly once at expiry and records the trip", async () => {
    vi.setSystemTime(0);
    const onExpire = vi.fn(async () => {});
    const controller = new SafetyController(1_000, onExpire);
    controller.arm();
    await vi.advanceTimersByTimeAsync(999);
    expect(onExpire).not.toHaveBeenCalled();
    expect(controller.lease().active).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(controller.lease()).toEqual({ active: false, expiresAt: null, remainingMs: null });
    expect(controller.lastTrip?.reason).toBe("heartbeat_timeout");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("does not fire after disarm", async () => {
    const onExpire = vi.fn();
    const controller = new SafetyController(1_000, onExpire);
    controller.arm();
    controller.disarm();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onExpire).not.toHaveBeenCalled();
    expect(controller.lease().active).toBe(false);
  });

  it("recovers: a trip does not block the next arm", async () => {
    const onExpire = vi.fn();
    const controller = new SafetyController(1_000, onExpire);
    controller.arm();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(controller.lastTrip).not.toBeNull();
    const lease = controller.arm();
    expect(lease.active).toBe(true);
  });

  it("markTripped records a manual safety event without arming", () => {
    const controller = new SafetyController(1_000, () => {});
    controller.markTripped("emergency_stop", 42);
    expect(controller.lastTrip).toEqual({ reason: "emergency_stop", at: 42 });
    expect(controller.lease().active).toBe(false);
  });
});

describe("validateTarget", () => {
  it("rejects targets above the effective ceiling", () => {
    expect(() => validateTarget(0, 31, 30, 5)).toThrowError(DglabError);
    try {
      validateTarget(0, 31, 30, 5);
    } catch (error) {
      expect((error as DglabError).code).toBe("SAFETY_LIMIT");
    }
  });

  it("rejects upward steps over the limit", () => {
    expect(() => validateTarget(0, 6, 30, 5)).toThrowError(/maximum step/);
    expect(() => validateTarget(10, 16, 30, 5)).toThrowError(DglabError);
  });

  it("permits steps within the limit and equal sets", () => {
    expect(() => validateTarget(0, 5, 30, 5)).not.toThrow();
    expect(() => validateTarget(10, 10, 30, 5)).not.toThrow();
  });

  it("always permits reductions and zero within the ceiling", () => {
    expect(() => validateTarget(200, 0, 30, 5)).not.toThrow();
    expect(() => validateTarget(150, 25, 30, 5)).not.toThrow();
  });

  it("rejects even reductions that would keep output above the ceiling", () => {
    // A device left above the cap must be stepped back under it, not held high.
    expect(() => validateTarget(150, 90, 30, 5)).toThrowError(/ceiling/);
  });

  it("permits a reduction that ends above an old-current unknown", () => {
    expect(() => validateTarget(null, 3, 30, 5)).not.toThrow();
  });
});

describe("validateDelta", () => {
  it("rejects positive deltas over the step limit", () => {
    expect(() => validateDelta(0, 6, 30, 5)).toThrowError(/maximum step/);
  });

  it("rejects positive deltas crossing the ceiling", () => {
    expect(() => validateDelta(28, 5, 30, 5)).toThrowError(/ceiling/);
  });

  it("permits small upward deltas and any reduction", () => {
    expect(() => validateDelta(10, 5, 30, 5)).not.toThrow();
    expect(() => validateDelta(40, -40, 30, 5)).not.toThrow();
    expect(() => validateDelta(0, 0, 30, 5)).not.toThrow();
  });
});
