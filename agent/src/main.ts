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
 *
 * export OPENSANDBOX_INSECURE_SERVER=YES opensandbox-server
 * opensandbox-mcp --domain localhost:8080 --protocol http --transport streamable-http
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

interface MinimizableComment {
  id: string;          // GraphQL node id
  databaseId: number;  // REST comment id, for logging
  isMinimized: boolean;
  body: string;
}

/**
 * Fetch all issue comments on the PR via GraphQL, including isMinimized,
 * so we can skip comments that are already minimized.
 */
async function fetchCommentsWithMinimizedStatus(
  repository: string,
  prNumber: number,
): Promise<MinimizableComment[]> {
  const [owner, repoName] = parseRepo(repository);
  const results: MinimizableComment[] = [];
  let cursor: string | null = null;

  const query = `
    query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          comments(first: 100, after: $cursor) {
            nodes {
              id
              databaseId
              body
              isMinimized
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  `;

  do {
    const response = await fetch(GITHUB_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        Authorization: `bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: { owner, name: repoName, number: prNumber, cursor },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GraphQL comment fetch failed: ${response.status} ${text}`);
    }

    const result = await response.json() as {
      data?: {
        repository?: {
          pullRequest?: {
            comments: {
              nodes: MinimizableComment[];
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
            };
          } | null;
        } | null;
      };
      errors?: Array<{ message: string }>;
    };

    if (result.errors && result.errors.length > 0) {
      throw new Error(`GraphQL comment fetch error: ${result.errors.map((e) => e.message).join(', ')}`);
    }

    const comments = result.data?.repository?.pullRequest?.comments;
    if (!comments) {
      // No comments field at all — either the PR doesn't exist, or the
      // response shape changed. Log loudly instead of silently returning
      // an empty list, since that failure mode is exactly what caused
      // this bug to go unnoticed.
      if (results.length === 0) {
        console.warn(
          `[fetchCommentsWithMinimizedStatus] repository.pullRequest.comments missing from ` +
          `GraphQL response — got: ${JSON.stringify(result.data)}`,
        );
      }
      break;
    }

    results.push(...comments.nodes);
    cursor = comments.pageInfo.hasNextPage ? comments.pageInfo.endCursor : null;
  } while (cursor);

  return results;
}

/**
 * Find previous bot comments on the PR that carry the marker and are not
 * already minimized, and minimize them as OUTDATED via GraphQL.
 */
async function minimizeOldComments(repository: string, prNumber: number): Promise<void> {
  const allComments = await fetchCommentsWithMinimizedStatus(repository, prNumber);

  const toMinimize = allComments.filter(
    (c) => c.body?.includes(GITHUB_MARKER) && !c.isMinimized,
  );

  console.log(
    `Found ${allComments.length} total comments, ${toMinimize.length} marked ` +
    `and not yet minimized (skipping already-minimized ones)`,
  );

  const mutation = `
    mutation($input: MinimizeCommentInput!) {
      minimizeComment(input: $input) {
        minimizedComment {
          isMinimized
          minimizedReason
        }
      }
    }
  `;

  for (const comment of toMinimize) {
    if (!comment.id) {
      console.warn(`Skipping comment databaseId=${comment.databaseId} — node id is missing, cannot minimize`);
      continue;
    }

    // Belt-and-suspenders: re-check isMinimized right before mutating, in
    // case it changed between the fetch above and this point in the loop
    // (e.g. another run minimized it concurrently). Cheap since it's just
    // reading data we already fetched — this makes the "don't re-minimize
    // already-minimized comments" guarantee hold even under races, not
    // just at fetch time.
    if (comment.isMinimized) {
      console.log(`Skipping comment databaseId=${comment.databaseId} — already minimized`);
      continue;
    }

    console.log(`Minimizing old comment databaseId=${comment.databaseId} id=${comment.id}`);

    const response = await fetch(GITHUB_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        Authorization: `bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: mutation,
        variables: {
          input: {
            subjectId: comment.id,
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

    const result = await response.json() as {
      data?: { minimizeComment?: { minimizedComment?: { isMinimized: boolean; minimizedReason: string } | null } | null };
      errors?: Array<{ message: string }>;
    };

    if (result.errors && result.errors.length > 0) {
      console.warn(`GraphQL minimize error: ${result.errors.map((e) => e.message).join(', ')}`);
      continue;
    }

    const minimized = result.data?.minimizeComment?.minimizedComment;
    if (!minimized?.isMinimized) {
      console.warn(
        `minimizeComment returned no confirmed isMinimized:true for databaseId=${comment.databaseId} — ` +
        `the comment may NOT have been minimized. Full response: ${JSON.stringify(result)}`,
      );
      continue;
    }

    console.log(`Minimized comment databaseId=${comment.databaseId} (reason: ${minimized.minimizedReason})`);
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
 *
 * The opts object is passed through verbatim — callers can include
 * maxSteps, structuredOutput, and any other PublicAgentExecutionOptions.
 */
function generateWithLimit(
  agent: Agent,
  prompt: string,
  opts?: Record<string, unknown>,
): Promise<any> {
  const call = () => (opts ? agent.generate(prompt, opts as any) : agent.generate(prompt));
  return useLimiter ? rateLimiter.add(call) : call();
}

/**
 * Run an agent with tools until it produces a final text answer, then run a
 * second, tool-free "structuring" call to force that text into the given
 * schema. Decoupling these two steps avoids the failure mode where a
 * schema-constrained call is interrupted mid tool-use-loop (e.g. the agent's
 * last turn is a tool call rather than a final answer, hitting maxSteps
 * before producing text) — the structuring call always has real text to
 * work from, since it runs after stage 1 is fully done.
 *
 * On structuring failure, returns `fallback` instead of throwing — a single
 * malformed/empty step should degrade to "no findings" rather than crash
 * the whole workflow run.
 */
async function generateStructured<T>(
  agent: Agent,
  prompt: string,
  schema: z.ZodType<T>,
  fallback: T,
  opts?: { maxSteps?: number },
): Promise<{ value: T; rawText: string }> {
  // Stage 1: freeform generation with tools, no schema constraint.
  // Retried on transient upstream failures (idle timeouts, connection drops).
  const freeform = await generateWithLimitRetrying(agent, prompt, opts, `${agent.name} (stage 1)`);
  const rawText = freeform.text ?? '';

  if (!rawText.trim()) {
    console.warn(
      `[generateStructured] Agent produced no text output (finishReason: ${freeform.finishReason}) — ` +
      `skipping structuring, using fallback.`,
    );
    return { value: fallback, rawText };
  }

  const structurer = createAgent(
    `${agent.name}-structurer`,
    'Extract the requested information from the following text and return it ' +
      'as structured data matching the schema. Do not add information that is ' +
      'not present in the text.',
  );

  try {
    const structured = await generateWithLimitRetrying(
      structurer,
      rawText,
      { structuredOutput: { schema, jsonPromptInjection: 'auto' } },
      `${agent.name} (stage 2 structuring)`,
    );
    if (!structured.object) {
      console.warn(`[generateStructured] Structuring returned no object — using fallback.`);
      return { value: fallback, rawText };
    }
    return { value: structured.object as T, rawText };
  } catch (e: any) {
    console.warn(`[generateStructured] Structuring failed: ${e.message} — using fallback.`);
    return { value: fallback, rawText };
  }
}

/**
 * Kill a single sandbox immediately and remove it from the tracking arrays.
 *
 * Used to free resources early: reviewer sandboxes are killed right after
 * their agent finishes (they're no longer needed), and the developer sandbox
 * is killed right after commit+push. This is critical under the default
 * `SANDBOX_RESOURCE_LIMITS = { cpu: '1', memory: '2Gi' }` — keeping 3-4
 * sandboxes alive simultaneously causes CPU/network contention that can make
 * git operations hang and get killed by the timeout (exit code -1).
 *
 * The 10s timeout on kill() mirrors cleanupSandboxes — during shutdown the
 * OpenSandbox lifecycle API may be unreachable.
 *
 * Individual failures are logged as warnings — killing an already-dead
 * sandbox is a no-op.
 */
async function killSandbox(sandbox: Sandbox): Promise<void> {
  const id = sandbox.id;
  console.log(`[killSandbox] Killing sandbox ${id}`);
  try {
    await Promise.race([sandbox.kill(), timeout(10000)]);
    console.log(`[killSandbox] Deleted sandbox ${id}`);
  } catch (e: any) {
    console.warn(`[killSandbox] Error killing sandbox ${id}:`, e);
  } finally {
    try {
      await sandbox.close();
    } catch (e: any) {
      console.warn(`[killSandbox] Error closing transport for sandbox ${id}:`, e);
    }
    createdSandboxIds.delete(id);
    const idx = createdSandboxes.findIndex((s) => s.id === id);
    if (idx !== -1) createdSandboxes.splice(idx, 1);
  }
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

/**
 * Returns true for errors that are worth retrying — transient upstream
 * issues (timeouts, connection drops, 5xx) rather than genuine failures
 * (bad request, auth, schema validation). OpenRouter free-tier models in
 * particular are prone to idle timeouts and dropped connections under load.
 */
function isTransientLLMError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return (
    /idle timeout/i.test(message) ||
    /timed out/i.test(message) ||
    /ECONNRESET|ETIMEDOUT|ECONNREFUSED/.test(message) ||
    /HTTP 5\d\d/.test(message) ||
    /overloaded|rate.?limit/i.test(message)
  );
}

/**
 * Call agent.generate() (via generateWithLimit) with retry for transient
 * upstream failures — e.g. "Upstream idle timeout exceeded", which is a
 * known OpenRouter free-tier flakiness pattern, not a real request error.
 * Non-transient errors (schema validation, bad request) are NOT retried —
 * they'd fail identically every time.
 */
async function generateWithLimitRetrying(
  agent: Agent,
  prompt: string,
  opts: Record<string, unknown> | undefined,
  label: string,
): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await generateWithLimit(agent, prompt, opts);
    } catch (e) {
      lastErr = e;
      if (!isTransientLLMError(e) || attempt === 3) throw e;
      const delay = 2000 * attempt;
      console.warn(
        `[generateWithLimitRetrying] ${label} failed on attempt ${attempt}/3 ` +
        `(transient: ${(e as Error).message}) — retrying in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * Returns true for errors that are worth retrying — transient upstream
 * issues (timeouts, connection drops, 5xx) rather than genuine failures
 * (bad request, auth, schema validation). OpenRouter free-tier models in
 * particular are prone to idle timeouts and dropped connections under load.
 */
function isTransientLLMError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return (
    /idle timeout/i.test(message) ||
    /timed out/i.test(message) ||
    /ECONNRESET|ETIMEDOUT|ECONNREFUSED/.test(message) ||
    /HTTP 5\d\d/.test(message) ||
    /overloaded|rate.?limit/i.test(message)
  );
}

/**
 * Call agent.generate() (via generateWithLimit) with retry for transient
 * upstream failures — e.g. "Upstream idle timeout exceeded", which is a
 * known OpenRouter free-tier flakiness pattern, not a real request error.
 * Non-transient errors (schema validation, bad request) are NOT retried —
 * they'd fail identically every time.
 */
async function generateWithLimitRetrying(
  agent: Agent,
  prompt: string,
  opts: Record<string, unknown> | undefined,
  label: string,
): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await generateWithLimit(agent, prompt, opts);
    } catch (e) {
      lastErr = e;
      if (!isTransientLLMError(e) || attempt === 3) throw e;
      const delay = 2000 * attempt;
      console.warn(
        `[generateWithLimitRetrying] ${label} failed on attempt ${attempt}/3 ` +
        `(transient: ${(e as Error).message}) — retrying in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * Retry an async operation with linear backoff. Used for the initial
 * git clone, which is the step most exposed to transient sandbox/network
 * hiccups — a single retry here is far cheaper than re-running the whole
 * develop_fix step (and losing the agent's tool-call work).
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts: number; baseDelayMs: number; label: string },
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < opts.attempts) {
        const delay = opts.baseDelayMs * attempt;
        console.warn(
          `[withRetry] ${opts.label} failed on attempt ${attempt}/${opts.attempts}: ${
            e instanceof Error ? e.message : String(e)
          } — retrying in ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
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
  const result = executionResult(execution);
  // A negative or null exit code means the SDK couldn't get a real exit
  // status back — almost always the command was killed by timeoutSeconds
  // or the exec channel dropped, NOT a normal command failure.
  if (result.exit_code === null || result.exit_code < 0) {
    console.warn(
      `[runCommandInSandbox] Command produced no real exit code (got ${result.exit_code}) — ` +
      `likely killed by the ${timeoutSeconds}s timeout or a dropped exec channel. ` +
      `command="${command}"`,
    );
  }
  return result;
}

async function setupSandbox(
  sandbox: Sandbox,
  repository: string,
  headRef: string,
): Promise<void> {
  await startSandboxServices(sandbox);
  console.log(`[setupSandbox] Cloning ${repository} into sandbox ${sandbox.id}...`);

  // 1. Clone the repo (working_directory "/" since /root/project doesn't exist yet).
  //    Retried with withRetry — this is the step most exposed to transient
  //    sandbox/network hiccups, and a single retry is far cheaper than
  //    re-running the entire develop_fix step (losing the agent's tool-call work).
  //    600s timeout per attempt (up from 300s) to give slow/contended clones
  //    room to finish instead of being killed and surfacing as exit -1.
  const cloneResult = await withRetry(
    () =>
      runCommandInSandbox(
        sandbox,
        `git clone https://github.com/${repository}.git /root/project`,
        '/',
        600,
      ),
    { attempts: 3, baseDelayMs: 5000, label: `git clone (sandbox ${sandbox.id})` },
  );
  if (cloneResult.exit_code !== 0) {
    const reason =
      cloneResult.exit_code === null || cloneResult.exit_code < 0
        ? `likely killed by timeout or a dropped exec channel (exit ${cloneResult.exit_code})`
        : `exit ${cloneResult.exit_code}`;
    throw new Error(`Git clone failed after retries (${reason}): ${cloneResult.stderr || 'no stderr'}`);
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

type Finding = z.infer<typeof FindingSchema>;
type ReviewerOutput = z.infer<typeof ReviewerStructuredOutputSchema>;
type RefuteOutput = z.infer<typeof RefuteOutputSchema>;

/** Developer output — extends the schema with subPrUrl (set after git push). */
interface DeveloperOutput {
  diff: string;
  summary: string;
  branch: string;
  changedFiles: string[];
  subPrUrl: string;
  testResults: string;
}

/**
 * Format a single finding as markdown for a PR comment.
 */
function formatFinding(f: Finding): string {
  return `**${f.title}** — *${f.location}* — ${f.description}\n\nSuggestion: ${f.suggestion}`;
}

/**
 * Format a reviewer's structured findings into a PR comment.
 *
 * Uses a consistent heading hierarchy: H1 (comment title) → H2 (Summary + severity
 * sections). Findings come directly from the schema-constrained agent output —
 * no regex parsing needed.
 */
function formatReviewerComment(findings: ReviewerOutput, title: string): string {
  const counts: Record<string, number> = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const f of findings.findings) {
    counts[f.severity]++;
  }

  const parts: string[] = [
    `# ${title}`,
    `## Summary\n${findings.findings.length} finding(s): ${counts.HIGH}H / ${counts.MEDIUM}M / ${counts.LOW}L`,
  ];

  for (const severity of ['HIGH', 'MEDIUM', 'LOW'] as const) {
    const sectionFindings = findings.findings.filter((f) => f.severity === severity);
    if (sectionFindings.length === 0) continue;
    parts.push(`## ${severity}\n${sectionFindings.map(formatFinding).join('\n\n')}`);
  }

  return parts.join('\n\n');
}

/**
 * Format the refuter's structured output into a PR comment.
 */
function formatRefutedComment(refuteResult: RefuteOutput): string {
  const acceptedLines = refuteResult.accepted
    .map((f) => `**${f.severity}** — ${f.title} — ${f.location}`)
    .join('\n');
  const rejectedLines = refuteResult.rejected
    .map((f) => `**${f.severity}** — ${f.title} — ${f.location} — _rejected: ${f.reason}_`)
    .join('\n');

  return `# Findings Summary\n\n## Accepted (${refuteResult.accepted.length})\n${acceptedLines || '_None_'}\n\n## Rejected (${refuteResult.rejected.length})\n${rejectedLines || '_None_'}`;
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

/**
 * Format all three reviewers' structured findings into a single text prompt
 * for the refuter agent.
 */
function formatFindingsForRefuter(
  security: ReviewerOutput,
  performance: ReviewerOutput,
  quality: ReviewerOutput,
): string {
  return [
    '## Security Review',
    formatReviewerFindingsForRefuter(security.findings),
    '## Performance Review',
    formatReviewerFindingsForRefuter(performance.findings),
    '## Code Quality Review',
    formatReviewerFindingsForRefuter(quality.findings),
  ].join('\n\n');
}

/**
 * Helper: format an array of findings as numbered markdown lines.
 */
function formatReviewerFindingsForRefuter(findings: Finding[]): string {
  if (findings.length === 0) return '_No findings._';
  return findings
    .map(
      (f, i) =>
        `${i + 1}. **${f.severity}** — ${f.title} — *${f.location}* — ${f.description}\n   Suggestion: ${f.suggestion}`,
    )
    .join('\n');
}

/**
 * Format the accepted findings from the refuter into a task string for the
 * developer agent.
 */
function formatAcceptedFindingsForDeveloper(accepted: Finding[]): string {
  if (accepted.length === 0) return '## Accepted Findings\n\nNo accepted findings — no fixes needed.';
  const items = accepted
    .map(
      (f) =>
        `- **${f.severity}** — ${f.title} — *${f.location}* — ${f.description}\n  Suggestion: ${f.suggestion}`,
    )
    .join('\n\n');
  return `## Accepted Findings\n\nYou must implement fixes for the following findings:\n\n${items}`;
}

// ── Mastra Workflow ───────────────────────────────────────────────────────────

const InputSchema = z.object({
  repository: z.string(),
  prNumber: z.number().int().positive(),
  headRef: z.string(),
  task: z.string(),
});

const OutputSchema = z.object({ status: z.string() });

/** Single finding from a reviewer agent. */
const FindingSchema = z.object({
  severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  title: z.string(),
  location: z.string().describe('e.g. file.ts:42'),
  description: z.string(),
  suggestion: z.string(),
});

/** Reviewer structured output — replaces ## HIGH/MEDIUM/LOW markdown format. */
const ReviewerStructuredOutputSchema = z.object({
  findings: z.array(FindingSchema),
});

/** Refuter output — accepted and rejected findings with rejection reasons. */
const RefuteOutputSchema = z.object({
  accepted: z.array(FindingSchema),
  rejected: z.array(
    FindingSchema.extend({ reason: z.string() }),
  ),
});

/** Developer structured output — replaces ## Summary/Branch/Diff/Test results. */
const DeveloperStructuredOutputSchema = z.object({
  summary: z.string(),
  branch: z.string(),
  diff: z.string(),
  testResults: z.string(),
  changedFiles: z.array(z.string()),
});

const ReviewOutputSchema = z.object({
  result: ReviewerStructuredOutputSchema,
});

const DevelopOutputSchema = z.object({
  result: DeveloperStructuredOutputSchema,
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
async function runReviewer(
  instructions: string,
  task: string,
  repository: string,
  headRef: string,
): Promise<z.infer<typeof ReviewerStructuredOutputSchema>> {
  const mcp = createMcpClient();
  const sandbox = await createSandbox();
  const taskWithSandbox = `${task}\n\nSANDBOX_ID: ${sandbox.id}`;
  try {
    const tools = await mcp.listTools();
    console.log(`[runReviewer] Sandbox ${sandbox.id} connected to MCP server — available tools: ${Object.keys(tools).join(', ')}`);
    await connectSandboxToMcp(tools, sandbox.id);
    await setupSandbox(sandbox, repository, headRef);
    const agent = createAgent('reviewer', instructions, tools);

    const { value, rawText } = await generateStructured(
      agent,
      taskWithSandbox,
      ReviewerStructuredOutputSchema,
      { findings: [] },
      { maxSteps: 50 },
    );

    if (process.env.DEBUG_MCP) {
      console.log(`[runReviewer] rawText (first 300 chars): ${rawText.slice(0, 300)}`);
      console.log(`[runReviewer] structured findings: ${JSON.stringify(value)}`);
    }
    return value;
  } finally {
    await mcp.disconnect();
    await killSandbox(sandbox);
  }
}

/**
 * Run the developer step: create MCPClient + Agent, implement fixes, get diff.
 *
 * A sandbox is created (via SDK) before the agent runs and its ID is
 * injected into the task string. The developer sandbox is killed immediately
 * after commit+push (it's no longer needed); cleanupSandBoxes() remains as
 * a safety-net for any sandboxes still alive if the step throws.
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

    const { value: obj, rawText } = await generateStructured(
      agent,
      taskWithSandbox,
      DeveloperStructuredOutputSchema,
      { summary: '', branch: '', diff: '', testResults: '', changedFiles: [] },
      { maxSteps: 50 },
    );


    const output: DeveloperOutput = {
      diff: obj.diff,
      summary: obj.summary,
      branch: obj.branch,
      changedFiles: obj.changedFiles,
      subPrUrl: '',
      testResults: obj.testResults,
    };

    // Commit and push the fix via git in the sandbox, then create a sub-PR.
    // If the agent copied the literal placeholder (xxxxxxxx), generate a real branch name.
    if (output.branch && output.branch.includes('xxxxxxxx')) {
      output.branch = `fix/review-swarm-${crypto.randomUUID().slice(0, 8)}`;
    }
    const fixBranch = output.branch || `fix/review-swarm-${crypto.randomUUID().slice(0, 8)}`;
    const pushedBranch = await gitCommitAndPush(sandbox, repository, fixBranch, prNumber);

    // Developer sandbox is no longer needed after commit+push — kill it
    // immediately to free resources (same reasoning as reviewer sandboxes).
    await killSandbox(sandbox);

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
const RefuteResultSchema = z.object({ result: RefuteOutputSchema });

const refuteStep = createStep({
  id: 'refute_findings',
  inputSchema: ParallelReviewOutputSchema,
  outputSchema: RefuteResultSchema,
  execute: async ({ getStepResult }) => {
    const security = getStepResult<{ result: z.infer<typeof ReviewerStructuredOutputSchema> }>('security_review');
    const performance = getStepResult<{ result: z.infer<typeof ReviewerStructuredOutputSchema> }>('performance_review');
    const quality = getStepResult<{ result: z.infer<typeof ReviewerStructuredOutputSchema> }>('code_quality_review');

    const combined = formatFindingsForRefuter(security.result, performance.result, quality.result);

    const agent = createAgent('refuter', REFUTER_INSTRUCTION);
    const { value } = await generateStructured(
      agent,
      combined,
      RefuteOutputSchema,
      { accepted: [], rejected: [] },
    );
    return { result: value };
  },
});

/**
 * Develop fix step: creates its own sandbox + MCPClient, implements fixes
 * for accepted findings, commits + pushes via git in the sandbox, and opens
 * a sub-PR. Returns the structured developer output.
 */
const developStep = createStep({
  id: 'develop_fix',
  inputSchema: RefuteResultSchema,
  outputSchema: DevelopOutputSchema,
  execute: async ({ getInitData, getStepResult }) => {
    const initData = getInitData<{ repository: string; prNumber: number; task: string; headRef: string }>();
    const refuted = getStepResult<{ result: z.infer<typeof RefuteOutputSchema> }>('refute_findings');
    const task = `${initData.task}\n\n${formatAcceptedFindingsForDeveloper(refuted.result.accepted)}`;
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
 * Robustly extract structured output from a `workflow-step-result` event.
 *
 * The step outputs (`{ result: <structured object> }`) are expected at
 * `event.payload.output`, but we defensively try several possible locations
 * so that a schema-shape mismatch never silently produces a header-only comment.
 *
 * Extraction order:
 *   1. `payload.output.result` — the canonical shape for our steps
 *   2. `payload.payload` — some Mastra internals nest the output under `payload`
 *
 * Returns `undefined` when no usable result is found.
 */
function extractStepResult<T>(event: StepResultEvent): T | undefined {
  const payload = event.payload;

  // 1. Canonical shape: { result: <structured object> }
  const output = payload.output;
  if (output && typeof output === 'object') {
    const result = (output as Record<string, any>).result;
    if (result !== undefined && result !== null) {
      return result as T;
    }
  }

  // 2. Fallback: output nested under `payload.payload`
  const innerPayload = payload.payload;
  if (innerPayload && typeof innerPayload === 'object') {
    const result = (innerPayload as Record<string, any>).result;
    if (result !== undefined && result !== null) {
      return result as T;
    }
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

  if (stepId === 'security_review') {
    const findings = extractStepResult<ReviewerOutput>(event);
    if (!findings || findings.findings.length === 0) {
      console.error(
        `handleStepCompletion: step '${stepId}' completed successfully but ` +
        `no findings extracted. Skipping comment to avoid a header-only post.`,
      );
      return;
    }
    if (debug) {
      console.log(`  Findings count: ${findings.findings.length}`);
    }
    await postPrComment(repository, prNumber, formatReviewerComment(findings, 'Security Review'));
  } else if (stepId === 'performance_review') {
    const findings = extractStepResult<ReviewerOutput>(event);
    if (!findings || findings.findings.length === 0) {
      console.error(
        `handleStepCompletion: step '${stepId}' completed successfully but ` +
        `no findings extracted. Skipping comment to avoid a header-only post.`,
      );
      return;
    }
    if (debug) {
      console.log(`  Findings count: ${findings.findings.length}`);
    }
    await postPrComment(repository, prNumber, formatReviewerComment(findings, 'Performance Review'));
  } else if (stepId === 'code_quality_review') {
    const findings = extractStepResult<ReviewerOutput>(event);
    if (!findings || findings.findings.length === 0) {
      console.error(
        `handleStepCompletion: step '${stepId}' completed successfully but ` +
        `no findings extracted. Skipping comment to avoid a header-only post.`,
      );
      return;
    }
    if (debug) {
      console.log(`  Findings count: ${findings.findings.length}`);
    }
    await postPrComment(repository, prNumber, formatReviewerComment(findings, 'Code Quality Review'));
  } else if (stepId === 'refute_findings') {
    const refuteResult = extractStepResult<RefuteOutput>(event);
    if (!refuteResult) {
      console.error(
        `handleStepCompletion: step '${stepId}' completed successfully but ` +
        `no refute result extracted. Skipping comment.`,
      );
      return;
    }
    await postPrComment(repository, prNumber, formatRefutedComment(refuteResult));
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

  // 1. Fetch PR context (diff, changed files, metadata) — validates the PR exists
  const ctx = await getPrContext(args.repository, args.prNumber);
  console.log(`PR #${args.prNumber}: "${ctx.title}" head=${ctx.headRef}`);

  // 2. Minimize old bot comments from previous runs (best-effort — skip on failure)
  try {
    await minimizeOldComments(args.repository, args.prNumber);
  } catch (e: any) {
    console.warn(`[warn] Failed to minimate old comments: ${e.message} — continuing anyway`);
  }

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
    for await (const event of workflowStream.fullStream) {
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
