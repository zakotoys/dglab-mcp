import { safetyLimit } from "./errors.js";
import type { Channel, DeviceTelemetry } from "./telemetry.js";
import { effectiveCeiling } from "./telemetry.js";

export interface LeaseState {
  active: boolean;
  expiresAt: number | null;
  remainingMs: number | null;
}

export interface TripRecord {
  reason: string;
  at: number;
}

/**
 * Global control lease. Every successful output command arms or renews it;
 * expiry fires the emergency cutoff callback. Read-only tools never renew.
 */
export class SafetyController {
  private timer: NodeJS.Timeout | null = null;
  private expiresAt: number | null = null;
  private trip: TripRecord | null = null;

  constructor(
    private readonly timeoutMs: number,
    private readonly onExpire: () => void | Promise<void>,
  ) {}

  /** Arm a fresh lease or renew the active one. */
  arm(now: number = Date.now()): LeaseState {
    this.clearTimer();
    this.expiresAt = now + this.timeoutMs;
    this.timer = setTimeout(() => {
      void this.handleExpire();
    }, this.timeoutMs);
    // Never keep the process alive just for the lease timer.
    this.timer.unref?.();
    return this.lease(now);
  }

  /** Renew only when a lease is currently active; null means nothing to renew. */
  renew(now: number = Date.now()): LeaseState | null {
    if (this.expiresAt === null) {
      return null;
    }
    return this.arm(now);
  }

  /** Cancel the lease without recording a trip (e.g. clean disconnect). */
  disarm(): void {
    this.clearTimer();
    this.expiresAt = null;
  }

  /** Record a safety event without arming anything (e.g. manual emergency stop). */
  markTripped(reason: string, at: number = Date.now()): void {
    this.trip = { reason, at };
  }

  get lastTrip(): TripRecord | null {
    return this.trip;
  }

  lease(now: number = Date.now()): LeaseState {
    if (this.expiresAt === null) {
      return { active: false, expiresAt: null, remainingMs: null };
    }
    return {
      active: true,
      expiresAt: this.expiresAt,
      remainingMs: Math.max(0, this.expiresAt - now),
    };
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async handleExpire(): Promise<void> {
    this.clearTimer();
    this.expiresAt = null;
    this.trip = { reason: "heartbeat_timeout", at: Date.now() };
    try {
      await this.onExpire();
    } catch (error) {
      // The cutoff callback must never take the process down.
      console.error("[dglab-mcp] lease-expiry cutoff failed:", error);
    }
  }
}

/**
 * Validate an absolute target against the effective ceiling and the step
 * guard. Reductions, zero resets, and equal-value sets always pass.
 * `current === null` (unknown telemetry) must be rejected by the caller
 * before any nonzero target reaches here.
 */
export function validateTarget(
  current: number | null,
  target: number,
  ceiling: number,
  maxStep: number,
): void {
  if (target > ceiling) {
    throw safetyLimit(`target intensity ${target} exceeds the effective ceiling ${ceiling}`, {
      target,
      ceiling,
      maxStep,
    });
  }
  if (current !== null && target > current && target - current > maxStep) {
    throw safetyLimit(
      `increase from ${current} to ${target} exceeds the maximum step of ${maxStep}`,
      { target, current, ceiling, maxStep },
    );
  }
}

/**
 * Validate a signed delta. Positive deltas obey both guards; negative deltas
 * are always permitted regardless of magnitude.
 */
export function validateDelta(
  current: number,
  delta: number,
  ceiling: number,
  maxStep: number,
): void {
  if (delta > maxStep) {
    throw safetyLimit(`increase of ${delta} exceeds the maximum step of ${maxStep}`, {
      delta,
      current,
      ceiling,
      maxStep,
    });
  }
  if (delta > 0 && current + delta > ceiling) {
    throw safetyLimit(
      `increase from ${current} by ${delta} would exceed the effective ceiling ${ceiling}`,
      { delta, current, ceiling, maxStep },
    );
  }
}

export function requireWithinCeiling(
  config: { maxIntensity: number },
  telemetry: DeviceTelemetry,
  channel: Channel,
): number {
  return effectiveCeiling(config.maxIntensity, telemetry, channel);
}
