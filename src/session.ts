import {
  DGLAB_SOCKET_STATE,
  DglabSocket,
  type DglabSocketCloseEvent,
  type DglabSocketDeviceEventPayload,
  type DglabSocketV4Client,
  type V4DeviceInfo,
} from "dglab-kit";
import { log } from "./log.js";
import type { Channel, DeviceTelemetry } from "./telemetry.js";
import { normalizeDevice } from "./telemetry.js";

/** The kit does not re-export its internal V4Client class; derive the shape. */
type V4ClientLike = NonNullable<ReturnType<DglabSocketV4Client["getClient"]>>;

export type RelayState = "idle" | "connecting" | "waiting_for_peer" | "paired" | "disconnected";

export interface SessionSnapshot {
  state: RelayState;
  targetId: string | null;
  relayUrl: string;
  appSocketUrl: string | null;
  sessionLink: string | null;
}

const STATE_NAMES: Record<DGLAB_SOCKET_STATE, RelayState> = {
  [DGLAB_SOCKET_STATE.Idle]: "idle",
  [DGLAB_SOCKET_STATE.Connecting]: "connecting",
  [DGLAB_SOCKET_STATE.WaitingForPeer]: "waiting_for_peer",
  [DGLAB_SOCKET_STATE.Paired]: "paired",
  [DGLAB_SOCKET_STATE.Disconnected]: "disconnected",
};

interface ShadowIntensity {
  value: number;
  at: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Owns the single idempotent V4 relay connection, mirrors kit-side client and
 * device state, and tracks locally-dispatched intensity so rapid successive
 * commands are step-checked against fresher values than telemetry may offer.
 */
export class DglabSession {
  private socket: DglabSocketV4Client | null = null;
  private wiringSocket: DglabSocketV4Client | null = null;
  private readonly shadow = new Map<string, ShadowIntensity>();
  private readonly telemetryAt = new Map<string, number>();

  constructor(readonly relayUrl: string) {}

  get state(): RelayState {
    return this.socket ? (STATE_NAMES[this.socket.state] ?? "idle") : "idle";
  }

  get targetId(): string | null {
    return this.socket?.targetId ?? null;
  }

  get appSocketUrl(): string | null {
    const targetId = this.targetId;
    return targetId === null ? null : `${this.relayUrl}?tid=${encodeURIComponent(targetId)}`;
  }

  get sessionLink(): string | null {
    const appSocketUrl = this.appSocketUrl;
    return appSocketUrl === null
      ? null
      : `https://dungeon-lab.cn/s/?v=1&action=socket&url=${encodeURIComponent(appSocketUrl)}`;
  }

  snapshot(): SessionSnapshot {
    return {
      state: this.state,
      targetId: this.targetId,
      relayUrl: this.relayUrl,
      appSocketUrl: this.appSocketUrl,
      sessionLink: this.sessionLink,
    };
  }

  get clients(): V4ClientLike[] {
    return this.socket?.clients ?? [];
  }

  /** Live V4 socket, or null when no session is established. */
  get v4Socket(): DglabSocketV4Client | null {
    return this.socket;
  }

  getClient(clientId: string): V4ClientLike | undefined {
    return this.socket?.getClient(clientId);
  }

  getDevice(clientId: string, slotId: string): V4DeviceInfo | undefined {
    return this.getClient(clientId)?.getDevice(slotId);
  }

  listDevices(): DeviceTelemetry[] {
    const devices: DeviceTelemetry[] = [];
    for (const client of this.clients) {
      for (const info of client.devices) {
        devices.push(normalizeDevice(client.clientId, info));
      }
    }
    return devices;
  }

  /**
   * Create the relay connection if absent or dead, then connect. Safe to
   * call repeatedly; an established or in-flight session is reused untouched.
   */
  async ensureConnected(): Promise<{ targetId: string }> {
    if (this.socket === null || this.socket.state === DGLAB_SOCKET_STATE.Disconnected) {
      this.socket?.destroy(1000, "reconnect");
      this.socket = new DglabSocket({ url: this.relayUrl }) as DglabSocketV4Client;
      this.wireSocketEvents(this.socket);
    }
    return this.socket.connect();
  }

  destroy(code = 1000, reason = "shutdown"): void {
    this.socket?.destroy(code, reason);
    this.socket = null;
    this.wiringSocket = null;
    this.shadow.clear();
    this.telemetryAt.clear();
  }

  /**
   * Fresher local knowledge of a channel's intensity: the telemetry value
   * unless we dispatched a change more recently than the last telemetry
   * report that carried intensity data for the device.
   */
  currentIntensity(telemetry: DeviceTelemetry, channel: Channel): number | null {
    const reported = telemetry.channels[channel].intensity;
    const entry = this.shadow.get(shadowKey(telemetry.clientId, telemetry.slotId, channel));
    if (!entry) {
      return reported;
    }
    const reportedAt = this.telemetryAt.get(`${telemetry.clientId}|${telemetry.slotId}`) ?? 0;
    return entry.at > reportedAt ? entry.value : reported;
  }

  noteDispatchedIntensity(
    clientId: string,
    slotId: string,
    channel: Channel,
    value: number,
    at: number = Date.now(),
  ): void {
    this.shadow.set(shadowKey(clientId, slotId, channel), { value, at });
  }

  private noteTelemetryAt(clientId: string, slotId: string, at: number = Date.now()): void {
    this.telemetryAt.set(`${clientId}|${slotId}`, at);
  }

  private wireSocketEvents(socket: DglabSocketV4Client): void {
    if (this.wiringSocket === socket) {
      return;
    }
    this.wiringSocket = socket;
    socket.on("state", (state, previous) => {
      log(`relay state: ${STATE_NAMES[previous] ?? previous} -> ${STATE_NAMES[state] ?? state}`);
    });
    socket.on("client-attached", (clientId) => {
      log("app attached", { clientId });
    });
    socket.on("client-disconnected", (clientId) => {
      this.dropKeysForClient(clientId);
      log("app disconnected", { clientId });
    });
    socket.on("device", (event, clientId) => {
      this.handleDeviceEvent(event, clientId);
    });
    socket.on("close", (event: DglabSocketCloseEvent) => {
      this.shadow.clear();
      this.telemetryAt.clear();
      log("relay closed", { code: event.code, reason: event.reason, wasClean: event.wasClean });
    });
    socket.on("error", (error: unknown) => {
      log("relay error", { error: String(error) });
    });
    socket.on("action", (action: number) => {
      log("app custom action", { action });
    });
  }

  private handleDeviceEvent(event: DglabSocketDeviceEventPayload, clientId: string): void {
    // V4 events always carry slotId; V3-shaped events are ignored (v1 is V4-only).
    const slotId = (event as { slotId?: unknown }).slotId;
    if (typeof slotId !== "string") {
      return;
    }
    if ((event as { removed?: unknown }).removed === true) {
      this.shadow.delete(shadowKey(clientId, slotId, "A"));
      this.shadow.delete(shadowKey(clientId, slotId, "B"));
      this.telemetryAt.delete(`${clientId}|${slotId}`);
      log("device removed", { clientId, slotId });
      return;
    }
    const props = asRecord((event as { props?: unknown }).props);
    const intensityA = (event as { intensityA?: unknown }).intensityA ?? props.intensityA;
    const intensityB = (event as { intensityB?: unknown }).intensityB ?? props.intensityB;
    if (intensityA !== undefined || intensityB !== undefined) {
      this.noteTelemetryAt(clientId, slotId);
    }
    log("device telemetry", { clientId, slotId, event });
  }

  private dropKeysForClient(clientId: string): void {
    const prefix = `${clientId}|`;
    for (const key of [...this.shadow.keys(), ...this.telemetryAt.keys()]) {
      if (key.startsWith(prefix)) {
        this.shadow.delete(key);
        this.telemetryAt.delete(key);
      }
    }
  }
}

function shadowKey(clientId: string, slotId: string, channel: Channel): string {
  return `${clientId}|${slotId}|${channel}`;
}
