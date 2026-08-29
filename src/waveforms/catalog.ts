import fs from "node:fs/promises";
import path from "node:path";
import type { WaveFrame } from "@dg-kit/core";
import { parsePulseText } from "@dg-kit/waveforms";
import { COYOTE_WAVEFORM, COYOTE_WAVEFORMS } from "dglab-kit";
import { invalidWaveform } from "../errors.js";
import { framesToOctets, hexToOctet, OCTET_MS } from "./compile.js";

export interface WaveformEntry {
  id: string;
  name: string;
  labels: { en: string; cn: string };
  source: "builtin" | "file";
  file?: string;
  /** V3-format octets, one per 100 ms tick. */
  octets: number[][];
  naturalDurationMs: number;
}

export interface FileError {
  file: string;
  error: string;
}

export interface WaveformCatalog {
  builtin: WaveformEntry[];
  external: WaveformEntry[];
  errors: FileError[];
}

export const PULSE_FILE_LIMIT_BYTES = 64 * 1024;
export const EXTERNAL_CATALOG_LIMIT = 100;

export function buildBuiltinCatalog(): WaveformEntry[] {
  const entries: WaveformEntry[] = [];
  for (const key of Object.values(COYOTE_WAVEFORM)) {
    const preset = COYOTE_WAVEFORMS[key];
    try {
      const octets = preset.raw.map(hexToOctet);
      entries.push({
        id: key,
        name: preset.label.en,
        labels: { en: preset.label.en, cn: preset.label.cn },
        source: "builtin",
        octets,
        naturalDurationMs: octets.length * OCTET_MS,
      });
    } catch (error) {
      // A malformed bundled preset must not break the catalog.
      console.error(`[dglab-mcp] skipping builtin waveform ${key}:`, error);
    }
  }
  return entries;
}

/**
 * Rescan the external `.pulse` directory recursively. Only regular `.pulse`
 * files are accepted; invalid or oversized files are reported without
 * disabling the rest of the catalog.
 */
export async function scanPulseDirectory(dir: string): Promise<{
  entries: WaveformEntry[];
  errors: FileError[];
}> {
  const entries: WaveformEntry[] = [];
  const errors: FileError[] = [];

  const pulseFiles = await findPulseFiles(dir);
  if (pulseFiles === null) {
    return { entries, errors };
  }

  for (const relativePath of pulseFiles) {
    if (entries.length >= EXTERNAL_CATALOG_LIMIT) {
      errors.push({
        file: relativePath,
        error: `external waveform catalog is full (${EXTERNAL_CATALOG_LIMIT} files); file skipped`,
      });
      continue;
    }
    const filePath = path.join(dir, ...relativePath.split("/"));
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > PULSE_FILE_LIMIT_BYTES) {
        throw new Error(
          `file is ${stat.size} bytes, exceeding the ${PULSE_FILE_LIMIT_BYTES}-byte limit`,
        );
      }
      const text = await fs.readFile(filePath, "utf8");
      const parsed = parsePulseText(text);
      const stem = relativePath.replace(/\.pulse$/i, "");
      const name = parsed.name || stem;
      entries.push({
        id: stem,
        name,
        labels: { en: name, cn: name },
        source: "file",
        file: filePath,
        octets: framesToOctets(parsed.frames as WaveFrame[]),
        naturalDurationMs: parsed.frames.length * 25,
      });
    } catch (error) {
      errors.push({ file: relativePath, error: (error as Error).message });
    }
  }

  return { entries, errors };
}

async function findPulseFiles(root: string): Promise<string[] | null> {
  const files: string[] = [];

  const visit = async (relativeDir: string): Promise<boolean> => {
    const directory = path.join(root, ...relativeDir.split("/").filter(Boolean));
    const dirents = await fs.readdir(directory, { withFileTypes: true }).catch(() => null);
    if (dirents === null) {
      return false;
    }
    for (const dirent of dirents) {
      const relativePath = relativeDir === "" ? dirent.name : `${relativeDir}/${dirent.name}`;
      if (dirent.isDirectory()) {
        await visit(relativePath);
      } else if (dirent.isFile() && dirent.name.toLowerCase().endsWith(".pulse")) {
        files.push(relativePath);
      }
    }
    return true;
  };

  if (!(await visit(""))) {
    return null;
  }
  return files.sort((a, b) => a.localeCompare(b));
}

/**
 * Load every waveform available right now: bundled presets plus a fresh
 * scan of the pulse directory, so files added or changed since startup
 * (or since the last call) are picked up without a restart.
 */
export async function loadCatalog(pulseDir: string): Promise<WaveformCatalog> {
  const builtin = buildBuiltinCatalog();
  const { entries, errors } = await scanPulseDirectory(pulseDir);
  return { builtin, external: entries, errors };
}

/**
 * Case- and separator-insensitive lookup across ids and English/Chinese
 * labels. Matching is exact after normalization — never fuzzy. Zero hits or
 * collisions (including a file shadowing a preset name) fail with an
 * ambiguity error listing the matches.
 */
export function lookupWaveform(query: string, catalog: WaveformCatalog): WaveformEntry {
  const normalized = normalizeName(query);
  const all = [...catalog.builtin, ...catalog.external];
  const matches = all.filter(
    (entry) =>
      normalizeName(entry.id) === normalized ||
      normalizeName(entry.name) === normalized ||
      normalizeName(entry.labels.en) === normalized ||
      normalizeName(entry.labels.cn) === normalized,
  );
  if (matches.length === 1) {
    return matches[0]!;
  }
  const candidates = matches.map((entry) => ({
    id: entry.id,
    name: entry.name,
    source: entry.source,
  }));
  if (matches.length === 0) {
    throw invalidWaveform(`no waveform matching "${query}"`, { query, candidates: [] });
  }
  throw invalidWaveform(`"${query}" is ambiguous; pick one of the matching waveform ids`, {
    query,
    candidates,
  });
}

export function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}
