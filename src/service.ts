import type { DesignSegment } from "@dg-kit/waveforms";
import { V4Channel, type V4SendPromise } from "dglab-kit";
import type { Config } from "./config.js";
import { DglabError, isDglabError, notConnected, relayError } from "./errors.js";
import { log } from "./log.js";
import { qrPng } from "./qr.js";
import {
  type LeaseState,
  SafetyController,
  type TripRecord,
  validateDelta,
  validateTarget,
} from "./safety.js";
import { DglabSession, type SessionSnapshot } from "./session.js";
import { type ResolvedTarget, resolveTarget, type TargetSelector } from "./targets.js";
import {
  type Channel,
  channelOf,
  type DeviceTelemetry,
  effectiveCeiling,
  normalizeDevice,
} from "./telemetry.js";
import {
  type FileError,
  loadCatalog,
  lookupWaveform,
  type WaveformEntry,
} from "./waveforms/catalog.js";
import { boundPlayback, compileCustomSegments } from "./waveforms/compile.js";

export type TaskState = "running" | "completed" | "cleared" | "replaced" | "cancelled" | "failed";

export interface TaskRecord {
  taskId: string;
  clientId: string;
  slotId: string;
  channel: Channel;
  waveform: string;
  requestedDurationMs: number;
  startedAt: number;
  state: TaskState;
  endedAt: number | null;
  error: string | null;
}

export interface ConnectResult {
  session: SessionSnapshot;
  qrBase64: string;
  qrBytes: number;
}

export interface IntensityResult {
  clientId: string;
  slotId: string;
  channel: Channel;
  previous: number | null;
  target: number;
  appliedDelta: number | null;
  ceiling: number;
}

export interface PlayResult {
  taskId: string;
  clientId: string;
  slotId: string;
  channel: Channel;
  waveform: string;
  durationMs: number;
  octetCount: number;
  naturalDurationMs: number;
}

export interface StopChannelResult {
  clientId: string;
  slotId: string;
  channel: Channel;
  runningTasksCleared: number;
}

export interface EmergencyStopResult {
  clients: number;
  devices: number;
  dispatches: string[];
  errors: string[];
}

export interface StatusResult {
  session: SessionSnapshot;
  safety: {
    lease: LeaseState;
    lastTrip: TripRecord | null;
    maxIntensity: number;
    maxStep: number;
    heartbeatTimeoutMs: number;
    maxWaveformDurationMs: number;
  };
  clients: Array<{
    clientId: string;
    devices: Array<DeviceTelemetry & { ceilings: Record<Channel, number> }>;
  }>;
  tasks: {
    active: TaskRecord[];
    recent: TaskRecord[];
  };
  refreshErrors: string[];
}

export interface ListWaveformsResult {
  pulseDir: string;
  builtin: Array<{
    id: string;
    name: string;
    labels: { en: string; cn: string };
    naturalDurationMs: number;
  }>;
  external: Array<{
    id: string;
    name: string;
    labels: { en: string; cn: string };
    file: string;
    naturalDurationMs: number;
  }>;
  errors: FileError[];
}

/** Serializes intensity operations per device channel; invalidated by emergency stop. */
class ChannelQueue {
  generation = 0;
  private chain: Promise<unknown> = Promise.resolve();

  run<T>(generation: number, operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(async () => {
      if (generation !== this.generation) {
        throw new DglabError("CANCELLED", "operation was invalidated by a newer safety action");
      }
      return operation();
    });
    this.chain = result.catch(() => undefined);
    // A caller that drops this promise (e.g. its test already ended) must not
    // surface an unhandled rejection; attaching a handler marks it handled
    // without affecting the caller's own await.
    result.catch(() => undefined);
    return result;
  }

  invalidate(): void {
    this.generation += 1;
  }
}

const RECENT_TASK_LIMIT = 50;

/**
 * Facade composing the relay session, safety controller, and waveform
 * system into the operations the MCP tools expose.
 */
export class DglabService {
  readonly session: DglabSession;
  readonly safety: SafetyController;
  private readonly queues = new Map<string, ChannelQueue>();
  private readonly tasks = new Map<string, TaskRecord>();
  private taskCounter = 0;

  constructor(readonly config: Config) {
    this.session = new DglabSession(config.relayUrl);
    this.safety = new SafetyController(config.heartbeatTimeoutMs, async () => {
      log("control lease expired; stopping all outputs");
      await this.emergencyStop("heartbeat_timeout");
    });
  }

  /**
   * Start or reuse the relay session and return pairing material, including
   * the QR code rendered as PNG.
   */
  async connect(): Promise<ConnectResult> {
    try {
      await this.session.ensureConnected();
    } catch (error) {
      throw relayError(`relay connection failed: ${message(error)}`, {
        relayUrl: this.config.relayUrl,
      });
    }
    const link = this.session.sessionLink;
    if (link === null) {
      throw relayError("relay did not assign a target id");
    }
    const png = await qrPng(link);
    log("relay session ready", { targetId: this.session.targetId, qrBytes: png.length });
    return {
      session: this.session.snapshot(),
      qrBase64: png.toString("base64"),
      qrBytes: png.length,
    };
  }

  async disconnect(): Promise<EmergencyStopResult> {
    const stopped = await this.emergencyStop("disconnect");
    this.session.destroy(1000, "client_disconnect");
    this.safety.disarm();
    this.queues.clear();
    log("session destroyed by client");
    return stopped;
  }

  heartbeat(now: number = Date.now()): ReturnType<SafetyController["renew"]> {
    return this.safety.renew(now);
  }

  async getStatus(
    options: { refresh?: boolean; clientId?: string; slotId?: string } = {},
  ): Promise<StatusResult> {
    const refreshErrors: string[] = [];
    const socket = this.session.v4Socket;
    if (options.refresh && socket !== null && this.session.state === "paired") {
      const targets = this.session.clients.filter(
        (client) => options.clientId === undefined || client.clientId === options.clientId,
      );
      const results = await Promise.allSettled(
        targets.map((client) => socket.requestDevices(client.clientId)),
      );
      for (const result of results) {
        if (result.status === "rejected") {
          refreshErrors.push(message(result.reason));
        }
      }
    }

    let clients = this.session.clients.map((client) => ({
      clientId: client.clientId,
      devices: client.devices.map((info) => {
        const telemetry = normalizeDevice(client.clientId, info);
        return {
          ...telemetry,
          ceilings: {
            A: effectiveCeiling(this.config.maxIntensity, telemetry, "A"),
            B: effectiveCeiling(this.config.maxIntensity, telemetry, "B"),
          },
        };
      }),
    }));

    if (options.clientId !== undefined) {
      clients = clients.filter((client) => client.clientId === options.clientId);
    }
    if (options.slotId !== undefined) {
      clients = clients
        .map((client) => ({
          ...client,
          devices: client.devices.filter((device) => device.slotId === options.slotId),
        }))
        .filter((client) => client.devices.length > 0);
    }

    const taskList = [...this.tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
    return {
      session: this.session.snapshot(),
      safety: {
        lease: this.safety.lease(),
        lastTrip: this.safety.lastTrip,
        maxIntensity: this.config.maxIntensity,
        maxStep: this.config.maxStep,
        heartbeatTimeoutMs: this.config.heartbeatTimeoutMs,
        maxWaveformDurationMs: this.config.maxWaveformDurationMs,
      },
      clients,
      tasks: {
        active: taskList.filter((task) => task.state === "running"),
        recent: taskList.filter((task) => task.state !== "running").slice(0, 10),
      },
      refreshErrors,
    };
  }

  async listWaveforms(): Promise<ListWaveformsResult> {
    const catalog = await loadCatalog(this.config.pulseDir);
    return {
      pulseDir: this.config.pulseDir,
      builtin: catalog.builtin.map(toWaveformSummary),
      external: catalog.external.map((entry) => ({
        ...toWaveformSummary(entry),
        file: entry.file ?? "",
      })),
      errors: catalog.errors,
    };
  }

  async setIntensity(
    selector: TargetSelector & { channel: Channel; target: number },
  ): Promise<IntensityResult> {
    return this.enqueueFor(selector, async (pinned) => {
      const telemetry = this.requireTelemetry(pinned);
      this.requireDeviceReady(telemetry);
      const ceiling = effectiveCeiling(this.config.maxIntensity, telemetry, pinned.channel);
      const current = this.session.currentIntensity(telemetry, pinned.channel);
      if (pinned.target > 0 && current === null) {
        throw notConnected(
          "current intensity is unknown; wait for device telemetry before nonzero output",
          { slotId: telemetry.slotId, channel: pinned.channel },
        );
      }
      validateTarget(current, pinned.target, ceiling, this.config.maxStep);

      const delta = current === null ? null : pinned.target - current;
      if (delta === null || delta !== 0) {
        await this.dispatchIntensity(
          telemetry.clientId,
          telemetry.slotId,
          pinned.channel,
          delta ?? "reset",
        );
        this.session.noteDispatchedIntensity(
          telemetry.clientId,
          telemetry.slotId,
          pinned.channel,
          pinned.target,
        );
        this.safety.arm();
      }
      log("intensity set", {
        clientId: telemetry.clientId,
        slotId: telemetry.slotId,
        channel: pinned.channel,
        previous: current,
        target: pinned.target,
        delta,
      });
      return {
        clientId: telemetry.clientId,
        slotId: telemetry.slotId,
        channel: pinned.channel,
        previous: current,
        target: pinned.target,
        appliedDelta: delta,
        ceiling,
      };
    });
  }

  async adjustIntensity(
    selector: TargetSelector & { channel: Channel; delta: number },
  ): Promise<IntensityResult> {
    return this.enqueueFor(selector, async (pinned) => {
      const telemetry = this.requireTelemetry(pinned);
      this.requireDeviceReady(telemetry);
      const ceiling = effectiveCeiling(this.config.maxIntensity, telemetry, pinned.channel);
      const current = this.session.currentIntensity(telemetry, pinned.channel);
      if (current === null) {
        throw notConnected(
          "current intensity is unknown; wait for device telemetry before adjusting output",
          { slotId: telemetry.slotId, channel: pinned.channel },
        );
      }
      validateDelta(current, pinned.delta, ceiling, this.config.maxStep);
      const target = Math.max(0, Math.min(200, current + pinned.delta));
      if (pinned.delta !== 0) {
        await this.dispatchIntensity(
          telemetry.clientId,
          telemetry.slotId,
          pinned.channel,
          pinned.delta,
        );
        this.session.noteDispatchedIntensity(
          telemetry.clientId,
          telemetry.slotId,
          pinned.channel,
          target,
        );
        this.safety.arm();
      }
      log("intensity adjusted", {
        clientId: telemetry.clientId,
        slotId: telemetry.slotId,
        channel: pinned.channel,
        previous: current,
        delta: pinned.delta,
        target,
      });
      return {
        clientId: telemetry.clientId,
        slotId: telemetry.slotId,
        channel: pinned.channel,
        previous: current,
        target,
        appliedDelta: pinned.delta,
        ceiling,
      };
    });
  }

  async playWaveform(
    selector: TargetSelector & {
      channel: Channel;
      name: string;
      durationMs?: number;
    },
  ): Promise<PlayResult> {
    const catalog = await loadCatalog(this.config.pulseDir);
    const entry = lookupWaveform(selector.name, catalog);
    const bounded = boundPlayback(
      entry.octets,
      selector.durationMs,
      this.config.maxWaveformDurationMs,
    );
    return this.playOctets(entry, bounded, selector);
  }

  async playCustomWaveform(
    selector: TargetSelector & {
      channel: Channel;
      segments: DesignSegment[];
    },
  ): Promise<PlayResult> {
    const compiled = compileCustomSegments(selector.segments, this.config.maxWaveformDurationMs);
    const entry: WaveformEntry = {
      id: "custom",
      name: "custom",
      labels: { en: "Custom waveform", cn: "自定义波形" },
      source: "builtin",
      octets: compiled.octets,
      naturalDurationMs: compiled.durationMs,
    };
    return this.playOctets(
      entry,
      { octets: compiled.octets, durationMs: compiled.durationMs },
      selector,
    );
  }

  async stopChannel(selector: TargetSelector & { channel: Channel }): Promise<StopChannelResult> {
    return this.enqueueFor(selector, async (pinned) => {
      const telemetry = this.requireTelemetry(pinned);
      this.requireDeviceReady(telemetry);
      const socket = this.requireSocket();
      const channelValue = channelOf(pinned.channel);
      const runningTasksCleared = [...this.tasks.values()].filter(
        (task) =>
          task.clientId === telemetry.clientId &&
          task.slotId === telemetry.slotId &&
          task.channel === pinned.channel &&
          task.state === "running",
      ).length;
      const results = await Promise.allSettled([
        socket.clearPulse(telemetry.clientId, telemetry.slotId, channelValue),
        socket.resetIntensity(telemetry.clientId, telemetry.slotId, channelValue),
      ]);
      collectDispatchFailures(results, "stop channel");
      this.session.noteDispatchedIntensity(telemetry.clientId, telemetry.slotId, pinned.channel, 0);
      this.safety.arm();
      log("channel stopped", {
        clientId: telemetry.clientId,
        slotId: telemetry.slotId,
        channel: pinned.channel,
      });
      return {
        clientId: telemetry.clientId,
        slotId: telemetry.slotId,
        channel: pinned.channel,
        runningTasksCleared,
      };
    });
  }

  async emergencyStop(reason = "emergency_stop"): Promise<EmergencyStopResult> {
    const clients = this.session.clients;
    const dispatches: string[] = [];
    const errors: string[] = [];

    // Invalidate every queued operation first, so no stale command can land
    // after the stop.
    for (const queue of this.queues.values()) {
      queue.invalidate();
    }
    this.safety.disarm();
    this.safety.markTripped(reason);

    if (clients.length === 0) {
      return { clients: 0, devices: 0, dispatches, errors };
    }
    const socket = this.session.v4Socket;
    if (socket === null) {
      return { clients: clients.length, devices: 0, dispatches, errors: ["relay socket is gone"] };
    }

    const jobs: Array<Promise<unknown>> = [];
    let deviceCount = 0;
    for (const client of clients) {
      jobs.push(
        socket
          .clearOperate(client.clientId)
          .then(() => {
            dispatches.push(`clearOperate(${client.clientId})`);
          })
          .catch((error: unknown) => {
            errors.push(`clear ${client.clientId}: ${message(error)}`);
          }),
      );
      for (const info of client.devices) {
        deviceCount += 1;
        for (const channelValue of [V4Channel.A, V4Channel.B] as const) {
          const channel: Channel = channelValue === V4Channel.A ? "A" : "B";
          this.session.noteDispatchedIntensity(client.clientId, info.slotId, channel, 0);
          jobs.push(
            socket
              .resetIntensity(client.clientId, info.slotId, channelValue)
              .then(() => {
                dispatches.push(`resetIntensity(${client.clientId}, ${info.slotId}, ${channel})`);
              })
              .catch((error: unknown) => {
                errors.push(
                  `reset ${client.clientId}/${info.slotId}/ch${channelValue}: ${message(error)}`,
                );
              }),
          );
        }
      }
    }
    await Promise.allSettled(jobs);

    // Best-effort verification: if telemetry still shows output once the
    // dust settles, reset those channels once more.
    setTimeout(() => {
      void this.verifyZeroOutput();
    }, 500);

    log("emergency stop dispatched", { reason, clients: clients.length, devices: deviceCount });
    return { clients: clients.length, devices: deviceCount, dispatches, errors };
  }

  private async verifyZeroOutput(): Promise<void> {
    if (this.session.v4Socket === null || this.session.state !== "paired") {
      return;
    }
    for (const telemetry of this.session.listDevices()) {
      for (const channel of ["A", "B"] as const) {
        const reported = telemetry.channels[channel].intensity;
        if (reported !== null && reported > 0) {
          log("post-stop verification found nonzero intensity; resetting again", {
            slotId: telemetry.slotId,
            channel,
            reported,
          });
          try {
            await this.requireSocket().resetIntensity(
              telemetry.clientId,
              telemetry.slotId,
              channelOf(channel),
            );
          } catch (error) {
            log("post-stop reset failed", { error: message(error) });
          }
        }
      }
    }
  }

  /**
   * Resolve the target once at call time (fail-fast on ambiguity, and to pin
   * the serialization queue to the concrete device), then run the operation
   * — re-validating against fresh telemetry — inside that device's queue.
   */
  private enqueueFor<T, S extends TargetSelector & { channel: Channel }>(
    selector: S,
    operation: (pinned: ResolvedTarget & S) => Promise<T>,
  ): Promise<T> {
    const resolved = resolveTarget(this.session, selector, { requireSupported: true });
    // Concrete resolved ids must win over the selector's possibly-undefined
    // keys (tool handlers pass `clientId: undefined` explicitly).
    const pinned = { ...selector, ...resolved } as ResolvedTarget & S;
    const key = `${resolved.clientId}|${resolved.slotId}|${selector.channel}`;
    let queue = this.queues.get(key);
    if (queue === undefined) {
      queue = new ChannelQueue();
      this.queues.set(key, queue);
    }
    return queue.run(queue.generation, () => operation(pinned));
  }

  private playOctets(
    entry: WaveformEntry,
    bounded: { octets: number[][]; durationMs: number },
    selector: TargetSelector & { channel: Channel },
  ): Promise<PlayResult> {
    return this.enqueueFor(selector, async (pinned) => {
      const telemetry = this.requireTelemetry(pinned);
      this.requireDeviceReady(telemetry);
      const ceiling = effectiveCeiling(this.config.maxIntensity, telemetry, pinned.channel);
      const current = this.session.currentIntensity(telemetry, pinned.channel);
      if (current === null || current <= 0) {
        throw new DglabError(
          "DEVICE_NOT_READY",
          `channel ${pinned.channel} intensity is ${current ?? "unknown"}; set a safe nonzero intensity before playing waveforms`,
          { slotId: telemetry.slotId, channel: pinned.channel },
        );
      }
      if (current > ceiling) {
        throw new DglabError(
          "SAFETY_LIMIT",
          `current intensity ${current} exceeds the effective ceiling ${ceiling}; reduce intensity before playing waveforms`,
          { current, ceiling },
        );
      }

      const socket = this.requireSocket();
      const channelValue = channelOf(pinned.channel);
      this.taskCounter += 1;
      const taskId = `task-${this.taskCounter}`;
      const record: TaskRecord = {
        taskId,
        clientId: telemetry.clientId,
        slotId: telemetry.slotId,
        channel: pinned.channel,
        waveform: entry.name,
        requestedDurationMs: bounded.durationMs,
        startedAt: Date.now(),
        state: "running",
        endedAt: null,
        error: null,
      };
      let promise: V4SendPromise;
      try {
        promise = socket.sendPulse(
          telemetry.clientId,
          telemetry.slotId,
          channelValue,
          bounded.durationMs,
          bounded.octets,
          { immediate: true },
        );
      } catch (error) {
        throw relayError(`waveform dispatch failed: ${message(error)}`);
      }
      this.tasks.set(taskId, record);
      this.pruneTasks();
      void promise.then(
        (result: unknown) => {
          const reason = (result as { reason?: string } | undefined)?.reason;
          record.state = normalizeTaskState(reason);
          record.endedAt = Date.now();
          log("waveform task settled", { taskId, state: record.state });
        },
        (error: unknown) => {
          record.state = "failed";
          record.endedAt = Date.now();
          record.error = message(error);
          log("waveform task failed", { taskId, error: record.error });
        },
      );
      this.safety.arm();
      log("waveform dispatched", {
        taskId,
        waveform: entry.name,
        channel: pinned.channel,
        octets: bounded.octets.length,
        naturalOctets: entry.octets.length,
        durationMs: bounded.durationMs,
      });
      return {
        taskId,
        clientId: telemetry.clientId,
        slotId: telemetry.slotId,
        channel: pinned.channel,
        waveform: entry.name,
        durationMs: bounded.durationMs,
        octetCount: bounded.octets.length,
        naturalDurationMs: entry.naturalDurationMs,
      };
    });
  }

  private async dispatchIntensity(
    clientId: string,
    slotId: string,
    channel: Channel,
    action: number | "reset",
  ): Promise<unknown> {
    const socket = this.requireSocket();
    const channelValue = channelOf(channel);
    try {
      if (action === "reset") {
        return await socket.resetIntensity(clientId, slotId, channelValue);
      }
      if (action > 0) {
        return await socket.addIntensity(clientId, slotId, channelValue, action);
      }
      return await socket.reduceStrength(clientId, slotId, channelValue, -action);
    } catch (error) {
      throw relayError(`device rejected intensity command: ${message(error)}`, {
        clientId,
        slotId,
        channel,
        action,
      });
    }
  }

  private requireSocket() {
    const socket = this.session.v4Socket;
    if (socket === null || this.session.state === "disconnected" || this.session.state === "idle") {
      throw notConnected("no relay session; call dglab_connect first");
    }
    return socket;
  }

  private requireTelemetry(pinned: ResolvedTarget): DeviceTelemetry {
    const info = this.session.getDevice(pinned.clientId, pinned.slotId);
    if (info === undefined) {
      throw new DglabError("DEVICE_NOT_READY", "device disappeared from the paired app", {
        clientId: pinned.clientId,
        slotId: pinned.slotId,
      });
    }
    return normalizeDevice(pinned.clientId, info);
  }

  private requireDeviceReady(telemetry: DeviceTelemetry): void {
    if (!telemetry.supported) {
      throw new DglabError(
        "DEVICE_NOT_READY",
        `device type ${telemetry.deviceType} is not supported for output control; only Coyote V2/V3 are`,
        { deviceType: telemetry.deviceType, slotId: telemetry.slotId },
      );
    }
    if (telemetry.connected !== true) {
      throw new DglabError("DEVICE_NOT_READY", "device is not connected over Bluetooth", {
        slotId: telemetry.slotId,
        connected: telemetry.connected,
      });
    }
  }

  private pruneTasks(): void {
    const settled = [...this.tasks.entries()].filter(([, task]) => task.state !== "running");
    if (settled.length <= RECENT_TASK_LIMIT) {
      return;
    }
    settled.sort((a, b) => (b[1].endedAt ?? 0) - (a[1].endedAt ?? 0));
    for (const [id] of settled.slice(RECENT_TASK_LIMIT)) {
      this.tasks.delete(id);
    }
  }
}

function toWaveformSummary(entry: WaveformEntry) {
  return {
    id: entry.id,
    name: entry.name,
    labels: entry.labels,
    naturalDurationMs: entry.naturalDurationMs,
  };
}

function normalizeTaskState(reason: string | undefined): TaskState {
  if (
    reason === "completed" ||
    reason === "cleared" ||
    reason === "replaced" ||
    reason === "cancelled"
  ) {
    return reason;
  }
  return "completed";
}

function collectDispatchFailures(results: PromiseSettledResult<unknown>[], what: string): void {
  for (const result of results) {
    if (result.status === "rejected") {
      throw relayError(`${what} failed: ${message(result.reason)}`);
    }
  }
}

function message(error: unknown): string {
  if (isDglabError(error)) {
    return error.message;
  }
  return (error as Error)?.message ?? String(error);
}
