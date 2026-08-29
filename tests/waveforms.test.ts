import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DglabError } from "../src/errors.js";
import {
  buildBuiltinCatalog,
  loadCatalog,
  lookupWaveform,
  normalizeName,
  scanPulseDirectory,
} from "../src/waveforms/catalog.js";
import {
  boundPlayback,
  compileCustomSegments,
  framesToOctets,
  hexToOctet,
} from "../src/waveforms/compile.js";

const tmpDirs: string[] = [];

async function makePulseDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dglab-pulses-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("framesToOctets", () => {
  it("groups four 25ms frames per 100ms octet", () => {
    const octets = framesToOctets([
      [10, 0],
      [20, 25],
      [30, 50],
      [40, 75],
    ]);
    expect(octets).toEqual([[10, 20, 30, 40, 0, 25, 50, 75]]);
  });

  it("pads the final group with silence", () => {
    const octets = framesToOctets([
      [10, 100],
      [10, 100],
      [10, 0],
    ]);
    expect(octets).toEqual([[10, 10, 10, 100, 100, 100, 0, 0]]);
  });

  it("returns an empty list for empty frames", () => {
    expect(framesToOctets([])).toEqual([]);
  });
});

describe("hexToOctet", () => {
  it("parses preset hex frames into 8 bytes", () => {
    expect(hexToOctet("0A0A0A0A00000000")).toEqual([10, 10, 10, 10, 0, 0, 0, 0]);
    expect(hexToOctet("2d2d2d2d64646464")).toEqual([45, 45, 45, 45, 100, 100, 100, 100]);
  });

  it("rejects malformed hex frames", () => {
    expect(() => hexToOctet("nothex")).toThrow(/invalid waveform frame/);
    expect(() => hexToOctet("0A0A0A0A")).toThrow(/invalid waveform frame/);
  });
});

describe("compileCustomSegments", () => {
  it("compiles ramp/hold/pulse/silence onto the 25ms grid", () => {
    const { octets, durationMs } = compileCustomSegments(
      [
        { type: "ramp", from: 0, to: 100, durationMs: 100 },
        { type: "hold", intensity: 50, durationMs: 50, frequencyMs: 200 },
        { type: "pulse", intensity: 80, onMs: 25, offMs: 25, count: 1 },
        { type: "silence", durationMs: 25 },
      ],
      10_000,
    );
    // 4 ramp + 2 hold + 2 pulse + 1 silence frames = 9 * 25ms.
    expect(durationMs).toBe(225);
    expect(octets).toHaveLength(3);
    // Ramp starts at 0% and reaches 100% (frames 0,33,67,100).
    expect(octets[0]).toEqual([100, 100, 100, 100, 0, 33, 67, 100]);
    // Hold runs at 50 with frequency 200; pulse is ON(80) then OFF(0).
    expect(octets[1]).toEqual([200, 200, 100, 100, 50, 50, 80, 0]);
  });

  it("enforces the configured duration ceiling", () => {
    // 10025ms rounds to 401 frames = 10025ms > 10000ms ceiling.
    expect(() =>
      compileCustomSegments([{ type: "hold", intensity: 10, durationMs: 10_025 }], 10_000),
    ).toThrowError(/exceeds the configured ceiling/);
    try {
      compileCustomSegments([{ type: "hold", intensity: 10, durationMs: 10_025 }], 10_000);
    } catch (error) {
      expect((error as DglabError).code).toBe("INVALID_WAVEFORM");
    }
  });

  it("rejects empty segment lists", () => {
    expect(() => compileCustomSegments([], 10_000)).toThrowError(DglabError);
  });
});

describe("boundPlayback", () => {
  const octets = [
    [10, 10, 10, 10, 0, 0, 0, 0],
    [20, 20, 20, 20, 50, 50, 50, 50],
  ];

  it("uses natural duration when unbounded", () => {
    const result = boundPlayback(octets, undefined, 10_000);
    expect(result.octets).toBe(octets);
    expect(result.durationMs).toBe(200);
  });

  it("repeats octets to cover a longer request", () => {
    const result = boundPlayback(octets, 500, 10_000);
    expect(result.octets).toHaveLength(5);
    expect(result.octets[2]).toEqual(octets[0]);
    expect(result.durationMs).toBe(500);
  });

  it("truncates to a shorter request", () => {
    const result = boundPlayback(octets, 100, 10_000);
    expect(result.octets).toHaveLength(1);
    expect(result.durationMs).toBe(100);
  });

  it("rejects requests beyond the configured ceiling", () => {
    expect(() => boundPlayback(octets, 10_001, 10_000)).toThrowError(/ceiling/);
    expect(() => boundPlayback(octets, 99, 10_000)).toThrowError(/at least 100/);
  });
});

describe("builtin catalog", () => {
  it("exposes all 24 Coyote presets with labels and valid octets", () => {
    const catalog = buildBuiltinCatalog();
    expect(catalog).toHaveLength(24);
    const bubble = catalog.find((entry) => entry.id === "BUBBLE")!;
    expect(bubble.labels).toEqual({ en: "Bubble", cn: "气泡" });
    expect(bubble.naturalDurationMs).toBe(bubble.octets.length * 100);
    for (const entry of catalog) {
      for (const octet of entry.octets) {
        expect(octet).toHaveLength(8);
        for (const byte of octet) {
          expect(byte).toBeGreaterThanOrEqual(0);
          expect(byte).toBeLessThanOrEqual(200);
        }
      }
    }
  });
});

describe("lookupWaveform", () => {
  const catalog = loadCatalogForTests();

  function loadCatalogForTests() {
    return { builtin: buildBuiltinCatalog(), external: [], errors: [] };
  }

  it("matches enum keys case- and separator-insensitively", () => {
    expect(lookupWaveform("AIR_WAVES", catalog).id).toBe("AIR_WAVES");
    expect(lookupWaveform("air waves", catalog).id).toBe("AIR_WAVES");
    expect(lookupWaveform("AirWaves", catalog).id).toBe("AIR_WAVES");
  });

  it("matches English and Chinese labels", () => {
    expect(lookupWaveform("bubble", catalog).id).toBe("BUBBLE");
    expect(lookupWaveform("气泡", catalog).id).toBe("BUBBLE");
  });

  it("is not fuzzy: unknown names fail with INVALID_WAVEFORM", () => {
    expect(() => lookupWaveform("bubbl", catalog)).toThrowError(/no waveform matching/);
  });

  it("reports ambiguity when a file shadows a preset", () => {
    const withFile = {
      builtin: buildBuiltinCatalog(),
      external: [
        {
          id: "bubble",
          name: "Bubble",
          labels: { en: "Bubble", cn: "Bubble" },
          source: "file" as const,
          file: "/x/bubble.pulse",
          octets: [[10, 10, 10, 10, 0, 0, 0, 0]],
          naturalDurationMs: 100,
        },
      ],
      errors: [],
    };
    expect(() => lookupWaveform("bubble", withFile)).toThrowError(/ambiguous/);
    try {
      lookupWaveform("bubble", withFile);
    } catch (error) {
      expect((error as DglabError).code).toBe("INVALID_WAVEFORM");
    }
  });

  it("normalizeName strips separators and lowercases, keeps CJK", () => {
    expect(normalizeName("Air_Waves-2")).toBe("airwaves2");
    expect(normalizeName("气泡 波")).toBe("气泡波");
  });
});

describe("scanPulseDirectory", () => {
  it("loads valid .pulse files and reports invalid ones without disabling them", async () => {
    const dir = await makePulseDir();
    await fs.writeFile(
      path.join(dir, "waves.pulse"),
      "Dungeonlab+pulse:MyWave=0,0,0,1,1/10-0,50-100",
      "utf8",
    );
    await fs.writeFile(path.join(dir, "broken.pulse"), "not a pulse file", "utf8");
    await fs.writeFile(path.join(dir, "notes.txt"), "ignored", "utf8");
    await fs.mkdir(path.join(dir, "nested"));
    await fs.writeFile(
      path.join(dir, "nested", "deep.pulse"),
      "Dungeonlab+pulse:X=0,0,0,1,1/10-0,50-100",
      "utf8",
    );

    const { entries, errors } = await scanPulseDirectory(dir);
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.id)).toEqual(["nested/deep", "waves"]);
    expect(entries[1]!.id).toBe("waves");
    expect(entries[1]!.name).toBe("MyWave");
    expect(entries[1]!.source).toBe("file");
    expect(entries[1]!.octets.length).toBeGreaterThan(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.file).toBe("broken.pulse");
  });

  it("rejects files over 64 KiB", async () => {
    const dir = await makePulseDir();
    await fs.writeFile(
      path.join(dir, "huge.pulse"),
      `Dungeonlab+pulse:X=${"0".repeat(70 * 1024)}`,
      "utf8",
    );
    const { entries, errors } = await scanPulseDirectory(dir);
    expect(entries).toHaveLength(0);
    expect(errors[0]!.error).toMatch(/byte limit/);
  });

  it("caps the external catalog at 100 files", async () => {
    const dir = await makePulseDir();
    for (let index = 0; index < 103; index += 1) {
      const content = `Dungeonlab+pulse:W${index}=0,0,0,1,1/10-0,50-100`;
      await fs.writeFile(
        path.join(dir, `w${String(index).padStart(3, "0")}.pulse`),
        content,
        "utf8",
      );
    }
    const { entries, errors } = await scanPulseDirectory(dir);
    expect(entries).toHaveLength(100);
    expect(errors).toHaveLength(3);
    expect(errors[0]!.error).toMatch(/catalog is full/);
  });

  it("returns empty results for a missing directory", async () => {
    const { entries, errors } = await scanPulseDirectory(path.join(os.tmpdir(), "dglab-nope"));
    expect(entries).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("hot reload: loadCatalog picks up files added after startup", async () => {
    const dir = await makePulseDir();
    const before = await loadCatalog(dir);
    expect(before.external).toHaveLength(0);

    await fs.writeFile(
      path.join(dir, "late.pulse"),
      "Dungeonlab+pulse:Late=0,0,0,1,1/10-0,50-100",
      "utf8",
    );
    const after = await loadCatalog(dir);
    expect(after.external.map((entry) => entry.id)).toEqual(["late"]);
  });
});
