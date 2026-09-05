#!/usr/bin/env bun
/**
 * Code review swarm CLI script.
 *
 * Run: bun run src/main.ts --repository owner/name --pr-number 123 [--debug]
 *
 * Implements a Mastra workflow:
 *   3 parallel review steps → refute_findings → develop_fix
 *
 * Each reviewer/developer gets its own MCPClient + sandbox (created via the
 * OpenSandbox JS SDK, registered with the MCP server via sandbox_connect,
 * killed by the cleanupSandboxes safety-net). Agents never create or destroy
 * sandboxes themselves — the sandbox_id is injected into their task string.
 *
 * The refuter has no MCPClient — pure analysis of findings text.
 *
 * All GitHub API work (minimize old comments, post PR comments, create fix
 * branch + sub-PR) is handled in the service layer — never inside an agent.
 */

import { Workflow, createStep } from '@mastra/core/workflows';
import { Agent } from '@mastra/core/agent';
import type { ToolsInput } from '@mastra/core/agent';
import { MCPClient } from '@mastra/mcp';
import { Octokit } from 'octokit';
import { z } from 'zod';
import { config } from 'dotenv';
import {
  ConnectionConfig,
  Sandbox,
  type Execution,
  type RunCommandOpts,
} from '@alibaba-group/opensandbox';

import {
  SECURITY_INSTRUCTION,
  PERFORMANCE_INSTRUCTION,
  QUALITY_INSTRUCTION,
  REFUTER_INSTRUCTION,
  DEVELOPER_INSTRUCTION,
} from './prompts';

config();

// ── Configuration ────────────────────────────────────────────────────────────

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MCP_URL = process.env.OPENSANDBOX_MCP_URL || 'http://localhost:8000/mcp';
const OPENSANDBOX_API_URL =
  process.env.OPENSANDBOX_API_URL || 'http://localhost:8080';
const OPENSANDBOX_API_KEY =
  process.env.OPEN_SANDBOX_API_KEY || process.env.OPENSANDBOX_API_KEY;
const GITHUB_MARKER = '<!-- REVIEW_SWARM_COMMENT -->';
const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';

const MODEL = process.env.OPENROUTER_MODEL || 'openrouter/nvidia/nemotron-3.5-lightning:free';
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || 'review-swarm-sandbox:latest';
const SANDBOX_RESOURCE_LIMITS = { cpu: '1', memory: '2Gi' };
const SANDBOX_TTL_SECONDS = 3600;

/**
 * Track sandboxes created during this run so cleanup only destroys
 * sandboxes we created — never pre-existing ones.
 * We store both the IDs (for filtering) and the Sandbox instances (for direct
 * kill() calls that bypass the unreliable SandboxManager.listSandboxInfos listing
 * step on SIGINT).
 */
const createdSandboxIds = new Set<string>();
const createdSandboxes: Sandbox[] = [];

/**
 * Build a ConnectionConfig for the OpenSandbox SDK.
 * Reads the API URL/key from environment (same env vars the REST API code used).
 */
function createConnectionConfig(): ConnectionConfig {
  return new ConnectionConfig({
    domain: OPENSANDBOX_API_URL.replace(/^https?:\/\//, ''),
    apiKey: OPENSANDBOX_API_KEY,
  });
}

// ── GitHub Helpers (service layer — never inside agents) ──────────────────────

const octokit = new Octokit({ auth: GITHUB_TOKEN });

function parseRepo(repo: string): [string, string] {
  const [owner, name] = repo.split('/');
  if (!owner || !name) {
    throw new Error(`Invalid repository format: ${repo}. Expected "owner/name".`);
  }
  return [owner, name];
}

interface PrContext {
  title: string;
  body: string | null;
  headRef: string;
  baseRef: string;
  diff: string;
  changedFiles: string[];
}

/**
 * Fetch PR metadata, the full diff, and changed files.
 */
async function getPrContext(repository: string, prNumber: number): Promise<PrContext> {
  const [owner, repoName] = parseRepo(repository);

  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo: repoName,
    pull_number: prNumber,
  });

  const { data: diff } = await octokit.rest.pulls.get({
    owner,
    repo: repoName,
    pull_number: prNumber,
    headers: { Accept: 'application/vnd.github.v3.diff' },
  });

  const { data: files } = await octokit.rest.pulls.listFiles({
    owner,
    repo: repoName,
    pull_number: prNumber,
  });

  const codeFiles = files
    .filter((f) => f.filename.endsWith('.ts') || f.filename.endsWith('.js') || f.filename.endsWith('.py'))
    .map((f) => f.filename);

  return {
    title: pr.title,
    body: pr.body,
    headRef: pr.head.ref,
    baseRef: pr.base.ref,
    diff: diff as unknown as string,
    changedFiles: codeFiles.slice(0, 20),
  };
}

/**
 * Find previous bot comments on the PR and minimize them as OUTDATED via GraphQL.
 */
async function minimizeOldComments(repository: string, prNumber: number): Promise<void> {
  const [owner, repoName] = parseRepo(repository);

  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo: repoName,
    issue_number: prNumber,
    per_page: 100,
  });

  const matcherComments = comments.filter((c) => c.body?.includes(GITHUB_MARKER));
  console.log(`Found ${comments.length} total comments, ${matcherComments.length} with the review-swarm marker`);

  for (const comment of comments) {
    if (!comment.body?.includes(GITHUB_MARKER)) continue;

    if (!comment.node_id) {
      console.warn(`Skipping comment id=${comment.id} — node_id is missing, cannot minimize`);
      continue;
    }

    console.log(`Minimizing old comment id=${comment.id} node_id=${comment.node_id}`);

    const query = `
      mutation($input: MinimizeCommentInput!) {
        minimizeComment(input: $input) {
          clientMutationId
        }
      }
    `;

    const response = await fetch(GITHUB_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        Authorization: `bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: {
          input: {
            subjectId: comment.node_id,
            classifier: 'OUTDATED',
            clientMutationId: crypto.randomUUID(),
          },
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.warn(`GraphQL minimize failed: ${response.status} ${text}`);
      continue;
    }

    // GitHub GraphQL returns 200 even when the mutation has errors.
    const result = await response.json() as {
      data?: {
        minimizeComment?: {
          clientMutationId?: string;
        } | null;
      };
      errors?: Array<{ message: string }>;
    };
    if (result.errors && result.errors.length > 0) {
      console.warn(
        `GraphQL minimize error: ${result.errors.map((e) => e.message).join(', ')}`,
      );
      continue;
    }

    // The mutation can return { data: { minimizeComment: null } } without
    // an errors array — this means the minimize silently failed (e.g. the
    // caller lacks permission, the node_id is invalid, etc.).
    if (!result.data?.minimizeComment) {
      console.warn(
        `minimizeComment returned null for comment id=${comment.id} — ` +
        `the comment was NOT minimized. Full response: ${JSON.stringify(result)}`,
      );
      continue;
    }

    console.log(`Minimized comment id=${comment.id}`);
  }
}

/**
 * Post a comment on the PR (with the bot marker) and return its URL.
 */
async function postPrComment(repository: string, prNumber: number, body: string): Promise<string> {
  const [owner, repoName] = parseRepo(repository);

  const { data: comment } = await octokit.rest.issues.createComment({
    owner,
    repo: repoName,
    issue_number: prNumber,
    body: `${GITHUB_MARKER}\n${body}`,
  });

  console.log(`Posted comment: ${comment.html_url}`);
  return comment.html_url;
}

interface DeveloperOutput {
  diff: string;
  summary: string;
  branch?: string;
  subPrUrl: string;
  testResults: string;
}

/**
 * Parse the developer agent's markdown output to extract diff, summary, and branch name.
 *
 * Expected format (from DEVELOPER_INSTRUCTION):
 * ## Summary
 * ...
 *
 * ## Branch
 * fix/review-swarm-xxxxxxxx
 *
 * ## Diff
 * ```diff
 * ...
 * ```
 *
 * ## Test results
 * ...
 */
function parseDeveloperOutput(text: string): DeveloperOutput {
  const summaryMatch = text.match(/## Summary\s*\n([\s\S]*?)(?=\n##|\n```|$)/);
  const branchMatch = text.match(/## Branch\s*\n([\s\S]*?)(?=\n##|\n```|$)/);
  const diffMatch = text.match(/## Diff\s*\n```diff\s*\n([\s\S]*?)\n```/);
  const testResultsMatch = text.match(/## Test results\s*\n([\s\S]*?)(?=\n##|$)/);

  return {
    summary: (summaryMatch?.[1] || '').trim(),
    branch: (branchMatch?.[1] || '').trim(),
    diff: (diffMatch?.[1] || '').trim(),
    subPrUrl: '',
    testResults: (testResultsMatch?.[1] || '').trim(),
  };
}

/**
 * Commit changes in the sandbox via git and push to a new fix branch.
 *
 * Uses git commands directly in the sandbox — the same approach as the Python
 * reference (osbx-self-healing-ci/agent/main.py:347-377) — rather than the
 * GitHub Contents API, which can't handle deletions, renames, or binary files.
 *
 * Returns the fix branch name, or an empty string if there was nothing to commit.
 */
async function gitCommitAndPush(
  sandbox: Sandbox,
  repository: string,
  fixBranch: string,
  prNumber: number,
): Promise<string> {
  const pushUrl = `https://${GITHUB_TOKEN}@github.com/${repository}.git`;

  // Log git status so we can diagnose "no changes to commit" issues
  const statusResult = await runCommandInSandbox(sandbox, 'git status --short', '/root/project');
  console.log(`[gitCommitAndPush] git status:\n${statusResult.stdout || '(clean)'}`);

  const gitSteps: Array<[string, string]> = [
    ['git-config-email', 'git config user.email "fixer-agent@example.com"'],
    ['git-config-name', 'git config user.name "Fixer Agent"'],
    [`git-checkout-${fixBranch}`, `git checkout -B ${fixBranch}`],
    ['git-add', 'git add -A'],
    ['git-commit', `git commit -m "fix: resolve issues in PR #${prNumber}"`],
  ];

  for (const [name, command] of gitSteps) {
    const result = await runCommandInSandbox(sandbox, command, '/root/project');
    // git commit returns exit code 1 when there's nothing to commit — that's OK
    if (name === 'git-commit' && result.exit_code === 1) {
      console.log('No changes to commit — skipping git push and sub-PR creation');
      return '';
    }
    if (result.exit_code !== 0) {
      throw new Error(`git step ${name} failed (exit ${result.exit_code}): ${result.stderr}`);
    }
  }

  const pushResult = await runCommandInSandbox(
    sandbox, `git push --force ${pushUrl} ${fixBranch}`, '/root/project'
  );
  if (pushResult.exit_code !== 0) {
    throw new Error(`git push failed (exit ${pushResult.exit_code}): ${pushResult.stderr}`);
  }

  console.log(`Fix branch ${fixBranch} pushed to ${repository}`);
  return fixBranch;
}

/**
 * Open a sub-PR from the fix branch back to the PR's head branch.
 * The fix branch was already committed and pushed by gitCommitAndPush.
 */
async function createFixBranchAndPr(
  repository: string,
  prHeadRef: string,
  fixBranch: string,
  summary: string,
): Promise<string> {
  const [owner, repoName] = parseRepo(repository);
  const { data: newPr } = await octokit.rest.pulls.create({
    owner,
    repo: repoName,
    title: `fix: ${summary.slice(0, 80)}`,
    head: fixBranch,
    base: prHeadRef,
    body: `Automated fix generated by review swarm.\n\n${summary}`,
  });
  console.log(`Fix PR created: ${newPr.html_url}`);
  return newPr.html_url;
}

// ── Sandbox Cleanup ────────────────────────────────────────────────────────────

// Module-level reference to the current Mastra workflow run.
// The signal handler uses this to abort the workflow so it stops creating
// new sandboxes while cleanup is in progress.
let currentRunAbortController: AbortController | null = null;

// Single-flight guard: the first caller starts the cleanup; concurrent callers
// (signal handler, finally block, .catch) await the same Promise.
let cleanupPromise: Promise<void> | null = null;

// Exit code requested by a signal handler (130 = SIGINT, 143 = SIGTERM).
let signalExitCode: number | null = null;

/**
 * Set by main() when --limiter is passed. Controls whether agent.generate()
 * calls are rate-limited to 1 request per 3 seconds (to stay within OpenRouter
 * free-tier limits).
 */
let useLimiter = false;

/**
 * Promise that rejects after `ms` milliseconds — used to race against
 * operations that can hang during SIGINT/SIGTERM (e.g. HTTP DELETE to a
 * shutting-down OpenSandbox server).
 */
function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
  );
}

/**
 * Simple in-process rate limiter for OpenRouter model calls.
 * Enforces ~1 request every 3 seconds (20 req/min) to stay within free-tier limits.
 * Concurrent requests are queued and executed sequentially with the interval enforced.
 * When disabled (no --limiter flag), agent.generate() calls bypass the limiter entirely.
 */
class RateLimiter {
  private queue: Array<{
    fn: () => Promise<unknown>;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  }> = [];
  private isProcessing = false;
  private lastRequestTime = 0;
  private readonly minIntervalMs = 3000;

  async add<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject: reject as (e: unknown) => void,
      });
      this.process();
    });
  }

  private async process(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;
    try {
      while (this.queue.length > 0) {
        const { fn, resolve, reject } = this.queue.shift()!;
        // Enforce minimum interval between requests
        const now = Date.now();
        const elapsed = now - this.lastRequestTime;
        if (elapsed < this.minIntervalMs) {
          await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
        }
        this.lastRequestTime = Date.now();
        try {
          const result = await fn();
          resolve(result);
        } catch (e) {
          reject(e);
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }
}

const rateLimiter = new RateLimiter();

/**
 * Call agent.generate() through the rate limiter when useLimiter is set.
 * Without the limiter, calls proceed normally (concurrent).
 */
function generateWithLimit(
  agent: Agent,
  prompt: string,
  opts?: { maxSteps?: number },
): Promise<any> {
  const call = () => (opts ? agent.generate(prompt, opts) : agent.generate(prompt));
  return useLimiter ? rateLimiter.add(call) : call();
}

/**
 * Idempotent, single-flight sandbox cleanup.
 *
 * Kills each Sandbox instance created during this run by calling
 * sandbox.kill() directly. This is the single point of sandbox destruction —
 * agents no longer call sandbox_kill themselves; each step's sandbox is
 * created by runReviewer/runDeveloper and killed here as a safety-net.
 *
 * We call sandbox.kill() directly on each instance rather than using
 * SandboxManager.listSandboxInfos (which can fail on SIGINT when the listing
 * step returns incomplete results). The stored Sandbox instances carry their
 * own connection state, so direct kill() is reliable even during shutdown.
 *
 * Individual kill failures are logged as warnings — cleanup never throws.
 *
 * Concurrent calls share the same Promise so cleanup runs at most once.
 */
async function cleanupSandboxes(): Promise<void> {
  if (cleanupPromise) {
    return cleanupPromise; // already in progress — await the same operation
  }

  cleanupPromise = (async () => {
    console.log('Cleaning up sandboxes...');

    // Take ownership of the sandbox instances created during this run.
    // We call sandbox.kill() directly on each instance — this bypasses
    // SandboxManager.listSandboxInfos which can fail on SIGINT (the listing
    // step may not return results when the workflow is being aborted).
    const toKill = createdSandboxes.splice(0); // atomically take all, clear the array
    if (toKill.length === 0) {
      console.log('No sandboxes to clean up');
      return;
    }

    console.log(`Found ${toKill.length} sandbox(es) to clean up`);

    let cleaned = 0;
    for (const sandbox of toKill) {
      const id = sandbox.id;
      console.log(`Deleting sandbox ${id}`);
      try {
        // Race the kill against a timeout — during SIGINT the OpenSandbox
        // lifecycle API may be unreachable, causing sandbox.kill() (which
        // makes an HTTP DELETE) to hang indefinitely and blocking process.exit.
        await Promise.race([sandbox.kill(), timeout(10000)]);
        console.log(`Deleted sandbox ${id}`);
        cleaned++;
      } catch (e: any) {
        console.warn(`Error deleting sandbox ${id}:`, e);
      } finally {
        // Always close the SDK's HTTP transport — keeps the event loop clean
        // so the process can exit without hanging on open connections.
        try {
          await sandbox.close();
        } catch (e: any) {
          console.warn(`Error closing transport for sandbox ${id}:`, e);
        }
        createdSandboxIds.delete(id);
      }
    }

    console.log(`Sandbox cleanup complete (${cleaned}/${toKill.length} deleted)`);
  })();

  return cleanupPromise;
}

/**
 * Create a sandbox via the OpenSandbox JS SDK and wait until it is ready.
 * The returned Sandbox instance is used by the service layer for commands;
 * its ID is also injected into the agent task string. The agent never needs to
 * call sandbox_create itself.
 *
 * Sandbox.create() internally waits for the sandbox to reach Running state
 * and passes the health check, so no manual polling is needed.
 */
async function createSandbox(): Promise<Sandbox> {
  const connectionConfig = createConnectionConfig();
  const sandbox = await Sandbox.create({
    connectionConfig,
    image: SANDBOX_IMAGE,
    resource: SANDBOX_RESOURCE_LIMITS,
    timeoutSeconds: SANDBOX_TTL_SECONDS,
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ||
        'postgresql://postgres:postgres@localhost:5432/postgres',
    },
  });
  createdSandboxIds.add(sandbox.id);
  createdSandboxes.push(sandbox);
  console.log(`[createSandbox] Sandbox ${sandbox.id} is ready (Running + healthy)`);
  return sandbox;
}

/**
 * Start background services (e.g. PostgreSQL) by running the sandbox image's
 * entrypoint script. The entrypoint ends with `wait` which would block the
 * exec session indefinitely, so we background it with nohup.
 */
async function startSandboxServices(sandbox: Sandbox): Promise<void> {
  console.log(`[startSandboxServices] Starting services via /entrypoint.sh in sandbox ${sandbox.id}...`);
  const result = await runCommandInSandbox(
    sandbox,
    'nohup /entrypoint.sh > /tmp/entrypoint.log 2>&1 &',
    '/',
    120,
  );
  if (result.exit_code !== 0) {
    console.warn(`[startSandboxServices] Entrypoint exited with code ${result.exit_code} — services may not have started`);
  }
  // Give services a moment to start (e.g., PostgreSQL needs a few seconds)
  await new Promise((resolve) => setTimeout(resolve, 5000));
  console.log(`[startSandboxServices] Services started in sandbox ${sandbox.id}`);
}

/**
 * Set up a sandbox: clone the repo, checkout the PR head, and install deps.
 * Runs inside the service layer so agents can start analyzing immediately.
 */
interface CommandRunResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Map an SDK Execution result to our simpler CommandRunResult.
 */
function executionResult(execution: Execution): CommandRunResult {
  return {
    exit_code: execution.exitCode ?? null,
    stdout: (execution.logs?.stdout ?? []).map((m) => m.text).join(''),
    stderr: (execution.logs?.stderr ?? []).map((m) => m.text).join(''),
  };
}

async function runCommandInSandbox(
  sandbox: Sandbox,
  command: string,
  workingDirectory?: string,
  timeoutSeconds: number = 300,
): Promise<CommandRunResult> {
  const execution = await sandbox.commands.run(
    command,
    { workingDirectory, timeoutSeconds } as RunCommandOpts,
  );
  return executionResult(execution);
}

async function setupSandbox(
  sandbox: Sandbox,
  repository: string,
  headRef: string,
): Promise<void> {
  await startSandboxServices(sandbox);
  console.log(`[setupSandbox] Cloning ${repository} into sandbox ${sandbox.id}...`);

  // 1. Clone the repo (working_directory "/" since /root/project doesn't exist yet)
  const cloneResult = await runCommandInSandbox(
    sandbox,
    `git clone https://github.com/${repository}.git /root/project`,
    '/',
  );
  if (cloneResult.exit_code !== 0) {
    throw new Error(
      `Git clone failed (exit ${cloneResult.exit_code}): ${cloneResult.stderr || 'no stderr'}`,
    );
  }

  // 2. Checkout the PR head
  const checkoutResult = await runCommandInSandbox(
    sandbox,
    `git checkout ${headRef}`,
    '/root/project',
  );
  if (checkoutResult.exit_code !== 0) {
    throw new Error(
      `Git checkout failed (exit ${checkoutResult.exit_code}): ${checkoutResult.stderr || 'no stderr'}`,
    );
  }

  // 3. Install app dependencies if the app directory exists
  const installResult = await runCommandInSandbox(
    sandbox,
    'cd /root/project/app && bun install 2>&1',
    '/root/project/app',
  );
  if (installResult.exit_code !== 0) {
    console.warn(`[setupSandbox] bun install exited with code ${installResult.exit_code} — continuing anyway`);
  }

  console.log(`[setupSandbox] Sandbox ${sandbox.id} is ready (clone + checkout + deps)`);
}

/**
 * Register a sandbox with the MCP server's local registry.
 *
 * When a sandbox is created via the SDK (Sandbox.create), the MCP server
 * doesn't know about it. MCP tools like `file_read` fail with
 * "Sandbox not found in local registry" unless the sandbox is first
 * registered. Calling `sandbox_connect` once registers the sandbox so all
 * subsequent MCP tool calls succeed.
 */
interface ExecutableTool {
  execute: (input: any, context?: any) => Promise<any>;
}

async function connectSandboxToMcp(tools: ToolsInput, sandboxId: string): Promise<void> {
  // Mastra MCPClient namespaces tools as `${serverName}_${toolName}`, so the
  // MCP server's `sandbox_connect` tool becomes `sandbox_sandbox_connect`.
  const toolKey = 'sandbox_sandbox_connect';
  const tool = (tools as Record<string, ExecutableTool>)[toolKey];
  if (!tool) {
    throw new Error(
      `[connectSandboxToMcp] MCP tool '${toolKey}' not available — ` +
      `cannot register sandbox ${sandboxId} with MCP server`,
    );
  }
  await tool.execute({ sandbox_id: sandboxId }, {});
  console.log(
    `[connectSandboxToMcp] Registered sandbox ${sandboxId} with MCP server — ` +
    `${Object.keys(tools).length} tools available: ${Object.keys(tools).join(', ')}`,
  );
}

// ── Comment Formatting ───────────────────────────────────────────────────────────

/**
 * A single finding parsed from a reviewer agent's markdown output.
 */
interface ReviewFinding {
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  /** The raw finding text, e.g. `1. **title** — \`file:line\` — description — suggestion` */
  rawText: string;
}

/**
 * Parse markdown findings from a reviewer agent into a structured model.
 *
 * The agent returns findings organized by severity:
 *   ## HIGH
 *   1. **title** — `file:line` — description + suggestion
 *   2. ...
 *   ## MEDIUM
 *   ...
 *
 * Falls back to a single uncategorized entry if no severity headers are found.
 */
function parseReviewerFindings(findings: string): ReviewFinding[] {
  const result: ReviewFinding[] = [];
  const lines = findings.split('\n');

  let currentSeverity: 'HIGH' | 'MEDIUM' | 'LOW' | null = null;
  for (const line of lines) {
    const headerMatch = line.match(/^## (HIGH|MEDIUM|LOW)$/);
    if (headerMatch) {
      currentSeverity = headerMatch[1] as 'HIGH' | 'MEDIUM' | 'LOW';
      continue;
    }
    // Finding lines start with a number + dot, e.g. "1. **title** — ..."
    if (currentSeverity && line.match(/^\s*\d+\.\s/)) {
      result.push({ severity: currentSeverity, rawText: line.trim() });
    }
  }

  return result;
}

/**
 * Format a reviewer's markdown findings into a PR comment.
 *
 * Uses a consistent heading hierarchy: H1 (comment title) → H2 (Summary + severity
 * sections). Findings are parsed from the agent's raw output into a structured model
 * and re-rendered for consistent formatting.
 */
function formatReviewerComment(findings: string, title: string): string {
  const parsed = parseReviewerFindings(findings);

  if (parsed.length === 0) {
    // Fallback: wrap raw findings if parsing failed
    return `# ${title}\n\n${findings}`;
  }

  const counts: Record<string, number> = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const f of parsed) {
    counts[f.severity]++;
  }

  const parts: string[] = [
    `# ${title}`,
    `## Summary\n${parsed.length} finding(s): ${counts.HIGH}H / ${counts.MEDIUM}M / ${counts.LOW}L`,
  ];

  for (const severity of ['HIGH', 'MEDIUM', 'LOW'] as const) {
    const sectionFindings = parsed.filter((f) => f.severity === severity);
    if (sectionFindings.length === 0) continue;
    parts.push(`## ${severity}\n${sectionFindings.map((f) => f.rawText).join('\n')}`);
  }

  return parts.join('\n\n');
}

/**
 * Format the refuter's output into a PR comment.
 */
function formatRefutedComment(findings: string): string {
  return `# Findings Summary\n\n${findings}`;
}

/**
 * Format the developer's changeset into a PR comment.
 *
 * Heading hierarchy: H1 (# Fix Applied) → H2 sections (## Diff, ## Sub-PR, ## Test Results).
 */
function formatChangesetComment(
  diff: string,
  branch: string,
  summary: string,
  subPrUrl: string,
  testResults: string,
): string {
  const testSection = testResults
    ? `\n\n## Test Results\n\`\`\`\n${testResults.slice(0, 3000)}\n\`\`\``
    : '';
  return `# Fix Applied\n\n**Branch:** \`${branch}\`\n\n**Summary:** ${summary}\n\n## Diff\n\`\`\`diff\n${diff.slice(0, 3000)}\n\`\`\`\n\n## Sub-PR\n${subPrUrl}${testSection}`;
}

// ── Mastra Workflow ───────────────────────────────────────────────────────────

const InputSchema = z.object({
  repository: z.string(),
  prNumber: z.number().int().positive(),
  headRef: z.string(),
  task: z.string(),
});

const OutputSchema = z.object({ status: z.string() });

const ReviewOutputSchema = z.object({ result: z.string() });

const DevelopOutputSchema = z.object({
  result: z.object({
    diff: z.string(),
    summary: z.string(),
    branch: z.string().optional(),
    subPrUrl: z.string(),
    testResults: z.string(),
  }),
});

/**
 * Combined output from all 3 parallel review steps.
 * Each key is a step id, and the value is that step's output.
 */
const ParallelReviewOutputSchema = z.object({
  security_review: ReviewOutputSchema,
  performance_review: ReviewOutputSchema,
  code_quality_review: ReviewOutputSchema,
});

/**
 * Create an MCPClient connected to the OpenSandbox MCP server.
 * Each reviewer/developer gets its own MCPClient for sandbox isolation.
 */
function createMcpClient(id: string = crypto.randomUUID()): MCPClient {
  return new MCPClient({
    id,
    servers: {
      sandbox: {
        url: new URL(MCP_URL),
      },
    },
  });
}

/**
 * Create an Agent with the given name, instructions, and optional tools.
 * The model uses Mastra v1.63.0 magic string for OpenRouter.
 */
function createAgent(name: string, instructions: string, tools?: ToolsInput): Agent {
  return new Agent({
    id: name,
    name,
    model: MODEL,
    instructions,
    tools,
  });
}

/**
 * Run a review step: create sandbox + MCPClient, set up repo, run agent, disconnect.
 *
 * The sandbox is created (via SDK) and set up (clone, checkout, deps) by the
 * service layer. The agent receives the sandbox_id in the task string and only
 * needs to analyze the code. cleanupSandboxes() handles destruction — the
 * agent never creates or destroys sandboxes itself.
 */
async function runReviewer(instructions: string, task: string, repository: string, headRef: string): Promise<string> {
  const mcp = createMcpClient();
  const sandbox = await createSandbox();
  const taskWithSandbox = `${task}\n\nSANDBOX_ID: ${sandbox.id}`;
  try {
    const tools = await mcp.listTools();
    console.log(`[runReviewer] Sandbox ${sandbox.id} connected to MCP server — available tools: ${Object.keys(tools).join(', ')}`);
    await connectSandboxToMcp(tools, sandbox.id);
    await setupSandbox(sandbox, repository, headRef);
    const agent = createAgent('reviewer', instructions, tools);
    const result = await generateWithLimit(agent, taskWithSandbox, { maxSteps: 50 });
    if (process.env.DEBUG_MCP) {
      console.log(`[runReviewer] result.text: ${JSON.stringify(result.text?.slice(0, 200))}`);
      console.log(`[runReviewer] result.steps.length: ${result.steps?.length ?? 'N/A'}`);
      console.log(`[runReviewer] result.toolCalls: ${JSON.stringify(result.toolCalls?.length ?? 0)}`);
      console.log(`[runReviewer] result.toolResults: ${JSON.stringify(result.toolResults?.length ?? 0)}`);
      console.log(`[runReviewer] result.finishReason: ${result.finishReason}`);
    }
    return result.text;
  } finally {
    await mcp.disconnect();
  }
}

/**
 * Run the developer step: create MCPClient + Agent, implement fixes, get diff.
 *
 * A sandbox is created (via SDK) before the agent runs and its ID is
 * injected into the task string. The cleanupSandboxes() safety-net handles
 * destruction — the agent never needs to call sandbox_create or sandbox_kill.
 */
async function runDeveloper(
  instructions: string,
  task: string,
  repository: string,
  headRef: string,
  prNumber: number,
): Promise<DeveloperOutput> {
  const mcp = createMcpClient();
  const sandbox = await createSandbox();
  const taskWithSandbox = `${task}\n\nSANDBOX_ID: ${sandbox.id}`;
  try {
    const tools = await mcp.listTools();
    console.log(`[runDeveloper] Sandbox ${sandbox.id} connected to MCP server — available tools: ${Object.keys(tools).join(', ')}`);
    await connectSandboxToMcp(tools, sandbox.id);
    await setupSandbox(sandbox, repository, headRef);
    const agent = createAgent('developer', instructions, tools);
    const result = await generateWithLimit(agent, taskWithSandbox, { maxSteps: 50 });
    // Always log key diagnostics — the developer's output is parsed structurally,
    // so empty/blocked output is a silent failure that must always surface.
    console.log(`[runDeveloper] result.text (first 500 chars): ${result.text?.slice(0, 500)}`);
    console.log(`[runDeveloper] result.finishReason: ${result.finishReason}`);
    console.log(`[runDeveloper] result.toolCalls: ${result.toolCalls?.length ?? 0}`);
    if (process.env.DEBUG_MCP) {
      console.log(`[runDeveloper] result.text: ${JSON.stringify(result.text?.slice(0, 500))}`);
      console.log(`[runDeveloper] result.steps.length: ${result.steps?.length ?? 'N/A'}`);
      console.log(`[runDeveloper] result.toolResults: ${JSON.stringify(result.toolResults?.length ?? 0)}`);
    }
    const output = parseDeveloperOutput(result.text || '');

    // Commit and push the fix via git in the sandbox, then create a sub-PR.
    // If the agent copied the literal placeholder (xxxxxxxx), generate a real branch name.
    if (output.branch && output.branch.includes('xxxxxxxx')) {
      output.branch = `fix/review-swarm-${crypto.randomUUID().slice(0, 8)}`;
    }
    const fixBranch = output.branch || `fix/review-swarm-${crypto.randomUUID().slice(0, 8)}`;
    const pushedBranch = await gitCommitAndPush(sandbox, repository, fixBranch, prNumber);
    if (pushedBranch) {
      output.subPrUrl = await createFixBranchAndPr(repository, headRef, pushedBranch, output.summary);
    }
    console.log(`[runDeveloper] Fix applied in sandbox ${sandbox.id} — subPR: ${output.subPrUrl}`);
    return output;
  } finally {
    await mcp.disconnect();
  }
}

// ── Step Definitions ───────────────────────────────────────────────────────────

/**
 * Security review step: creates its own sandbox + MCPClient, runs linters,
 * reviews the diff for vulnerabilities, returns markdown findings.
 */
const securityReviewStep = createStep({
  id: 'security_review',
  inputSchema: InputSchema,
  outputSchema: ReviewOutputSchema,
  execute: async ({ inputData }) => {
    const result = await runReviewer(SECURITY_INSTRUCTION, inputData.task, inputData.repository, inputData.headRef);
    return { result };
  },
});

/**
 * Performance review step: creates its own sandbox + MCPClient, reviews for
 * performance issues, returns markdown findings.
 */
const performanceReviewStep = createStep({
  id: 'performance_review',
  inputSchema: InputSchema,
  outputSchema: ReviewOutputSchema,
  execute: async ({ inputData }) => {
    const result = await runReviewer(PERFORMANCE_INSTRUCTION, inputData.task, inputData.repository, inputData.headRef);
    return { result };
  },
});

/**
 * Code quality review step: creates its own sandbox + MCPClient, runs linters,
 * reviews for code smells, returns markdown findings.
 */
const codeQualityReviewStep = createStep({
  id: 'code_quality_review',
  inputSchema: InputSchema,
  outputSchema: ReviewOutputSchema,
  execute: async ({ inputData }) => {
    const result = await runReviewer(QUALITY_INSTRUCTION, inputData.task, inputData.repository, inputData.headRef);
    return { result };
  },
});

/**
 * Refute findings step: no MCPClient (pure analysis), examines all 3 review
 * sets of findings, filters false positives, returns markdown summary.
 */
const refuteStep = createStep({
  id: 'refute_findings',
  inputSchema: ParallelReviewOutputSchema,
  outputSchema: ReviewOutputSchema,
  execute: async ({ getStepResult }) => {
    const security = getStepResult<{ result: string }>('security_review');
    const performance = getStepResult<{ result: string }>('performance_review');
    const quality = getStepResult<{ result: string }>('code_quality_review');

    const combined = [
      '## Security Review',
      security.result,
      '## Performance Review',
      performance.result,
      '## Code Quality Review',
      quality.result,
    ].join('\n\n');

    const agent = createAgent('refuter', REFUTER_INSTRUCTION);
    const result = await generateWithLimit(agent, combined);
    return { result: result.text };
  },
});

/**
 * Develop fix step: creates its own sandbox + MCPClient, implements fixes
 * for accepted findings, commits + pushes via git in the sandbox, and opens
 * a sub-PR. Returns the structured developer output.
 */
const developStep = createStep({
  id: 'develop_fix',
  inputSchema: ReviewOutputSchema,
  outputSchema: DevelopOutputSchema,
  execute: async ({ getInitData, getStepResult }) => {
    const initData = getInitData<{ repository: string; prNumber: number; task: string; headRef: string }>();
    const refuted = getStepResult<{ result: string }>('refute_findings');
    const task = `${initData.task}\n\n## Refuted Findings\n\n${refuted.result}`;
    const result = await runDeveloper(DEVELOPER_INSTRUCTION, task, initData.repository, initData.headRef, initData.prNumber);
    return { result };
  },
});

// ── Workflow Definition ────────────────────────────────────────────────────────

const reviewSwarmWorkflow = new Workflow({
  id: 'CodeReviewSwarm',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
})
  .parallel([securityReviewStep, performanceReviewStep, codeQualityReviewStep])
  .then(refuteStep)
  .then(developStep)
  .commit();

// ── Event Handling ─────────────────────────────────────────────────────────────

// Matches the `workflow-step-result` chunk type from
// @mastra/core stream types (v1.63.0). The stream wrapper in
// EventedRun.stream() additionally adds `stepName` to the payload.
interface StepResultEvent {
  type: string;
  runId: string;
  from: string;
  metadata?: Record<string, any>;
  payload: {
    id: string;
    stepCallId?: string;
    stepName?: string;
    status: string;
    output?: Record<string, any>;
    payload?: Record<string, any>;
    endedAt?: number;
    startedAt?: number;
  };
}

/**
 * Robustly extract the step result text from a `workflow-step-result` event.
 *
 * The step outputs (`{ result: "..." }`) are expected at `event.payload.output`,
 * but we defensively try several possible locations so that a schema-shape
 * mismatch never silently produces a header-only comment.
 *
 * Extraction order:
 *   1. `payload.output.result` — the canonical shape for our steps
 *   2. `payload.payload` — some Mastra internals nest the output under `payload`
 *   3. `payload.output` as a bare string
 *
 * Returns `undefined` when no usable text is found.
 */
function extractStepResultText(event: StepResultEvent): string | undefined {
  const payload = event.payload;

  // 1. Canonical shape: { result: "..." }
  const output = payload.output;
  if (output && typeof output === 'object') {
    const result = (output as Record<string, any>).result;
    if (result !== undefined && result !== null) {
      return typeof result === 'string' ? result : undefined;
    }
  }

  // 2. Fallback: output nested under `payload.payload`
  const innerPayload = payload.payload;
  if (innerPayload && typeof innerPayload === 'object') {
    const result = (innerPayload as Record<string, any>).result;
    if (result !== undefined && result !== null) {
      return typeof result === 'string' ? result : undefined;
    }
  }

  // 3. Last resort: output itself is a string
  if (typeof output === 'string') {
    return output;
  }

  return undefined;
}

async function handleStepCompletion(
  event: StepResultEvent,
  repository: string,
  prNumber: number,
  ctx: PrContext,
  debug: boolean,
): Promise<void> {
  const stepId = event.payload?.id;

  if (debug) {
    console.log(`Step finished: ${stepId}`);
  }

  if (!stepId) {
    console.error('handleStepCompletion: event.payload.id is missing — skipping.');
    return;
  }

  // develop_fix has structured output (DeveloperOutput), not text findings.
  // Handle it separately before the text-based extraction below.
  if (stepId === 'develop_fix') {
    const dev = event.payload?.output?.result as DeveloperOutput | undefined;
    if (!dev || !dev.summary) {
      console.error(
        `handleStepCompletion: step '${stepId}' completed successfully but ` +
        `no developer output was extracted. Skipping comment to avoid a header-only post.`,
      );
      // Always log — empty developer output is a silent failure that must surface.
      console.log(`  event.payload.output:`, JSON.stringify(event.payload?.output));
      return;
    }
    if (debug) {
      console.log(`  Developer output: diff=${dev.diff.length} chars, summary=${dev.summary.length} chars, testResults=${dev.testResults.length} chars, subPrUrl=${dev.subPrUrl}`);
    }
    await postPrComment(
      repository,
      prNumber,
      formatChangesetComment(dev.diff, dev.branch || '', dev.summary, dev.subPrUrl, dev.testResults),
    );
    return;
  }

  const findings = extractStepResultText(event);

  if (debug) {
    if (!findings || findings.trim() === '') {
      console.log(`  [WARN] No findings text extracted for step '${stepId}'.`);
      console.log(`  event.payload.output:`, JSON.stringify(event.payload?.output));
      console.log(`  event.payload.payload:`, JSON.stringify(event.payload?.payload));
    } else {
      console.log(`  Findings length: ${findings.length} chars`);
    }
  }

  if (!findings || findings.trim() === '') {
    console.error(
      `handleStepCompletion: step '${stepId}' completed successfully but ` +
      `no findings text was extracted. Skipping comment to avoid a header-only post.`,
    );
    return;
  }

  if (stepId === 'security_review') {
    await postPrComment(repository, prNumber, formatReviewerComment(findings, 'Security Review'));
  } else if (stepId === 'performance_review') {
    await postPrComment(repository, prNumber, formatReviewerComment(findings, 'Performance Review'));
  } else if (stepId === 'code_quality_review') {
    await postPrComment(repository, prNumber, formatReviewerComment(findings, 'Code Quality Review'));
  } else if (stepId === 'refute_findings') {
    await postPrComment(repository, prNumber, formatRefutedComment(findings));
  }
}

// ── CLI Entry Point ────────────────────────────────────────────────────────────

interface CliArgs {
  repository: string;
  prNumber: number;
  debug: boolean;
  limiter: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { repository: '', prNumber: NaN, debug: false, limiter: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repository') {
      args.repository = argv[i + 1];
      i++;
    } else if (arg === '--pr-number') {
      args.prNumber = parseInt(argv[i + 1], 10);
      i++;
    } else if (arg === '--debug') {
      args.debug = true;
    } else if (arg === '--limiter') {
      args.limiter = true;
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Validate arguments
  if (!args.repository || !args.repository.includes('/')) {
    console.error('--repository "owner/name" is required');
    process.exit(1);
  }
  if (isNaN(args.prNumber)) {
    console.error('--pr-number is required and must be an integer');
    process.exit(1);
  }
  if (!GITHUB_TOKEN) {
    console.error('GITHUB_TOKEN env var is required');
    process.exit(1);
  }
  if (!OPENROUTER_API_KEY) {
    console.error('OPENROUTER_API_KEY env var is required');
    process.exit(1);
  }

  console.log(`Starting code review swarm for ${args.repository} PR #${args.prNumber}`);
  if (args.debug) console.log(`Debug mode enabled. Model: ${MODEL}`);
  useLimiter = args.limiter;
  if (useLimiter) console.log(`Rate limiter enabled — 1 request per 3 seconds.`);

  // 1. Minimize old bot comments from previous runs
  await minimizeOldComments(args.repository, args.prNumber);

  // 2. Fetch PR context (diff, changed files, metadata)
  const ctx = await getPrContext(args.repository, args.prNumber);
  console.log(`PR #${args.prNumber}: "${ctx.title}" head=${ctx.headRef}`);

  // 3. Build the task string with full context for the agents
  const changedFilesStr = ctx.changedFiles.length > 0
    ? ctx.changedFiles.map((f) => `- \`${f}\``).join('\n')
    : '*No code files changed*';

  //const diffPreview = ctx.diff ? ctx.diff.slice(0, 6000) : '*No diff available*';

  // Build the task string — just PR context. Agent instructions come from
  // prompts.ts (SECURITY_INSTRUCTION, PERFORMANCE_INSTRUCTION, etc.).
  // Each sandboxed step gets SANDBOX_ID appended at runtime by runReviewer/
  // runDeveloper.
  const taskString = `PR REVIEW SWARM TASK
====================

Repository: ${args.repository}
PR #${args.prNumber}: ${ctx.title}
Head branch: ${ctx.headRef}
Base branch: ${ctx.baseRef}

PR description:
${ctx.body || '(no description)'}

Changed files:
${changedFilesStr}
`;

  // 4. Run the Mastra workflow with streaming
  try {
    const run = await reviewSwarmWorkflow.createRun();
    currentRunAbortController = run.abortController;
    const workflowStream = run.stream({
      inputData: {
        repository: args.repository,
        prNumber: args.prNumber,
        headRef: ctx.headRef,
        task: taskString,
      },
    });

    // 5. Stream events — post PR comments as each step completes
    for await (const event of workflowStream) {
      if (event.type === 'workflow-step-result') {
        if (args.debug) {
          console.log('workflow-step-result event:', JSON.stringify(event, null, 2));
        }
        if (event.payload?.status === 'success') {
          await handleStepCompletion(event as StepResultEvent, args.repository, args.prNumber, ctx, args.debug);
        }
      }
    }
  } finally {
    // 6. Safety-net: destroy all sandboxes created during this run.
    //    Agents no longer self-manage sandbox lifecycle — each step's sandbox
    //    is created by runReviewer/runDeveloper and killed here. Always runs —
    //    even if a step throws or the workflow is aborted by a signal.
    await cleanupSandboxes();
  }

  console.log('Review swarm complete.');
}

// ── Graceful Shutdown ────────────────────────────────────────────────────────────

// process.once so handlers are registered exactly once.
process.once('SIGINT', () => {
  console.log('\nSIGINT — aborting workflow and cleaning up sandboxes...');
  signalExitCode = 130;
  // Abort the Mastra workflow so it stops creating/using sandboxes.
  currentRunAbortController?.abort();
  // Clean up (idempotent — the finally block may also call this), then exit.
  // process.exit is called explicitly to ensure we never hang on pending I/O.
  cleanupSandboxes()
    .catch((e) => console.warn('Cleanup failed during shutdown:', e))
    .finally(() => process.exit(signalExitCode ?? 130));
});

process.once('SIGTERM', () => {
  console.log('SIGTERM — aborting workflow and cleaning up sandboxes...');
  signalExitCode = 143;
  currentRunAbortController?.abort();
  cleanupSandboxes()
    .catch((e) => console.warn('Cleanup failed during shutdown:', e))
    .finally(() => process.exit(signalExitCode ?? 143));
});

main().catch(async (err) => {
  console.error('Review swarm failed:', err);
  await cleanupSandboxes().catch((e) => console.warn('Cleanup failed after error:', e));
  process.exit(signalExitCode ?? 1);
});
