import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DglabError } from "../src/errors.js";
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
  options: { specs?: FakeDeviceSpec[]; maxWaveformDurationMs?: number } = {},
): Promise<World> {
  const relay = new FakeV4Relay();
  const url = await relay.start();
  const pulseDir = await fs.mkdtemp(path.join(os.tmpdir(), "dglab-play-pulses-"));
  const service = new DglabService(
    makeConfig({
      relayUrl: url,
      pulseDir,
      maxWaveformDurationMs: options.maxWaveformDurationMs ?? 10_000,
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

async function stopWorlds(): Promise<void> {
  for (const world of worlds.splice(0)) {
    world.app.close();
    await world.relay.stop();
    await fs.rm(world.pulseDir, { recursive: true, force: true });
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

/** Bring channel A to a safe nonzero intensity, respecting the step guard. */
async function armChannel(service: DglabService): Promise<void> {
  await service.setIntensity({ channel: "A", target: 5 });
  await service.setIntensity({ channel: "A", target: 10 });
}

describe("waveform playback", () => {
  afterEach(stopWorlds);

  it("plays a named preset and reports the task", async () => {
    const { service } = await startWorld();
    await armChannel(service);
    const result = await service.playWaveform({ channel: "A", name: "bubble" });
    expect(result.taskId).toMatch(/^task-/);
    expect(result.octetCount).toBe(2);
    expect(result.durationMs).toBe(200);
    expect(result.naturalDurationMs).toBe(200);

    // Task settles as the app consumes the short waveform (200ms) — leave margin.
    await delay(450);
    const status = await service.getStatus();
    expect(status.tasks.recent[0]?.state).toBe("completed");
  });

  it("matches presets case/separator-insensitively and by Chinese name", async () => {
    const { service } = await startWorld();
    await armChannel(service);
    const byKey = await service.playWaveform({ channel: "A", name: "air_waves" });
    const byEn = await service.playWaveform({ channel: "A", name: "Air Waves" });
    expect(byKey.waveform).toBe(byEn.waveform);
    const byCn = await service.playWaveform({ channel: "A", name: "气泡" });
    expect(byCn.waveform).toBe("Bubble");
  });

  it("rejects unknown waveform names", async () => {
    const { service } = await startWorld();
    await armChannel(service);
    const error = await catchError(service.playWaveform({ channel: "A", name: "nope" }));
    expect(error.code).toBe("INVALID_WAVEFORM");
  });

  it("requires a safe nonzero intensity before playing", async () => {
    const { service } = await startWorld();
    const error = await catchError(service.playWaveform({ channel: "A", name: "bubble" }));
    expect(error.code).toBe("DEVICE_NOT_READY");
    expect(error.message).toMatch(/nonzero/);
  });

  it("refuses playback when the current intensity exceeds the ceiling", async () => {
    const { service, app } = await startWorld({ specs: [{ ...COYOTE, intensityMaxA: 20 }] });
    // Climb to 15 (ceiling min(30, 20) permits it).
    await service.setIntensity({ channel: "A", target: 5 });
    await service.setIntensity({ channel: "A", target: 10 });
    await service.setIntensity({ channel: "A", target: 15 });
    // Tighten the app's advertised ceiling to 10 behind the service's back.
    const fakeDevice = app.devices.get("slot-1")!;
    fakeDevice.spec.intensityMaxA = 10;
    app.pushSnapshot();
    await delay(80);
    const error = await catchError(service.playWaveform({ channel: "A", name: "bubble" }));
    expect(error.code).toBe("SAFETY_LIMIT");
    expect(error.message).toMatch(/exceeds the effective ceiling/);
  });

  it("repeats and truncates to the requested duration", async () => {
    const { service } = await startWorld();
    await armChannel(service);
    const longer = await service.playWaveform({ channel: "A", name: "bubble", durationMs: 500 });
    expect(longer.durationMs).toBe(500);
    expect(longer.octetCount).toBe(5);
    const shorter = await service.playWaveform({ channel: "A", name: "bubble", durationMs: 100 });
    expect(shorter.durationMs).toBe(100);
    expect(shorter.octetCount).toBe(1);
    const over = await catchError(
      service.playWaveform({ channel: "A", name: "bubble", durationMs: 10_001 }),
    );
    expect(over.code).toBe("INVALID_WAVEFORM");
  });

  it("plays compiled custom segments and enforces the duration cap", async () => {
    const { service } = await startWorld();
    await armChannel(service);
    const result = await service.playCustomWaveform({
      channel: "A",
      segments: [
        { type: "ramp", from: 0, to: 100, durationMs: 100 },
        { type: "hold", intensity: 50, durationMs: 100 },
        { type: "silence", durationMs: 50 },
      ],
    });
    expect(result.octetCount).toBe(3);
    expect(result.durationMs).toBe(250);

    const tooLong = await catchError(
      service.playCustomWaveform({
        channel: "A",
        segments: [{ type: "hold", intensity: 10, durationMs: 10_025 }],
      }),
    );
    expect(tooLong.code).toBe("INVALID_WAVEFORM");
    expect(tooLong.message).toMatch(/ceiling/);
  });

  it("replaces the channel's previous waveform task", async () => {
    const { service } = await startWorld();
    await armChannel(service);
    const first = await service.playWaveform({ channel: "A", name: "bubble", durationMs: 8000 });
    const second = await service.playWaveform({ channel: "A", name: "tide", durationMs: 8000 });
    expect(second.taskId).not.toBe(first.taskId);
    await delay(120);
    const status = await service.getStatus();
    const firstTask = [...status.tasks.recent, ...status.tasks.active].find(
      (task) => task.taskId === first.taskId,
    );
    expect(firstTask?.state).toBe("replaced");
    expect(status.tasks.active.some((task) => task.taskId === second.taskId)).toBe(true);
  });

  it("stops the channel: clears tasks and resets intensity", async () => {
    const { service, app } = await startWorld();
    await armChannel(service);
    const played = await service.playWaveform({ channel: "A", name: "bubble", durationMs: 8000 });
    const stopped = await service.stopChannel({ channel: "A" });
    expect(stopped.runningTasksCleared).toBe(1);
    expect(app.intensityOf("slot-1", "A")).toBe(0);
    await delay(120);
    const status = await service.getStatus();
    const task = [...status.tasks.recent, ...status.tasks.active].find(
      (t) => t.taskId === played.taskId,
    );
    expect(task?.state).toBe("cleared");
  });

  it("hot-loads .pulse files dropped into the pulse directory", async () => {
    const { service, pulseDir } = await startWorld();
    const before = await service.listWaveforms();
    expect(before.external).toHaveLength(0);

    await fs.writeFile(
      path.join(pulseDir, "myspike.pulse"),
      "Dungeonlab+pulse:Spike=0,0,0,1,1/80-0,20-100",
      "utf8",
    );
    const after = await service.listWaveforms();
    expect(after.external.map((entry) => entry.id)).toEqual(["myspike"]);

    await armChannel(service);
    const played = await service.playWaveform({ channel: "A", name: "myspike" });
    expect(played.waveform).toBe("Spike");
  });

  it("reports unreadable pulse files without losing valid presets", async () => {
    const { service, pulseDir } = await startWorld();
    await fs.writeFile(path.join(pulseDir, "bad.pulse"), "garbage", "utf8");
    const listing = await service.listWaveforms();
    expect(listing.errors).toHaveLength(1);
    expect(listing.errors[0]!.file).toBe("bad.pulse");
    expect(listing.builtin).toHaveLength(24);
    await armChannel(service);
    const played = await service.playWaveform({ channel: "A", name: "bubble" });
    expect(played.taskId).toMatch(/^task-/);
  });
});
