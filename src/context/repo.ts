// Cheap, git-free repository facts for the gate state and the brain prompt.
// Cached per cwd for 60 s so back-to-back prompts do not re-scan.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface RepoContext {
  dir_name: string;
  languages: string[];
  frameworks: string[];
  has_tests: boolean;
  has_ci: boolean;
  git_branch: string | null;
  is_git_repo: boolean;
}

const cache = new Map<string, { at: number; ctx: RepoContext }>();
const TTL_MS = 60_000;

const FRAMEWORK_DEPS: Record<string, string> = {
  react: "react",
  next: "next",
  vue: "vue",
  svelte: "svelte",
  express: "express",
  fastify: "fastify",
  electron: "electron",
  "@nestjs/core": "nestjs",
  django: "django",
  flask: "flask",
  fastapi: "fastapi",
};

export function detectRepoContext(cwd: string, now = Date.now()): RepoContext {
  const hit = cache.get(cwd);
  if (hit && now - hit.at < TTL_MS) return hit.ctx;
  const ctx = scan(cwd);
  cache.set(cwd, { at: now, ctx });
  return ctx;
}

export function scan(cwd: string): RepoContext {
  const languages = new Set<string>();
  const frameworks = new Set<string>();
  const has = (p: string) => existsSync(join(cwd, p));

  if (has("package.json")) {
    languages.add(has("tsconfig.json") ? "typescript" : "javascript");
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      for (const [dep, name] of Object.entries(FRAMEWORK_DEPS)) if (dep in deps) frameworks.add(name);
      if ("typescript" in deps) {
        languages.add("typescript");
        languages.delete("javascript");
      }
    } catch {
      /* unreadable package.json */
    }
  }
  if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) {
    languages.add("python");
    for (const f of ["pyproject.toml", "requirements.txt"]) {
      try {
        const text = readFileSync(join(cwd, f), "utf8").toLowerCase();
        for (const fw of ["django", "flask", "fastapi"]) if (text.includes(fw)) frameworks.add(fw);
      } catch {
        /* none */
      }
    }
  }
  if (has("go.mod")) languages.add("go");
  if (has("Cargo.toml")) languages.add("rust");
  if (has("pom.xml") || has("build.gradle") || has("build.gradle.kts")) languages.add("java");
  if (has("Gemfile")) languages.add("ruby");

  const has_tests =
    ["test", "tests", "__tests__", "spec"].some((d) => has(d)) || hasTestFileAtTop(cwd);
  const has_ci = dirNonEmpty(join(cwd, ".github", "workflows")) || has(".gitlab-ci.yml") || has(".circleci");

  const is_git_repo = has(".git");
  let git_branch: string | null = null;
  if (is_git_repo) git_branch = readGitBranch(cwd);

  return {
    dir_name: basename(cwd) || cwd,
    languages: [...languages],
    frameworks: [...frameworks],
    has_tests,
    has_ci,
    git_branch,
    is_git_repo,
  };
}

function hasTestFileAtTop(cwd: string): boolean {
  try {
    return readdirSync(cwd).some((f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || /^test_.*\.py$/.test(f));
  } catch {
    return false;
  }
}

function dirNonEmpty(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/** Parse .git/HEAD directly; handles worktrees (.git is a file) and detached HEAD. */
export function readGitBranch(cwd: string): string | null {
  try {
    let gitDir = join(cwd, ".git");
    const dotGit = readFileSync(gitDir, "utf8").trim();
    if (dotGit.startsWith("gitdir:")) gitDir = join(cwd, dotGit.slice(7).trim());
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    if (head.startsWith("ref: refs/heads/")) return head.slice("ref: refs/heads/".length);
    return head.slice(0, 12); // detached: short sha
  } catch {
    try {
      // .git is a directory (the readFileSync above threw EISDIR)
      const head = readFileSync(join(cwd, ".git", "HEAD"), "utf8").trim();
      if (head.startsWith("ref: refs/heads/")) return head.slice("ref: refs/heads/".length);
      return head.slice(0, 12);
    } catch {
      return null;
    }
  }
}
