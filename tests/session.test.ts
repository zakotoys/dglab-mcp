import { afterEach, describe, expect, it, vi } from "vitest";
import { DglabSession } from "../src/session.js";
import { normalizeDevice } from "../src/telemetry.js";
import { delay, FakeDglabApp, FakeV4Relay } from "./helpers.js";

type EventSocket = { emit: (...args: unknown[]) => unknown };

const relays: FakeV4Relay[] = [];

async function connectedSession(): Promise<{
  relay: FakeV4Relay;
  session: DglabSession;
  app: FakeDglabApp;
}> {
  const relay = new FakeV4Relay();
  relays.push(relay);
  await relay.start();
  const session = new DglabSession(relay.url);
  await session.ensureConnected();
  const app = new FakeDglabApp(relay, session.targetId!, [
    { slotId: "slot-1", name: "Coyote V3", type: "COYOTE_030" },
  ]);
  await app.connect();
  await delay(60);
  return { relay, session, app };
}

afterEach(async () => {
  for (const relay of relays.splice(0)) {
    await relay.stop();
  }
});

describe("DglabSession", () => {
  it("reports an idle snapshot before connecting", () => {
    const session = new DglabSession("ws://example.test/v4");
    expect(session.snapshot()).toEqual({
      state: "idle",
      targetId: null,
      relayUrl: "ws://example.test/v4",
      appSocketUrl: null,
      sessionLink: null,
    });
    expect(session.clients).toEqual([]);
    expect(session.v4Socket).toBeNull();
    expect(session.listDevices()).toEqual([]);
    expect(session.getClient("missing")).toBeUndefined();
    expect(session.getDevice("missing", "slot")).toBeUndefined();
  });

  it("connects, lists devices, and reuses an established socket", async () => {
    const { session, app } = await connectedSession();
    const socket = session.v4Socket;
    expect(session.state).toBe("paired");
    expect(session.appSocketUrl).toContain("tid=");
    expect(session.sessionLink).toContain("dungeon-lab.cn");
    expect(session.clients).toHaveLength(1);
    expect(session.listDevices()[0]?.slotId).toBe("slot-1");
    expect(session.getClient(app.clientId!)).toBeDefined();
    expect(session.getDevice(app.clientId!, "slot-1")).toBeDefined();
    await session.ensureConnected();
    expect(session.v4Socket).toBe(socket);
  });

  it("tracks shadow intensity until fresher telemetry arrives", async () => {
    const { session } = await connectedSession();
    const telemetry = session.listDevices()[0]!;
    expect(session.currentIntensity(telemetry, "A")).toBe(0);
    vi.useFakeTimers();
    const base = Date.now();
    session.noteDispatchedIntensity("app-1", "slot-1", "A", 7, base + 100);
    expect(session.currentIntensity(telemetry, "A")).toBe(7);
    vi.setSystemTime(base + 200);
    (session.v4Socket! as unknown as EventSocket).emit(
      "device",
      { slotId: "slot-1", props: { intensityA: 3 } },
      "app-1",
    );
    const refreshed = session.listDevices()[0]!;
    expect(session.currentIntensity(refreshed, "A")).toBe(0);
    session.noteDispatchedIntensity("app-1", "slot-1", "A", 8, base + 300);
    expect(session.currentIntensity(refreshed, "A")).toBe(8);
    vi.useRealTimers();
  });

  it("handles socket callbacks and clears client keys on disconnect", async () => {
    const { session, app } = await connectedSession();
    const socket = session.v4Socket! as unknown as EventSocket;
    const errorSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    session.noteDispatchedIntensity(app.clientId!, "slot-1", "A", 9, Date.now() + 1000);
    socket.emit("error", new Error("boom"));
    socket.emit("action", 42);
    socket.emit("device", { props: {} }, app.clientId!);
    socket.emit("device", { slotId: "slot-1", props: { intensityA: 3 } }, app.clientId!);
    socket.emit("device", { slotId: "slot-1", removed: true }, app.clientId!);
    expect(session.currentIntensity(session.listDevices()[0]!, "A")).toBe(0);
    socket.emit("client-disconnected", app.clientId!);
    errorSpy.mockRestore();
  });

  it("ignores removed and malformed event payloads safely", async () => {
    const { session, app } = await connectedSession();
    const socket = session.v4Socket! as unknown as EventSocket;
    session.noteDispatchedIntensity(app.clientId!, "slot-1", "A", 9, Date.now() + 1000);
    socket.emit("device", { removed: true }, app.clientId!);
    socket.emit("device", { slotId: "slot-1", props: { intensityA: 3 } }, app.clientId!);
    socket.emit("close", { code: 1000, reason: "test", wasClean: true });
    expect(session.currentIntensity(session.listDevices()[0]!, "A")).toBe(0);
  });

  it("recreates a disconnected socket and clears all state on destroy", async () => {
    const { session } = await connectedSession();
    const first = session.v4Socket! as unknown as {
      destroy: (code: number, reason: string) => void;
    };
    session.destroy(1000, "lost");
    await session.ensureConnected();
    expect(session.v4Socket).not.toBe(first);
    session.destroy(1000, "done");
    expect(session.state).toBe("idle");
    expect(session.v4Socket).toBeNull();
    expect(session.snapshot().sessionLink).toBeNull();
  });

  it("returns reported intensity when no shadow entry exists", () => {
    const session = new DglabSession("ws://example.test");
    const telemetry = normalizeDevice("app", {
      slotId: "slot",
      name: "Coyote",
      type: "COYOTE_020",
      props: { intensityA: 4 },
    } as unknown as Parameters<typeof normalizeDevice>[1]);
    expect(session.currentIntensity(telemetry, "A")).toBe(4);
  });
});
