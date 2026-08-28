import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DglabError } from "../src/errors.js";
import { DglabService } from "../src/service.js";
import { delay, type FakeDeviceSpec, FakeDglabApp, FakeV4Relay, makeConfig } from "./helpers.js";

const COYOTE: FakeDeviceSpec = {
  slotId: "slot-1",
  name: "Coyote V3",
  type: "COYOTE_030",
};

interface World {
  relay: FakeV4Relay;
  service: DglabService;
  app: FakeDglabApp;
  pulseDir: string;
}

const worlds: World[] = [];

async function startWorld(
  options: {
    specs?: FakeDeviceSpec[];
    heartbeatTimeoutMs?: number;
    maxIntensity?: number;
    maxStep?: number;
  } = {},
): Promise<World> {
  const relay = new FakeV4Relay();
  const url = await relay.start();
  const pulseDir = await fs.mkdtemp(path.join(os.tmpdir(), "dglab-test-pulses-"));
  const service = new DglabService(
    makeConfig({
      relayUrl: url,
      pulseDir,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 60_000,
      maxIntensity: options.maxIntensity ?? 30,
      maxStep: options.maxStep ?? 5,
    }),
  );
  await service.connect();
  const app = new FakeDglabApp(relay, service.session.targetId!, options.specs ?? [COYOTE]);
  await app.connect();
  await delay(80);
  const world: World = { relay, service, app, pulseDir };
  worlds.push(world);
  return world;
}

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    world.app.close();
    await world.relay.stop();
    await fs.rm(world.pulseDir, { recursive: true, force: true });
  }
});

function expectDglabError(error: unknown, code: string, pattern?: RegExp): void {
  expect(error).toBeInstanceOf(DglabError);
  expect((error as DglabError).code).toBe(code);
  if (pattern !== undefined) {
    expect((error as DglabError).message).toMatch(pattern);
  }
}

async function catchError(promise: Promise<unknown>): Promise<DglabError> {
  try {
    await promise;
  } catch (error) {
    return error as DglabError;
  }
  throw new Error("expected the promise to reject");
}

describe("connect and status", () => {
  it("pairs with the app and reports normalized telemetry", async () => {
    const { service, app } = await startWorld();
    expect(service.session.state).toBe("paired");
    expect(service.session.targetId).toBe(app.clientId !== null ? service.session.targetId : null);

    const status = await service.getStatus();
    expect(status.session.state).toBe("paired");
    expect(status.clients).toHaveLength(1);
    const device = status.clients[0]!.devices[0]!;
    expect(device.slotId).toBe("slot-1");
    expect(device.supported).toBe(true);
    expect(device.connected).toBe(true);
    expect(device.battery).toBe(88);
    expect(device.channels.A.intensity).toBe(0);
    expect(device.ceilings.A).toBe(30);
  });

  it("refresh re-requests device lists from the app", async () => {
    const { service } = await startWorld();
    const status = await service.getStatus({ refresh: true });
    expect(status.refreshErrors).toEqual([]);
    expect(status.clients[0]!.devices).toHaveLength(1);
  });

  it("computes effective ceilings from advertised device limits", async () => {
    const { service } = await startWorld({ specs: [{ ...COYOTE, intensityMaxA: 20 }] });
    const status = await service.getStatus();
    const device = status.clients[0]!.devices[0]!;
    expect(device.ceilings.A).toBe(20);
    expect(device.ceilings.B).toBe(30);
  });
});

describe("target resolution", () => {
  it("auto-selects the only compatible device", async () => {
    const { service } = await startWorld();
    const result = await service.setIntensity({ channel: "A", target: 5 });
    expect(result.slotId).toBe("slot-1");
  });

  it("rejects ambiguity between multiple compatible devices", async () => {
    const { service } = await startWorld({
      specs: [COYOTE, { slotId: "slot-2", name: "Coyote V2", type: "COYOTE_020" }],
    });
    const error = await catchError(service.setIntensity({ channel: "A", target: 5 }));
    expectDglabError(error, "AMBIGUOUS_TARGET");
    expect(error.details?.candidates).toHaveLength(2);
  });

  it("accepts explicit slotId among several devices", async () => {
    const { service } = await startWorld({
      specs: [COYOTE, { slotId: "slot-2", name: "Coyote V2", type: "COYOTE_020" }],
    });
    const result = await service.setIntensity({ channel: "A", target: 5, slotId: "slot-2" });
    expect(result.slotId).toBe("slot-2");
  });

  it("skips unsupported devices when auto-resolving", async () => {
    const { service } = await startWorld({
      specs: [{ slotId: "ovc-1", name: "Opossum", type: "OVC_1" }, COYOTE],
    });
    const result = await service.setIntensity({ channel: "A", target: 5 });
    expect(result.slotId).toBe("slot-1");
  });

  it("rejects explicit unsupported devices", async () => {
    const { service } = await startWorld({
      specs: [COYOTE, { slotId: "ovc-1", name: "Opossum", type: "OVC_1" }],
    });
    const error = await catchError(
      service.setIntensity({ channel: "A", target: 5, slotId: "ovc-1" }),
    );
    expectDglabError(error, "DEVICE_NOT_READY", /no compatible Coyote|not supported/);
  });

  it("reports no devices when the app has none", async () => {
    const { service } = await startWorld({ specs: [] });
    const error = await catchError(service.setIntensity({ channel: "A", target: 5 }));
    expectDglabError(error, "DEVICE_NOT_READY", /no attached devices/);
  });

  it("rejects unknown client and slot ids with candidates", async () => {
    const { service } = await startWorld();
    const missingClient = await catchError(
      service.setIntensity({ channel: "A", target: 5, clientId: "app-nope" }),
    );
    expectDglabError(missingClient, "AMBIGUOUS_TARGET");
    const missingSlot = await catchError(
      service.setIntensity({ channel: "A", target: 5, slotId: "slot-nope" }),
    );
    expectDglabError(missingSlot, "DEVICE_NOT_READY");
  });

  it("rejects output before any session exists", async () => {
    const relay = new FakeV4Relay();
    await relay.start();
    try {
      const service = new DglabService(makeConfig({ relayUrl: relay.url }));
      const error = await catchError(service.setIntensity({ channel: "A", target: 5 }));
      expectDglabError(error, "NOT_CONNECTED");
    } finally {
      await relay.stop();
    }
  });
});

describe("intensity control", () => {
  it("sets intensity through relative V4 ops", async () => {
    const { service, app } = await startWorld();
    const first = await service.setIntensity({ channel: "A", target: 5 });
    expect(first.appliedDelta).toBe(5);
    expect(app.intensityOf("slot-1", "A")).toBe(5);

    const second = await service.setIntensity({ channel: "A", target: 10 });
    expect(second.previous).toBe(5);
    expect(app.intensityOf("slot-1", "A")).toBe(10);
  });

  it("arms the safety lease on success", async () => {
    const { service } = await startWorld();
    expect(service.safety.lease().active).toBe(false);
    await service.setIntensity({ channel: "A", target: 5 });
    expect(service.safety.lease().active).toBe(true);
  });

  it("rejects zero-to-nonzero when telemetry has not reported intensity", async () => {
    const { service } = await startWorld({
      specs: [{ ...COYOTE, props: { intensityA: undefined, intensityB: undefined } }],
    });
    const error = await catchError(service.setIntensity({ channel: "A", target: 5 }));
    expectDglabError(error, "NOT_CONNECTED", /unknown/);
    // Zero targets remain allowed even without telemetry.
    const result = await service.setIntensity({ channel: "A", target: 0 });
    expect(result.target).toBe(0);
  });

  it("rejects disconnected devices", async () => {
    const { service } = await startWorld({
      specs: [{ ...COYOTE, props: { connectState: "disconnected" } }],
    });
    const error = await catchError(service.setIntensity({ channel: "A", target: 5 }));
    expectDglabError(error, "DEVICE_NOT_READY", /not connected/);
  });

  it("enforces the software cap and step guard", async () => {
    const { service, app } = await startWorld();
    const overCap = await catchError(service.setIntensity({ channel: "A", target: 31 }));
    expectDglabError(overCap, "SAFETY_LIMIT", /ceiling/);
    await service.setIntensity({ channel: "A", target: 5 });
    const overStep = await catchError(service.setIntensity({ channel: "A", target: 20 }));
    expectDglabError(overStep, "SAFETY_LIMIT", /maximum step/);
    expect(app.intensityOf("slot-1", "A")).toBe(5);
  });

  it("enforces advertised ceilings below the software cap", async () => {
    const { service, app } = await startWorld({ specs: [{ ...COYOTE, intensityMaxA: 8 }] });
    const error = await catchError(service.setIntensity({ channel: "A", target: 10 }));
    expectDglabError(error, "SAFETY_LIMIT", /ceiling 8/);
    await service.setIntensity({ channel: "A", target: 5 });
    expect(app.intensityOf("slot-1", "A")).toBe(5);
  });

  it("always permits large reductions and resets", async () => {
    const { service, app } = await startWorld();
    await service.setIntensity({ channel: "A", target: 5 });
    const result = await service.adjustIntensity({ channel: "A", delta: -5 });
    expect(result.target).toBe(0);
    expect(app.intensityOf("slot-1", "A")).toBe(0);
    await service.setIntensity({ channel: "A", target: 0 });
    expect(app.intensityOf("slot-1", "A")).toBe(0);
  });

  it("adjusts intensity with signed deltas", async () => {
    const { service, app } = await startWorld();
    await service.setIntensity({ channel: "A", target: 5 });
    const up = await service.adjustIntensity({ channel: "A", delta: 5 });
    expect(up.target).toBe(10);
    expect(app.intensityOf("slot-1", "A")).toBe(10);
    const overStep = await catchError(service.adjustIntensity({ channel: "A", delta: 6 }));
    expectDglabError(overStep, "SAFETY_LIMIT", /maximum step/);
    const down = await service.adjustIntensity({ channel: "A", delta: -100 });
    expect(down.target).toBe(0);
    expect(app.intensityOf("slot-1", "A")).toBe(0);
  });

  it("rejects positive deltas that would cross the ceiling", async () => {
    const { service } = await startWorld({ maxIntensity: 8 });
    await service.setIntensity({ channel: "A", target: 5 });
    const error = await catchError(service.adjustIntensity({ channel: "A", delta: 5 }));
    expectDglabError(error, "SAFETY_LIMIT", /ceiling/);
  });

  it("uses locally-dispatched intensity for rapid successive steps", async () => {
    const { service } = await startWorld();
    await service.setIntensity({ channel: "A", target: 5 });
    // Telemetry may not have caught up yet; the step guard must still see 5.
    const result = await service.setIntensity({ channel: "A", target: 10 });
    expect(result.previous).toBe(5);
    const rejected = await catchError(service.setIntensity({ channel: "A", target: 16 }));
    expectDglabError(rejected, "SAFETY_LIMIT");
  });

  it("serializes operations per device channel", async () => {
    const world = await startWorld();
    world.app.responseDelayMs = 40;
    const first = world.service.setIntensity({ channel: "A", target: 5 });
    const second = world.service.setIntensity({ channel: "A", target: 10 });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.target).toBe(5);
    expect(secondResult.previous).toBe(5);
    expect(secondResult.target).toBe(10);
    expect(world.app.intensityOf("slot-1", "A")).toBe(10);
  });

  it("maps device rejections to RELAY_ERROR", async () => {
    const { service, app } = await startWorld();
    app.failNextOperate = true;
    const error = await catchError(service.setIntensity({ channel: "A", target: 5 }));
    expectDglabError(error, "RELAY_ERROR", /internal_error/);
  });
});

describe("emergency stop and lease", () => {
  it("stops every device and invalidates queued operations", async () => {
    const world = await startWorld();
    world.app.responseDelayMs = 30;
    // Queue two operations; once the first is actually in flight, emergency-stop
    // invalidates the second before it ever dispatches. The rejection handler
    // is attached immediately so the cancellation is handled from birth.
    const first = world.service.setIntensity({ channel: "A", target: 5 });
    const second = world.service.setIntensity({ channel: "A", target: 10 });
    const secondOutcome = second.then(
      (value) => ({ error: null, value }),
      (error: DglabError) => ({ error, value: null }),
    );
    await delay(10);
    const stopped = await world.service.emergencyStop();
    expect(stopped.clients).toBe(1);
    expect(stopped.devices).toBe(1);
    await expect(first).resolves.toMatchObject({ target: 5 });
    const { error } = await secondOutcome;
    expectDglabError(error, "CANCELLED");
    expect(world.app.intensityOf("slot-1", "A")).toBe(0);
    expect(world.service.safety.lastTrip?.reason).toBe("emergency_stop");
  });

  it("reports partial emergency-stop failures without failing the stop itself", async () => {
    const world = await startWorld();
    await world.service.setIntensity({ channel: "A", target: 5 });
    // The next device.op (channel A's reset) is rejected by the app; channel B
    // still resets, and the stop reports the failure instead of throwing.
    world.app.failNextOperate = true;
    const stopped = await world.service.emergencyStop();
    expect(stopped.errors).toHaveLength(1);
    expect(stopped.dispatches.length).toBeGreaterThanOrEqual(2);
    expect(world.app.intensityOf("slot-1", "A")).toBe(5);
    expect(world.app.intensityOf("slot-1", "B")).toBe(0);
    expect(world.service.safety.lastTrip?.reason).toBe("emergency_stop");
  });

  it("expires the lease and stops all outputs", async () => {
    const { service, app } = await startWorld({ heartbeatTimeoutMs: 400 });
    await service.setIntensity({ channel: "A", target: 5 });
    expect(app.intensityOf("slot-1", "A")).toBe(5);
    await delay(700);
    expect(app.intensityOf("slot-1", "A")).toBe(0);
    expect(service.safety.lastTrip?.reason).toBe("heartbeat_timeout");
    expect(service.safety.lease().active).toBe(false);
    // Recovery: the next output command starts a fresh lease.
    const result = await service.setIntensity({ channel: "A", target: 5 });
    expect(result.target).toBe(5);
    expect(service.safety.lease().active).toBe(true);
    // Defuse the fresh lease so its expiry cannot fire after this test ends.
    service.safety.disarm();
  }, 10_000);

  it("renews the lease via heartbeat", async () => {
    const { service } = await startWorld({ heartbeatTimeoutMs: 500 });
    await service.setIntensity({ channel: "A", target: 5 });
    await delay(300);
    const renewed = service.heartbeat();
    expect(renewed?.active).toBe(true);
    await delay(300);
    expect(service.safety.lease().active).toBe(true);
    await delay(400);
    expect(service.safety.lease().active).toBe(false);
    // The expired lease already fired; nothing left to trip after the test.
    service.safety.disarm();
  }, 10_000);

  it("heartbeat is an idle no-op without an active lease", async () => {
    const { service } = await startWorld();
    expect(service.heartbeat()).toBeNull();
  });

  it("succeeds as a no-op when nothing is connected", async () => {
    const relay = new FakeV4Relay();
    await relay.start();
    try {
      const service = new DglabService(makeConfig({ relayUrl: relay.url }));
      const stopped = await service.emergencyStop();
      expect(stopped).toEqual({ clients: 0, devices: 0, dispatches: [], errors: [] });
    } finally {
      await relay.stop();
    }
  });

  it("disconnect stops devices, destroys the session, and blocks further output", async () => {
    const { service, app } = await startWorld();
    await service.setIntensity({ channel: "A", target: 5 });
    const stopped = await service.disconnect();
    expect(stopped.devices).toBe(1);
    expect(app.intensityOf("slot-1", "A")).toBe(0);
    const error = await catchError(service.setIntensity({ channel: "A", target: 5 }));
    expectDglabError(error, "NOT_CONNECTED");
  });
});
