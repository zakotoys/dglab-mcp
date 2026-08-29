import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parsePulseText } from "@dg-kit/waveforms";
import { type DefaultTreeAdapterTypes, parse } from "parse5";
import { z } from "zod";
import { PULSE_FILE_LIMIT_BYTES } from "./waveforms/catalog.js";

const MANIFEST_VERSION = 1;
const FETCH_TIMEOUT_MS = 15_000;
const DIRECTORY_PAGE_LIMIT_BYTES = 1024 * 1024;
const GITHUB_TREE_LIMIT_BYTES = 7 * 1024 * 1024;
const DIRECTORY_PAGE_LIMIT = 1000;
export const PRESET_MANIFEST_FILE = "manifest.json";

const manifestFileSchema = z.object({
  url: z.url(),
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

const manifestSourceSchema = z.object({
  kind: z.enum(["file", "directory"]),
  files: z.array(manifestFileSchema),
});

const manifestSchema = z.object({
  version: z.literal(MANIFEST_VERSION),
  sources: z.record(z.string(), manifestSourceSchema),
});

const githubTreeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(
    z.object({
      path: z.string().min(1),
      type: z.string(),
    }),
  ),
});

type Manifest = z.infer<typeof manifestSchema>;
type ManifestFile = z.infer<typeof manifestFileSchema>;
type ManifestSource = z.infer<typeof manifestSourceSchema>;

interface RemoteFile {
  url: URL;
  relativePath: string;
}

interface GitHubTreeSource {
  sourceUrl: URL;
  owner: string;
  repo: string;
  ref: string;
  directoryPath: string;
}

interface GitHubBlobSource {
  owner: string;
  repo: string;
  ref: string;
  filePath: string;
}

export type ParsedPresetUrl =
  | { kind: "file"; url: URL; relativePath: string }
  | { kind: "directory"; url: URL }
  | { kind: "github-tree"; source: GitHubTreeSource };

interface DownloadedFile extends RemoteFile {
  content: Buffer;
  sha256: string;
  managedPath?: string;
}

export interface PresetSyncResult {
  sourceUrl: string;
  downloaded: number;
  reused: number;
  files: number;
}

export async function syncPreset(sourceUrl: URL, pulseDir: string): Promise<PresetSyncResult> {
  const normalizedSourceUrl = new URL(normalizeSourceUrl(sourceUrl));
  const sourceKey = normalizedSourceUrl.href;
  await fs.mkdir(pulseDir, { recursive: true });
  const manifest = await readManifest(pulseDir);
  const cachedSource = manifest.sources[sourceKey];

  if (cachedSource !== undefined && (await sourceIsCurrent(pulseDir, cachedSource))) {
    return {
      sourceUrl: sourceKey,
      downloaded: 0,
      reused: cachedSource.files.length,
      files: cachedSource.files.length,
    };
  }

  const { kind, files } = await discoverRemoteFiles(normalizedSourceUrl);
  const previousFiles = new Map(cachedSource?.files.map((file) => [file.url, file]) ?? []);
  const nextFiles: ManifestFile[] = [];
  const downloads: DownloadedFile[] = [];
  let reused = 0;

  for (const remoteFile of files) {
    const url = remoteFile.url.href;
    const previous = previousFiles.get(url);
    if (previous !== undefined && (await manifestFileIsCurrent(pulseDir, previous))) {
      nextFiles.push(previous);
      reused += 1;
      continue;
    }

    const content = await downloadPulse(remoteFile.url);
    downloads.push({
      ...remoteFile,
      content,
      sha256: sha256(content),
      managedPath: previous?.path,
    });
  }

  for (const download of downloads) {
    const relativePath = await storePulse(
      pulseDir,
      download.relativePath,
      download.content,
      download.sha256,
      download.managedPath,
    );
    nextFiles.push({ url: download.url.href, path: relativePath, sha256: download.sha256 });
  }

  nextFiles.sort((a, b) => a.url.localeCompare(b.url));
  manifest.sources[sourceKey] = { kind, files: nextFiles };
  await writeManifest(pulseDir, manifest);

  return {
    sourceUrl: sourceKey,
    downloaded: downloads.length,
    reused,
    files: nextFiles.length,
  };
}

function normalizeSourceUrl(url: URL): string {
  const normalized = new URL(url);
  normalized.hash = "";
  return normalized.href;
}

async function readManifest(pulseDir: string): Promise<Manifest> {
  const manifestPath = path.join(pulseDir, PRESET_MANIFEST_FILE);
  let text: string;
  try {
    text = await fs.readFile(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: MANIFEST_VERSION, sources: {} };
    }
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid preset manifest: ${(error as Error).message}`);
  }
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`invalid preset manifest: ${z.prettifyError(parsed.error)}`);
  }
  for (const source of Object.values(parsed.data.sources)) {
    for (const file of source.files) {
      try {
        resolveManifestPath(pulseDir, file.path);
      } catch (error) {
        throw new Error(`invalid preset manifest: ${(error as Error).message}`);
      }
    }
  }
  return parsed.data;
}

async function writeManifest(pulseDir: string, manifest: Manifest): Promise<void> {
  const sources = Object.fromEntries(
    Object.entries(manifest.sources).sort(([left], [right]) => left.localeCompare(right)),
  );
  const manifestPath = path.join(pulseDir, PRESET_MANIFEST_FILE);
  const temporaryPath = path.join(
    pulseDir,
    `.${PRESET_MANIFEST_FILE}.${process.pid}.${Date.now()}.tmp`,
  );
  await fs.writeFile(
    temporaryPath,
    `${JSON.stringify({ version: MANIFEST_VERSION, sources }, null, 2)}\n`,
    "utf8",
  );
  try {
    await fs.rename(temporaryPath, manifestPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

async function sourceIsCurrent(pulseDir: string, source: ManifestSource): Promise<boolean> {
  if (source.files.length === 0) {
    return false;
  }
  const current = await Promise.all(
    source.files.map((file) => manifestFileIsCurrent(pulseDir, file)),
  );
  return current.every(Boolean);
}

async function manifestFileIsCurrent(pulseDir: string, file: ManifestFile): Promise<boolean> {
  let filePath: string;
  try {
    filePath = resolveManifestPath(pulseDir, file.path);
  } catch {
    return false;
  }
  try {
    const content = await fs.readFile(filePath);
    return content.length <= PULSE_FILE_LIMIT_BYTES && sha256(content) === file.sha256;
  } catch {
    return false;
  }
}

async function discoverRemoteFiles(
  sourceUrl: URL,
): Promise<{ kind: "file" | "directory"; files: RemoteFile[] }> {
  const parsed = parsePresetUrl(sourceUrl);
  if (parsed.kind === "file") {
    return {
      kind: "file",
      files: [{ url: parsed.url, relativePath: parsed.relativePath }],
    };
  }

  const files =
    parsed.kind === "github-tree"
      ? await discoverGitHubFiles(parsed.source)
      : await crawlDirectory(parsed.url);
  if (files.length === 0) {
    throw new Error(`preset directory ${sourceUrl.href} contains no .pulse files`);
  }
  return { kind: "directory", files };
}

export function parsePresetUrl(sourceUrl: URL): ParsedPresetUrl {
  const url = new URL(sourceUrl);
  if (isPulseUrl(url)) {
    const githubBlob = parseGitHubBlobUrl(url);
    return {
      kind: "file",
      url: githubBlob === undefined ? url : githubRawFileUrl(githubBlob, githubBlob.filePath),
      relativePath: safeUrlPath(path.posix.basename(url.pathname)),
    };
  }

  const githubTree = parseGitHubTreeUrl(url);
  if (githubTree !== undefined) {
    return { kind: "github-tree", source: githubTree };
  }
  return { kind: "directory", url };
}

function parseGitHubTreeUrl(url: URL): GitHubTreeSource | undefined {
  if (url.hostname.toLowerCase() !== "github.com") {
    return undefined;
  }
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  if (segments.length < 4 || segments[2]?.toLowerCase() !== "tree") {
    return undefined;
  }
  try {
    return {
      sourceUrl: url,
      owner: decodeURIComponent(segments[0]!),
      repo: decodeURIComponent(segments[1]!),
      ref: decodeURIComponent(segments[3]!),
      directoryPath: segments
        .slice(4)
        .map((segment) => decodeURIComponent(segment))
        .join("/"),
    };
  } catch {
    throw new Error(`invalid GitHub tree URL ${url.href}`);
  }
}

function parseGitHubBlobUrl(url: URL): GitHubBlobSource | undefined {
  if (url.hostname.toLowerCase() !== "github.com") {
    return undefined;
  }
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  if (segments.length < 5 || segments[2]?.toLowerCase() !== "blob") {
    return undefined;
  }
  try {
    return {
      owner: decodeURIComponent(segments[0]!),
      repo: decodeURIComponent(segments[1]!),
      ref: decodeURIComponent(segments[3]!),
      filePath: segments
        .slice(4)
        .map((segment) => decodeURIComponent(segment))
        .join("/"),
    };
  } catch {
    throw new Error(`invalid GitHub blob URL ${url.href}`);
  }
}

async function discoverGitHubFiles(source: GitHubTreeSource): Promise<RemoteFile[]> {
  const apiUrl = new URL(
    `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/git/trees/${encodeURIComponent(source.ref)}`,
  );
  apiUrl.searchParams.set("recursive", "1");
  const response = await fetch(apiUrl, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "dglab-mcp",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `failed to fetch GitHub preset tree ${source.sourceUrl.href}: HTTP ${response.status}`,
    );
  }

  const body = await readBoundedResponse(response, GITHUB_TREE_LIMIT_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch (error) {
    throw new Error(
      `invalid GitHub tree response for ${source.sourceUrl.href}: ${(error as Error).message}`,
    );
  }
  const parsed = githubTreeSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`invalid GitHub tree response for ${source.sourceUrl.href}`);
  }
  if (parsed.data.truncated) {
    throw new Error(`GitHub tree for ${source.sourceUrl.href} is too large to traverse safely`);
  }

  const prefix = source.directoryPath === "" ? "" : `${source.directoryPath.replace(/\/+$/g, "")}/`;
  const files = new Map<string, RemoteFile>();
  for (const entry of parsed.data.tree) {
    if (entry.type !== "blob" || !entry.path.toLowerCase().endsWith(".pulse")) {
      continue;
    }
    if (prefix !== "" && !entry.path.startsWith(prefix)) {
      continue;
    }
    if (files.size >= 100) {
      throw new Error("preset directory contains more than 100 .pulse files");
    }
    const relativePath = safeUrlPath(entry.path.slice(prefix.length));
    const url = githubRawFileUrl(source, entry.path);
    files.set(url.href, { url, relativePath });
  }
  return [...files.values()].sort((left, right) => left.url.href.localeCompare(right.url.href));
}

function githubRawFileUrl(
  source: Pick<GitHubTreeSource, "owner" | "repo" | "ref"> | GitHubBlobSource,
  filePath: string,
): URL {
  const pathSegments = [source.owner, source.repo, source.ref, ...filePath.split("/")];
  return new URL(
    `https://raw.githubusercontent.com/${pathSegments.map((segment) => encodeURIComponent(segment)).join("/")}`,
  );
}

async function crawlDirectory(sourceUrl: URL): Promise<RemoteFile[]> {
  const firstPage = await downloadPage(sourceUrl);
  const rootUrl = directoryBaseUrl(new URL(firstPage.url));
  const queue: Array<{ url: URL; html?: string }> = [{ url: rootUrl, html: firstPage.html }];
  const visited = new Set<string>();
  const files = new Map<string, RemoteFile>();

  while (queue.length > 0) {
    if (visited.size >= DIRECTORY_PAGE_LIMIT) {
      throw new Error(`preset directory exceeds the ${DIRECTORY_PAGE_LIMIT}-page traversal limit`);
    }
    const page = queue.shift()!;
    const pageKey = page.url.href;
    if (visited.has(pageKey)) {
      continue;
    }
    visited.add(pageKey);
    const downloaded = page.html === undefined ? await downloadPage(page.url) : undefined;
    const effectiveUrl = directoryBaseUrl(new URL(downloaded?.url ?? page.url));
    assertWithinDirectory(effectiveUrl, rootUrl);
    const html = downloaded?.html ?? page.html!;

    for (const href of extractLinks(html)) {
      let candidate: URL;
      try {
        candidate = new URL(href, effectiveUrl);
      } catch {
        continue;
      }
      candidate.hash = "";
      if (!isWithinDirectory(candidate, rootUrl)) {
        continue;
      }
      if (isPulseUrl(candidate)) {
        if (!files.has(candidate.href)) {
          if (files.size >= 100) {
            throw new Error("preset directory contains more than 100 .pulse files");
          }
          const relativeUrlPath = candidate.pathname.slice(rootUrl.pathname.length);
          files.set(candidate.href, {
            url: candidate,
            relativePath: safeUrlPath(relativeUrlPath),
          });
        }
      } else if (
        candidate.search === "" &&
        (candidate.pathname.endsWith("/") || !path.posix.basename(candidate.pathname).includes("."))
      ) {
        queue.push({ url: candidate });
      }
    }
  }

  return [...files.values()].sort((a, b) => a.url.href.localeCompare(b.url.href));
}

function extractLinks(html: string): string[] {
  const links: string[] = [];
  const document = parse(html);

  const visit = (node: DefaultTreeAdapterTypes.Node): void => {
    if ("tagName" in node && node.tagName === "a") {
      const href = node.attrs.find((attribute) => attribute.name === "href")?.value;
      if (href !== undefined) {
        links.push(href);
      }
    }
    if ("childNodes" in node) {
      for (const child of node.childNodes) {
        visit(child);
      }
    }
  };
  visit(document);
  return links;
}

async function downloadPage(url: URL): Promise<{ url: string; html: string }> {
  const response = await fetch(url, {
    headers: { accept: "text/html" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`failed to fetch preset directory ${url.href}: HTTP ${response.status}`);
  }
  const content = await readBoundedResponse(response, DIRECTORY_PAGE_LIMIT_BYTES);
  return { url: response.url, html: new TextDecoder("utf-8", { fatal: true }).decode(content) };
}

async function downloadPulse(url: URL): Promise<Buffer> {
  const response = await fetch(url, {
    headers: { accept: "text/plain, application/octet-stream" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`failed to download preset ${url.href}: HTTP ${response.status}`);
  }
  const content = await readBoundedResponse(response, PULSE_FILE_LIMIT_BYTES);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    parsePulseText(text);
  } catch (error) {
    throw new Error(`invalid preset ${url.href}: ${(error as Error).message}`);
  }
  return content;
}

async function readBoundedResponse(response: Response, limit: number): Promise<Buffer> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > limit) {
    await response.body?.cancel();
    throw new Error(`response is ${contentLength} bytes, exceeding the ${limit}-byte limit`);
  }
  if (response.body === null) {
    return Buffer.alloc(0);
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      throw new Error(`response exceeds the ${limit}-byte limit`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size);
}

async function storePulse(
  pulseDir: string,
  requestedPath: string,
  content: Buffer,
  hash: string,
  managedPath?: string,
): Promise<string> {
  if (managedPath !== undefined) {
    const filePath = resolveManifestPath(pulseDir, managedPath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
    return managedPath;
  }

  let candidate = requestedPath;
  let suffix = 0;
  while (true) {
    const filePath = resolveManifestPath(pulseDir, candidate);
    try {
      const existing = await fs.readFile(filePath);
      if (sha256(existing) === hash) {
        return candidate;
      }
      suffix += 1;
      candidate = withHashSuffix(requestedPath, hash, suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, { flag: "wx" });
      return candidate;
    }
  }
}

function withHashSuffix(relativePath: string, hash: string, suffix: number): string {
  const extension = path.posix.extname(relativePath);
  const stem = relativePath.slice(0, -extension.length);
  const counter = suffix === 1 ? "" : `-${suffix}`;
  return `${stem}-${hash.slice(0, 12)}${counter}${extension}`;
}

function directoryBaseUrl(url: URL): URL {
  const base = new URL(url);
  base.hash = "";
  base.search = "";
  if (!base.pathname.endsWith("/")) {
    base.pathname += "/";
  }
  return base;
}

function isPulseUrl(url: URL): boolean {
  return url.pathname.toLowerCase().endsWith(".pulse");
}

function isWithinDirectory(candidate: URL, root: URL): boolean {
  return (
    candidate.origin === root.origin &&
    candidate.username === "" &&
    candidate.password === "" &&
    candidate.pathname.startsWith(root.pathname)
  );
}

function assertWithinDirectory(candidate: URL, root: URL): void {
  if (!isWithinDirectory(candidate, root)) {
    throw new Error(`preset directory redirected outside ${root.href}`);
  }
}

function safeUrlPath(urlPath: string): string {
  const segments = urlPath
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => sanitizePathSegment(segment));
  if (segments.length === 0 || !segments.at(-1)!.toLowerCase().endsWith(".pulse")) {
    throw new Error(`unsafe preset path "${urlPath}"`);
  }
  return segments.join("/");
}

function sanitizePathSegment(encodedSegment: string): string {
  let segment: string;
  try {
    segment = decodeURIComponent(encodedSegment);
  } catch {
    throw new Error(`invalid URL path segment "${encodedSegment}"`);
  }
  segment = [...segment]
    .map((character) => (character.charCodeAt(0) < 32 ? "_" : character))
    .join("")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/[ .]+$/g, "");
  if (segment === "" || segment === "." || segment === "..") {
    throw new Error(`unsafe URL path segment "${encodedSegment}"`);
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) {
    segment = `_${segment}`;
  }
  return segment;
}

function resolveManifestPath(pulseDir: string, manifestPath: string): string {
  if (manifestPath.includes("\\")) {
    throw new Error(`unsafe manifest path "${manifestPath}"`);
  }
  const root = path.resolve(pulseDir);
  const resolved = path.resolve(root, ...manifestPath.split("/"));
  const relative = path.relative(root, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`unsafe manifest path "${manifestPath}"`);
  }
  return resolved;
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
