import { describe, expect, it } from "vitest";
import { CliArgumentError, parseCliArgs } from "../src/cli.js";

describe("parseCliArgs", () => {
  it("accepts the short and long preset options", () => {
    expect(parseCliArgs(["-p", "https://example.com/waves.pulse"]).presetSources).toEqual([
      "https://example.com/waves.pulse",
    ]);
    expect(parseCliArgs(["--preset", "owner/repo/pulses"]).presetSources).toEqual([
      "owner/repo/pulses",
    ]);
    expect(parseCliArgs([])).toEqual({ presetSources: [] });
  });

  it("collects multiple sources in argument order", () => {
    expect(
      parseCliArgs([
        "--preset",
        "https://example.com/first.pulse",
        "owner/repo/second",
        "-p",
        "./third.pulse",
      ]),
    ).toEqual({
      presetSources: ["https://example.com/first.pulse", "owner/repo/second", "./third.pulse"],
    });
  });

  it.each([
    [["--other"], /unknown argument/],
    [["--preset"], /requires a source/],
    [["-p", "https://example.com/one.pulse", "--other"], /unknown argument/],
  ])("rejects invalid arguments %#", (args, expected) => {
    expect(() => parseCliArgs(args)).toThrowError(CliArgumentError);
    expect(() => parseCliArgs(args)).toThrow(expected);
  });
});
