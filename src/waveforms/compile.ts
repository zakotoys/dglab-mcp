import type { WaveFrame } from "@dg-kit/core";
import { compileWaveformDesign, type DesignSegment } from "@dg-kit/waveforms";
import { invalidWaveform } from "../errors.js";

/** One protocol tick — a V3-format octet carries four 25 ms frames. */
export const OCTET_MS = 100;
export const FRAME_MS = 25;

/** Default frequency-period encoding for silent frames; value is irrelevant at 0% intensity. */
const SILENCE_FRAME: WaveFrame = [100, 0];

/**
 * Convert 25 ms semantic frames into V3-format octets, each holding four
 * `[freq, intensity]` steps as `[f1, f2, f3, f4, i1, i2, i3, i4]`. The final
 * group is padded with silence.
 */
export function framesToOctets(frames: WaveFrame[]): number[][] {
  const octets: number[][] = [];
  for (let index = 0; index < frames.length; index += 4) {
    const group: WaveFrame[] = [];
    for (let step = 0; step < 4; step += 1) {
      group.push(frames[index + step] ?? SILENCE_FRAME);
    }
    octets.push([
      group[0]![0],
      group[1]![0],
      group[2]![0],
      group[3]![0],
      group[0]![1],
      group[1]![1],
      group[2]![1],
      group[3]![1],
    ]);
  }
  return octets;
}

/** Parse one preset hex frame ("0A0A0A0A64646464") into an octet of 8 bytes. */
export function hexToOctet(hex: string): number[] {
  if (!/^[0-9a-fA-F]{16}$/.test(hex)) {
    throw new Error(`invalid waveform frame "${hex}"`);
  }
  const bytes: number[] = [];
  for (let index = 0; index < 16; index += 2) {
    bytes.push(Number.parseInt(hex.slice(index, index + 2), 16));
  }
  return bytes;
}

/**
 * Compile semantic segments on the 25 ms grid. Enforces the configured
 * duration ceiling (the underlying compiler's own hard limit is 30 s).
 */
export function compileCustomSegments(
  segments: DesignSegment[],
  capMs: number,
): { octets: number[][]; durationMs: number } {
  let compiled: { frames: WaveFrame[]; totalDurationMs: number };
  try {
    compiled = compileWaveformDesign(segments);
  } catch (error) {
    throw invalidWaveform(`invalid waveform segments: ${(error as Error).message}`);
  }
  if (compiled.totalDurationMs > capMs) {
    throw invalidWaveform(
      `compiled waveform duration ${compiled.totalDurationMs}ms exceeds the configured ceiling of ${capMs}ms (DGLAB_MAX_WAVEFORM_DURATION_MS)`,
    );
  }
  return { octets: framesToOctets(compiled.frames), durationMs: compiled.totalDurationMs };
}

/**
 * Bound a playback to an optional requested duration by repeating or
 * truncating octets. Rounding is up to the next 100 ms octet; the exact
 * requested value stays the authoritative playback bound.
 */
export function boundPlayback(
  octets: number[][],
  requestedMs: number | undefined,
  capMs: number,
): { octets: number[][]; durationMs: number } {
  const naturalMs = octets.length * OCTET_MS;
  if (requestedMs === undefined) {
    return { octets, durationMs: naturalMs };
  }
  if (!Number.isInteger(requestedMs) || requestedMs < OCTET_MS) {
    throw invalidWaveform(`durationMs must be an integer of at least ${OCTET_MS}ms`);
  }
  if (requestedMs > capMs) {
    throw invalidWaveform(
      `requested duration ${requestedMs}ms exceeds the configured ceiling of ${capMs}ms (DGLAB_MAX_WAVEFORM_DURATION_MS)`,
    );
  }
  const needed = Math.max(1, Math.ceil(requestedMs / OCTET_MS));
  const bounded: number[][] = [];
  for (let index = 0; index < needed; index += 1) {
    bounded.push(octets[index % octets.length]!);
  }
  return { octets: bounded, durationMs: requestedMs };
}
