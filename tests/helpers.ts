import { type WebSocket, WebSocketServer } from "ws";
import type { Config } from "../src/config.js";
import { DglabService } from "../src/service.js";

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RelayPeer {
  id: string;
  ws: WebSocket;
  controllerId: string | null;
  appId: string | null;
}

/**
 * Minimal fake of the DG-LAB 4 V4 WebSocket relay: hello assignment, app
 * attach/detach notifications, bidirectional message passthrough, server-level
 * ping/pong, heartbeat, and idle-timeout triggering.
 */
export class FakeV4Relay {
  private wss: WebSocketServer | null = null;
  private readonly controllers = new Map<string, RelayPeer>();
  private readonly apps = new Map<string, RelayPeer>();
  private controllerCounter = 0;
  private appCounter = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  url = "";

  async start(options: { heartbeatMs?: number } = {}): Promise<string> {
    this.wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => this.wss!.once("listening", resolve));
    const address = this.wss.address();
    const port = typeof address === "object" ? address.port : 0;
    this.url = `ws://127.0.0.1:${port}/v4`;
    this.wss.on("connection", (ws, request) => {
      const tid = new URL(request.url ?? "/", "http://localhost").searchParams.get("tid");
      if (tid === null) {
        this.attachController(ws);
      } else {
        this.attachApp(ws, tid);
      }
    });
    if (options.heartbeatMs && options.heartbeatMs > 0) {
      this.heartbeatTimer = setInterval(() => {
        this.broadcastAll({ type: "heartbeat" });
      }, options.heartbeatMs);
    }
    return this.url;
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
    }
    for (const peer of [...this.controllers.values(), ...this.apps.values()]) {
      peer.ws.close();
    }
    await new Promise<void>((resolve, reject) => {
      if (this.wss === null) {
        resolve();
        return;
      }
      this.wss.close((error) => (error ? reject(error) : resolve()));
    });
    this.wss = null;
    this.controllers.clear();
    this.apps.clear();
  }

  /** Simulate the relay's 5-minute idle timeout for the controller. */
  idleTimeoutController(): void {
    const controller = [...this.controllers.values()][0];
    if (controller === undefined) {
      return;
    }
    this.send(controller.ws, { type: "idle_timeout" });
    controller.ws.close(4002, "idle_timeout");
  }

  private attachController(ws: WebSocket): void {
    this.controllerCounter += 1;
    const id = `ctrl-${this.controllerCounter}`;
    const peer: RelayPeer = { id, ws, controllerId: null, appId: null };
    this.controllers.set(id, peer);
    this.send(ws, { type: "hello", clientId: id });
    ws.on("message", (raw) => {
      const frame = this.parse(raw);
      if (frame === undefined) {
        return;
      }
      if (frame.type === "ping") {
        this.send(ws, { type: "pong", ts: Date.now() });
        return;
      }
      if (frame.type === "message") {
        const app = this.apps.get(frame.clientId);
        if (app !== undefined) {
          this.send(app.ws, { type: "message", clientId: app.id, data: frame.data });
        }
      }
    });
    ws.on("close", () => {
      this.controllers.delete(id);
      for (const app of this.apps.values()) {
        if (app.controllerId === id) {
          this.send(app.ws, { type: "controller_disconnected", clientId: id });
          app.ws.close(4000, "controller_disconnected");
        }
      }
    });
  }

  private attachApp(ws: WebSocket, tid: string): void {
    const controller = this.controllers.get(tid);
    if (controller === undefined) {
      ws.close(4001, "controller_not_found");
      return;
    }
    this.appCounter += 1;
    const id = `app-${this.appCounter}`;
    const peer: RelayPeer = { id, ws, controllerId: tid, appId: null };
    this.apps.set(id, peer);
    this.send(ws, { type: "hello", clientId: id });
    this.send(ws, { type: "controller_attached", clientId: tid });
    this.send(controller.ws, { type: "client_attached", clientId: id });
    ws.on("message", (raw) => {
      const payload = this.parse(raw);
      if (payload === undefined || payload.type !== undefined) {
        return;
      }
      // App payloads ride to the controller inside a message frame.
      this.send(controller.ws, { type: "message", clientId: id, data: payload });
    });
    ws.on("close", () => {
      this.apps.delete(id);
      this.send(controller.ws, { type: "client_disconnected", clientId: id });
    });
  }

  private broadcastAll(frame: unknown): void {
    for (const peer of [...this.controllers.values(), ...this.apps.values()]) {
      this.send(peer.ws, frame);
    }
  }

  private send(ws: WebSocket, frame: unknown): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(frame));
    }
  }

  private parse(raw: unknown): Record<string, unknown> | undefined {
    try {
      const value = JSON.parse(String(raw));
      return typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }
}

export interface FakeDeviceSpec {
  slotId: string;
  name: string;
  type: string;
  props?: Record<string, unknown>;
  intensityMaxA?: number;
  intensityMaxB?: number;
}

interface PendingPulse {
  reqId: string;
  slotId: string;
  channel: 0 | 1;
  timer: NodeJS.Timeout | null;
}

interface FakeDevice {
  spec: FakeDeviceSpec;
  props: Record<string, unknown>;
  intensity: { A: number; B: number };
}

/**
 * Minimal fake of a DG-LAB 4 app (controlled side): reports a device
 * snapshot on attach, answers RPCs, simulates one-shot intensity ops and
 * long-running pulse tasks, and pushes telemetry patches.
 */
export class FakeDglabApp {
  private ws: WebSocket | null = null;
  clientId: string | null = null;
  readonly devices = new Map<string, FakeDevice>();
  private readonly pendingPulses = new Map<string, PendingPulse>();
  onFrame: ((data: Record<string, unknown>) => void) | null = null;
  /** Artificial latency applied to RPC handling, for queue-order tests. */
  responseDelayMs = 0;
  /** When true, the next device.op is rejected with an RPC error. */
  failNextOperate = false;
  /** The controller target id this app pairs with. */
  tid: string;

  constructor(
    private readonly relay: FakeV4Relay,
    tid: string,
    specs: FakeDeviceSpec[],
  ) {
    this.tid = tid;
    for (const spec of specs) {
      this.devices.set(spec.slotId, {
        spec,
        props: {
          power: 88,
          connectState: "connected",
          intensityA: 0,
          intensityB: 0,
          channelAStatus: 2,
          channelBStatus: 2,
          ...spec.props,
        },
        intensity: { A: 0, B: 0 },
      });
    }
  }

  async connect(): Promise<string> {
    const { WebSocket } = await import("ws");
    const url = new URL(this.relay.url);
    url.searchParams.set("tid", this.tid);
    const ws = new WebSocket(url);
    this.ws = ws;
    return new Promise<string>((resolve, reject) => {
      ws.on("message", (raw) => {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>;
        if (frame.type === "hello") {
          this.clientId = frame.clientId as string;
          this.pushSnapshot();
          resolve(this.clientId);
          return;
        }
        if (frame.type === "message") {
          const payload = frame.data as Record<string, unknown>;
          if (this.responseDelayMs > 0 && payload.t === "req") {
            setTimeout(() => this.handlePayload(payload), this.responseDelayMs);
          } else {
            this.handlePayload(payload);
          }
        }
      });
      ws.on("error", reject);
    });
  }

  close(): void {
    this.ws?.close();
  }

  intensityOf(slotId: string, channel: "A" | "B"): number {
    return this.devices.get(slotId)?.intensity[channel] ?? -1;
  }

  /** Directly set device intensity and push telemetry, bypassing the protocol. */
  async setLocalIntensity(
    slotId: string,
    channel: "A" | "B",
    value: number,
    delayMs = 30,
  ): Promise<void> {
    const device = this.devices.get(slotId);
    if (device === undefined) {
      return;
    }
    device.intensity[channel] = value;
    device.props[`intensity${channel}`] = value;
    await delay(delayMs);
    this.pushPatch([{ slotId, props: { [`intensity${channel}`]: value } }]);
  }

  pushSnapshot(): void {
    this.emit({
      t: "ev",
      ev: "devices.snapshot",
      devices: [...this.devices.values()].map((device) => this.describe(device)),
    });
  }

  private pushPatch(slots: Array<Record<string, unknown>>): void {
    this.emit({ t: "ev", ev: "slots.patch", slots });
  }

  private describe(device: FakeDevice): Record<string, unknown> {
    return {
      id: 0,
      slotId: device.spec.slotId,
      name: device.spec.name,
      type: device.spec.type,
      props: { ...device.props },
      slotState: {
        markLight: "green",
        hasDevice: device.props.connectState === "connected",
        channelA: {
          isMuted: false,
          intensityMax: device.spec.intensityMaxA ?? 200,
          comfortLimit: { mode: "simple", comfortMax: 200, absoluteMax: 200 },
        },
        channelB: {
          isMuted: false,
          intensityMax: device.spec.intensityMaxB ?? 200,
          comfortLimit: { mode: "simple", comfortMax: 200, absoluteMax: 200 },
        },
      },
    };
  }

  private emit(payload: Record<string, unknown>): void {
    this.ws?.send(JSON.stringify(payload));
  }

  private respond(reqId: string, body: Record<string, unknown>): void {
    this.emit({ t: "resp", reqId, ...body });
  }

  private handlePayload(payload: Record<string, unknown>): void {
    this.onFrame?.(payload);
    if (payload.t !== "req") {
      return;
    }
    const reqId = payload.reqId as string;
    const method = payload.m as string;
    if (method === "devices.get") {
      this.respond(reqId, {
        result: { devices: [...this.devices.values()].map((device) => this.describe(device)) },
      });
      return;
    }
    if (method === "ping") {
      this.respond(reqId, { result: Date.now() });
      return;
    }
    if (method === "device.op.clear") {
      const data = (payload.data ?? {}) as Record<string, unknown>;
      for (const [key, pulse] of [...this.pendingPulses.entries()]) {
        if (data.s !== undefined && pulse.slotId !== data.s) {
          continue;
        }
        if (data.c !== undefined && pulse.channel !== data.c) {
          continue;
        }
        this.cancelPulse(key);
      }
      this.respond(reqId, { result: {} });
      return;
    }
    if (method === "device.op") {
      this.handleOperate(reqId, (payload.data ?? {}) as Record<string, unknown>);
      return;
    }
    this.respond(reqId, { error: "method_not_found" });
  }

  private handleOperate(reqId: string, data: Record<string, unknown>): void {
    if (this.failNextOperate) {
      this.failNextOperate = false;
      this.respond(reqId, { error: "internal_error" });
      return;
    }
    const slotId = data.s as string;
    const channel = data.c as 0 | 1;
    const device = this.devices.get(slotId);
    if (device === undefined) {
      this.respond(reqId, { error: "slot_not_found" });
      return;
    }
    const channelName = channel === 0 ? "A" : "B";
    const type = data.t as number;
    const value = data.v;

    if (type === 3) {
      // AddIntensity (relative)
      device.intensity[channelName] = Math.max(
        0,
        Math.min(200, device.intensity[channelName] + (value as number)),
      );
      device.props[`intensity${channelName}`] = device.intensity[channelName];
      this.respond(reqId, { result: { type, reason: "completed", slotId, channel } });
      this.notifyTelemetry(slotId, channelName);
      return;
    }
    if (type === 7) {
      // SetIntensity: V4 only supports absolute reset to 0.
      if (value !== 0) {
        this.respond(reqId, { error: "invalid_operate" });
        return;
      }
      device.intensity[channelName] = 0;
      device.props[`intensity${channelName}`] = 0;
      this.respond(reqId, { result: { type, reason: "completed", slotId, channel } });
      this.notifyTelemetry(slotId, channelName);
      return;
    }
    if (type === 0) {
      // AppendPulseData: long-running until cleared, replaced, or duration elapses.
      const key = `${slotId}:${channel}`;
      const existing = this.pendingPulses.get(key);
      if (existing !== undefined) {
        if (data.im === true) {
          this.respond(existing.reqId, {
            result: { type: 0, reason: "replaced", slotId, channel },
          });
          if (existing.timer !== null) {
            clearTimeout(existing.timer);
          }
        } else {
          this.respond(reqId, { error: "invalid_operate" });
          return;
        }
      }
      const duration = (data.d as number) ?? 0;
      const pulse: PendingPulse = { reqId, slotId, channel, timer: null };
      this.pendingPulses.set(key, pulse);
      if (duration > 0) {
        pulse.timer = setTimeout(() => {
          if (this.pendingPulses.get(key) === pulse) {
            this.pendingPulses.delete(key);
            this.respond(reqId, { result: { type: 0, reason: "completed", slotId, channel } });
          }
        }, duration);
      }
      return;
    }
    if (type === 4) {
      // SetTempIntensity
      device.intensity[channelName] = value as number;
      device.props[`intensity${channelName}`] = value;
      this.respond(reqId, { result: { type, reason: "completed", slotId, channel } });
      this.notifyTelemetry(slotId, channelName);
      return;
    }
    this.respond(reqId, { error: "invalid_operate" });
  }

  private cancelPulse(key: string): void {
    const pulse = this.pendingPulses.get(key);
    if (pulse === undefined) {
      return;
    }
    this.pendingPulses.delete(key);
    if (pulse.timer !== null) {
      clearTimeout(pulse.timer);
    }
    this.respond(pulse.reqId, {
      result: { type: 0, reason: "cleared", slotId: pulse.slotId, channel: pulse.channel },
    });
  }

  private notifyTelemetry(slotId: string, _channel: "A" | "B"): void {
    const device = this.devices.get(slotId);
    if (device === undefined) {
      return;
    }
    setTimeout(() => {
      this.pushPatch([
        {
          slotId,
          props: { intensityA: device.props.intensityA, intensityB: device.props.intensityB },
        },
      ]);
    }, 20);
  }
}

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    maxIntensity: 30,
    maxStep: 5,
    heartbeatTimeoutMs: 20000,
    maxWaveformDurationMs: 10000,
    relayUrl: "ws://127.0.0.1:1/v4",
    pulseDir: "~/.dglab-mcp/pulses-does-not-exist",
    ...overrides,
  };
}

export function makeService(config: Config): DglabService {
  return new DglabService(config);
}
