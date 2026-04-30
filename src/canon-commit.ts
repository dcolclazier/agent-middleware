import { execFile } from "child_process";
import { promisify } from "util";
import { mkdir, readFile, writeFile, access } from "fs/promises";
import { join, resolve } from "path";
import { Mutex } from "async-mutex";

const execFileAsync = promisify(execFile);

// --- Config ---

function getRepoPath(): string {
  return process.env.CANON_REPO_PATH || "/mnt/c/dev/dcc";
}

function getStateDir(): string {
  return process.env.CANON_STATE_DIR || "/tmp/claude-middleware-canon";
}

const VALID_DOMAINS = new Set([
  "resistance",
  "bestiary",
  "world_bible",
  "factions",
  "technology",
  "facility_ops",
]);

const STAGING_ROOT = "SPARK/output/canon/nemoclaw";
const MAX_CONTENT_BYTES = 100 * 1024; // 100 KB per file

function getWorktreeBase(): string {
  return process.env.CANON_WORKTREE_DIR || "/tmp/claude-middleware-canon-worktree";
}

// --- Types ---

export type Agent = "claude" | "qwen" | "nemoclaw";

const VALID_AGENTS = new Set<Agent>(["claude", "qwen", "nemoclaw"]);

export function isValidAgent(value: unknown): value is Agent {
  return typeof value === "string" && VALID_AGENTS.has(value as Agent);
}

const DEFAULT_AGENT: Agent = "claude";

export interface CommitBody {
  domain: string;
  subdomain: string;
  filename: string;
  content: string;
  message: string;
  overwrite?: boolean;
  agent?: Agent;
}

export interface CommitResult {
  branch: string;
  commit_sha: string;
  path: string;
}

export interface PushResult {
  branch: string;
  url: string;
  commits: number;
}

export interface StatusResult {
  branch: string | null;
  committed_files: string[];
  pending_push: boolean;
}

export interface ResetResult {
  reset: string;
}

export class CanonError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = "CanonError";
  }
}

// --- Per-agent mutexes ---
// Guards commitCanon / pushCanon / resetCanon for each agent so two concurrent
// callers on the same agent worktree can't corrupt state. Status reads are not
// mutexed (they're advisory snapshots only).
const agentMutexes = new Map<Agent, Mutex>();
function mutexFor(agent: Agent): Mutex {
  let m = agentMutexes.get(agent);
  if (!m) {
    m = new Mutex();
    agentMutexes.set(agent, m);
  }
  return m;
}

// --- Helpers ---

function getWorktreeDir(agent: Agent): string {
  return join(getWorktreeBase(), agent);
}

async function runGit(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

async function runGitSilent(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function runGitInRepo(...args: string[]): Promise<string> {
  return runGit(getRepoPath(), ...args);
}

async function runGitInWorktree(agent: Agent, ...args: string[]): Promise<string> {
  return runGit(getWorktreeDir(agent), ...args);
}

async function runGitInWorktreeSilent(agent: Agent, ...args: string[]): Promise<void> {
  return runGitSilent(getWorktreeDir(agent), ...args);
}

function stateFile(agent: Agent): string {
  return join(getStateDir(), `${agent}_current_branch`);
}

async function currentBranch(agent: Agent): Promise<string | null> {
  try {
    const branch = await readFile(stateFile(agent), "utf-8");
    return branch.trim() || null;
  } catch {
    return null;
  }
}

async function setCurrentBranch(agent: Agent, branch: string): Promise<void> {
  await mkdir(getStateDir(), { recursive: true });
  await writeFile(stateFile(agent), branch + "\n");
}

async function clearCurrentBranch(agent: Agent): Promise<void> {
  try {
    await writeFile(stateFile(agent), "");
  } catch {
    // ignore
  }
}

function validatePath(agent: Agent, domain: string, subdomain: string, filename: string): void {
  if (!VALID_DOMAINS.has(domain)) {
    throw new CanonError(400, `Invalid domain '${domain}'. Must be one of: ${Array.from(VALID_DOMAINS).join(", ")}`);
  }
  if (!/^[a-z0-9_-]+$/.test(subdomain)) {
    throw new CanonError(400, `Invalid subdomain '${subdomain}'. Must match ^[a-z0-9_-]+$`);
  }
  if (!/^[a-z0-9_-]+\.md$/.test(filename)) {
    throw new CanonError(400, `Invalid filename '${filename}'. Must match ^[a-z0-9_-]+\\.md$`);
  }

  // Defense-in-depth: after composition, verify the resolved absolute path stays inside the staging dir
  const worktreeDir = getWorktreeDir(agent);
  const stagingAbs = resolve(worktreeDir, STAGING_ROOT, domain, subdomain);
  const fileAbs = resolve(stagingAbs, filename);
  if (!fileAbs.startsWith(stagingAbs + "/") && fileAbs !== stagingAbs + "/" + filename) {
    throw new CanonError(400, `Path traversal detected`);
  }
}

function stagingRelPath(domain: string, subdomain: string, filename: string): string {
  return `${STAGING_ROOT}/${domain}/${subdomain}/${filename}`;
}

async function fileExists(absPath: string): Promise<boolean> {
  try {
    await access(absPath);
    return true;
  } catch {
    return false;
  }
}

async function worktreeExists(agent: Agent): Promise<boolean> {
  try {
    const worktrees = await runGitInRepo("worktree", "list", "--porcelain");
    return worktrees.includes(getWorktreeDir(agent));
  } catch {
    return false;
  }
}

/**
 * Creates a git worktree for a new canon branch, or re-uses the existing one
 * if a current branch is already set.
 *
 * Uses `git worktree add` with GIT_LFS_SKIP_SMUDGE=1 and disabled hooks to
 * avoid the git-lfs post-checkout warning. The user's main working tree in
 * CANON_REPO_PATH is never disturbed, even if dirty.
 */
async function ensureBranch(agent: Agent, domain: string, subdomain: string): Promise<string> {
  const existing = await currentBranch(agent);
  if (existing) {
    // Verify the worktree is still present and on the expected branch
    if (await worktreeExists(agent)) {
      try {
        const head = await runGitInWorktree(agent, "rev-parse", "--abbrev-ref", "HEAD");
        if (head === existing) return existing;
        console.warn(`[${agent}] Worktree exists but HEAD is ${head}, expected ${existing}. Recreating.`);
      } catch {
        console.warn(`[${agent}] Worktree in bad state, recreating`);
      }
      // Clean up the stale worktree
      try {
        await runGitInRepo("worktree", "remove", "--force", getWorktreeDir(agent));
      } catch {
        // ignore
      }
    }
    await clearCurrentBranch(agent);
  }

  // Also clean up any orphaned worktree dir that git doesn't know about
  try {
    await runGitInRepo("worktree", "prune");
  } catch {
    // ignore
  }
  try {
    const { rm } = await import("fs/promises");
    await rm(getWorktreeDir(agent), { recursive: true, force: true });
  } catch {
    // ignore
  }

  // Fetch latest main so the new branch is based on current upstream
  try {
    await runGitInRepo("fetch", "origin", "main");
  } catch (err) {
    console.warn(`git fetch origin main failed: ${err}`);
  }

  // Build branch name. The default "claude" agent keeps the historical
  // "nemoclaw/canon/..." prefix for backward compatibility with the existing
  // NemoClaw → middleware curl flow (unchanged public behavior). Other agents
  // get their own branch-name prefix so origin branches are distinguishable.
  const now = new Date();
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, "");
  const hms = now.toISOString().slice(11, 19).replace(/:/g, "");
  const branchPrefix = agent === DEFAULT_AGENT ? "nemoclaw" : agent;
  const branch = `${branchPrefix}/canon/${domain}/${subdomain}/${ymd}-${hms}`;

  // Create the worktree with hooks disabled (avoids git-lfs post-checkout failure)
  // and GIT_LFS_SKIP_SMUDGE=1 so git doesn't try to fetch LFS objects.
  // Full checkout is needed so that commits include the full tree (sparse-checkout
  // breaks this by removing files from the index).
  await execFileAsync(
    "git",
    [
      "-c", "core.hooksPath=/dev/null",
      "worktree",
      "add",
      "-b",
      branch,
      getWorktreeDir(agent),
      "origin/main",
    ],
    {
      cwd: getRepoPath(),
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" },
    }
  );

  await setCurrentBranch(agent, branch);
  return branch;
}

/**
 * Clean up the worktree and branch — called from resetCanon.
 */
async function destroyWorktree(agent: Agent, branch: string): Promise<void> {
  try {
    await runGitInRepo("worktree", "remove", "--force", getWorktreeDir(agent));
  } catch (err) {
    console.warn(`worktree remove failed: ${err}`);
  }
  try {
    await runGitInRepo("branch", "-D", branch);
  } catch {
    // Branch might already be gone
  }
}

// --- Public API ---

export async function commitCanon(body: CommitBody): Promise<CommitResult> {
  const agent: Agent = body.agent ?? DEFAULT_AGENT;
  if (!VALID_AGENTS.has(agent)) {
    throw new CanonError(400, `Invalid agent '${agent}'. Must be one of: ${Array.from(VALID_AGENTS).join(", ")}`);
  }

  return mutexFor(agent).runExclusive(async () => {
    const { domain, subdomain, filename, content, message, overwrite } = body;

    if (!domain || !subdomain || !filename || content === undefined || !message) {
      throw new CanonError(400, "Missing required fields: domain, subdomain, filename, content, message");
    }
    if (typeof content !== "string") {
      throw new CanonError(400, "content must be a string");
    }
    if (Buffer.byteLength(content, "utf-8") > MAX_CONTENT_BYTES) {
      throw new CanonError(413, `Content exceeds ${MAX_CONTENT_BYTES} bytes`);
    }

    validatePath(agent, domain, subdomain, filename);

    const branch = await ensureBranch(agent, domain, subdomain);

    const worktreeDir = getWorktreeDir(agent);
    const relPath = stagingRelPath(domain, subdomain, filename);
    const absPath = resolve(worktreeDir, relPath);
    const absDir = resolve(worktreeDir, STAGING_ROOT, domain, subdomain);

    // Check overwrite policy
    if (await fileExists(absPath)) {
      if (!overwrite) {
        throw new CanonError(409, `File already exists: ${relPath}. Set overwrite: true to replace.`);
      }
    }

    await mkdir(absDir, { recursive: true });
    await writeFile(absPath, content, "utf-8");

    // Stage and commit (in the worktree)
    await runGitInWorktreeSilent(agent, "add", relPath);

    // Check if there are staged changes (content might be identical)
    let hasChanges = true;
    try {
      await runGitInWorktreeSilent(agent, "diff", "--cached", "--quiet");
      hasChanges = false;
    } catch {
      // git diff --quiet exits non-zero when there ARE changes — good
      hasChanges = true;
    }
    if (!hasChanges) {
      throw new CanonError(409, `No changes to commit for ${relPath} (content unchanged)`);
    }

    await runGitInWorktreeSilent(agent, "commit", "-m", message);
    const sha = await runGitInWorktree(agent, "rev-parse", "HEAD");

    return {
      branch,
      commit_sha: sha,
      path: relPath,
    };
  });
}

export async function pushCanon(agent: Agent = DEFAULT_AGENT): Promise<PushResult> {
  if (!VALID_AGENTS.has(agent)) {
    throw new CanonError(400, `Invalid agent '${agent}'`);
  }

  return mutexFor(agent).runExclusive(async () => {
    const branch = await currentBranch(agent);
    if (!branch) {
      throw new CanonError(400, "No current branch — call /api/canon/commit first");
    }

    if (!(await worktreeExists(agent))) {
      throw new CanonError(500, `Worktree for ${branch} not found`);
    }

    // Verify the worktree is on the expected branch
    const head = await runGitInWorktree(agent, "rev-parse", "--abbrev-ref", "HEAD");
    if (head !== branch) {
      throw new CanonError(500, `Worktree HEAD is ${head} but state says ${branch}`);
    }

    // Push with hooks disabled to bypass git-lfs's pre-push hook (which
    // bombs out on this WSL host because git-lfs isn't installed). Pass 0.2
    // applied the same -c override to `git worktree add`; this is the
    // missing twin for `git push`. Without it, every push fails with
    // "git-lfs not found on path" before the network request even fires.
    await runGitInWorktreeSilent(
      agent,
      "-c",
      "core.hooksPath=/dev/null",
      "push",
      "-u",
      "origin",
      branch,
    );

    // Count commits on this branch vs main
    let commits = 0;
    try {
      const commitsStr = await runGitInWorktree(agent, "rev-list", "--count", `origin/main..${branch}`);
      commits = parseInt(commitsStr, 10) || 0;
    } catch {
      // ignore
    }

    return {
      branch,
      url: `https://github.com/dcolclazier/dcc/tree/${branch}`,
      commits,
    };
  });
}

export async function getCanonStatus(agent: Agent = DEFAULT_AGENT): Promise<StatusResult> {
  if (!VALID_AGENTS.has(agent)) {
    throw new CanonError(400, `Invalid agent '${agent}'`);
  }

  // Read-only: no mutex. This is an advisory snapshot.
  const branch = await currentBranch(agent);
  if (!branch) {
    return { branch: null, committed_files: [], pending_push: false };
  }

  if (!(await worktreeExists(agent))) {
    // State file has a branch but worktree is gone — return stale info
    return { branch, committed_files: [], pending_push: false };
  }

  // List files changed on this branch vs origin/main
  let files: string[] = [];
  try {
    const diff = await runGitInWorktree(agent, "diff", "--name-only", "origin/main..HEAD");
    files = diff.split("\n").filter((f) => f.trim().length > 0);
  } catch {
    files = [];
  }

  // Check if branch exists on origin (heuristic for pending_push)
  let pending_push = true;
  try {
    await runGitInWorktree(agent, "rev-parse", `origin/${branch}`);
    const ahead = await runGitInWorktree(agent, "rev-list", "--count", `origin/${branch}..HEAD`);
    pending_push = parseInt(ahead, 10) > 0;
  } catch {
    // Branch not on origin yet
    pending_push = true;
  }

  return { branch, committed_files: files, pending_push };
}

export async function resetCanon(agent: Agent = DEFAULT_AGENT): Promise<ResetResult> {
  if (!VALID_AGENTS.has(agent)) {
    throw new CanonError(400, `Invalid agent '${agent}'`);
  }

  return mutexFor(agent).runExclusive(async () => {
    const branch = await currentBranch(agent);
    if (!branch) {
      throw new CanonError(400, "No current branch to reset");
    }

    await destroyWorktree(agent, branch);
    await clearCurrentBranch(agent);

    return { reset: branch };
  });
}
