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
    expect(parseSource("https://github.com/owner/repo/tree/main/")).toEqual({
      type: "github",
      url: "https://github.com/owner/repo.git",
      ref: "main",
    });
    expect(parseSource("https://github.com/owner/repo/tree/main/my%20pulses")).toEqual({
      type: "github",
      url: "https://github.com/owner/repo.git",
      ref: "main",
      subpath: "my pulses",
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
    expect(parseSource("https://gitlab.com/group/repo/-/tree/main/")).toEqual({
      type: "gitlab",
      url: "https://gitlab.com/group/repo.git",
      ref: "main",
    });
    expect(parseSource("https://gitlab.com/group/repo/-/tree/main/my%20pulses")).toEqual({
      type: "gitlab",
      url: "https://gitlab.com/group/repo.git",
      ref: "main",
      subpath: "my pulses",
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

  it("supports fragment filters and git URL forms", () => {
    expect(parseSource("github:owner/repo#feature%2Fbranch@pulse")).toEqual({
      type: "github",
      url: "https://github.com/owner/repo.git",
      ref: "feature/branch",
      skillFilter: "pulse",
    });
    expect(parseSource("git@github.com:owner/repo.git#main")).toEqual({
      type: "git",
      url: "git@github.com:owner/repo.git",
      ref: "main",
    });
    expect(parseSource("ssh://git.example.com/owner/repo.git")).toEqual({
      type: "git",
      url: "ssh://git.example.com/owner/repo.git",
    });
    expect(parseSource("https://git.example.com/owner/repo.git")).toEqual({
      type: "git",
      url: "https://git.example.com/owner/repo.git",
    });
    expect(parseSource("https://git.example.com/owner/repo.git/")).toEqual({
      type: "git",
      url: "https://git.example.com/owner/repo.git/",
    });
    expect(parseSource("https://git.example.com/owner/repo.git?token=test")).toEqual({
      type: "git",
      url: "https://git.example.com/owner/repo.git?token=test",
    });
    expect(parseSource("ssh://git.example.com/owner/repo.git#develop")).toEqual({
      type: "git",
      url: "ssh://git.example.com/owner/repo.git",
      ref: "develop",
    });
    expect(parseSource("https://git.example.com/owner/repo.git#develop")).toEqual({
      type: "git",
      url: "https://git.example.com/owner/repo.git",
      ref: "develop",
    });
    expect(parseSource("file:///tmp/repo.git#develop")).toEqual({
      type: "git",
      url: "file:///tmp/repo.git",
      ref: "develop",
    });
    expect(parseSource("https://gitlab.com/group/repo#develop")).toEqual({
      type: "gitlab",
      url: "https://gitlab.com/group/repo.git",
      ref: "develop",
    });
    expect(parseSource("owner/repo#%E0%A4%A")).toEqual({
      type: "github",
      url: "https://github.com/owner/repo.git",
      ref: "%E0%A4%A",
    });
  });

  it("handles invalid GitHub host configuration and enterprise URLs", () => {
    vi.stubEnv("GH_HOST", "github.example.com/path");
    expect(parseSource("owner/repo")).toMatchObject({
      type: "github",
      url: "https://github.com/owner/repo.git",
    });
    vi.stubEnv("GH_HOST", "github.example.com");
    expect(parseSource("https://github.example.com/owner/repo/tree/dev/pulses")).toEqual({
      type: "git",
      url: "https://github.example.com/owner/repo.git",
      ref: "dev",
      subpath: "pulses",
    });
    expect(parseSource("https://github.example.com/owner/repo#develop")).toEqual({
      type: "git",
      url: "https://github.example.com/owner/repo.git",
      ref: "develop",
    });
    expect(parseSource("https://github.example.com/owner/repo")).toEqual({
      type: "git",
      url: "https://github.example.com/owner/repo.git",
    });
    expect(parseSource("https://github.example.com/owner")).toEqual({
      type: "well-known",
      url: "https://github.example.com/owner",
    });
    vi.stubEnv("GH_HOST", "%");
    expect(parseSource("owner/repo")).toMatchObject({
      type: "github",
      url: "https://github.com/owner/repo.git",
    });
  });

  it("supports aliases, GitLab prefixes, shorthand subpaths, and fragment filters", () => {
    expect(parseSource("coinbase/agentWallet")).toEqual({
      type: "github",
      url: "https://github.com/coinbase/agentic-wallet-skills.git",
    });
    expect(parseSource("gitlab:group/repo#develop")).toEqual({
      type: "gitlab",
      url: "https://gitlab.com/group/repo.git",
      ref: "develop",
    });
    expect(parseSource("owner/repo/pulses#main@wave")).toEqual({
      type: "github",
      url: "https://github.com/owner/repo.git",
      ref: "main",
      subpath: "pulses",
      skillFilter: "wave",
    });
    expect(parseSource("owner/repo#@wave")).toEqual({
      type: "github",
      url: "https://github.com/owner/repo.git",
      skillFilter: "wave",
    });
    expect(parseSource("owner/repo#main@")).toEqual({
      type: "github",
      url: "https://github.com/owner/repo.git",
      ref: "main",
    });
    expect(parseSource("owner/repo@fallback#main@wave")).toEqual({
      type: "github",
      url: "https://github.com/owner/repo.git",
      ref: "main",
      skillFilter: "wave",
    });
  });

  it("recognizes hosted artifact URLs", () => {
    expect(parseSource("https://codeload.github.com/owner/repo/zip/main")).toMatchObject({
      type: "download",
    });
    expect(parseSource("https://github.com/owner/repo/archive/main.zip")).toMatchObject({
      type: "download",
    });
    expect(parseSource("https://gitlab.com/group/repo/-/raw/main/wave.pulse")).toMatchObject({
      type: "download",
    });
  });

  it("rejects traversal subpaths", () => {
    expect(() => parseSource("https://github.com/owner/repo/tree/main/pulses/../private")).toThrow(
      /unsafe preset source subpath/,
    );
    expect(() => parseSource("https://github.com/owner/repo/tree/main/%2E%2E/private")).toThrow(
      /unsafe preset source subpath/,
    );
    expect(() => parseSource("https://github.com/owner/repo/tree/main/%invalid")).toThrow(
      /invalid preset source subpath/,
    );
  });

  it("does not classify lookalike hosts as GitHub or GitLab", () => {
    expect(parseSource("https://evil.example/github.com/owner/repo")).toEqual({
      type: "well-known",
      url: "https://evil.example/github.com/owner/repo",
    });
    expect(parseSource("https://evil.example/gitlab.com/group/repo")).toEqual({
      type: "well-known",
      url: "https://evil.example/gitlab.com/group/repo",
    });
    expect(parseSource("https://github.com/owner")).toEqual({
      type: "git",
      url: "https://github.com/owner",
    });
    expect(parseSource("https://gitlab.com/owner")).toEqual({
      type: "git",
      url: "https://gitlab.com/owner",
    });
    expect(parseSource("https://%")).toEqual({
      type: "git",
      url: "https://%",
    });
    expect(parseSource("https://example.com/page#section")).toEqual({
      type: "well-known",
      url: "https://example.com/page#section",
    });
  });
});
