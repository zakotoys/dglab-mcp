import type { V4DeviceInfo } from "dglab-kit";

export type Channel = "A" | "B";

export const CHANNELS: readonly Channel[] = ["A", "B"];

export function channelOf(channel: Channel): 0 | 1 {
  return channel === "A" ? 0 : 1;
}

/** Device families the output tools accept; everything else is telemetry-only. */
const SUPPORTED_TYPES = new Set(["COYOTE_020", "COYOTE_030"]);

export interface ComfortLimit {
  mode: string | null;
  comfortMax: number | null;
  absoluteMax: number | null;
  overheat: boolean | null;
}

export interface ChannelTelemetry {
  intensity: number | null;
  muted: boolean | null;
  warmUpScale: number | null;
  /** App-advertised maximum for this channel, if any. */
  intensityMax: number | null;
  comfortLimit: ComfortLimit | null;
  /** COYOTE_030 channel output status (0-4), when reported. */
  outputStatus: number | null;
}

export interface DeviceTelemetry {
  clientId: string;
  slotId: string;
  name: string;
  deviceType: string;
  /** Coyote V2/V3 — the only device families v1 outputs to. */
  supported: boolean;
  /** Bluetooth link state as reported by the app, null when unknown. */
  connected: boolean | null;
  battery: number | null;
  channels: Record<Channel, ChannelTelemetry>;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function normalizeComfortLimit(raw: unknown): ComfortLimit | null {
  if (raw === undefined) {
    return null;
  }
  const record = asRecord(raw);
  const mode = record.mode;
  return {
    mode: typeof mode === "string" ? mode : null,
    comfortMax: asNumber(record.comfortMax),
    absoluteMax: asNumber(record.absoluteMax),
    overheat: typeof record.overheat === "boolean" ? record.overheat : null,
  };
}

function normalizeChannel(channel: Record<string, unknown>): ChannelTelemetry {
  return {
    intensity: asNumber(channel.intensity),
    muted: typeof channel.isMuted === "boolean" ? channel.isMuted : null,
    warmUpScale: asNumber(channel.warmUpScale),
    intensityMax: asNumber(channel.intensityMax),
    comfortLimit: normalizeComfortLimit(channel.comfortLimit),
    outputStatus: asNumber(channel.outputStatus),
  };
}

function normalizeConnected(
  props: Record<string, unknown>,
  slotState: Record<string, unknown>,
): boolean | null {
  const connectState = props.connectState;
  if (typeof connectState === "string") {
    return connectState === "connected";
  }
  const hasDevice = slotState.hasDevice;
  if (typeof hasDevice === "boolean") {
    return hasDevice;
  }
  return null;
}

/**
 * Merge a (possibly partial) telemetry update into a stored snapshot.
 * Patches from `slots.patch` only carry changed fields, so `undefined`
 * leaves the previous value untouched.
 */
export function applyChannelPatch(
  previous: ChannelTelemetry,
  patch: Record<string, unknown>,
): ChannelTelemetry {
  const comfortPatch = patch.comfortLimit;
  return {
    intensity: patch.intensity === undefined ? previous.intensity : asNumber(patch.intensity),
    muted:
      patch.isMuted === undefined
        ? previous.muted
        : typeof patch.isMuted === "boolean"
          ? patch.isMuted
          : null,
    warmUpScale:
      patch.warmUpScale === undefined ? previous.warmUpScale : asNumber(patch.warmUpScale),
    intensityMax:
      patch.intensityMax === undefined ? previous.intensityMax : asNumber(patch.intensityMax),
    comfortLimit:
      comfortPatch === undefined
        ? previous.comfortLimit
        : (normalizeComfortLimit(comfortPatch) ?? previous.comfortLimit),
    outputStatus:
      patch.outputStatus === undefined ? previous.outputStatus : asNumber(patch.outputStatus),
  };
}

export function normalizeDevice(
  clientId: string,
  info: V4DeviceInfo,
  previous?: DeviceTelemetry,
): DeviceTelemetry {
  const props = asRecord(info.props);
  const slotState = asRecord(info.slotState);
  const channelA = asRecord(slotState.channelA);
  const channelB = asRecord(slotState.channelB);

  const connected =
    props.connectState === undefined && slotState.hasDevice === undefined
      ? (previous?.connected ?? null)
      : normalizeConnected(props, slotState);

  if (previous === undefined) {
    const channelATelemetry = normalizeChannel(channelA);
    const channelBTelemetry = normalizeChannel(channelB);
    if (props.intensityA !== undefined) {
      channelATelemetry.intensity = asNumber(props.intensityA);
    }
    if (props.intensityB !== undefined) {
      channelBTelemetry.intensity = asNumber(props.intensityB);
    }
    if (props.channelAStatus !== undefined) {
      channelATelemetry.outputStatus = asNumber(props.channelAStatus);
    }
    if (props.channelBStatus !== undefined) {
      channelBTelemetry.outputStatus = asNumber(props.channelBStatus);
    }
    return {
      clientId,
      slotId: info.slotId,
      name: info.name,
      deviceType: info.type,
      supported: SUPPORTED_TYPES.has(info.type),
      connected,
      battery: props.power === undefined ? null : asNumber(props.power),
      channels: { A: channelATelemetry, B: channelBTelemetry },
    };
  }

  return {
    clientId,
    slotId: info.slotId,
    name: info.name,
    deviceType: info.type,
    supported: SUPPORTED_TYPES.has(info.type),
    connected,
    battery: props.power === undefined ? previous.battery : asNumber(props.power),
    channels: {
      A: applyChannelPatch(
        previous.channels.A,
        channelPatch(props, channelA, "intensityA", "channelAStatus"),
      ),
      B: applyChannelPatch(
        previous.channels.B,
        channelPatch(props, channelB, "intensityB", "channelBStatus"),
      ),
    },
  };
}

/**
 * Collect only the fields a telemetry update explicitly carries, so absent
 * fields leave the previous snapshot untouched.
 */
function channelPatch(
  props: Record<string, unknown>,
  channelState: Record<string, unknown>,
  intensityKey: "intensityA" | "intensityB",
  statusKey: "channelAStatus" | "channelBStatus",
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (props[intensityKey] !== undefined) {
    patch.intensity = props[intensityKey];
  }
  if (channelState.isMuted !== undefined) {
    patch.isMuted = channelState.isMuted;
  }
  if (channelState.warmUpScale !== undefined) {
    patch.warmUpScale = channelState.warmUpScale;
  }
  if (channelState.intensityMax !== undefined) {
    patch.intensityMax = channelState.intensityMax;
  }
  if (channelState.comfortLimit !== undefined) {
    patch.comfortLimit = channelState.comfortLimit;
  }
  if (props[statusKey] !== undefined) {
    patch.outputStatus = props[statusKey];
  }
  return patch;
}

/**
 * Effective ceiling for one channel: the software cap tightened by every
 * numeric limit the app or device advertises.
 */
export function effectiveCeiling(
  softwareCap: number,
  telemetry: DeviceTelemetry,
  channel: Channel,
): number {
  let ceiling = softwareCap;
  const ch = telemetry.channels[channel];
  const limits: Array<number | null> = [
    ch.intensityMax,
    ch.comfortLimit?.comfortMax ?? null,
    ch.comfortLimit?.absoluteMax ?? null,
  ];
  for (const limit of limits) {
    if (limit !== null && Number.isFinite(limit) && limit < ceiling) {
      ceiling = Math.floor(limit);
    }
  }
  return Math.max(0, ceiling);
}
