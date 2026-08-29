import { isAbsolute, resolve } from "node:path";

export interface ParsedSource {
  type: "github" | "gitlab" | "git" | "local" | "well-known" | "download";
  url: string;
  subpath?: string;
  localPath?: string;
  ref?: string;
  treePath?: string;
  skillFilter?: string;
}

const SOURCE_ALIASES: Record<string, string> = {
  "coinbase/agentWallet": "coinbase/agentic-wallet-skills",
  "vercel-labs/vercel-skills": "vercel-labs/agent-skills",
};

interface FragmentRefResult {
  inputWithoutFragment: string;
  ref?: string;
  skillFilter?: string;
}

function getGitHubHost(): string {
  const configuredHost = process.env.GH_HOST?.trim();
  if (!configuredHost) {
    return "github.com";
  }
  try {
    const parsed = new URL(`https://${configuredHost}`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return "github.com";
    }
    return parsed.hostname;
  } catch {
    return "github.com";
  }
}

function isGitHubHost(host: string): boolean {
  const normalizedHost = host.toLowerCase();
  return normalizedHost === "github.com" || normalizedHost === getGitHubHost().toLowerCase();
}

function sanitizeSubpath(subpath: string): string {
  const normalized = subpath.replace(/\\/g, "/");
  if (normalized.split("/").some((segment) => segment === "..")) {
    throw new Error(`unsafe preset source subpath "${subpath}"`);
  }
  return subpath;
}

function decodeUrlSubpath(subpath: string): string {
  try {
    return sanitizeSubpath(
      subpath
        .split("/")
        .map((segment) => decodeURIComponent(segment))
        .join("/"),
    );
  } catch (error) {
    if ((error as Error).message.startsWith("unsafe preset source subpath")) {
      throw error;
    }
    throw new Error(`invalid preset source subpath "${subpath}"`);
  }
}

function isLocalPath(input: string): boolean {
  return (
    isAbsolute(input) ||
    input.startsWith("./") ||
    input.startsWith("../") ||
    input === "." ||
    input === ".." ||
    /^[a-zA-Z]:[\\/]/.test(input)
  );
}

function decodeFragmentValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function looksLikeGitSource(input: string): boolean {
  if (
    input.startsWith("github:") ||
    input.startsWith("gitlab:") ||
    input.startsWith("git@") ||
    input.startsWith("file://")
  ) {
    return true;
  }
  if (/^ssh:\/\/.+\.git(?:$|[/?])/i.test(input)) {
    return true;
  }
  if (input.startsWith("http://") || input.startsWith("https://")) {
    try {
      const parsed = new URL(input);
      if (isGitHubHost(parsed.host)) {
        return /^\/[^/]+\/[^/]+(?:\.git)?(?:\/tree\/[^/]+(?:\/.*)?)?\/?$/.test(parsed.pathname);
      }
      if (parsed.hostname === "gitlab.com") {
        return /^\/.+?\/[^/]+(?:\.git)?(?:\/-\/tree\/[^/]+(?:\/.*)?)?\/?$/.test(parsed.pathname);
      }
    } catch {
      // Fall through to generic checks.
    }
  }
  if (/^https?:\/\/.+\.git(?:$|[/?])/i.test(input)) {
    return true;
  }
  return (
    !input.includes(":") &&
    !input.startsWith(".") &&
    !input.startsWith("/") &&
    /^([^/]+)\/([^/]+)(?:\/(.+)|@(.+))?$/.test(input)
  );
}

function parseFragmentRef(input: string): FragmentRefResult {
  const hashIndex = input.indexOf("#");
  if (hashIndex < 0) {
    return { inputWithoutFragment: input };
  }
  const inputWithoutFragment = input.slice(0, hashIndex);
  const fragment = input.slice(hashIndex + 1);
  if (!fragment || !looksLikeGitSource(inputWithoutFragment)) {
    return { inputWithoutFragment: input };
  }
  const atIndex = fragment.indexOf("@");
  if (atIndex === -1) {
    return { inputWithoutFragment, ref: decodeFragmentValue(fragment) };
  }
  const ref = fragment.slice(0, atIndex);
  const skillFilter = fragment.slice(atIndex + 1);
  return {
    inputWithoutFragment,
    ref: ref ? decodeFragmentValue(ref) : undefined,
    skillFilter: skillFilter ? decodeFragmentValue(skillFilter) : undefined,
  };
}

function appendFragmentRef(input: string, ref?: string, skillFilter?: string): string {
  if (!ref) {
    return input;
  }
  return `${input}#${ref}${skillFilter ? `@${skillFilter}` : ""}`;
}

function isHostedArtifactUrl(input: string): boolean {
  try {
    const parsed = new URL(input);
    const host = parsed.hostname.toLowerCase();
    if (
      host === "raw.githubusercontent.com" ||
      host === "codeload.github.com" ||
      host === "objects.githubusercontent.com"
    ) {
      return true;
    }
    if (host === "github.com") {
      return /^\/[^/]+\/[^/]+\/(?:archive\/|raw\/|releases\/(?:download\/|latest\/download\/))/.test(
        parsed.pathname,
      );
    }
    if (host === "gitlab.com") {
      return /\/-\/(?:archive|raw)\//.test(parsed.pathname);
    }
    return false;
  } catch {
    return false;
  }
}

function isWellKnownUrl(input: string): boolean {
  if (!input.startsWith("http://") && !input.startsWith("https://")) {
    return false;
  }
  try {
    const parsed = new URL(input);
    if (["github.com", "gitlab.com", "raw.githubusercontent.com"].includes(parsed.hostname)) {
      return false;
    }
    return !looksLikeGitSource(input);
  } catch {
    return false;
  }
}

export function parseSource(input: string): ParsedSource {
  if (isLocalPath(input)) {
    const localPath = resolve(input);
    return { type: "local", url: localPath, localPath };
  }

  const {
    inputWithoutFragment,
    ref: fragmentRef,
    skillFilter: fragmentSkillFilter,
  } = parseFragmentRef(input);
  input = inputWithoutFragment;

  const alias = SOURCE_ALIASES[input];
  if (alias) {
    input = alias;
  }

  const githubPrefixMatch = input.match(/^github:(.+)$/);
  if (githubPrefixMatch) {
    return parseSource(appendFragmentRef(githubPrefixMatch[1]!, fragmentRef, fragmentSkillFilter));
  }
  const gitlabPrefixMatch = input.match(/^gitlab:(.+)$/);
  if (gitlabPrefixMatch) {
    return parseSource(
      appendFragmentRef(
        `https://gitlab.com/${gitlabPrefixMatch[1]!}`,
        fragmentRef,
        fragmentSkillFilter,
      ),
    );
  }

  if (isHostedArtifactUrl(input)) {
    return { type: "download", url: input };
  }

  if (/^https?:\/\//.test(input)) {
    try {
      const parsedUrl = new URL(input);
      if (isGitHubHost(parsedUrl.host) && parsedUrl.hostname !== "github.com") {
        const segments = parsedUrl.pathname.split("/").filter(Boolean);
        const [owner, rawRepo, marker, ref, ...subpathSegments] = segments;
        if (owner && rawRepo) {
          const repo = rawRepo.replace(/\.git$/, "");
          const isTreeUrl = marker === "tree" && ref;
          return {
            type: "git",
            url: `${parsedUrl.protocol}//${parsedUrl.host}/${owner}/${repo}.git`,
            ...(isTreeUrl ? { ref } : fragmentRef ? { ref: fragmentRef } : {}),
            ...(isTreeUrl && subpathSegments.length > 0
              ? { subpath: decodeUrlSubpath(subpathSegments.join("/")) }
              : {}),
          };
        }
      }
    } catch {
      // Continue through the remaining source formats.
    }
  }

  const queryIndex = input.indexOf("?");
  const hostedRepositoryInput = queryIndex === -1 ? input : input.slice(0, queryIndex);

  const githubTreeMatch = hostedRepositoryInput.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/(.+?)\/?$/,
  );
  if (githubTreeMatch) {
    const [, owner, repo, treePath] = githubTreeMatch;
    return {
      type: "github",
      url: `https://github.com/${owner}/${repo!.replace(/\.git$/, "")}.git`,
      treePath: decodeUrlSubpath(treePath!),
    };
  }
  const githubRepoMatch = hostedRepositoryInput.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/.*)?$/,
  );
  if (githubRepoMatch) {
    const [, owner, repo] = githubRepoMatch;
    return {
      type: "github",
      url: `https://github.com/${owner}/${repo!.replace(/\.git$/, "")}.git`,
      ...(fragmentRef ? { ref: fragmentRef } : {}),
    };
  }

  const gitlabTreeMatch = hostedRepositoryInput.match(
    /^(https?):\/\/([^/]+)\/(.+?)\/-\/tree\/(.+?)\/?$/,
  );
  if (gitlabTreeMatch) {
    const [, protocol, hostname, repoPath, treePath] = gitlabTreeMatch;
    return {
      type: "gitlab",
      url: `${protocol}://${hostname}/${repoPath!.replace(/\.git$/, "")}.git`,
      treePath: decodeUrlSubpath(treePath!),
    };
  }
  const gitlabRepoMatch = hostedRepositoryInput.match(
    /^https?:\/\/gitlab\.com\/(.+?)(?:\.git)?\/?$/,
  );
  if (gitlabRepoMatch) {
    const repoPath = gitlabRepoMatch[1]!;
    if (repoPath.includes("/")) {
      return {
        type: "gitlab",
        url: `https://gitlab.com/${repoPath}.git`,
        ...(fragmentRef ? { ref: fragmentRef } : {}),
      };
    }
  }

  const githubHost = getGitHubHost();
  const shorthandSourceType = githubHost === "github.com" ? "github" : "git";
  const atSkillMatch = input.match(/^([^/]+)\/([^/@]+)@(.+)$/);
  if (atSkillMatch && !input.includes(":") && !input.startsWith(".") && !input.startsWith("/")) {
    const [, owner, repo, skillFilter] = atSkillMatch;
    return {
      type: shorthandSourceType,
      url: `https://${githubHost}/${owner}/${repo}.git`,
      ...(fragmentRef ? { ref: fragmentRef } : {}),
      skillFilter: fragmentSkillFilter || skillFilter,
    };
  }
  const shorthandMatch = input.match(/^([^/]+)\/([^/]+)(?:\/(.+?))?\/?$/);
  if (shorthandMatch && !input.includes(":") && !input.startsWith(".") && !input.startsWith("/")) {
    const [, owner, repo, subpath] = shorthandMatch;
    return {
      type: shorthandSourceType,
      url: `https://${githubHost}/${owner}/${repo}.git`,
      ...(fragmentRef ? { ref: fragmentRef } : {}),
      subpath: subpath ? sanitizeSubpath(subpath) : subpath,
      ...(fragmentSkillFilter ? { skillFilter: fragmentSkillFilter } : {}),
    };
  }

  if (isWellKnownUrl(input)) {
    return { type: "well-known", url: input };
  }
  return { type: "git", url: input, ...(fragmentRef ? { ref: fragmentRef } : {}) };
}
