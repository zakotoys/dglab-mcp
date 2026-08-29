import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DglabError } from "../src/errors.js";
import { DglabService, type TaskRecord } from "../src/service.js";
import { delay, FakeDglabApp, FakeV4Relay, makeConfig } from "./helpers.js";

const worlds: Array<{ relay: FakeV4Relay; apps: FakeDglabApp[]; pulseDir: string }> = [];

async function startWorld(): Promise<{
  service: DglabService;
  relay: FakeV4Relay;
  app: FakeDglabApp;
  pulseDir: string;
}> {
  const relay = new FakeV4Relay();
  await relay.start();
  const pulseDir = await fs.mkdtemp(path.join(os.tmpdir(), "dglab-edge-pulses-"));
  const service = new DglabService(makeConfig({ relayUrl: relay.url, pulseDir }));
  await service.connect();
  const app = new FakeDglabApp(relay, service.session.targetId!, [
    { slotId: "slot-1", name: "Coyote V3", type: "COYOTE_030" },
  ]);
  await app.connect();
  await delay(60);
  worlds.push({ relay, apps: [app], pulseDir });
  return { service, relay, app, pulseDir };
}

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    for (const app of world.apps) app.close();
    await world.relay.stop();
    await fs.rm(world.pulseDir, { recursive: true, force: true });
  }
});

async function rejected(promise: Promise<unknown>): Promise<DglabError> {
  try {
    await promise;
  } catch (error) {
    return error as DglabError;
  }
  throw new Error("expected rejection");
}

describe("DglabService edge paths", () => {
  it("maps relay connection failures to RELAY_ERROR", async () => {
    const service = new DglabService(makeConfig({ relayUrl: "ws://127.0.0.1:1/v4" }));
    const error = await rejected(service.connect());
    expect(error.code).toBe("RELAY_ERROR");
    expect(error.message).toMatch(/relay connection failed/);
  });

  it("filters status by client and slot", async () => {
    const { service, relay, app, pulseDir } = await startWorld();
    const second = new FakeDglabApp(relay, service.session.targetId!, [
      { slotId: "slot-2", name: "Coyote V2", type: "COYOTE_020" },
    ]);
    worlds[worlds.length - 1]!.apps.push(second);
    await second.connect();
    await delay(60);
    const all = await service.getStatus();
    expect(all.clients).toHaveLength(2);
    expect((await service.getStatus({ clientId: app.clientId! })).clients).toHaveLength(1);
    expect((await service.getStatus({ slotId: "slot-2" })).clients[0]?.devices[0]?.slotId).toBe(
      "slot-2",
    );
    expect(pulseDir).toContain("dglab-edge-pulses");
  });

  it("reports stop-channel dispatch failures", async () => {
    const { service, app } = await startWorld();
    await service.setIntensity({ channel: "A", target: 5 });
    app.failNextOperate = true;
    const error = await rejected(service.stopChannel({ channel: "A" }));
    expect(error.code).toBe("RELAY_ERROR");
    expect(error.message).toMatch(/stop channel failed/);
  });

  it("retries nonzero outputs during post-stop verification", async () => {
    const { service, app } = await startWorld();
    await service.setIntensity({ channel: "A", target: 5 });
    app.failNextOperate = true;
    const stopped = await service.emergencyStop();
    expect(stopped.errors).toHaveLength(1);
    await delay(650);
    expect(app.intensityOf("slot-1", "A")).toBe(0);
  });

  it("maps synchronous waveform dispatch errors", async () => {
    const { service } = await startWorld();
    await service.setIntensity({ channel: "A", target: 5 });
    const socket = service.session.v4Socket!;
    const socketGetter = vi.spyOn(service.session, "v4Socket", "get").mockReturnValue({
      ...socket,
      sendPulse: () => {
        throw new Error("sync send failure");
      },
    } as unknown as typeof socket);
    const error = await rejected(service.playWaveform({ channel: "A", name: "bubble" }));
    expect(error.code).toBe("RELAY_ERROR");
    expect(error.message).toMatch(/dispatch failed/);
    socketGetter.mockRestore();
  });

  it("handles a device disappearing after target resolution", async () => {
    const { service } = await startWorld();
    const getDevice = vi.spyOn(service.session, "getDevice").mockReturnValue(undefined);
    const error = await rejected(service.setIntensity({ channel: "A", target: 5 }));
    expect(error.code).toBe("DEVICE_NOT_READY");
    expect(error.message).toMatch(/disappeared/);
    getDevice.mockRestore();
  });

  it("preserves DglabError messages while mapping device failures", async () => {
    const { service } = await startWorld();
    const socket = service.session.v4Socket!;
    const socketGetter = vi.spyOn(service.session, "v4Socket", "get").mockReturnValue({
      ...socket,
      addIntensity: () => Promise.reject(new DglabError("RELAY_ERROR", "specific device failure")),
    } as unknown as typeof socket);
    const error = await rejected(service.setIntensity({ channel: "A", target: 5 }));
    expect(error.code).toBe("RELAY_ERROR");
    expect(error.message).toContain("specific device failure");
    socketGetter.mockRestore();
  });

  it("normalizes unknown task completion reasons and prunes old tasks", async () => {
    const { service } = await startWorld();
    await service.setIntensity({ channel: "A", target: 5 });
    const socket = service.session.v4Socket!;
    const socketGetter = vi.spyOn(service.session, "v4Socket", "get").mockReturnValue({
      ...socket,
      sendPulse: () => Promise.resolve({ reason: "unrecognized" }),
    } as unknown as typeof socket);
    const played = await service.playWaveform({ channel: "A", name: "bubble" });
    await delay(0);
    expect(
      (await service.getStatus()).tasks.recent.find((task) => task.taskId === played.taskId)?.state,
    ).toBe("completed");
    const internals = service as unknown as {
      tasks: Map<string, TaskRecord>;
      pruneTasks: () => void;
    };
    const tasks = internals.tasks;
    for (let i = 0; i < 55; i += 1) {
      tasks.set(`old-${i}`, {
        taskId: `old-${i}`,
        state: "completed",
        startedAt: i,
        endedAt: i,
      });
    }
    internals.pruneTasks();
    expect(tasks.size).toBeLessThanOrEqual(50);
    socketGetter.mockRestore();
  });
});
