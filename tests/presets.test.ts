import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PRESET_MANIFEST_FILE, syncPreset } from "../src/presets.js";
import { scanPulseDirectory } from "../src/waveforms/catalog.js";

const PULSE_A = "Dungeonlab+pulse:Alpha=0,0,0,1,1/10-0,50-100";
const PULSE_B = "Dungeonlab+pulse:Beta=0,0,0,1,1/20-0,75-100";
const servers: Server[] = [];
const tmpDirs: string[] = [];

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
      response.setHeader("content-type", url.endsWith("/") ? "text/html" : "text/plain");
      if (url === "/library/") {
        response.end(
          '<a href="root.pulse">root</a><a href="nested">nested</a><a href="/outside.pulse">outside</a>',
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
    expect(requests).toHaveLength(requestCount);

    await fs.rm(path.join(pulseDir, "nested", "deep wave.pulse"));
    const repaired = await syncPreset(source, pulseDir);
    expect(repaired).toMatchObject({ downloaded: 1, reused: 1, files: 2 });
    expect(requests.slice(requestCount)).toEqual([
      "/library/",
      "/library/nested",
      "/library/nested/deep%20wave.pulse",
    ]);
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
  });

  it("resolves GitHub tree URLs through the recursive tree API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (
        url.startsWith("https://api.github.com/repos/zakotoys/dglab-pulse-collect/git/trees/main")
      ) {
        return new Response(
          JSON.stringify({
            truncated: false,
            tree: [
              { path: "pulses/pulse-001/root.pulse", type: "blob" },
              { path: "pulses/pulse-001/nested/deep.pulse", type: "blob" },
              { path: "pulses/other.pulse", type: "blob" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
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
      expect(fetchMock).toHaveBeenCalledTimes(3);
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

  it("resolves GitLab tree URLs through the repository tree API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("gitlab.com/api/v4/projects/group%2Frepo/repository/tree")) {
        return new Response(JSON.stringify([{ type: "blob", path: "pulses/wave.pulse" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://gitlab.com/group/repo/-/raw/main/pulses/wave.pulse") {
        return new Response(PULSE_A, { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const pulseDir = await makePulseDir();

    try {
      const result = await syncPreset("https://gitlab.com/group/repo/-/tree/main/pulses", pulseDir);
      expect(result).toMatchObject({ downloaded: 1, reused: 0, files: 1 });
      expect(await fs.readFile(path.join(pulseDir, "wave.pulse"), "utf8")).toBe(PULSE_A);
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
});
