import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSource } from "../src/source-parser.js";

describe("source-parser", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses GitHub shorthand and refs", () => {
    expect(parseSource("vercel-labs/agent-skills")).toEqual({
      type: "github",
      url: "https://github.com/vercel-labs/agent-skills.git",
    });
    expect(parseSource("vercel-labs/agent-skills#feature/install")).toEqual({
      type: "github",
      url: "https://github.com/vercel-labs/agent-skills.git",
      ref: "feature/install",
    });
  });

  it("parses GitHub tree URLs into a repository and subpath", () => {
    expect(parseSource("https://github.com/owner/repo/tree/main/path/to/pulses")).toEqual({
      type: "github",
      url: "https://github.com/owner/repo.git",
      ref: "main",
      subpath: "path/to/pulses",
    });
    expect(parseSource("https://github.com/owner/repo")).toEqual({
      type: "github",
      url: "https://github.com/owner/repo.git",
    });
  });

  it("does not treat GitHub blob paths as a separate source kind", () => {
    expect(parseSource("https://github.com/owner/repo/blob/main/pulses/wave.pulse#L10")).toEqual({
      type: "github",
      url: "https://github.com/owner/repo.git",
    });
  });

  it("parses GitLab repositories, subpaths, and custom domains", () => {
    expect(parseSource("https://gitlab.com/group/subgroup/repo/-/tree/main/pulses")).toEqual({
      type: "gitlab",
      url: "https://gitlab.com/group/subgroup/repo.git",
      ref: "main",
      subpath: "pulses",
    });
    expect(parseSource("https://git.corp.test/group/repo/-/tree/dev")).toEqual({
      type: "gitlab",
      url: "https://git.corp.test/group/repo.git",
      ref: "dev",
    });
  });

  it("parses local, hosted, and well-known sources", () => {
    expect(parseSource("./pulses")).toMatchObject({ type: "local", localPath: expect.any(String) });
    expect(parseSource("https://raw.githubusercontent.com/owner/repo/main/wave.pulse")).toEqual({
      type: "download",
      url: "https://raw.githubusercontent.com/owner/repo/main/wave.pulse",
    });
    expect(parseSource("https://example.com/pulses/")).toEqual({
      type: "well-known",
      url: "https://example.com/pulses/",
    });
  });

  it("supports source aliases and GitHub Enterprise shorthand", () => {
    expect(parseSource("github:owner/repo@pulse")).toEqual({
      type: "github",
      url: "https://github.com/owner/repo.git",
      skillFilter: "pulse",
    });
    vi.stubEnv("GH_HOST", "github.example.com");
    expect(parseSource("owner/repo")).toEqual({
      type: "git",
      url: "https://github.example.com/owner/repo.git",
    });
  });

  it("rejects traversal subpaths", () => {
    expect(() => parseSource("https://github.com/owner/repo/tree/main/pulses/../private")).toThrow(
      /unsafe preset source subpath/,
    );
  });
});
