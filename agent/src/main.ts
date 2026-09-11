#!/usr/bin/env bun
/**
 * Code review swarm CLI script.
 *
 * Run: bun run src/main.ts --repository owner/name --pr-number 123 [--debug] [--fix]
 *
 * Implements a Mastra workflow:
 *   3 parallel review steps → refute_findings → [develop_fix]  (develop_fix only runs with --fix)
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
 * Structured output: instead of asking agents to emit JSON as their final
 * text answer (which needs a second LLM call to parse and is prone to
 * step-limit / schema-mismatch failures), each agent gets a local "report_*"
 * tool whose input schema IS the Zod schema we want. The agent calls it as
 * its final action; Mastra validates the tool call arguments the same way
 * it validates every other tool call. See createReportTool/generateWithReportTool.
 *
 * OPENSANDBOX_INSECURE_SERVER=YES opensandbox-server
 * opensandbox-mcp --domain localhost:8080 --protocol http --transport streamable-http
 */

import { Workflow, createStep } from '@mastra/core/workflows';
import { Observability } from "@mastra/observability";
import { ArizeExporter } from "@mastra/arize";
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
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
// Cap on how many changed code files get listed in the task prompt sent to
// the agents — keeps the prompt bounded on PRs that touch huge numbers of files.
const MAX_REVIEWED_FILES = 20;
// Cap on how many characters of a diff / test-results block get embedded in
// a PR comment, so a huge diff or test log doesn't blow past GitHub's
// comment size limit.
const COMMENT_SNIPPET_LIMIT = 3000;
const EXCLUDED_TOOLS = new Set([
  'sandbox_sandbox_create',
  'sandbox_sandbox_connect',
  'sandbox_sandbox_kill',
  'sandbox_sandbox_get_info',
  'sandbox_sandbox_list',
  'sandbox_sandbox_renew',
  'sandbox_sandbox_get_metrics',
  'sandbox_sandbox_healthcheck'
]);

/**
 * Track Sandbox instances created during this run so cleanup only destroys
 * sandboxes we created — never pre-existing ones.
 *
 * We keep an array of Sandbox instances (not just IDs) so we can call
 * sandbox.kill() directly, bypassing the unreliable SandboxManager.listSandboxInfos
 * listing step on SIGINT.
 */
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
    changedFiles: codeFiles.slice(0, MAX_REVIEWED_FILES),
  };
}

interface MinimizableComment {
  id: string;          // GraphQL node id
  databaseId: number;  // REST comment id, for logging
  isMinimized: boolean;
  body: string | null;
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
 * Call agent.generate() with retry for transient upstream failures — e.g.
 * "Upstream idle timeout exceeded", a known OpenRouter free-tier flakiness
 * pattern, not a real request error. Non-transient errors (schema
 * validation, bad request) are NOT retried — they'd fail identically every time.
 */
async function generateWithRetry(
  agent: Agent,
  prompt: string | any[],
  opts: Record<string, unknown> | undefined,
  label: string,
): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return opts ? await agent.generate(prompt as any, opts as any) : await agent.generate(prompt as any);
    } catch (e) {
      lastErr = e;
      if (!isTransientLLMError(e) || attempt === 3) throw e;
      const delay = 2000 * attempt;
      console.warn(
        `[generateWithRetry] ${label} failed on attempt ${attempt}/3 ` +
        `(transient: ${(e as Error).message}) — retrying in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * Rough token estimate — good enough for a truncation budget, not exact.
 * ~4 chars/token is a standard approximation for English/code text.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Cap the total size of phase-1 messages carried into the forced call.
 * Tool results (file reads, npm audit/eslint output) can be huge; without
 * a cap, threading the full trace risks exceeding the model's context
 * window entirely (seen in practice: a 1,048,576-token Gemini limit
 * exceeded from an uncapped forced-call prompt).
 *
 * Strategy: keep messages starting from the END (most recent tool calls
 * are usually most relevant to "what did you just find"), dropping older
 * ones once the budget is exhausted. Truncate any individual oversized
 * message's content rather than dropping it outright, so at least a
 * summary survives.
 */
function capMessagesToBudget(messages: any[], maxTokens: number): any[] {
  const kept: any[] = [];
  let used = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];

    const content =
      typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content ?? '');

    const tokens = estimateTokens(content);

    if (used + tokens > maxTokens) {
      const remaining = maxTokens - used;

      if (remaining > 200) {
        const truncatedChars = remaining * 4;

        kept.unshift({
          ...msg,
          content:
            content.slice(0, truncatedChars) +
            '\n...[truncated]',
        });
      }

      break;
    }

    kept.unshift(msg);
    used += tokens;
  }

  return kept;
}

/**
 * Build a local, in-process "reporting" tool whose input schema is the
 * caller's Zod schema. Instructing the agent to call this tool (instead of
 * writing a JSON final answer) gets its output schema-validated by Mastra's
 * normal tool-argument parsing — the same mechanism already reliably driving
 * file_read/command_run — rather than needing a second LLM call to coerce
 * free text into JSON after the fact.
 *
 * getResult() returns the last captured call, or undefined if the agent
 * never called it (e.g. it hit maxSteps first).
 */
function createReportTool<T>(id: string, description: string, schema: z.ZodType<T>) {
  let captured: T | undefined;
  let callCount = 0;
  const tool = createTool({
    id,
    description,
    inputSchema: schema,
    execute: async (inputData) => {
      callCount++;
      if (callCount > 1) {
        console.warn(`[${id}] Called ${callCount} times — using the most recent call.`);
      }
      captured = inputData as T;
      return { received: true };
    },
  });
  return { id, tool, getResult: () => captured };
}

/**
 * Run an agent with tools (including a report tool) and return whatever it
 * reported, or `fallback` if it never called the report tool. The whole
 * call is retried on transient upstream failures via generateWithRetry.
 */
async function generateWithReportTool<T>(
  agent: Agent,
  prompt: string,
  reportTool: { id: string; getResult: () => T | undefined },
  fallback: T,
  opts: { maxSteps?: number },
  label: string,
): Promise<{ value: T; finishReason: string }> {
  // Phase 1: let the agent do its normal investigation/work.
  const result = await generateWithRetry(agent, prompt, opts, label);

  // Normal path — the agent successfully reported its result.
  const captured = reportTool.getResult();

  if (captured !== undefined) {
    return {
      value: captured,
      finishReason: result.finishReason,
    };
  }

  // Recovery path — the agent finished without calling the report tool.
  console.warn(
    `[generateWithReportTool] ${label} — agent did not call ${reportTool.id}; ` +
    `running recovery report call.`,
  );

  /*
   * Preserve the phase-1 conversation so the recovery call can see the work
   * the agent already performed.
   *
   * Keep only the most recent messages and cap the total size. This avoids
   * resending the entire conversation when a long tool-using run hits
   * maxSteps.
   */
    const rawMessages = result.response?.messages ?? [];

    const MAX_RECOVERY_MESSAGES = 20;
    const MAX_RECOVERY_TOKENS = 10_000;

    const recoveryMessages = capMessagesToBudget(
      rawMessages.slice(-MAX_RECOVERY_MESSAGES),
      MAX_RECOVERY_TOKENS,
    );

    console.warn(
      `[generateWithReportTool] ${label} — recovery context: ` +
      `${recoveryMessages.length} messages.`,
    );

  const recoveryPrompt = [
    {
      role: 'user' as const,
      content:
        `You already completed the task above. Do not perform any more investigation ` +
        `or use any other tools. Based on the work you already completed, immediately ` +
        `call ${reportTool.id} with the best complete result you can produce. ` +
        `This must be your only action.`,
    },
  ];

  try {
    const recoveryResult = await generateWithRetry(
      agent,
      [
        ...recoveryMessages,
        ...recoveryPrompt,
      ],
      {
        ...opts,
        maxSteps: 1,
        toolChoice: {
          type: 'tool',
          toolName: reportTool.id,
        },
      },
      `${label} (recovery)`,
    );

    const recovered = reportTool.getResult();

    if (recovered !== undefined) {
      console.log(
        `[generateWithReportTool] ${label} — recovery successfully captured ${reportTool.id}.`,
      );

      return {
        value: recovered,
        finishReason: result.finishReason,
      };
    }

    console.warn(
      `[generateWithReportTool] ${label} — recovery call did not produce ` +
      `${reportTool.id}; using fallback.`,
    );

    if (process.env.DEBUG_MCP) {
      console.warn(
        `[generateWithReportTool] ${label} — recovery finishReason=${recoveryResult.finishReason}, ` +
        `text=${recoveryResult.text?.slice(0, 500)}, ` +
        `toolCalls=${JSON.stringify(recoveryResult.toolCalls)}`,
      );
    }
  } catch (e) {
    console.error(
      `[generateWithReportTool] ${label} — recovery call failed; using fallback.`,
      e,
    );
  }

  return {
    value: fallback,
    finishReason: result.finishReason,
  };
}

/**
 * Kill a single sandbox immediately and remove it from the tracking array.
 * Returns true if the kill call itself succeeded, false if it errored (the
 * sandbox is still removed from tracking either way — killing an already-dead
 * sandbox, or one we've lost track of, is treated as a no-op, not a retry
 * target).
 *
 * Used to free resources early: reviewer sandboxes are killed right after
 * their agent finishes (they're no longer needed), and the developer sandbox
 * is killed right after commit+push. This is critical under the default
 * `SANDBOX_RESOURCE_LIMITS = { cpu: '1', memory: '2Gi' }` — keeping 3-4
 * sandboxes alive simultaneously causes CPU/network contention that can make
 * git operations hang and get killed by the timeout (exit code -1).
 *
 * The 10s timeout on kill() also protects cleanupSandboxes (which calls this
 * for every remaining sandbox) during shutdown, when the OpenSandbox
 * lifecycle API may be unreachable.
 *
 * Individual failures are logged as warnings, never thrown — this is the
 * single point of sandbox destruction and must never itself become the
 * reason a run or a shutdown fails.
 */
async function killSandbox(sandbox: Sandbox): Promise<boolean> {
  const id = sandbox.id;
  console.log(`[killSandbox] Killing sandbox ${id}`);
  let success = false;
  try {
    await Promise.race([sandbox.kill(), timeout(10000)]);
    console.log(`[killSandbox] Deleted sandbox ${id}`);
    success = true;
  } catch (e: any) {
    console.warn(`[killSandbox] Error killing sandbox ${id}:`, e);
  } finally {
    try {
      await sandbox.close();
    } catch (e: any) {
      console.warn(`[killSandbox] Error closing transport for sandbox ${id}:`, e);
    }
    const idx = createdSandboxes.findIndex((s) => s.id === id);
    if (idx !== -1) createdSandboxes.splice(idx, 1);
  }
  return success;
}

/**
 * Idempotent, single-flight sandbox cleanup.
 *
 * Kills every Sandbox instance still tracked from this run via killSandbox —
 * this is the safety-net that runs at the end of main() (and on SIGINT/SIGTERM)
 * for any sandbox that wasn't already killed early by runReviewer/runDeveloper.
 *
 * Kills run in parallel since they're independent, so shutdown isn't gated
 * on the slowest sandbox.
 *
 * Concurrent calls share the same Promise so cleanup runs at most once.
 */
async function cleanupSandboxes(): Promise<void> {
  if (cleanupPromise) {
    return cleanupPromise; // already in progress — await the same operation
  }

  cleanupPromise = (async () => {
    console.log('Cleaning up sandboxes...');

    const toKill = createdSandboxes.splice(0); // atomically take all, clear the array
    if (toKill.length === 0) {
      console.log('No sandboxes to clean up');
      return;
    }

    console.log(`Found ${toKill.length} sandbox(es) to clean up`);
    const results = await Promise.all(toKill.map((sandbox) => killSandbox(sandbox)));
    const cleaned = results.filter(Boolean).length;
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
  await new Promise((resolve) => setTimeout(resolve, 5000));
  console.log(`[startSandboxServices] Services started in sandbox ${sandbox.id}`);
}

interface CommandRunResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
}

function executionResult(execution: Execution): CommandRunResult {
  return {
    exit_code: execution.exitCode ?? null,
    stdout: (execution.logs?.stdout ?? []).map((m) => m.text).join(''),
    stderr: (execution.logs?.stderr ?? []).map((m) => m.text).join(''),
  };
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

interface ExecutableTool {
  execute: (input: any, context?: any) => Promise<any>;
}

async function connectSandboxToMcp(tools: ToolsInput, sandboxId: string): Promise<void> {
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
/** Developer output — extends the reported schema with subPrUrl (set after git push). */
type DeveloperOutput = z.infer<typeof DeveloperStructuredOutputSchema> & { subPrUrl: string };

function formatFinding(f: Finding): string {
  return `**${f.title}** — *${f.location}* — ${f.description}\n\nSuggestion: ${f.suggestion}`;
}

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

function formatRefutedComment(refuteResult: RefuteOutput): string {
  const acceptedLines = refuteResult.accepted
    .map((f) => `${formatFinding(f)}\n\n_Accepted: ${f.reason}_`)
    .join('\n\n') || '_None_';
  const rejectedLines = refuteResult.rejected
    .map((f) => `${formatFinding(f)}\n\n_Rejected: ${f.reason}_`)
    .join('\n\n') || '_None_';

  return `# Review Analysis\n\n## Accepted (${refuteResult.accepted.length})\n${acceptedLines}\n\n## Rejected (${refuteResult.rejected.length})\n${rejectedLines}`;
}

function formatChangesetComment(
  diff: string,
  branch: string,
  summary: string,
  subPrUrl: string,
  testResults: string,
): string {
  const testSection = testResults
    ? `\n\n## Test Results\n\`\`\`\n${testResults.slice(0, COMMENT_SNIPPET_LIMIT)}\n\`\`\``
    : '';
  return `# Fix Applied\n\n**Branch:** \`${branch}\`\n\n**Summary:** ${summary}\n\n## Diff\n\`\`\`diff\n${diff.slice(0, COMMENT_SNIPPET_LIMIT)}\n\`\`\`\n\n## Sub-PR\n${subPrUrl}${testSection}`;
}

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

function formatReviewerFindingsForRefuter(findings: Finding[]): string {
  if (findings.length === 0) return '_No findings._';
  return findings
    .map(
      (f, i) =>
        `${i + 1}. **${f.severity}** — ${f.title} — *${f.location}* — ${f.description}\n   Suggestion: ${f.suggestion}`,
    )
    .join('\n');
}

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

/** Reviewer structured output — reported via the report_findings tool. */
const ReviewerStructuredOutputSchema = z.object({
  findings: z.array(FindingSchema),
});

/** A finding the refuter has classified, with its rationale either way. */
const EvaluatedFindingSchema = FindingSchema.extend({ reason: z.string() });

const RefuteOutputSchema = z.object({
  accepted: z.array(EvaluatedFindingSchema),
  rejected: z.array(EvaluatedFindingSchema),
});

/** Developer structured output — reported via the report_fix tool. */
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
 * The agent reports its findings by calling the local report_findings tool
 * as its final action, instead of writing JSON as a text answer — this
 * avoids the separate structuring-call failure mode entirely.
 */
async function runReviewer(
  instructions: string,
  task: string,
  repository: string,
  headRef: string,
): Promise<ReviewerOutput> {
  const mcp = createMcpClient();
  const sandbox = await createSandbox();
  const taskWithSandbox = `${task}\n\nSANDBOX_ID: ${sandbox.id}`;
  try {
    const tools = await mcp.listTools();
    console.log(`[runReviewer] Sandbox ${sandbox.id} connected to MCP server — available tools: ${Object.keys(tools).join(', ')}`);
    await connectSandboxToMcp(tools, sandbox.id);
    const agentTools = Object.fromEntries(
      Object.entries(tools).filter(
        ([name]) => !EXCLUDED_TOOLS.has(name)
      )
    );
    await setupSandbox(sandbox, repository, headRef);

    const reportTool = createReportTool(
      'report_findings',
      'Call this exactly once, as your final action, with your complete review findings. This is the only way to submit your review — do not write your findings as plain text.',
      ReviewerStructuredOutputSchema,
    );
    const agent = createAgent('reviewer', instructions, { ...agentTools, report_findings: reportTool.tool });

    const { value, finishReason } = await generateWithReportTool(
      agent,
      taskWithSandbox,
      reportTool,
      { findings: [] },
      { maxSteps: 30 },
      'reviewer',
    );

    if (process.env.DEBUG_MCP) {
      console.log(`[runReviewer] finishReason: ${finishReason}, findings: ${JSON.stringify(value)}`);
    }
    return value;
  } finally {
    await mcp.disconnect();
    // Reviewer sandbox is no longer needed — kill it immediately to free
    // CPU/memory for the remaining reviewers and the developer step.
    await killSandbox(sandbox);
  }
}

/**
 * Run the developer step: create MCPClient + Agent, implement fixes, get diff.
 *
 * The agent reports its work by calling the local report_fix tool as its
 * final action. The developer sandbox is killed immediately after
 * commit+push (it's no longer needed); if anything throws before that point
 * (e.g. gitCommitAndPush fails), the `finally` block below kills it instead,
 * so it never has to wait for the end-of-run cleanupSandboxes() safety-net.
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
  let sandboxKilled = false;
  const taskWithSandbox = `${task}\n\nSANDBOX_ID: ${sandbox.id}`;
  try {
    const tools = await mcp.listTools();
    console.log(`[runDeveloper] Sandbox ${sandbox.id} connected to MCP server — available tools: ${Object.keys(tools).join(', ')}`);
    await connectSandboxToMcp(tools, sandbox.id);
    const agentTools = Object.fromEntries(
      Object.entries(tools).filter(
        ([name]) => !EXCLUDED_TOOLS.has(name)
      )
    );
    await setupSandbox(sandbox, repository, headRef);

    const reportTool = createReportTool(
      'report_fix',
      'Call this exactly once, as your final action, with the diff, branch name, summary, test results, and changed files. This is the only way to submit your work — do not write your output as plain text.',
      DeveloperStructuredOutputSchema,
    );
    const agent = createAgent('developer', instructions, { ...agentTools, report_fix: reportTool.tool });

    const { value: obj, finishReason } = await generateWithReportTool(
      agent,
      taskWithSandbox,
      reportTool,
      { summary: '', branch: '', diff: '', testResults: '', changedFiles: [] },
      { maxSteps: 75 },
      'developer',
    );

    console.log(`[runDeveloper] finishReason: ${finishReason}, summary: ${obj.summary?.slice(0, 200)}`);

    const output: DeveloperOutput = {
      diff: obj.diff,
      summary: obj.summary,
      branch: obj.branch,
      changedFiles: obj.changedFiles,
      subPrUrl: '',
      testResults: obj.testResults,
    };

    // Commit and push the fix via git in the sandbox, then create a sub-PR.
    // Only trust the agent's branch name if it actually matches our naming
    // convention (fix/review-swarm-{id}) — anything else (empty, "none",
    // a stray placeholder, or the agent inventing its own scheme) gets a
    // freshly generated one instead of being passed to `git checkout -B`.
    const BRANCH_NAME_PATTERN = /^fix\/review-swarm-[a-zA-Z0-9-]+$/;
    if (!BRANCH_NAME_PATTERN.test(output.branch)) {
      console.warn(
        `[runDeveloper] Agent-reported branch name "${output.branch}" doesn't match ` +
        `expected pattern — generating a real one instead.`,
      );
      output.branch = `fix/review-swarm-${crypto.randomUUID().slice(0, 8)}`;
    }
    const fixBranch = output.branch;
    const pushedBranch = await gitCommitAndPush(sandbox, repository, fixBranch, prNumber);

    // Developer sandbox is no longer needed after commit+push — kill it
    // immediately to free resources (same reasoning as reviewer sandboxes).
    await killSandbox(sandbox);
    sandboxKilled = true;

    if (pushedBranch) {
      output.subPrUrl = await createFixBranchAndPr(repository, headRef, pushedBranch, output.summary);
    }
    console.log(`[runDeveloper] Fix applied in sandbox ${sandbox.id} — subPR: ${output.subPrUrl}`);
    return output;
  } finally {
    await mcp.disconnect();
    // Safety-net: if we threw (or returned) before the post-commit kill
    // above ran, make sure the sandbox still gets cleaned up immediately
    // rather than sitting alive until the end-of-run cleanupSandboxes().
    if (!sandboxKilled) {
      await killSandbox(sandbox);
    }
  }
}

// ── Step Definitions ───────────────────────────────────────────────────────────

const securityReviewStep = createStep({
  id: 'security_review',
  inputSchema: InputSchema,
  outputSchema: ReviewOutputSchema,
  execute: async ({ inputData }) => {
    const result = await runReviewer(SECURITY_INSTRUCTION, inputData.task, inputData.repository, inputData.headRef);
    return { result };
  },
});

const performanceReviewStep = createStep({
  id: 'performance_review',
  inputSchema: InputSchema,
  outputSchema: ReviewOutputSchema,
  execute: async ({ inputData }) => {
    const result = await runReviewer(PERFORMANCE_INSTRUCTION, inputData.task, inputData.repository, inputData.headRef);
    return { result };
  },
});

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
 * Refute findings step: no MCPClient, no sandbox tools — pure analysis of
 * findings text. Reports its evaluation via the report_evaluation tool.
 */
const RefuteResultSchema = z.object({ result: RefuteOutputSchema });

const refuteStep = createStep({
  id: 'refute_findings',
  inputSchema: ParallelReviewOutputSchema,
  outputSchema: RefuteResultSchema,
  execute: async ({ getStepResult }) => {
    const security = getStepResult<{ result: ReviewerOutput }>('security_review');
    const performance = getStepResult<{ result: ReviewerOutput }>('performance_review');
    const quality = getStepResult<{ result: ReviewerOutput }>('code_quality_review');

    const combined = formatFindingsForRefuter(security.result, performance.result, quality.result);

    const reportTool = createReportTool(
      'report_evaluation',
      'Call this exactly once, as your final action, with your accepted and rejected findings. This is the only way to submit your evaluation — do not write your evaluation as plain text.',
      RefuteOutputSchema,
    );
    const agent = createAgent('refuter', REFUTER_INSTRUCTION, { report_evaluation: reportTool.tool });

    const { value } = await generateWithReportTool(
      agent,
      combined,
      reportTool,
      { accepted: [], rejected: [] },
      {},
      'refuter',
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
    const refuted = getStepResult<{ result: RefuteOutput }>('refute_findings');
    const task = `${initData.task}\n\n${formatAcceptedFindingsForDeveloper(refuted.result.accepted)}`;
    const result = await runDeveloper(DEVELOPER_INSTRUCTION, task, initData.repository, initData.headRef, initData.prNumber);
    return { result };
  },
});

// ── Workflow Definition ────────────────────────────────────────────────────────

// Whether the develop_fix step should be part of the workflow graph at all.
// Read directly from argv here (rather than via parseArgs/main) so importing
// this module has no other side effects — full CLI validation still happens
// in main() below.
const FIX_FLAG_ENABLED = process.argv.includes('--fix');

const workflowBuilder = new Workflow({
  id: 'CodeReviewSwarm',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
})
  .parallel([securityReviewStep, performanceReviewStep, codeQualityReviewStep])
  .then(refuteStep);

const reviewSwarmWorkflow = FIX_FLAG_ENABLED
  ? workflowBuilder.then(developStep).commit()
  : workflowBuilder.commit();

const mastra = new Mastra({
  workflows: { CodeReviewSwarm: reviewSwarmWorkflow },
  observability: new Observability({
    configs: {
      arize: {
        serviceName: process.env.ARIZE_PROJECT_NAME || 'osbx-review-swarm',
        exporters: [new ArizeExporter()],
      },
    },
  }),
});



// ── Event Handling ─────────────────────────────────────────────────────────────

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
 * Extraction order:
 *   1. `payload.output.result` — the canonical shape for our steps
 *   2. `payload.payload` — some Mastra internals nest the output under `payload`
 */
function extractStepResult<T>(event: StepResultEvent): T | undefined {
  const payload = event.payload;

  const output = payload.output;
  if (output && typeof output === 'object') {
    const result = (output as Record<string, any>).result;
    if (result !== undefined && result !== null) {
      return result as T;
    }
  }

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
    if (ctx) {
      console.log(`  Changed files (${ctx.changedFiles.length}): ${ctx.changedFiles.join(', ')}`);
    }
  }

  if (!stepId) {
    console.error('handleStepCompletion: event.payload.id is missing — skipping.');
    return;
  }

  if (stepId === 'develop_fix') {
    const dev = extractStepResult<DeveloperOutput>(event);

    // Treat a missing/placeholder diff or branch as "no real fix produced" —
    // even if summary is non-empty prose (e.g. the agent reporting it was
    // still investigating), don't post a "Fix Applied" comment that implies
    // a fix actually happened.
    const hasRealFix =
      dev &&
      dev.diff &&
      dev.diff !== 'none' &&
      dev.branch &&
      dev.branch !== 'none';

    if (!hasRealFix) {
      console.error(
        `handleStepCompletion: step '${stepId}' completed but no real fix was produced ` +
        `(diff="${dev?.diff}", branch="${dev?.branch}"). Skipping comment.`,
      );
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

  if (stepId === 'security_review' || stepId === 'performance_review' || stepId === 'code_quality_review') {
    const titles: Record<string, string> = {
      security_review: 'Security Review',
      performance_review: 'Performance Review',
      code_quality_review: 'Code Quality Review',
    };
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
    await postPrComment(repository, prNumber, formatReviewerComment(findings, titles[stepId]));
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
  fix: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { repository: '', prNumber: NaN, debug: false, fix: false };

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
    } else if (arg === '--fix') {
      args.fix = true;
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

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
  if (args.fix) {
    console.log('Fix mode enabled. Developer step will run after review.');
  } else {
    console.log('Review-only mode. Pass --fix to apply fixes after review.');
  }

  // 1. Fetch PR context (diff, changed files, metadata) — validates the PR exists
  const ctx = await getPrContext(args.repository, args.prNumber);
  console.log(`PR #${args.prNumber}: "${ctx.title}" head=${ctx.headRef}`);

  // 2. Minimize old bot comments from previous runs (best-effort — skip on failure)
  try {
    await minimizeOldComments(args.repository, args.prNumber);
  } catch (e: any) {
    console.warn(`[warn] Failed to minimize old comments: ${e.message} — continuing anyway`);
  }

  // 3. Build the task string with full context for the agents
  const changedFilesStr = ctx.changedFiles.length > 0
    ? ctx.changedFiles.map((f) => `- \`${f}\``).join('\n')
    : '*No code files changed*';

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
    const run = await mastra.getWorkflow('CodeReviewSwarm').createRun();
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
    await cleanupSandboxes();
  }

  console.log('Review swarm complete.');
}

// ── Graceful Shutdown ────────────────────────────────────────────────────────────

process.once('SIGINT', () => {
  console.log('\nSIGINT, aborting workflow and cleaning up sandboxes...');
  signalExitCode = 130;
  currentRunAbortController?.abort();
  cleanupSandboxes()
    .catch((e) => console.warn('Cleanup failed during shutdown:', e))
    .finally(() => process.exit(130));
});

process.once('SIGTERM', () => {
  console.log('SIGTERM, aborting workflow and cleaning up sandboxes...');
  signalExitCode = 143;
  currentRunAbortController?.abort();
  cleanupSandboxes()
    .catch((e) => console.warn('Cleanup failed during shutdown:', e))
    .finally(() => process.exit(143));
});

main().catch(async (err) => {
  console.error('Review swarm failed:', err);
  await cleanupSandboxes().catch((e) => console.warn('Cleanup failed after error:', e));
  process.exit(signalExitCode ?? 1);
});
