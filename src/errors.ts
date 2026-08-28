/**
 * Stable error codes surfaced to MCP clients in failure envelopes.
 */
export type ErrorCode =
  | "NOT_CONNECTED"
  | "AMBIGUOUS_TARGET"
  | "DEVICE_NOT_READY"
  | "SAFETY_LIMIT"
  | "INVALID_WAVEFORM"
  | "RELAY_ERROR"
  | "CANCELLED"
  | "INTERNAL";

export class DglabError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "DglabError";
    this.code = code;
    this.details = details;
  }
}

export function isDglabError(error: unknown): error is DglabError {
  return error instanceof DglabError;
}

export function notConnected(message: string, details?: Record<string, unknown>): DglabError {
  return new DglabError("NOT_CONNECTED", message, details);
}

export function ambiguousTarget(message: string, details?: Record<string, unknown>): DglabError {
  return new DglabError("AMBIGUOUS_TARGET", message, details);
}

export function deviceNotReady(message: string, details?: Record<string, unknown>): DglabError {
  return new DglabError("DEVICE_NOT_READY", message, details);
}

export function safetyLimit(message: string, details?: Record<string, unknown>): DglabError {
  return new DglabError("SAFETY_LIMIT", message, details);
}

export function invalidWaveform(message: string, details?: Record<string, unknown>): DglabError {
  return new DglabError("INVALID_WAVEFORM", message, details);
}

export function relayError(message: string, details?: Record<string, unknown>): DglabError {
  return new DglabError("RELAY_ERROR", message, details);
}
