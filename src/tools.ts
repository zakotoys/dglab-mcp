import type { DesignSegment } from "@dg-kit/waveforms";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { isDglabError } from "./errors.js";
import { log } from "./log.js";
import type { DglabService } from "./service.js";

const targetIds = {
  clientId: z
    .string()
    .optional()
    .describe("Paired app (controlled client) id. Omit when exactly one app is attached."),
  slotId: z
    .string()
    .optional()
    .describe("Device slot id within the app. Omit when exactly one compatible device exists."),
};

const channel = z.enum(["A", "B"]).describe("Output channel");

const frequencyHz = z
  .number()
  .min(1)
  .max(100)
  .optional()
  .describe("Pulse frequency in hertz (1-100). Default 10 Hz (a 100 ms pulse period).");

const segmentSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ramp"),
    from: z.number().min(0).max(100).describe("Start width percent (0-100)."),
    to: z.number().min(0).max(100).describe("End width percent (0-100)."),
    durationMs: z
      .number()
      .int()
      .min(25)
      .max(30000)
      .describe("Segment duration; rounded to the 25 ms grid."),
    frequencyHz,
  }),
  z.object({
    type: z.literal("hold"),
    intensity: z.number().min(0).max(100).describe("Width percent (0-100)."),
    durationMs: z
      .number()
      .int()
      .min(25)
      .max(30000)
      .describe("Segment duration; rounded to the 25 ms grid."),
    frequencyHz,
  }),
  z.object({
    type: z.literal("pulse"),
    intensity: z.number().min(0).max(100).describe("On-phase width percent (0-100)."),
    onMs: z.number().int().min(25).max(30000).describe("On-phase duration."),
    offMs: z.number().int().min(25).max(30000).describe("Off-phase duration."),
    count: z.number().int().min(1).max(1000).describe("Number of on/off cycles."),
    frequencyHz,
  }),
  z.object({
    type: z.literal("silence"),
    durationMs: z.number().int().min(25).max(30000).describe("Silent duration."),
  }),
]);

/**
 * Convert the tool-facing segment model (frequency in hertz) to the compiler
 * model (pulse period in milliseconds): 1-100 Hz maps to 1000-10 ms.
 */
function toDesignSegments(segments: z.infer<typeof segmentSchema>[]): DesignSegment[] {
  return segments.map((segment) => {
    if (segment.type === "silence") {
      return segment;
    }
    const frequencyMs =
      segment.frequencyHz === undefined ? undefined : Math.round(1000 / segment.frequencyHz);
    return { ...segment, frequencyMs };
  });
}

type ToolResult = {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/png" }
  >;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

function success(structured: Record<string, unknown>, text: string): ToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: { ok: true, ...structured },
  };
}

function failure(error: unknown): ToolResult {
  if (isDglabError(error)) {
    return {
      content: [
        {
          type: "text",
          text: `${error.code}: ${error.message}${error.details ? ` ${JSON.stringify(error.details)}` : ""}`,
        },
      ],
      structuredContent: { ok: false, code: error.code, message: error.message, ...error.details },
      isError: true,
    };
  }
  const message = (error as Error)?.message ?? String(error);
  log("tool call failed unexpectedly", { error });
  return {
    content: [{ type: "text", text: `INTERNAL: ${message}` }],
    structuredContent: { ok: false, code: "INTERNAL", message },
    isError: true,
  };
}

/** Register every dglab tool on the MCP server. */
export function registerTools(server: McpServer, service: DglabService, config: Config): void {
  server.registerTool(
    "dglab_connect",
    {
      title: "Connect DG-LAB relay",
      description:
        "Start (or reuse) the DG-LAB 4 V4 relay session. Returns the pairing QR code (PNG), the app socket URL, and the session link. Scan the QR code or open the link with the DG-LAB 4 mobile app to pair. Safe to call again to fetch pairing info for an existing session.",
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const result = await service.connect();
        return {
          content: [
            {
              type: "text",
              text: `Relay session ${result.session.state}. Pair the DG-LAB 4 app by scanning the QR code or opening: ${result.session.sessionLink}`,
            },
            { type: "image", data: result.qrBase64, mimeType: "image/png" },
          ],
          structuredContent: {
            ok: true,
            state: result.session.state,
            targetId: result.session.targetId,
            appSocketUrl: result.session.appSocketUrl,
            sessionLink: result.session.sessionLink,
            qrPngBytes: result.qrBytes,
          },
        };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "dglab_disconnect",
    {
      title: "Disconnect relay session",
      description:
        "Emergency-stop every device, then destroy the relay session and all cached pairing state.",
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const stopped = await service.disconnect();
        return success(
          { ...stopped },
          `Disconnected. Emergency stop dispatched to ${stopped.clients} app(s), ${stopped.devices} device(s).`,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "dglab_get_status",
    {
      title: "Get DG-LAB status",
      description:
        "Read relay state, the safety lease, paired apps, devices (battery, Bluetooth state, A/B intensity, channel condition, mute, comfort limits, effective ceilings), and waveform tasks. Set refresh to re-query device lists from the apps first.",
      inputSchema: {
        refresh: z
          .boolean()
          .optional()
          .describe("Re-request the device list from every paired app before reporting."),
        ...targetIds,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const status = await service.getStatus({
          refresh: args.refresh,
          clientId: args.clientId,
          slotId: args.slotId,
        });
        const deviceLines = status.clients.flatMap((client) =>
          client.devices.map((device) => {
            const a = device.channels.A.intensity ?? "?";
            const b = device.channels.B.intensity ?? "?";
            return `- ${device.name} [${device.deviceType}] app=${client.clientId} slot=${device.slotId} battery=${device.battery ?? "?"}% bt=${device.connected === true ? "connected" : device.connected === false ? "disconnected" : "unknown"} A=${a} B=${b} ceiling A/B=${device.ceilings.A}/${device.ceilings.B}`;
          }),
        );
        const lease = status.safety.lease;
        return success(
          { ...status },
          [
            `Relay ${status.session.state}${status.session.targetId ? ` (target ${status.session.targetId})` : ""}; lease ${lease.active ? `active, ${lease.remainingMs}ms left` : "inactive"}${status.safety.lastTrip ? `; last trip: ${status.safety.lastTrip.reason}` : ""}; active tasks: ${status.tasks.active.length}.`,
            deviceLines.length > 0 ? deviceLines.join("\n") : "No devices attached.",
            status.refreshErrors.length > 0
              ? `Refresh errors: ${status.refreshErrors.join("; ")}`
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "dglab_set_intensity",
    {
      title: "Set channel intensity",
      description: `Set one output channel (A or B) to an absolute target on the 0-200 scale. The target must not exceed the effective ceiling (software cap DGLAB_MAX_INTENSITY=${config.maxIntensity} tightened by device limits) and increases are limited to steps of ${config.maxStep}. Reductions and 0 are always allowed.`,
      inputSchema: {
        ...targetIds,
        channel,
        target: z.number().int().min(0).max(200).describe("Absolute intensity target (0-200)."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const result = await service.setIntensity({
          clientId: args.clientId,
          slotId: args.slotId,
          channel: args.channel,
          target: args.target,
        });
        return success(
          { ...result },
          `Channel ${result.channel} set to ${result.target} (was ${result.previous ?? "unknown"}, ceiling ${result.ceiling}) on ${result.slotId}.`,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "dglab_adjust_intensity",
    {
      title: "Adjust channel intensity",
      description: `Apply a signed intensity delta to one channel. Positive deltas are limited to +${config.maxStep} per call and to the effective ceiling; negative deltas are unrestricted.`,
      inputSchema: {
        ...targetIds,
        channel,
        delta: z.number().int().min(-200).max(200).describe("Signed intensity delta."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const result = await service.adjustIntensity({
          clientId: args.clientId,
          slotId: args.slotId,
          channel: args.channel,
          delta: args.delta,
        });
        return success(
          { ...result },
          `Channel ${result.channel} adjusted by ${result.appliedDelta} to ${result.target} (was ${result.previous}, ceiling ${result.ceiling}) on ${result.slotId}.`,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "dglab_list_waveforms",
    {
      title: "List waveforms",
      description:
        "List built-in Coyote presets and external .pulse waveforms with ids, labels, source, and natural duration. The pulse directory is rescanned on every call, so newly added or changed files appear immediately.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const result = await service.listWaveforms();
        const lines = [
          ...result.builtin.map(
            (w) => `- ${w.id} ("${w.name}" / ${w.labels.cn}, builtin, ${w.naturalDurationMs}ms)`,
          ),
          ...result.external.map((w) => `- ${w.id} ("${w.name}", file, ${w.naturalDurationMs}ms)`),
        ];
        const errorLines = result.errors.map((e) => `- ${e.file}: ${e.error}`);
        return success(
          { ...result },
          `${result.builtin.length} builtin and ${result.external.length} external waveforms.${errorLines.length > 0 ? `\nUnreadable files:\n${errorLines.join("\n")}` : ""}\n${lines.join("\n")}`,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "dglab_play_waveform",
    {
      title: "Play named waveform",
      description: `Play a named waveform (built-in preset or hot-loaded .pulse file; matching is case/separator-insensitive across ids and English/Chinese names) on one channel. Optionally repeat or truncate it to durationMs (max ${config.maxWaveformDurationMs}ms). Requires a safe nonzero intensity on the channel; never changes intensity. Playback replaces the channel's current waveform task.`,
      inputSchema: {
        ...targetIds,
        channel,
        name: z.string().min(1).describe("Waveform name or id."),
        durationMs: z
          .number()
          .int()
          .min(100)
          .max(30000)
          .optional()
          .describe("Bound the playback to this duration by repeating/truncating."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const result = await service.playWaveform({
          clientId: args.clientId,
          slotId: args.slotId,
          channel: args.channel,
          name: args.name,
          durationMs: args.durationMs,
        });
        return success(
          { ...result },
          `Waveform "${result.waveform}" playing on channel ${result.channel} for ${result.durationMs}ms (task ${result.taskId}).`,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "dglab_play_custom_waveform",
    {
      title: "Play custom waveform",
      description: `Compile and play semantic waveform segments (ramp, hold, pulse, silence) on one channel. Total duration is capped at ${config.maxWaveformDurationMs}ms. Requires a safe nonzero intensity on the channel; never changes intensity.`,
      inputSchema: {
        ...targetIds,
        channel,
        segments: z
          .array(segmentSchema)
          .min(1)
          .max(64)
          .describe("Waveform segments compiled in order."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const result = await service.playCustomWaveform({
          clientId: args.clientId,
          slotId: args.slotId,
          channel: args.channel,
          segments: toDesignSegments(args.segments),
        });
        return success(
          { ...result },
          `Custom waveform (${result.octetCount} octets) playing on channel ${result.channel} for ${result.durationMs}ms (task ${result.taskId}).`,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "dglab_stop_channel",
    {
      title: "Stop channel",
      description: "Clear all waveform tasks and reset the intensity of one channel to 0.",
      inputSchema: { ...targetIds, channel },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const result = await service.stopChannel({
          clientId: args.clientId,
          slotId: args.slotId,
          channel: args.channel,
        });
        return success(
          { ...result },
          `Channel ${result.channel} on ${result.slotId} stopped (${result.runningTasksCleared} running task(s) cleared, intensity reset to 0).`,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "dglab_emergency_stop",
    {
      title: "Emergency stop",
      description:
        "Immediately stop every channel and waveform task on every paired app and device, bypassing all queues. Cannot be undone by pending commands.",
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const result = await service.emergencyStop();
        return success(
          { ...result },
          `Emergency stop dispatched to ${result.clients} app(s), ${result.devices} device(s).${result.errors.length > 0 ? ` Errors: ${result.errors.join("; ")}` : ""}`,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "dglab_heartbeat",
    {
      title: "Renew safety lease",
      description: `Renew the control lease (timeout ${config.heartbeatTimeoutMs}ms) to keep output enabled while idle. When no output is active this succeeds as a no-op. If the lease ever expires, all outputs are stopped automatically.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const renewed = service.heartbeat();
        if (renewed === null) {
          return success(
            { lease: { active: false } },
            "No active control lease; nothing to renew.",
          );
        }
        return success(
          { lease: renewed },
          `Control lease renewed; expires in ${renewed.remainingMs}ms.`,
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
}
