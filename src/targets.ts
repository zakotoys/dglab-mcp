import { ambiguousTarget, deviceNotReady, notConnected } from "./errors.js";
import type { DglabSession } from "./session.js";
import type { DeviceTelemetry } from "./telemetry.js";
import { normalizeDevice } from "./telemetry.js";

export interface TargetSelector {
  clientId?: string;
  slotId?: string;
}

export interface ResolvedTarget {
  clientId: string;
  slotId: string;
  telemetry: DeviceTelemetry;
}

export interface CandidateSummary {
  clientId: string;
  slotId: string;
  name: string;
  deviceType: string;
}

function candidateOf(telemetry: DeviceTelemetry): CandidateSummary {
  return {
    clientId: telemetry.clientId,
    slotId: telemetry.slotId,
    name: telemetry.name,
    deviceType: telemetry.deviceType,
  };
}

function collectDevices(session: DglabSession, clientId: string | undefined): DeviceTelemetry[] {
  const clients =
    clientId === undefined
      ? session.clients
      : [session.getClient(clientId)].filter((client) => client !== undefined);
  const devices: DeviceTelemetry[] = [];
  for (const client of clients) {
    for (const info of client.devices) {
      devices.push(normalizeDevice(client.clientId, info));
    }
  }
  return devices;
}

/**
 * Resolve the device a tool call should act on. Omitted identifiers resolve
 * only when exactly one compatible device remains across all paired apps;
 * otherwise the failure lists the candidates without sending anything.
 */
export function resolveTarget(
  session: DglabSession,
  selector: TargetSelector,
  options: { requireSupported: boolean },
): ResolvedTarget {
  const state = session.state;
  if (state !== "paired" && state !== "waiting_for_peer") {
    throw notConnected(`relay session is ${state}; call dglab_connect and pair an app first`, {
      state,
      targetId: session.targetId,
    });
  }

  const clientId = selector.clientId;
  if (clientId !== undefined && session.getClient(clientId) === undefined) {
    throw ambiguousTarget(`no attached app with clientId "${clientId}"`, {
      clientId,
      candidates: session.clients.map((client) => ({ clientId: client.clientId })),
    });
  }

  let devices = collectDevices(session, clientId);
  const slotId = selector.slotId;
  if (slotId !== undefined) {
    devices = devices.filter((device) => device.slotId === slotId);
    if (devices.length === 0) {
      const known = collectDevices(session, clientId).map(candidateOf);
      throw deviceNotReady(`no device with slotId "${slotId}" on the targeted app`, {
        slotId,
        candidates: known,
      });
    }
  }

  if (options.requireSupported) {
    devices = devices.filter((device) => device.supported);
    if (devices.length === 0) {
      const all = collectDevices(session, clientId);
      throw deviceNotReady(
        all.length === 0
          ? "the targeted app has no attached devices"
          : "no compatible Coyote device is available for output control",
        { candidates: all.map(candidateOf) },
      );
    }
  }

  if (devices.length > 1) {
    throw ambiguousTarget(
      `${devices.length} compatible devices match; pass clientId and/or slotId to choose one`,
      { candidates: devices.map(candidateOf) },
    );
  }

  const telemetry = devices[0]!;
  return { clientId: telemetry.clientId, slotId: telemetry.slotId, telemetry };
}
