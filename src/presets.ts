import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parsePulseText } from "@dg-kit/waveforms";
import { type DefaultTreeAdapterTypes, parse } from "parse5";
import { z } from "zod";
import { type ParsedSource, parseSource } from "./source-parser.js";
import { PULSE_FILE_LIMIT_BYTES } from "./waveforms/catalog.js";

const MANIFEST_VERSION = 1;
const FETCH_TIMEOUT_MS = 15_000;
const DIRECTORY_PAGE_LIMIT_BYTES = 1024 * 1024;
const GITHUB_TREE_LIMIT_BYTES = 7 * 1024 * 1024;
const DIRECTORY_PAGE_LIMIT = 1000;
const GITLAB_PAGE_LIMIT = 1000;
export const PRESET_MANIFEST_FILE = "manifest.json";

const manifestFileSchema = z.object({
  url: z.url(),
  path: z
    .string()
    .min(1)
    .refine((value) => value.toLowerCase().endsWith(".pulse"), {
      message: "must reference a .pulse file",
    }),
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

const gitlabTreeSchema = z.array(
  z.object({
    type: z.string(),
    path: z.string().min(1),
  }),
);

const gitlabProjectSchema = z.object({ default_branch: z.string().min(1) });

type Manifest = z.infer<typeof manifestSchema>;
type ManifestFile = z.infer<typeof manifestFileSchema>;
type ManifestSource = z.infer<typeof manifestSourceSchema>;

interface RemoteFile {
  url: URL;
  relativePath: string;
  content?: Buffer;
}

interface DownloadedFile extends RemoteFile {
  content: Buffer;
  sha256: string;
  managedPath?: string;
  reservedPath?: string;
}

export interface PresetSyncResult {
  sourceUrl: string;
  downloaded: number;
  reused: number;
  files: number;
}

export async function syncPreset(sourceInput: string, pulseDir: string): Promise<PresetSyncResult> {
  const source = parseSource(sourceInput);
  const sourceKey = sourceKeyFor(source);
  await fs.mkdir(pulseDir, { recursive: true });
  const manifest = await readManifest(pulseDir);
  const cachedSource = manifest.sources[sourceKey];

  if (
    source.type !== "local" &&
    source.type !== "git" &&
    cachedSource !== undefined &&
    cachedSource.kind === "file" &&
    (await sourceIsCurrent(pulseDir, cachedSource))
  ) {
    return {
      sourceUrl: sourceKey,
      downloaded: 0,
      reused: cachedSource.files.length,
      files: cachedSource.files.length,
    };
  }

  const { kind, files } = await discoverRemoteFiles(source);
  const previousFiles = new Map(cachedSource?.files.map((file) => [file.url, file]) ?? []);
  const nextFiles: ManifestFile[] = [];
  const downloads: DownloadedFile[] = [];
  let reused = 0;

  for (const remoteFile of files) {
    const url = remoteFile.url.href;
    const previous = previousFiles.get(url);
    const targetIsCurrent =
      previous !== undefined && (await manifestFileIsCurrent(pulseDir, previous));
    if (
      source.type !== "local" &&
      remoteFile.content === undefined &&
      previous !== undefined &&
      targetIsCurrent
    ) {
      nextFiles.push(previous);
      reused += 1;
      continue;
    }

    const content = remoteFile.content ?? (await downloadPulse(remoteFile.url));
    const contentSha256 = sha256(content);
    if (targetIsCurrent && previous !== undefined && previous.sha256 === contentSha256) {
      nextFiles.push(previous);
      reused += 1;
      continue;
    }
    const previousPathIsShared =
      previous !== undefined && manifestPathReferenceCount(manifest, previous.path) > 1;
    downloads.push({
      ...remoteFile,
      content,
      sha256: contentSha256,
      managedPath: previousPathIsShared ? undefined : previous?.path,
      reservedPath: previousPathIsShared ? previous.path : undefined,
    });
  }

  for (const download of downloads) {
    const relativePath = await storePulse(
      pulseDir,
      download.relativePath,
      download.content,
      download.sha256,
      download.managedPath,
      download.reservedPath,
    );
    nextFiles.push({ url: download.url.href, path: relativePath, sha256: download.sha256 });
  }

  nextFiles.sort((a, b) => a.url.localeCompare(b.url));
  if (cachedSource?.kind === "directory") {
    await removeStaleManagedFiles(pulseDir, manifest, cachedSource, nextFiles);
  }
  manifest.sources[sourceKey] = { kind, files: nextFiles };
  await writeManifest(pulseDir, manifest);

  return {
    sourceUrl: sourceKey,
    downloaded: downloads.length,
    reused,
    files: nextFiles.length,
  };
}

function manifestPathReferenceCount(manifest: Manifest, managedPath: string): number {
  let references = 0;
  for (const source of Object.values(manifest.sources)) {
    for (const file of source.files) {
      if (file.path === managedPath) {
        references += 1;
      }
    }
  }
  return references;
}

async function removeStaleManagedFiles(
  pulseDir: string,
  manifest: Manifest,
  previousSource: ManifestSource,
  nextFiles: ManifestFile[],
): Promise<void> {
  const nextUrls = new Set(nextFiles.map((file) => file.url));
  for (const previous of previousSource.files) {
    if (nextUrls.has(previous.url) || manifestPathReferenceCount(manifest, previous.path) !== 1) {
      continue;
    }
    if (!(await manifestFileIsCurrent(pulseDir, previous))) {
      continue;
    }
    await fs.rm(resolveManifestPath(pulseDir, previous.path), { force: true });
  }
}

function sourceKeyFor(source: ParsedSource): string {
  if (source.type === "local") {
    return pathToFileURL(source.localPath!).href;
  }
  if (!source.url.startsWith("http://") && !source.url.startsWith("https://")) {
    return source.ref === undefined ? source.url : `${source.url}#${source.ref}`;
  }
  const normalized = new URL(source.url);
  normalized.hash = "";
  if (source.ref !== undefined) {
    normalized.hash = source.ref;
  }
  if (source.treePath !== undefined) {
    normalized.searchParams.set("tree", source.treePath);
  }
  if (source.subpath !== undefined) {
    normalized.searchParams.set("path", source.subpath);
  }
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
  const filePath = resolveManifestPath(pulseDir, file.path);
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > PULSE_FILE_LIMIT_BYTES) {
      return false;
    }
    const content = await fs.readFile(filePath);
    return sha256(content) === file.sha256;
  } catch {
    return false;
  }
}

async function discoverRemoteFiles(
  source: ParsedSource,
): Promise<{ kind: "file" | "directory"; files: RemoteFile[] }> {
  if (source.type === "local") {
    return discoverLocalFiles(source.localPath!);
  }
  if (source.type === "github") {
    const files = await discoverGitHubFiles(source);
    return directoryResult(source.url, files);
  }
  if (source.type === "gitlab") {
    const files = await discoverGitLabFiles(source);
    return directoryResult(source.url, files);
  }
  if (source.type === "well-known" || source.type === "download") {
    return discoverHttpFiles(source);
  }
  const files = await discoverGitFiles(source);
  return directoryResult(source.url, files);
}

function directoryResult(
  sourceUrl: string,
  files: RemoteFile[],
): { kind: "directory"; files: RemoteFile[] } {
  if (files.length === 0) {
    throw new Error(`preset directory ${sourceUrl} contains no .pulse files`);
  }
  return { kind: "directory", files };
}

async function discoverHttpFiles(
  source: ParsedSource,
): Promise<{ kind: "file" | "directory"; files: RemoteFile[] }> {
  const url = new URL(source.url);
  if (isPulseUrl(url)) {
    return {
      kind: "file",
      files: [{ url, relativePath: safeUrlPath(path.posix.basename(url.pathname)) }],
    };
  }
  if (source.type === "download") {
    throw new Error(`preset download ${source.url} is not a .pulse file`);
  }
  return discoverDirectoryFiles(url);
}

async function discoverLocalFiles(
  localPath: string,
): Promise<{ kind: "file" | "directory"; files: RemoteFile[] }> {
  const absolutePath = path.resolve(localPath);
  const stats = await fs.stat(absolutePath);
  if (stats.isFile()) {
    if (!isPulsePath(absolutePath)) {
      throw new Error(`local preset file ${absolutePath} does not end in .pulse`);
    }
    return {
      kind: "file",
      files: [
        {
          url: pathToFileURL(absolutePath),
          relativePath: safeLocalPath(path.basename(absolutePath)),
        },
      ],
    };
  }
  if (!stats.isDirectory()) {
    throw new Error(`local preset source ${absolutePath} is not a file or directory`);
  }

  const files: RemoteFile[] = [];
  const queue = [absolutePath];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      if (!entry.isFile() || !isPulsePath(entryPath)) {
        continue;
      }
      if (files.length >= 100) {
        throw new Error("preset directory contains more than 100 .pulse files");
      }
      const relativePath = path.relative(absolutePath, entryPath);
      files.push({
        url: pathToFileURL(entryPath),
        relativePath: safeLocalPath(relativePath),
      });
    }
  }
  files.sort((left, right) => left.url.href.localeCompare(right.url.href));
  if (files.length === 0) {
    throw new Error(`preset directory ${absolutePath} contains no .pulse files`);
  }
  return { kind: "directory", files };
}

async function discoverGitFiles(source: ParsedSource): Promise<RemoteFile[]> {
  const tempDir = await fs.mkdtemp(path.join(tmpdir(), "dglab-git-preset-"));
  try {
    const args = ["clone", "--depth", "1"];
    if (source.ref !== undefined) {
      args.push("--branch", source.ref);
    }
    args.push(source.url, tempDir);
    await new Promise<void>((resolve, reject) => {
      execFile("git", args, { timeout: FETCH_TIMEOUT_MS, windowsHide: true }, (error) =>
        error ? reject(error) : resolve(),
      );
    });

    const root = source.subpath === undefined ? tempDir : path.join(tempDir, source.subpath);
    const discovered = await discoverLocalFiles(root);
    const files = await Promise.all(
      discovered.files.map(async (file) => ({
        url: gitSourceFileUrl(source, file.relativePath),
        relativePath: file.relativePath,
        content: await readLocalPulse(fileURLToPath(file.url), file.url.href),
      })),
    );
    return files;
  } catch (error) {
    throw new Error(`failed to fetch git preset ${source.url}: ${(error as Error).message}`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

interface RepositoryTreeLocation {
  ref: string;
  subpath?: string;
}

function repositoryTreeLocations(treePath: string): RepositoryTreeLocation[] {
  const segments = treePath.split("/").filter(Boolean);
  return segments.map((_, index) => ({
    ref: segments.slice(0, segments.length - index).join("/"),
    ...(index === 0 ? {} : { subpath: segments.slice(segments.length - index).join("/") }),
  }));
}

function gitSourceFileUrl(source: ParsedSource, relativePath: string): URL {
  const url = new URL("git+preset://source/file");
  url.searchParams.set("source", source.url);
  if (source.ref !== undefined) {
    url.searchParams.set("ref", source.ref);
  }
  url.searchParams.set("path", relativePath);
  return url;
}

function isPulsePath(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === ".pulse";
}

async function discoverDirectoryFiles(
  sourceUrl: URL,
): Promise<{ kind: "file" | "directory"; files: RemoteFile[] }> {
  const files = await crawlDirectory(sourceUrl);
  if (files.length === 0) {
    throw new Error(`preset directory ${sourceUrl.href} contains no .pulse files`);
  }
  return { kind: "directory", files };
}

async function discoverGitHubFiles(source: ParsedSource): Promise<RemoteFile[]> {
  const repository = parseRepositoryUrl(source.url);
  const locations =
    source.treePath === undefined
      ? (source.ref === undefined ? ["HEAD", "main", "master"] : [source.ref]).map((ref) => ({
          ref,
          subpath: source.subpath,
        }))
      : repositoryTreeLocations(source.treePath);
  let treeResponse: Response | undefined;
  let resolvedLocation: RepositoryTreeLocation | undefined;
  for (const location of locations) {
    const apiUrl = new URL(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/git/trees/${encodeURIComponent(location.ref)}`,
    );
    apiUrl.searchParams.set("recursive", "1");
    const response = await fetch(apiUrl, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "dglab-mcp",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status === 404 && (source.ref === undefined || source.treePath !== undefined)) {
      continue;
    }
    treeResponse = response;
    resolvedLocation = location;
    break;
  }
  if (treeResponse === undefined || resolvedLocation === undefined) {
    throw new Error(`failed to resolve GitHub preset repository ${source.url}`);
  }
  if (!treeResponse.ok) {
    throw new Error(
      `failed to fetch GitHub preset tree ${source.url}: HTTP ${treeResponse.status}`,
    );
  }

  const body = await readBoundedResponse(treeResponse, GITHUB_TREE_LIMIT_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch (error) {
    throw new Error(`invalid GitHub tree response for ${source.url}: ${(error as Error).message}`);
  }
  const parsed = githubTreeSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`invalid GitHub tree response for ${source.url}`);
  }
  if (parsed.data.truncated) {
    throw new Error(`GitHub tree for ${source.url} is too large to traverse safely`);
  }

  const prefix =
    resolvedLocation.subpath === undefined
      ? ""
      : `${resolvedLocation.subpath.replace(/\/+$/g, "")}/`;
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
    const relativePath = safeRepositoryPath(entry.path.slice(prefix.length));
    const url = githubRawFileUrl(
      repository.owner,
      repository.repo,
      resolvedLocation.ref,
      entry.path,
    );
    files.set(url.href, { url, relativePath });
  }
  return [...files.values()].sort((left, right) => left.url.href.localeCompare(right.url.href));
}

function parseRepositoryUrl(repositoryUrl: string): { owner: string; repo: string } {
  const parsed = new URL(repositoryUrl);
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) {
    throw new Error(`invalid repository source ${repositoryUrl}`);
  }
  return {
    owner: decodeURIComponent(segments[0]!),
    repo: decodeURIComponent(segments[1]!).replace(/\.git$/i, ""),
  };
}

function githubRawFileUrl(owner: string, repo: string, ref: string, filePath: string): URL {
  const pathSegments = [owner, repo, ref, ...filePath.split("/")];
  return new URL(
    `https://raw.githubusercontent.com/${pathSegments.map((segment) => encodeURIComponent(segment)).join("/")}`,
  );
}

async function discoverGitLabFiles(source: ParsedSource): Promise<RemoteFile[]> {
  const repository = parseGitLabRepositoryUrl(source.url);
  const apiBase = `${repository.protocol}//${repository.host}/api/v4`;
  const projectId = encodeURIComponent(repository.repoPath);
  const locations =
    source.treePath === undefined
      ? [
          {
            ref: source.ref ?? (await fetchGitLabDefaultBranch(apiBase, projectId, source.url)),
            subpath: source.subpath,
          },
        ]
      : repositoryTreeLocations(source.treePath);
  let resolvedLocation: RepositoryTreeLocation | undefined;
  let firstResponse: Response | undefined;
  for (const location of locations) {
    const response = await fetchGitLabTreePage(apiBase, projectId, location.ref, 1);
    if (response.status === 404 && source.treePath !== undefined) {
      continue;
    }
    resolvedLocation = location;
    firstResponse = response;
    break;
  }
  if (resolvedLocation === undefined || firstResponse === undefined) {
    throw new Error(`failed to resolve GitLab preset tree ${source.url}`);
  }
  const entries: Array<{ type: string; path: string }> = [];

  for (let page = 1; page <= GITLAB_PAGE_LIMIT; page += 1) {
    const response =
      page === 1
        ? firstResponse
        : await fetchGitLabTreePage(apiBase, projectId, resolvedLocation.ref, page);
    if (!response.ok) {
      throw new Error(`failed to fetch GitLab preset tree ${source.url}: HTTP ${response.status}`);
    }
    const body = await readBoundedResponse(response, DIRECTORY_PAGE_LIMIT_BYTES);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch (error) {
      throw new Error(
        `invalid GitLab tree response for ${source.url}: ${(error as Error).message}`,
      );
    }
    const parsed = gitlabTreeSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(`invalid GitLab tree response for ${source.url}`);
    }
    entries.push(...parsed.data);
    const nextPage = response.headers.get("x-next-page");
    if (nextPage === null || nextPage === "" || parsed.data.length < 100) {
      break;
    }
  }

  const prefix =
    resolvedLocation.subpath === undefined
      ? ""
      : `${resolvedLocation.subpath.replace(/\/+$/g, "")}/`;
  const files = new Map<string, RemoteFile>();
  for (const entry of entries) {
    if (entry.type !== "blob" || !entry.path.toLowerCase().endsWith(".pulse")) {
      continue;
    }
    if (prefix !== "" && !entry.path.startsWith(prefix)) {
      continue;
    }
    if (files.size >= 100) {
      throw new Error("preset directory contains more than 100 .pulse files");
    }
    const relativePath = safeRepositoryPath(entry.path.slice(prefix.length));
    const url = gitLabRawFileUrl(repository, resolvedLocation.ref, entry.path);
    files.set(url.href, { url, relativePath });
  }
  return [...files.values()].sort((left, right) => left.url.href.localeCompare(right.url.href));
}

function fetchGitLabTreePage(
  apiBase: string,
  projectId: string,
  ref: string,
  page: number,
): Promise<Response> {
  const apiUrl = new URL(`${apiBase}/projects/${projectId}/repository/tree`);
  apiUrl.searchParams.set("recursive", "true");
  apiUrl.searchParams.set("per_page", "100");
  apiUrl.searchParams.set("page", String(page));
  apiUrl.searchParams.set("ref", ref);
  return fetch(apiUrl, {
    headers: { accept: "application/json", "user-agent": "dglab-mcp" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

async function fetchGitLabDefaultBranch(
  apiBase: string,
  projectId: string,
  sourceUrl: string,
): Promise<string> {
  const response = await fetch(`${apiBase}/projects/${projectId}`, {
    headers: { accept: "application/json", "user-agent": "dglab-mcp" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `failed to resolve GitLab preset repository ${sourceUrl}: HTTP ${response.status}`,
    );
  }
  const body = await readBoundedResponse(response, DIRECTORY_PAGE_LIMIT_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch (error) {
    throw new Error(
      `invalid GitLab repository response for ${sourceUrl}: ${(error as Error).message}`,
    );
  }
  const parsed = gitlabProjectSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`invalid GitLab repository response for ${sourceUrl}`);
  }
  return parsed.data.default_branch;
}

function parseGitLabRepositoryUrl(repositoryUrl: string): {
  protocol: string;
  host: string;
  repoPath: string;
} {
  const parsed = new URL(repositoryUrl);
  const repoPath = parsed.pathname.replace(/^\//, "").replace(/\.git$/i, "");
  if (!repoPath.includes("/")) {
    throw new Error(`invalid GitLab repository source ${repositoryUrl}`);
  }
  return { protocol: parsed.protocol, host: parsed.host, repoPath };
}

function gitLabRawFileUrl(
  repository: { protocol: string; host: string; repoPath: string },
  ref: string,
  filePath: string,
): URL {
  const repositoryPath = repository.repoPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const fileSegments = filePath.split("/").map((segment) => encodeURIComponent(segment));
  return new URL(
    `${repository.protocol}//${repository.host}/${repositoryPath}/-/raw/${encodeURIComponent(ref)}/${fileSegments.join("/")}`,
  );
}

async function crawlDirectory(sourceUrl: URL): Promise<RemoteFile[]> {
  const firstPage = await downloadPage(sourceUrl, true);
  if (firstPage.html === null) {
    return [];
  }
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
    const downloaded = page.html === undefined ? await downloadPage(page.url, false) : undefined;
    const effectiveUrl = directoryBaseUrl(new URL(downloaded?.url ?? page.url));
    assertWithinDirectory(effectiveUrl, rootUrl);
    if (downloaded?.html === null) {
      continue;
    }
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
      } else if (candidate.search === "") {
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

async function downloadPage(
  url: URL,
  required: boolean,
): Promise<{ url: string; html: string | null }> {
  const response = await fetch(url, {
    headers: { accept: "text/html" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    if (!required) {
      await response.body?.cancel();
      return { url: response.url || url.href, html: null };
    }
    throw new Error(`failed to fetch preset directory ${url.href}: HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type");
  if (contentType !== null && !/^text\/html(?:;|$)/i.test(contentType.trim())) {
    await response.body?.cancel();
    return { url: response.url || url.href, html: null };
  }
  const content = await readBoundedResponse(response, DIRECTORY_PAGE_LIMIT_BYTES);
  return {
    url: response.url || url.href,
    html: new TextDecoder("utf-8", { fatal: true }).decode(content),
  };
}

async function downloadPulse(url: URL): Promise<Buffer> {
  if (url.protocol === "file:") {
    return readLocalPulse(fileURLToPath(url), url.href);
  }
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

async function readLocalPulse(filePath: string, sourceUrl: string): Promise<Buffer> {
  let content: Buffer;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > PULSE_FILE_LIMIT_BYTES) {
      throw new Error(`response exceeds the ${PULSE_FILE_LIMIT_BYTES}-byte limit`);
    }
    content = await fs.readFile(filePath);
  } catch (error) {
    throw new Error(`failed to read preset ${sourceUrl}: ${(error as Error).message}`);
  }
  try {
    parsePulseText(new TextDecoder("utf-8", { fatal: true }).decode(content));
  } catch (error) {
    throw new Error(`invalid preset ${sourceUrl}: ${(error as Error).message}`);
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
  reservedPath?: string,
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
    if (candidate === reservedPath) {
      suffix += 1;
      candidate = withHashSuffix(requestedPath, hash, suffix);
      continue;
    }
    const filePath = resolveManifestPath(pulseDir, candidate);
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile() && stat.size <= PULSE_FILE_LIMIT_BYTES) {
        const existing = await fs.readFile(filePath);
        if (sha256(existing) === hash) {
          return candidate;
        }
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

function safeLocalPath(localPath: string): string {
  const encoded = localPath
    .split(/[\\/]/)
    .filter((segment) => segment !== "")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return safeUrlPath(encoded);
}

function safeRepositoryPath(repositoryPath: string): string {
  return safeUrlPath(
    repositoryPath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/"),
  );
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
