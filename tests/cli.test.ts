import { describe, expect, it } from "vitest";
import { CliArgumentError, parseCliArgs } from "../src/cli.js";

describe("parseCliArgs", () => {
  it("accepts the short and long preset options", () => {
    expect(parseCliArgs(["-p", "https://example.com/waves.pulse"]).presetSource).toBe(
      "https://example.com/waves.pulse",
    );
    expect(parseCliArgs(["--preset", "owner/repo/pulses"]).presetSource).toBe("owner/repo/pulses");
    expect(parseCliArgs([])).toEqual({ presetSource: undefined });
  });

  it.each([
    [["--other"], /unknown argument/],
    [["--preset"], /requires a source/],
    [
      ["-p", "https://example.com/one.pulse", "--preset", "https://example.com/two.pulse"],
      /only be specified once/,
    ],
  ])("rejects invalid arguments %#", (args, expected) => {
    expect(() => parseCliArgs(args)).toThrowError(CliArgumentError);
    expect(() => parseCliArgs(args)).toThrow(expected);
  });
});
