import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PRESET_MANIFEST_FILE, syncPreset } from "../src/presets.js";
import { scanPulseDirectory } from "../src/waveforms/catalog.js";

const PULSE_A = "Dungeonlab+pulse:Alpha=0,0,0,1,1/10-0,50-100";
const PULSE_B = "Dungeonlab+pulse:Beta=0,0,0,1,1/20-0,75-100";
const PULSE_C = "Dungeonlab+pulse:Gamma=0,0,0,1,1/30-0,25-100";
const servers: Server[] = [];
const tmpDirs: string[] = [];
const execFile = promisify(execFileCallback);

async function makePulseDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dglab-preset-test-"));
  tmpDirs.push(dir);
  return dir;
}

async function startHttpServer(
  handler: Parameters<typeof createServer>[0],
): Promise<{ origin: string }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("test HTTP server has no TCP address");
  }
  return { origin: `http://127.0.0.1:${address.port}` };
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("syncPreset", () => {
  it("downloads a single pulse once and verifies it from the hash manifest", async () => {
    let requests = 0;
    const { origin } = await startHttpServer((request, response) => {
      if (request.url === "/alpha.pulse") {
        requests += 1;
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(PULSE_A);
        return;
      }
      response.writeHead(404).end();
    });
    const pulseDir = await makePulseDir();
    const source = `${origin}/alpha.pulse`;

    const first = await syncPreset(source, pulseDir);
    expect(first).toMatchObject({ downloaded: 1, reused: 0, files: 1 });
    expect(await fs.readFile(path.join(pulseDir, "alpha.pulse"), "utf8")).toBe(PULSE_A);

    const manifest = JSON.parse(
      await fs.readFile(path.join(pulseDir, PRESET_MANIFEST_FILE), "utf8"),
    ) as {
      version: number;
      sources: Record<string, { files: Array<{ path: string; sha256: string }> }>;
    };
    expect(manifest.version).toBe(1);
    expect(manifest.sources[source]!.files[0]).toEqual({
      url: source,
      path: "alpha.pulse",
      sha256: createHash("sha256").update(PULSE_A).digest("hex"),
    });

    const second = await syncPreset(source, pulseDir);
    expect(second).toMatchObject({ downloaded: 0, reused: 1, files: 1 });
    expect(requests).toBe(1);

    await fs.writeFile(path.join(pulseDir, "alpha.pulse"), "locally modified", "utf8");
    const repaired = await syncPreset(source, pulseDir);
    expect(repaired.downloaded).toBe(1);
    expect(requests).toBe(2);
    expect(await fs.readFile(path.join(pulseDir, "alpha.pulse"), "utf8")).toBe(PULSE_A);
  });

  it("recursively downloads same-origin directory listings and preserves paths", async () => {
    const requests: string[] = [];
    const { origin } = await startHttpServer((request, response) => {
      const url = request.url ?? "";
      requests.push(url);
      response.setHeader(
        "content-type",
        url === "/library/" || url === "/library/nested" || url === "/library/nested/"
          ? "text/html"
          : "text/plain",
      );
      if (url === "/library/") {
        response.end(
          '<a href="root.pulse">root</a><a href="root.pulse">duplicate</a><a href="nested">nested</a><a href="page?query=1">query</a><a href="/outside.pulse">outside</a>',
        );
      } else if (url === "/library/nested" || url === "/library/nested/") {
        response.end('<a href="deep%20wave.pulse">deep</a><a href="../">parent</a>');
      } else if (url === "/library/root.pulse") {
        response.end(PULSE_A);
      } else if (url === "/library/nested/deep%20wave.pulse") {
        response.end(PULSE_B);
      } else {
        response.writeHead(404).end();
      }
    });
    const pulseDir = await makePulseDir();
    const source = `${origin}/library/`;

    const result = await syncPreset(source, pulseDir);
    expect(result).toMatchObject({ downloaded: 2, reused: 0, files: 2 });
    expect(await fs.readFile(path.join(pulseDir, "root.pulse"), "utf8")).toBe(PULSE_A);
    expect(await fs.readFile(path.join(pulseDir, "nested", "deep wave.pulse"), "utf8")).toBe(
      PULSE_B,
    );
    expect(requests).not.toContain("/outside.pulse");

    const catalog = await scanPulseDirectory(pulseDir);
    expect(catalog.entries.map((entry) => entry.id)).toEqual(["nested/deep wave", "root"]);
    expect(catalog.errors).toEqual([]);

    const requestCount = requests.length;
    const cached = await syncPreset(source, pulseDir);
    expect(cached).toMatchObject({ downloaded: 0, reused: 2, files: 2 });
    expect(requests).toHaveLength(requestCount + 2);

    await fs.rm(path.join(pulseDir, "nested", "deep wave.pulse"));
    const repaired = await syncPreset(source, pulseDir);
    expect(repaired).toMatchObject({ downloaded: 1, reused: 1, files: 2 });
    expect(requests.slice(requestCount + 2)).toEqual([
      "/library/",
      "/library/nested",
      "/library/nested/deep%20wave.pulse",
    ]);
  });

  it("refreshes remote directory listings and removes stale managed files", async () => {
    let includeFirst = true;
    const { origin } = await startHttpServer((request, response) => {
      response.setHeader("content-type", request.url === "/library/" ? "text/html" : "text/plain");
      if (request.url === "/library/") {
        response.end(
          `${includeFirst ? '<a href="first.pulse">first</a>' : ""}<a href="second.pulse">second</a>`,
        );
      } else if (request.url === "/library/first.pulse") {
        response.end(PULSE_A);
      } else if (request.url === "/library/second.pulse") {
        response.end(PULSE_B);
      } else {
        response.writeHead(404).end();
      }
    });
    const pulseDir = await makePulseDir();
    const source = `${origin}/library/`;

    expect(await syncPreset(source, pulseDir)).toMatchObject({ downloaded: 2, files: 2 });
    includeFirst = false;
    expect(await syncPreset(source, pulseDir)).toMatchObject({
      downloaded: 0,
      reused: 1,
      files: 1,
    });
    await expect(fs.stat(path.join(pulseDir, "first.pulse"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.readFile(path.join(pulseDir, "second.pulse"), "utf8")).toBe(PULSE_B);
  });

  it("uses response types to distinguish files from dotted directories", async () => {
    const { origin } = await startHttpServer((request, response) => {
      if (request.url === "/library/") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          '<a href="README">file</a><a href="missing">missing</a><a href="waves.v1">directory</a>',
        );
      } else if (request.url === "/library/README") {
        response.writeHead(200, {
          "content-length": String(1024 * 1024 + 1),
          "content-type": "text/plain",
        });
        response.end();
      } else if (request.url === "/library/waves.v1") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end('<a href="deep.pulse">deep</a>');
      } else if (request.url === "/library/waves.v1/deep.pulse") {
        response.end(PULSE_A);
      } else {
        response.writeHead(404).end();
      }
    });
    const pulseDir = await makePulseDir();

    expect(await syncPreset(`${origin}/library/`, pulseDir)).toMatchObject({ files: 1 });
    expect(await fs.readFile(path.join(pulseDir, "waves.v1", "deep.pulse"), "utf8")).toBe(PULSE_A);
    await expect(syncPreset(`${origin}/library/README`, await makePulseDir())).rejects.toThrow(
      /contains no \.pulse files/,
    );
  });

  it("recursively imports local source directories", async () => {
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "dglab-local-preset-"));
    tmpDirs.push(sourceDir);
    await fs.mkdir(path.join(sourceDir, "nested"));
    await fs.writeFile(path.join(sourceDir, "root.pulse"), PULSE_A);
    await fs.writeFile(path.join(sourceDir, "nested", "deep.pulse"), PULSE_B);
    await fs.writeFile(path.join(sourceDir, "ignore.txt"), "ignored");
    const pulseDir = await makePulseDir();

    const result = await syncPreset(sourceDir, pulseDir);
    expect(result).toMatchObject({ downloaded: 2, reused: 0, files: 2 });
    expect(await fs.readFile(path.join(pulseDir, "root.pulse"), "utf8")).toBe(PULSE_A);
    expect(await fs.readFile(path.join(pulseDir, "nested", "deep.pulse"), "utf8")).toBe(PULSE_B);

    await fs.writeFile(path.join(sourceDir, "root.pulse"), PULSE_B);
    await fs.writeFile(path.join(sourceDir, "new.pulse"), PULSE_A);
    const updated = await syncPreset(sourceDir, pulseDir);
    expect(updated).toMatchObject({ downloaded: 2, reused: 1, files: 3 });
    expect(await fs.readFile(path.join(pulseDir, "root.pulse"), "utf8")).toBe(PULSE_B);
    expect(await fs.readFile(path.join(pulseDir, "new.pulse"), "utf8")).toBe(PULSE_A);
  });

  it("resolves GitHub tree URLs through the recursive tree API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (new URL(url).pathname === "/repos/zakotoys/dglab-pulse-collect/git/trees/main") {
        return new Response(
          JSON.stringify({
            truncated: false,
            tree: [
              { path: "pulses/pulse-001/root.pulse", type: "blob" },
              { path: "pulses/pulse-001/nested/deep.pulse", type: "blob" },
              { path: "pulses/other.pulse", type: "blob" },
              { path: "pulses/pulse-001/ignore.txt", type: "blob" },
              { path: "pulses/pulse-001/directory.pulse", type: "tree" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.startsWith("https://api.github.com/repos/")) {
        return new Response("", { status: 404 });
      }
      if (
        url ===
        "https://raw.githubusercontent.com/zakotoys/dglab-pulse-collect/main/pulses/pulse-001/root.pulse"
      ) {
        return new Response(PULSE_A, { status: 200 });
      }
      if (
        url ===
        "https://raw.githubusercontent.com/zakotoys/dglab-pulse-collect/main/pulses/pulse-001/nested/deep.pulse"
      ) {
        return new Response(PULSE_B, { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const pulseDir = await makePulseDir();
    const source = "https://github.com/zakotoys/dglab-pulse-collect/tree/main/pulses/pulse-001";

    try {
      const result = await syncPreset(source, pulseDir);
      expect(result).toMatchObject({ downloaded: 2, reused: 0, files: 2 });
      expect(await fs.readFile(path.join(pulseDir, "root.pulse"), "utf8")).toBe(PULSE_A);
      expect(await fs.readFile(path.join(pulseDir, "nested", "deep.pulse"), "utf8")).toBe(PULSE_B);

      const cached = await syncPreset(source, pulseDir);
      expect(cached).toMatchObject({ downloaded: 0, reused: 2, files: 2 });
      expect(fetchMock).toHaveBeenCalledTimes(8);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("resolves the longest GitHub branch name in a tree URL", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/git/trees/feature%2Fx")) {
        return new Response(
          JSON.stringify({
            truncated: false,
            tree: [{ path: "root.pulse", type: "blob" }],
          }),
        );
      }
      if (url === "https://raw.githubusercontent.com/owner/repo/feature%2Fx/root.pulse") {
        return new Response(PULSE_A);
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const pulseDir = await makePulseDir();

    try {
      expect(
        await syncPreset("https://github.com/owner/repo/tree/feature/x", pulseDir),
      ).toMatchObject({ files: 1 });
      expect(await fs.readFile(path.join(pulseDir, "root.pulse"), "utf8")).toBe(PULSE_A);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("resolves a GitHub repository URL from the default HEAD tree", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (
        url.startsWith("https://api.github.com/repos/zakotoys/dglab-pulse-collect/git/trees/HEAD")
      ) {
        return new Response(
          JSON.stringify({
            truncated: false,
            tree: [{ path: "pulses/root.pulse", type: "blob" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (
        url ===
        "https://raw.githubusercontent.com/zakotoys/dglab-pulse-collect/HEAD/pulses/root.pulse"
      ) {
        return new Response(PULSE_A, { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const pulseDir = await makePulseDir();

    try {
      const result = await syncPreset(
        "https://github.com/zakotoys/dglab-pulse-collect.git",
        pulseDir,
      );
      expect(result).toMatchObject({ downloaded: 1, reused: 0, files: 1 });
      expect(await fs.readFile(path.join(pulseDir, "pulses", "root.pulse"), "utf8")).toBe(PULSE_A);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("normalizes encoded GitHub subpaths and raw repository filenames", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (new URL(url).pathname === "/repos/owner/repo/git/trees/main") {
        return new Response(
          JSON.stringify({
            truncated: false,
            tree: [{ path: "pulses/my folder/50%.pulse", type: "blob" }],
          }),
        );
      }
      if (url.includes("api.github.com")) {
        return new Response("", { status: 404 });
      }
      if (
        url === "https://raw.githubusercontent.com/owner/repo/main/pulses/my%20folder/50%25.pulse"
      ) {
        return new Response(PULSE_A);
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const pulseDir = await makePulseDir();

    try {
      const result = await syncPreset(
        "https://github.com/owner/repo/tree/main/pulses/my%20folder",
        pulseDir,
      );
      expect(result.files).toBe(1);
      expect(await fs.readFile(path.join(pulseDir, "50%.pulse"), "utf8")).toBe(PULSE_A);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("resolves GitLab tree URLs through the repository tree API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("gitlab.com/api/v4/projects/group%2Frepo/repository/tree")) {
        if (new URL(url).searchParams.get("ref") !== "main") {
          return new Response("", { status: 404 });
        }
        return new Response(
          JSON.stringify([
            { type: "blob", path: "pulses/my folder/50%.pulse" },
            { type: "blob", path: "pulses/other.pulse" },
            { type: "tree", path: "pulses/my folder/directory.pulse" },
            { type: "blob", path: "pulses/my folder/ignore.txt" },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "https://gitlab.com/group/repo/-/raw/main/pulses/my%20folder/50%25.pulse") {
        return new Response(PULSE_A, { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const pulseDir = await makePulseDir();

    try {
      const result = await syncPreset(
        "https://gitlab.com/group/repo/-/tree/main/pulses/my%20folder",
        pulseDir,
      );
      expect(result).toMatchObject({ downloaded: 1, reused: 0, files: 1 });
      expect(await fs.readFile(path.join(pulseDir, "50%.pulse"), "utf8")).toBe(PULSE_A);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("resolves the longest GitLab branch name in a tree URL", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/repository/tree")) {
        expect(new URL(url).searchParams.get("ref")).toBe("feature/x");
        return new Response(JSON.stringify([{ type: "blob", path: "root.pulse" }]));
      }
      if (url === "https://gitlab.com/group/repo/-/raw/feature%2Fx/root.pulse") {
        return new Response(PULSE_A);
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const pulseDir = await makePulseDir();

    try {
      expect(
        await syncPreset("https://gitlab.com/group/repo/-/tree/feature/x", pulseDir),
      ).toMatchObject({ files: 1 });
      expect(await fs.readFile(path.join(pulseDir, "root.pulse"), "utf8")).toBe(PULSE_A);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("keeps colliding filenames from different sources distinct", async () => {
    const { origin } = await startHttpServer((request, response) => {
      response.end(request.url?.startsWith("/alpha/") ? PULSE_A : PULSE_B);
    });
    const pulseDir = await makePulseDir();

    await syncPreset(`${origin}/alpha/same.pulse`, pulseDir);
    await syncPreset(`${origin}/beta/same.pulse`, pulseDir);

    const files = (await fs.readdir(pulseDir)).filter((file) => file.endsWith(".pulse")).sort();
    const collision = files.find((file) => file !== "same.pulse");
    expect(files).toHaveLength(2);
    expect(files).toContain("same.pulse");
    expect(collision).toMatch(/^same-[a-f0-9]{12}\.pulse$/);
    expect(await fs.readFile(path.join(pulseDir, "same.pulse"), "utf8")).toBe(PULSE_A);
    expect(await fs.readFile(path.join(pulseDir, collision!), "utf8")).toBe(PULSE_B);
  });

  it("forks a shared managed path when one local source changes", async () => {
    const firstSource = await fs.mkdtemp(path.join(os.tmpdir(), "dglab-local-first-"));
    const secondSource = await fs.mkdtemp(path.join(os.tmpdir(), "dglab-local-second-"));
    tmpDirs.push(firstSource, secondSource);
    await fs.writeFile(path.join(firstSource, "same.pulse"), PULSE_A);
    await fs.writeFile(path.join(secondSource, "same.pulse"), PULSE_A);
    const pulseDir = await makePulseDir();

    await syncPreset(firstSource, pulseDir);
    await syncPreset(secondSource, pulseDir);
    await fs.writeFile(path.join(firstSource, "same.pulse"), PULSE_B);
    await syncPreset(firstSource, pulseDir);

    const pulseBHash = createHash("sha256").update(PULSE_B).digest("hex").slice(0, 12);
    expect(await fs.readFile(path.join(pulseDir, "same.pulse"), "utf8")).toBe(PULSE_A);
    expect(await fs.readFile(path.join(pulseDir, `same-${pulseBHash}.pulse`), "utf8")).toBe(
      PULSE_B,
    );
    expect(await syncPreset(secondSource, pulseDir)).toMatchObject({ reused: 1, files: 1 });
  });

  it("does not reclaim a missing path that another source still references", async () => {
    const firstSource = await fs.mkdtemp(path.join(os.tmpdir(), "dglab-local-first-"));
    const secondSource = await fs.mkdtemp(path.join(os.tmpdir(), "dglab-local-second-"));
    tmpDirs.push(firstSource, secondSource);
    await fs.writeFile(path.join(firstSource, "same.pulse"), PULSE_A);
    await fs.writeFile(path.join(secondSource, "same.pulse"), PULSE_A);
    const pulseDir = await makePulseDir();

    await syncPreset(firstSource, pulseDir);
    await syncPreset(secondSource, pulseDir);
    await fs.rm(path.join(pulseDir, "same.pulse"));
    await fs.writeFile(path.join(firstSource, "same.pulse"), PULSE_B);
    await syncPreset(firstSource, pulseDir);

    const pulseBHash = createHash("sha256").update(PULSE_B).digest("hex").slice(0, 12);
    await expect(fs.stat(path.join(pulseDir, "same.pulse"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.readFile(path.join(pulseDir, `same-${pulseBHash}.pulse`), "utf8")).toBe(
      PULSE_B,
    );
    await syncPreset(secondSource, pulseDir);
    expect(await fs.readFile(path.join(pulseDir, "same.pulse"), "utf8")).toBe(PULSE_A);
  });

  it.each([
    ["invalid JSON", "not JSON", /invalid preset manifest/],
    ["invalid schema", '{"version":2,"sources":{}}', /invalid preset manifest/],
    [
      "unsafe local path",
      JSON.stringify({
        version: 1,
        sources: {
          "https://example.com/wave.pulse": {
            kind: "file",
            files: [
              {
                url: "https://example.com/wave.pulse",
                path: "../wave.pulse",
                sha256: "a".repeat(64),
              },
            ],
          },
        },
      }),
      /unsafe manifest path/,
    ],
    [
      "backslash path",
      JSON.stringify({
        version: 1,
        sources: {
          "https://example.com/wave.pulse": {
            kind: "file",
            files: [
              {
                url: "https://example.com/wave.pulse",
                path: "nested\\wave.pulse",
                sha256: "a".repeat(64),
              },
            ],
          },
        },
      }),
      /unsafe manifest path/,
    ],
  ])("rejects an %s manifest before making a request", async (_name, manifest, expected) => {
    const pulseDir = await makePulseDir();
    await fs.writeFile(path.join(pulseDir, PRESET_MANIFEST_FILE), manifest, "utf8");
    await expect(syncPreset("https://example.com/wave.pulse", pulseDir)).rejects.toThrow(expected);
  });

  it("rejects invalid remote pulse content without writing a manifest", async () => {
    const { origin } = await startHttpServer((_request, response) => response.end("not a pulse"));
    const pulseDir = await makePulseDir();

    await expect(syncPreset(`${origin}/bad.pulse`, pulseDir)).rejects.toThrow(/invalid preset/);
    await expect(fs.stat(path.join(pulseDir, PRESET_MANIFEST_FILE))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports unsuccessful pulse downloads without creating cache state", async () => {
    const { origin } = await startHttpServer((_request, response) => response.writeHead(404).end());
    const pulseDir = await makePulseDir();

    await expect(syncPreset(`${origin}/missing.pulse`, pulseDir)).rejects.toThrow(/HTTP 404/);
    expect(await fs.readdir(pulseDir)).toEqual([]);
  });

  it("rejects an empty directory listing", async () => {
    const { origin } = await startHttpServer((_request, response) => response.end("<html></html>"));
    const pulseDir = await makePulseDir();

    await expect(syncPreset(`${origin}/empty`, pulseDir)).rejects.toThrow(
      /contains no \.pulse files/,
    );
  });

  it("reports unsuccessful directory requests", async () => {
    const { origin } = await startHttpServer((_request, response) => response.writeHead(404).end());
    const pulseDir = await makePulseDir();

    await expect(syncPreset(`${origin}/missing/`, pulseDir)).rejects.toThrow(/HTTP 404/);
  });

  it("rejects a pulse whose declared size exceeds the file limit", async () => {
    const { origin } = await startHttpServer((_request, response) => {
      response.writeHead(200, { "content-length": String(64 * 1024 + 1) });
      response.end();
    });
    const pulseDir = await makePulseDir();

    await expect(syncPreset(`${origin}/large.pulse`, pulseDir)).rejects.toThrow(
      /exceeding the 65536-byte limit/,
    );
  });

  it("rejects a chunked pulse response that exceeds the file limit", async () => {
    const { origin } = await startHttpServer((_request, response) => {
      response.writeHead(200);
      response.end("x".repeat(64 * 1024 + 1));
    });
    const pulseDir = await makePulseDir();

    await expect(syncPreset(`${origin}/chunked.pulse`, pulseDir)).rejects.toThrow(
      /response exceeds the 65536-byte limit/,
    );
  });

  it("imports a single local file from a git source", async () => {
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "dglab-git-preset-test-"));
    tmpDirs.push(repoDir);
    await execFile("git", ["init", "-q", "-b", "main", repoDir]);
    await fs.writeFile(path.join(repoDir, "wave.pulse"), PULSE_A);
    await execFile("git", ["-C", repoDir, "add", "wave.pulse"]);
    await execFile("git", [
      "-C",
      repoDir,
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=test",
      "commit",
      "-qm",
      "initial",
    ]);
    const pulseDir = await makePulseDir();
    const result = await syncPreset(`file://${repoDir}#main`, pulseDir);
    expect(result).toMatchObject({ downloaded: 1, reused: 0, files: 1 });
    expect(await fs.readFile(path.join(pulseDir, "wave.pulse"), "utf8")).toBe(PULSE_A);
    expect(await syncPreset(`file://${repoDir}#main`, pulseDir)).toMatchObject({
      downloaded: 0,
      reused: 1,
      files: 1,
    });
    await fs.writeFile(path.join(repoDir, "wave.pulse"), PULSE_B);
    await execFile("git", ["-C", repoDir, "add", "wave.pulse"]);
    await execFile("git", [
      "-C",
      repoDir,
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=test",
      "commit",
      "-qm",
      "update",
    ]);
    const updated = await syncPreset(`file://${repoDir}#main`, pulseDir);
    expect(updated).toMatchObject({ downloaded: 1, reused: 0, files: 1 });
    expect(await fs.readFile(path.join(pulseDir, "wave.pulse"), "utf8")).toBe(PULSE_B);
  });

  it("rejects invalid local files and empty or oversized directories", async () => {
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "dglab-local-edge-"));
    tmpDirs.push(sourceDir);
    const pulseDir = await makePulseDir();
    const textFile = path.join(sourceDir, "notes.txt");
    await fs.writeFile(textFile, "ignored");
    await expect(syncPreset(textFile, pulseDir)).rejects.toThrow(/does not end in \.pulse/);
    const emptyDir = path.join(sourceDir, "empty");
    await fs.mkdir(emptyDir);
    await expect(syncPreset(emptyDir, pulseDir)).rejects.toThrow(/contains no \.pulse files/);
    const oversized = path.join(sourceDir, "large.pulse");
    await fs.writeFile(oversized, "x".repeat(64 * 1024 + 1));
    await expect(syncPreset(oversized, pulseDir)).rejects.toThrow(/response exceeds/);
    const invalidPulse = path.join(sourceDir, "invalid.pulse");
    await fs.writeFile(invalidPulse, "not a pulse");
    await expect(syncPreset(invalidPulse, pulseDir)).rejects.toThrow(/invalid preset/);
    const manyDir = path.join(sourceDir, "many");
    await fs.mkdir(manyDir);
    await Promise.all(
      Array.from({ length: 101 }, (_, index) =>
        fs.writeFile(path.join(manyDir, `wave-${index}.pulse`), PULSE_A),
      ),
    );
    await expect(syncPreset(manyDir, pulseDir)).rejects.toThrow(/more than 100/);
    if (process.platform !== "win32") {
      const specialFile = path.join(sourceDir, "special");
      await execFile("mkfifo", [specialFile]);
      await expect(syncPreset(specialFile, pulseDir)).rejects.toThrow(/not a file or directory/);
    }
  });

  it("reuses an existing file with the same content and rejects non-pulse downloads", async () => {
    const { origin } = await startHttpServer((request, response) => {
      if (request.url?.endsWith("/same.pulse")) response.end(PULSE_A);
      else response.end("not a pulse");
    });
    const pulseDir = await makePulseDir();
    await syncPreset(`${origin}/alpha/same.pulse`, pulseDir);
    const result = await syncPreset(`${origin}/gamma/same.pulse`, pulseDir);
    expect(result.downloaded).toBe(1);
    expect(result.files).toBe(1);
    await expect(
      syncPreset("https://raw.githubusercontent.com/owner/repo/main/README.md", pulseDir),
    ).rejects.toThrow(/is not a \.pulse file/);
  });

  it("falls back from GitHub HEAD", async () => {
    const pulseDir = await makePulseDir();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/git/trees/HEAD")) return new Response("", { status: 404 });
      if (url.includes("/git/trees/main"))
        return new Response(JSON.stringify({ truncated: false, tree: [] }));
      throw new Error(`unexpected fetch ${url}`);
    });
    try {
      await expect(syncPreset("https://github.com/owner/repo", pulseDir)).rejects.toThrow(
        /contains no \.pulse files/,
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it.each([
    ["HTTP failure", new Response("", { status: 500 }), /HTTP 500/],
    ["invalid JSON", new Response("{", { status: 200 }), /invalid GitHub tree response/],
    [
      "invalid schema",
      new Response(JSON.stringify({ tree: [] }), { status: 200 }),
      /invalid GitHub tree response/,
    ],
    [
      "truncated tree",
      new Response(JSON.stringify({ truncated: true, tree: [] }), { status: 200 }),
      /too large to traverse/,
    ],
  ])("rejects a GitHub %s response", async (_name, response, expected) => {
    const pulseDir = await makePulseDir();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    try {
      await expect(syncPreset("https://github.com/owner/repo", pulseDir)).rejects.toThrow(expected);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("resolves a GitLab default branch and handles project errors", async () => {
    const pulseDir = await makePulseDir();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v4/projects/group%2Frepo"))
        return new Response(JSON.stringify({ default_branch: "develop" }));
      if (url.includes("/repository/tree"))
        return new Response(JSON.stringify([{ type: "blob", path: "wave.pulse" }]));
      if (url.endsWith("/-/raw/develop/wave.pulse")) return new Response(PULSE_A);
      throw new Error(`unexpected fetch ${url}`);
    });
    try {
      const result = await syncPreset("https://gitlab.com/group/repo", pulseDir);
      expect(result.files).toBe(1);
    } finally {
      fetchMock.mockRestore();
    }
    const failingDir = await makePulseDir();
    const failingFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 403 }));
    try {
      await expect(syncPreset("https://gitlab.com/group/repo", failingDir)).rejects.toThrow(
        /failed to resolve GitLab preset repository/,
      );
    } finally {
      failingFetch.mockRestore();
    }
  });

  it("rejects unsafe directory redirects and malformed links", async () => {
    const pulseDir = await makePulseDir();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const response = new Response('<a href="%E0%A4%A.pulse">bad</a>', {
        headers: { "content-type": "text/html" },
      });
      Object.defineProperty(response, "url", { value: String(input) });
      return response;
    });
    try {
      await expect(syncPreset("https://example.com/pulses/", pulseDir)).rejects.toThrow(
        /invalid URL path segment/,
      );
    } finally {
      fetchMock.mockRestore();
    }
    const redirectedDir = await makePulseDir();
    const redirectFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const response = new Response(
        String(input).endsWith("/pulses/") ? '<a href="child">child</a>' : "<html></html>",
        { headers: { "content-type": "text/html" } },
      );
      Object.defineProperty(response, "url", {
        value: String(input).endsWith("/pulses/") ? String(input) : "https://evil.example/outside/",
      });
      return response;
    });
    try {
      await expect(syncPreset("https://example.com/pulses/", redirectedDir)).rejects.toThrow(
        /redirected outside/,
      );
    } finally {
      redirectFetch.mockRestore();
    }
  });

  it("retries empty cache entries and cleans up failed manifest writes", async () => {
    const { origin } = await startHttpServer((_request, response) => response.end(PULSE_A));
    const source = `${origin}/wave.pulse`;
    const pulseDir = await makePulseDir();
    await fs.writeFile(
      path.join(pulseDir, PRESET_MANIFEST_FILE),
      JSON.stringify({
        version: 1,
        sources: { [source]: { kind: "file", files: [] } },
      }),
    );
    expect(await syncPreset(source, pulseDir)).toMatchObject({ downloaded: 1, files: 1 });

    const failingDir = await makePulseDir();
    const renameMock = vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename failed"));
    try {
      await expect(syncPreset(source, failingDir)).rejects.toThrow(/rename failed/);
      expect((await fs.readdir(failingDir)).some((file) => file.endsWith(".tmp"))).toBe(false);
    } finally {
      renameMock.mockRestore();
    }
  });

  it("reports manifest read errors and invalid cached target types", async () => {
    const pulseDir = await makePulseDir();
    await fs.mkdir(path.join(pulseDir, PRESET_MANIFEST_FILE));
    await expect(syncPreset("https://example.com/wave.pulse", pulseDir)).rejects.toThrow();

    const { origin } = await startHttpServer((_request, response) => response.end(PULSE_A));
    const source = `${origin}/wave.pulse`;
    const cachedDir = await makePulseDir();
    await fs.mkdir(path.join(cachedDir, "cached.pulse"));
    await fs.writeFile(
      path.join(cachedDir, PRESET_MANIFEST_FILE),
      JSON.stringify({
        version: 1,
        sources: {
          [source]: {
            kind: "file",
            files: [{ url: source, path: "cached.pulse", sha256: "a".repeat(64) }],
          },
        },
      }),
    );
    await expect(syncPreset(source, cachedDir)).rejects.toThrow();
  });

  it("reports git clone failures", async () => {
    const pulseDir = await makePulseDir();
    await expect(syncPreset("not-a-repository", pulseDir)).rejects.toThrow(
      /failed to fetch git preset/,
    );
  });

  it("reports unresolved and oversized GitHub trees", async () => {
    const unresolvedDir = await makePulseDir();
    const missingFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 404 }));
    try {
      await expect(syncPreset("https://github.com/owner/repo", unresolvedDir)).rejects.toThrow(
        /failed to resolve GitHub preset repository/,
      );
      expect(missingFetch).toHaveBeenCalledTimes(3);
    } finally {
      missingFetch.mockRestore();
    }

    const oversizedDir = await makePulseDir();
    const oversizedFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          truncated: false,
          tree: Array.from({ length: 101 }, (_, index) => ({
            type: "blob",
            path: `wave-${index}.pulse`,
          })),
        }),
      ),
    );
    try {
      await expect(syncPreset("https://github.com/owner/repo#main", oversizedDir)).rejects.toThrow(
        /more than 100/,
      );
    } finally {
      oversizedFetch.mockRestore();
    }
  });

  it.each([
    ["HTTP failure", new Response("", { status: 500 }), /HTTP 500/],
    ["invalid JSON", new Response("{", { status: 200 }), /invalid GitLab tree response/],
    ["invalid schema", new Response("{}", { status: 200 }), /invalid GitLab tree response/],
  ])("rejects a GitLab tree %s", async (_name, response, expected) => {
    const pulseDir = await makePulseDir();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    try {
      await expect(
        syncPreset("https://gitlab.com/group/repo/-/tree/main", pulseDir),
      ).rejects.toThrow(expected);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("rejects a GitLab tree URL when no candidate ref exists", async () => {
    const pulseDir = await makePulseDir();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 404 }));
    try {
      await expect(
        syncPreset("https://gitlab.com/group/repo/-/tree/missing/branch", pulseDir),
      ).rejects.toThrow(/failed to resolve GitLab preset tree/);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it.each([
    ["invalid JSON", new Response("{", { status: 200 })],
    ["invalid schema", new Response("{}", { status: 200 })],
  ])("rejects a GitLab project %s", async (_name, response) => {
    const pulseDir = await makePulseDir();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    try {
      await expect(syncPreset("https://gitlab.com/group/repo", pulseDir)).rejects.toThrow(
        /invalid GitLab repository response/,
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("paginates GitLab trees and rejects incomplete repository paths", async () => {
    const pulseDir = await makePulseDir();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/-/raw/")) {
        return new Response(PULSE_A);
      }
      const page = new URL(String(input)).searchParams.get("page");
      if (page === "1") {
        return new Response(
          JSON.stringify(
            Array.from({ length: 100 }, (_, index) => ({
              type: "blob",
              path: `ignore-${index}.txt`,
            })),
          ),
          { headers: { "x-next-page": "2" } },
        );
      }
      return new Response(
        JSON.stringify([
          { type: "blob", path: "wave-b.pulse" },
          { type: "blob", path: "wave-a.pulse" },
        ]),
      );
    });
    try {
      const result = await syncPreset("https://gitlab.com/group/repo/-/tree/main", pulseDir);
      expect(result.files).toBe(2);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      fetchMock.mockRestore();
    }

    await expect(
      syncPreset("https://git.corp.test/repo/-/tree/main", await makePulseDir()),
    ).rejects.toThrow(/invalid GitLab repository source/);
  });

  it("enforces GitLab and HTTP directory file limits", async () => {
    const gitlabDir = await makePulseDir();
    const gitlabFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify(
          Array.from({ length: 101 }, (_, index) => ({
            type: "blob",
            path: `wave-${index}.pulse`,
          })),
        ),
      ),
    );
    try {
      await expect(
        syncPreset("https://gitlab.com/group/repo/-/tree/main", gitlabDir),
      ).rejects.toThrow(/more than 100/);
    } finally {
      gitlabFetch.mockRestore();
    }

    const links = Array.from(
      { length: 101 },
      (_, index) => `<a href="wave-${index}.pulse">wave</a>`,
    ).join("");
    const { origin } = await startHttpServer((_request, response) => {
      response.end(`<a>missing href</a><a href="http://[">invalid</a>${links}`);
    });
    const httpDir = await makePulseDir();
    await expect(syncPreset(`${origin}/pulses/`, httpDir)).rejects.toThrow(/more than 100/);
  });

  it("enforces the HTTP directory traversal limit", async () => {
    let page = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const response = new Response(`<a href="/pulses/${page++}/">next</a>`, {
        headers: { "content-type": "text/html" },
      });
      Object.defineProperty(response, "url", { value: String(input) });
      return response;
    });
    const pulseDir = await makePulseDir();
    try {
      await expect(syncPreset("https://example.com/pulses/", pulseDir)).rejects.toThrow(
        /1000-page traversal limit/,
      );
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("handles empty bodies, reserved names, unsafe paths, and repeated collisions", async () => {
    const emptyDir = await makePulseDir();
    const emptyFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    try {
      await expect(syncPreset("https://example.com/empty.pulse", emptyDir)).rejects.toThrow(
        /invalid preset/,
      );
    } finally {
      emptyFetch.mockRestore();
    }

    const unsafeDir = await makePulseDir();
    const unsafeFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          truncated: false,
          tree: [{ type: "blob", path: "../unsafe.pulse" }],
        }),
      ),
    );
    try {
      await expect(syncPreset("https://github.com/owner/repo#main", unsafeDir)).rejects.toThrow(
        /unsafe URL path segment/,
      );
    } finally {
      unsafeFetch.mockRestore();
    }

    const reservedDir = await makePulseDir();
    const reservedFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("api.github.com")) {
        return new Response(
          JSON.stringify({
            truncated: false,
            tree: [
              { type: "blob", path: "CON.pulse" },
              { type: "blob", path: "bad\u0001.pulse" },
            ],
          }),
        );
      }
      return new Response(PULSE_A);
    });
    try {
      await syncPreset("https://github.com/owner/repo#main", reservedDir);
      expect(await fs.readFile(path.join(reservedDir, "_CON.pulse"), "utf8")).toBe(PULSE_A);
      expect(await fs.readFile(path.join(reservedDir, "bad_.pulse"), "utf8")).toBe(PULSE_A);
    } finally {
      reservedFetch.mockRestore();
    }

    const { origin } = await startHttpServer((request, response) => {
      if (request.url?.startsWith("/a/")) response.end(PULSE_A);
      else if (request.url?.startsWith("/b/")) response.end(PULSE_B);
      else response.end(PULSE_C);
    });
    const collisionDir = await makePulseDir();
    await syncPreset(`${origin}/a/same.pulse`, collisionDir);
    await syncPreset(`${origin}/b/same.pulse`, collisionDir);
    const pulseCHash = createHash("sha256").update(PULSE_C).digest("hex").slice(0, 12);
    await fs.writeFile(path.join(collisionDir, `same-${pulseCHash}.pulse`), PULSE_A);
    await syncPreset(`${origin}/c/same.pulse`, collisionDir);
    expect(await fs.readFile(path.join(collisionDir, `same-${pulseCHash}-2.pulse`), "utf8")).toBe(
      PULSE_C,
    );

    const occupiedDir = await makePulseDir();
    await fs.mkdir(path.join(occupiedDir, "same.pulse"));
    await syncPreset(`${origin}/a/same.pulse`, occupiedDir);
    expect(
      (await fs.readdir(occupiedDir)).some((file) => /^same-[a-f0-9]{12}\.pulse$/.test(file)),
    ).toBe(true);
  });

  it("reports path component conflicts while storing repository files", async () => {
    const pulseDir = await makePulseDir();
    await fs.writeFile(path.join(pulseDir, "nested"), "occupied");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("api.github.com")) {
        return new Response(
          JSON.stringify({
            truncated: false,
            tree: [{ type: "blob", path: "nested/wave.pulse" }],
          }),
        );
      }
      return new Response(PULSE_A);
    });
    try {
      await expect(syncPreset("https://github.com/owner/repo#main", pulseDir)).rejects.toThrow();
    } finally {
      fetchMock.mockRestore();
    }
  });
});
