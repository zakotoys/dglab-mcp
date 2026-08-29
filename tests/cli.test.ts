import { describe, expect, it } from "vitest";
import { CliArgumentError, parseCliArgs } from "../src/cli.js";

describe("parseCliArgs", () => {
  it("accepts the short and long preset options", () => {
    expect(parseCliArgs(["-p", "https://example.com/waves.pulse"]).presetUrl?.href).toBe(
      "https://example.com/waves.pulse",
    );
    expect(parseCliArgs(["--preset", "https://example.com/library/"]).presetUrl?.href).toBe(
      "https://example.com/library/",
    );
    expect(parseCliArgs([])).toEqual({ presetUrl: undefined });
  });

  it.each([
    [["--other"], /unknown argument/],
    [["--preset"], /requires an HTTP/],
    [["--preset", "not-a-url"], /valid URL/],
    [["-p", "file:///tmp/wave.pulse"], /http: or https:/],
    [
      ["-p", "https://example.com/one.pulse", "--preset", "https://example.com/two.pulse"],
      /only be specified once/,
    ],
  ])("rejects invalid arguments %#", (args, expected) => {
    expect(() => parseCliArgs(args)).toThrowError(CliArgumentError);
    expect(() => parseCliArgs(args)).toThrow(expected);
  });
});
