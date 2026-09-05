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
  SandboxManager,
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
const GITHUB_API_BASE = 'https://api.github.com';

const MODEL = process.env.OPENROUTER_MODEL || 'openrouter/nvidia/nemotron-3.5-lightning:free';
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || 'review-swarm-sandbox:latest';
const SANDBOX_RESOURCE_LIMITS = { cpu: '1', memory: '2Gi' };
const SANDBOX_TTL_SECONDS = 3600;

/**
 * Track sandbox IDs created during this run so cleanup only destroys
 * sandboxes we created — never pre-existing ones.
 */
const createdSandboxIds = new Set<string>();

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

  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo: repoName,
    issue_number: prNumber,
  });

  for (const comment of comments) {
    if (!comment.body?.includes(GITHUB_MARKER)) continue;

    console.log(`Minimizing old comment id=${comment.id}`);

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
        };
      };
      errors?: Array<{ message: string }>;
    };
    if (result.errors && result.errors.length > 0) {
      console.warn(
        `GraphQL minimize error: ${result.errors.map((e) => e.message).join(', ')}`,
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
 */
function parseDeveloperOutput(text: string): DeveloperOutput {
  const summaryMatch = text.match(/## Summary\s*\n([\s\S]*?)(?=\n##|\n```|$)/);
  const branchMatch = text.match(/## Branch\s*\n([\s\S]*?)(?=\n##|\n```|$)/);
  const diffMatch = text.match(/## Diff\s*\n```diff\s*\n([\s\S]*?)\n```/);

  return {
    summary: (summaryMatch?.[1] || '').trim(),
    branch: (branchMatch?.[1] || '').trim(),
    diff: (diffMatch?.[1] || '').trim(),
  };
}

/**
 * Create a fix branch from the PR head, commit the diff file-by-file via the
 * GitHub Contents API, and open a sub-PR back to the PR's head branch.
 */
async function createFixBranchAndPr(
  repository: string,
  prHeadRef: string,
  diff: string,
  summary: string,
): Promise<{ branch: string; subPrUrl: string }> {
  const [owner, repoName] = parseRepo(repository);
  const branch = `fix/review-swarm-${crypto.randomUUID().slice(0, 8)}`;
  const headers: Record<string, string> = {
    Authorization: `token ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
  };

  // 1. Resolve the PR head commit SHA
  const branchResp = await fetch(`${GITHUB_API_BASE}/repos/${repository}/branches/${prHeadRef}`, { headers });
  if (!branchResp.ok) {
    throw new Error(`Could not get base branch ref: ${await branchResp.text()}`);
  }
  const branchData = (await branchResp.json()) as { commit: { sha: string } };
  const baseSha = branchData.commit.sha;

  // 2. Create the fix branch ref from the PR head
  const refResp = await fetch(`${GITHUB_API_BASE}/repos/${repository}/git/refs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
  });
  if (!refResp.ok) {
    throw new Error(`Could not create branch ${branch}: ${await refResp.text()}`);
  }

  // 3. Parse the diff to extract per-file added content
  const fileContents = parseDiffForNewFiles(diff);

  if (Object.keys(fileContents).length === 0) {
    console.log('No file changes in fix diff — skipping sub-PR creation');
    return { branch, subPrUrl: '' };
  }

  // 4. Commit each file via the Contents API
  for (const [filePath, lines] of Object.entries(fileContents)) {
    const content = lines.join('\n');
    const encoded = Buffer.from(content).toString('base64');

    // Determine if file already exists on the new branch
    const getResp = await fetch(`${GITHUB_API_BASE}/repos/${repository}/contents/${filePath}?ref=${branch}`, { headers });
    let fileSha: string | undefined;
    if (getResp.ok) {
      const fileData = (await getResp.json()) as { sha?: string };
      fileSha = fileData.sha;
    }

    const putResp = await fetch(`${GITHUB_API_BASE}/repos/${repository}/contents/${filePath}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: fileSha ? 'Update from review swarm' : 'Add from review swarm',
        content: encoded,
        sha: fileSha,
        branch,
      }),
    });

    if (!putResp.ok) {
      console.warn(`Could not update ${filePath}: ${await putResp.text()}`);
    }
  }

  // 5. Open a sub-PR
  const { data: newPr } = await octokit.rest.pulls.create({
    owner,
    repo: repoName,
    title: `fix: ${summary.slice(0, 80)}`,
    head: branch,
    base: prHeadRef,
    body: `Automated fix generated by review swarm.\n\n${summary}\n\n\`\`\`diff\n${diff.slice(0, 3000)}\n\`\`\``,
  });

  console.log(`Fix PR created: ${newPr.html_url}`);
  return { branch, subPrUrl: newPr.html_url };
}

/**
 * Parse a unified diff to extract per-file content (added lines grouped by file).
 * Returns a map of file paths to arrays of content lines.
 */
function parseDiffForNewFiles(diff: string): Record<string, string[]> {
  const lines = diff.split('\n');
  const result: Record<string, string[]> = {};
  let currentFile: string | null = null;
  let currentContent: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('diff --git ')) {
      if (currentFile && currentContent.length > 0) {
        result[currentFile] = currentContent;
      }
      // Skip to the +++ line — may be preceded by an index line and --- line
      while (i + 1 < lines.length && !lines[i + 1].startsWith('+++')) {
        i++;
      }
      i++; // Move to the +++ line
      if (i < lines.length && lines[i].startsWith('+++')) {
        const match = lines[i].match(/\+\+\+ b\/(.+)/);
        currentFile = match ? match[1].trim() : null;
      }
      currentContent = [];
    } else if (currentFile) {
      if (line.startsWith('+ ') || line.startsWith('+++') || line === '') {
        if (line.startsWith('+ ')) {
          currentContent.push(line.slice(2));
        } else if (line.startsWith('+')) {
          currentContent.push(line.slice(1));
        } else {
          currentContent.push(line);
        }
      }
    }
  }

  if (currentFile && currentContent.length > 0) {
    result[currentFile] = currentContent;
  }

  return result;
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
 * Idempotent, single-flight sandbox cleanup.
 *
 * Lists sandboxes via the OpenSandbox JS SDK (SandboxManager) and kills each one
 * that was created during this run. This is the single point of sandbox
 * destruction — agents no longer call sandbox_kill themselves; each step's
 * sandbox is created by runReviewer/runDeveloper and killed here as a
 * safety-net.
 *
 * If the server is unreachable (e.g. already shutting down from SIGINT),
 * cleanup logs a warning and returns — it never throws.
 *
 * Concurrent calls share the same Promise so cleanup runs at most once.
 */
async function cleanupSandboxes(): Promise<void> {
  if (cleanupPromise) {
    return cleanupPromise; // already in progress — await the same operation
  }

  cleanupPromise = (async () => {
    console.log('Cleaning up sandboxes...');

    try {
      const connectionConfig = createConnectionConfig();
      const manager = SandboxManager.create({ connectionConfig });

      // 1. List all sandboxes
      let items: Array<{ id: string }> = [];
      try {
        const response = await manager.listSandboxInfos({});
        items = response.items || [];
      } catch (e: any) {
        console.warn('Sandbox cleanup (best-effort) failed:', e);
        await manager.close();
        return;
      }

      const sandboxes = items;
      // Only delete sandboxes that were created during this run.
      const toDelete = sandboxes.filter((sb) => sb.id && createdSandboxIds.has(sb.id));
      if (toDelete.length === 0) {
        console.log('No sandboxes to clean up');
        await manager.close();
        return;
      }

      console.log(`Found ${toDelete.length} sandbox(es) to clean up (of ${sandboxes.length} total on the server)`);

      // Delete each sandbox created in this run (continue on individual failures)
      let cleaned = 0;
      for (const sb of toDelete) {
        const id = sb.id;
        console.log(`Deleting sandbox ${id}`);
        try {
          await manager.killSandbox(id);
          console.log(`Deleted sandbox ${id}`);
          cleaned++;
        } catch (e: any) {
          console.warn(`Error deleting sandbox ${id}:`, e);
        } finally {
          createdSandboxIds.delete(id);
        }
      }

      console.log(`Sandbox cleanup complete (${cleaned}/${toDelete.length} deleted)`);
      await manager.close();
    } catch (e: any) {
      console.warn('Sandbox cleanup encountered an unexpected error:', e);
    }
  })();

  return cleanupPromise;
}

/**
 * Create a sandbox via the OpenSandbox JS SDK and wait until it is ready.
 * The returned Sandbox instance is used by the service layer for commands;
 * its ID is also injected into the agent task string so the agent can call
 * command_run with connect_if_missing=True — it never needs to call
 * sandbox_create itself.
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
  });
  createdSandboxIds.add(sandbox.id);
  console.log(`[createSandbox] Sandbox ${sandbox.id} is ready (Running + healthy)`);
  return sandbox;
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
 * doesn't know about it. MCP tools like `file_read` don't support
 * connect_if_missing, so they fail with "Sandbox not found in local
 * registry". Calling `sandbox_connect` once registers the sandbox so all
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
    console.warn(`[connectSandboxToMcp] MCP tool '${toolKey}' not available — agent MCP tools may fail`);
    return;
  }
  await tool.execute({ sandbox_id: sandboxId }, {});
  console.log(`[connectSandboxToMcp] Registered sandbox ${sandboxId} with MCP server`);
}

// ── Comment Formatting (simple markdown templates) ────────────────────────────

/**
 * Format a reviewer's markdown findings into a PR comment with a header emoji.
 * The agent already returns markdown with ## HIGH / ## MEDIUM / ## LOW sections.
 */
function formatReviewerComment(findings: string, title: string): string {
  return `### ${title}\n\n${findings}`;
}

/**
 * Format the refuter's output into a PR comment.
 */
function formatRefutedComment(findings: string): string {
  return `### Findings Summary\n\n${findings}`;
}

/**
 * Format the developer's changeset into a PR comment.
 */
function formatChangesetComment(diff: string, branch: string, summary: string, subPrUrl: string): string {
  return `### Fix Applied\n\n**Branch:** \`${branch}\`\n\n**Summary:** ${summary}\n\n#### Diff\n\`\`\`diff\n${diff.slice(0, 3000)}\n\`\`\`\n\n#### Sub-PR: ${subPrUrl}`;
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
    const result = await agent.generate(taskWithSandbox, { maxSteps: 15 });
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
async function runDeveloper(instructions: string, task: string, repository: string, headRef: string): Promise<string> {
  const mcp = createMcpClient();
  const sandbox = await createSandbox();
  const taskWithSandbox = `${task}\n\nSANDBOX_ID: ${sandbox.id}`;
  try {
    const tools = await mcp.listTools();
    console.log(`[runDeveloper] Sandbox ${sandbox.id} connected to MCP server — available tools: ${Object.keys(tools).join(', ')}`);
    await connectSandboxToMcp(tools, sandbox.id);
    await setupSandbox(sandbox, repository, headRef);
    const agent = createAgent('developer', instructions, tools);
    const result = await agent.generate(taskWithSandbox, { maxSteps: 15 });
    if (process.env.DEBUG_MCP) {
      console.log(`[runDeveloper] result.text: ${JSON.stringify(result.text?.slice(0, 200))}`);
      console.log(`[runDeveloper] result.steps.length: ${result.steps?.length ?? 'N/A'}`);
      console.log(`[runDeveloper] result.toolCalls: ${result.toolCalls?.length ?? 0}`);
      console.log(`[runDeveloper] result.finishReason: ${result.finishReason}`);
    }
    return result.text;
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
    const result = await agent.generate(combined);
    return { result: result.text };
  },
});

/**
 * Develop fix step: creates its own sandbox + MCPClient, implements fixes
 * for accepted findings, returns diff as markdown.
 */
const developStep = createStep({
  id: 'develop_fix',
  inputSchema: ReviewOutputSchema,
  outputSchema: ReviewOutputSchema,
  execute: async ({ getInitData, getStepResult }) => {
    const initData = getInitData<{ repository: string; prNumber: number; task: string; headRef: string }>();
    const refuted = getStepResult<{ result: string }>('refute_findings');
    const task = `${initData.task}\n\n## Refuted Findings\n\n${refuted.result}`;
    const result = await runDeveloper(DEVELOPER_INSTRUCTION, task, initData.repository, initData.headRef);
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
  const findings = extractStepResultText(event);

  if (debug) {
    console.log(`Step finished: ${stepId}`);
    if (!findings || findings.trim() === '') {
      console.log(`  [WARN] No findings text extracted for step '${stepId}'.`);
      console.log(`  event.payload.output:`, JSON.stringify(event.payload?.output));
      console.log(`  event.payload.payload:`, JSON.stringify(event.payload?.payload));
    } else {
      console.log(`  Findings length: ${findings.length} chars`);
    }
  }

  if (!stepId) {
    console.error('handleStepCompletion: event.payload.id is missing — skipping.');
    return;
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
  } else if (stepId === 'develop_fix') {
    const { diff, summary } = parseDeveloperOutput(findings);
    const { branch: actualBranch, subPrUrl } = await createFixBranchAndPr(
      repository,
      ctx.headRef,
      diff,
      summary,
    );
    await postPrComment(
      repository,
      prNumber,
      formatChangesetComment(diff, actualBranch, summary, subPrUrl),
    );
  }
}

// ── CLI Entry Point ────────────────────────────────────────────────────────────

interface CliArgs {
  repository: string;
  prNumber: number;
  debug: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { repository: '', prNumber: NaN, debug: false };

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

  // 1. Minimize old bot comments from previous runs
  await minimizeOldComments(args.repository, args.prNumber);

  // 2. Fetch PR context (diff, changed files, metadata)
  const ctx = await getPrContext(args.repository, args.prNumber);
  console.log(`PR #${args.prNumber}: "${ctx.title}" head=${ctx.headRef}`);

  // 3. Build the task string with full context for the agents
  const changedFilesStr = ctx.changedFiles.length > 0
    ? ctx.changedFiles.map((f) => `- \`${f}\``).join('\n')
    : '*No code files changed*';

  const diffPreview = ctx.diff ? ctx.diff.slice(0, 6000) : '*No diff available*';

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

PR diff:
\`\`\`diff
${diffPreview}
\`\`\`;`;

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
