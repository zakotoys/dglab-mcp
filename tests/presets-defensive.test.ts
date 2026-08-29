import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/source-parser.js", () => ({
  parseSource: (input: string) => ({ type: "github", url: input }),
}));

const { syncPreset } = await import("../src/presets.js");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("preset defensive validation", () => {
  it("rejects a repository URL without owner and repository segments", async () => {
    const pulseDir = await fs.mkdtemp(path.join(os.tmpdir(), "dglab-preset-defensive-"));
    temporaryDirectories.push(pulseDir);

    await expect(syncPreset("https://github.com/owner", pulseDir)).rejects.toThrow(
      /invalid repository source/,
    );
  });
});
