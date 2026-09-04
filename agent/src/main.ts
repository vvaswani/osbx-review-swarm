#!/usr/bin/env bun
/**
 * Code review swarm CLI script.
 *
 * Run: bun run src/main.ts --repository owner/name --pr-number 123 [--debug]
 *
 * Implements a Mastra workflow:
 *   3 parallel review steps → refute_findings → develop_fix
 *
 * Each reviewer/developer creates its own MCPClient (sandbox isolation),
 * runs linters/tests in the sandbox, and returns markdown findings.
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
const GITHUB_MARKER = '<!-- REVIEW_SWARM_COMMENT -->';
const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';
const GITHUB_API_BASE = 'https://api.github.com';

const MODEL = process.env.OPENROUTER_MODEL || 'openrouter/nvidia/nemotron-3.5-lightning:free';

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
          minimizedComment { id }
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
    }
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
      // Parse new file header (+++ b/path)
      i++;
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

/**
 * Safety-net: destroy any sandboxes that agents failed to clean up.
 */
async function cleanupRemainingSandboxes(): Promise<void> {
  const apiKey = process.env.OPENSANDBOX_API_KEY;
  const headers: Record<string, string> = apiKey
    ? { Authorization: `Bearer ${apiKey}` }
    : {};

  try {
    const resp = await fetch('http://localhost:8080/sandboxes', { headers });
    if (!resp.ok) return;

    const data = (await resp.json()) as { sandboxes?: Array<{ id: string }> };
    const sandboxes = data.sandboxes || [];
    for (const sb of sandboxes) {
      const id = sb.id;
      if (id) {
        console.log(`Cleaning up leftover sandbox ${id}`);
        await fetch(`http://localhost:8080/sandboxes/${id}`, { method: 'DELETE', headers });
      }
    }
  } catch (e) {
    console.warn(`Sandbox cleanup (best-effort) failed: ${e}`);
  }
}

// ── Comment Formatting (simple markdown templates) ────────────────────────────

/**
 * Format a reviewer's markdown findings into a PR comment with a header emoji.
 * The agent already returns markdown with ## HIGH / ## MEDIUM / ## LOW sections.
 */
function formatReviewerComment(findings: string, emoji: string, title: string): string {
  return `### ${emoji} ${title}\n\n${findings}`;
}

/**
 * Format the refuter's output into a PR comment.
 */
function formatRefutedComment(findings: string): string {
  return `### 🎯 Findings Summary\n\n${findings}`;
}

/**
 * Format the developer's changeset into a PR comment.
 */
function formatChangesetComment(diff: string, branch: string, summary: string, subPrUrl: string): string {
  return `### 💻 Fix Applied\n\n**Branch:** \`${branch}\`\n\n**Summary:** ${summary}\n\n#### Diff\n\`\`\`diff\n${diff.slice(0, 3000)}\n\`\`\`\n\n#### Sub-PR: ${subPrUrl}`;
}

// ── Mastra Workflow ───────────────────────────────────────────────────────────

const InputSchema = z.object({
  repository: z.string(),
  prNumber: z.number().int().positive(),
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
function createMcpClient(): MCPClient {
  return new MCPClient({
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
 * Run a review step: create MCPClient + Agent, get markdown findings, disconnect.
 */
async function runReview(instructions: string, task: string): Promise<string> {
  const mcp = createMcpClient();
  const tools = await mcp.listTools();
  const agent = createAgent('reviewer', instructions, tools);
  const result = await agent.generate(task);
  await mcp.disconnect();
  return result.text;
}

/**
 * Run the developer step: create MCPClient + Agent, implement fixes, get diff.
 */
async function runDeveloper(instructions: string, task: string): Promise<string> {
  const mcp = createMcpClient();
  const tools = await mcp.listTools();
  const agent = createAgent('developer', instructions, tools);
  const result = await agent.generate(task);
  await mcp.disconnect();
  return result.text;
}

// ── Step Definitions ───────────────────────────────────────────────────────────

/**
 * Security review step: creates its own MCPClient (sandbox isolation),
 * clones repo, runs security linters, returns markdown findings.
 */
const securityReviewStep = createStep({
  id: 'security_review',
  inputSchema: InputSchema,
  outputSchema: ReviewOutputSchema,
  execute: async ({ inputData }) => {
    const result = await runReview(SECURITY_INSTRUCTION, inputData.task);
    return { result };
  },
});

/**
 * Performance review step: creates its own MCPClient (sandbox isolation),
 * reviews for performance issues, returns markdown findings.
 */
const performanceReviewStep = createStep({
  id: 'performance_review',
  inputSchema: InputSchema,
  outputSchema: ReviewOutputSchema,
  execute: async ({ inputData }) => {
    const result = await runReview(PERFORMANCE_INSTRUCTION, inputData.task);
    return { result };
  },
});

/**
 * Code quality review step: creates its own MCPClient (sandbox isolation),
 * runs linters, reviews for code smells, returns markdown findings.
 */
const codeQualityReviewStep = createStep({
  id: 'code_quality_review',
  inputSchema: InputSchema,
  outputSchema: ReviewOutputSchema,
  execute: async ({ inputData }) => {
    const result = await runReview(QUALITY_INSTRUCTION, inputData.task);
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
 * Develop fix step: creates its own MCPClient (sandbox isolation),
 * implements fixes for accepted findings, returns diff as markdown.
 */
const developStep = createStep({
  id: 'develop_fix',
  inputSchema: ReviewOutputSchema,
  outputSchema: ReviewOutputSchema,
  execute: async ({ getInitData, getStepResult }) => {
    const initData = getInitData<{ repository: string; prNumber: number; task: string }>();
    const refuted = getStepResult<{ result: string }>('refute_findings');
    const task = `${initData.task}\n\n## Refuted Findings\n\n${refuted.result}`;
    const result = await runDeveloper(DEVELOPER_INSTRUCTION, task);
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
  .then(developStep);

// ── Event Handling ─────────────────────────────────────────────────────────────

interface StepResultEvent {
  type: string;
  payload?: {
    id: string;
    stepCallId: string;
    status: string;
    output?: Record<string, any>;
  };
}

async function handleStepCompletion(
  event: StepResultEvent,
  repository: string,
  prNumber: number,
  ctx: PrContext,
  debug: boolean,
): Promise<void> {
  const stepId = event.payload?.id;
  const output = event.payload?.output as Record<string, any> | undefined;

  if (debug) console.log(`Step finished: ${stepId}`);

  if (!stepId || !output) return;

  if (stepId === 'security_review') {
    await postPrComment(repository, prNumber, formatReviewerComment(output.result, '🔒', 'Security Review'));
  } else if (stepId === 'performance_review') {
    await postPrComment(repository, prNumber, formatReviewerComment(output.result, '⚡', 'Performance Review'));
  } else if (stepId === 'code_quality_review') {
    await postPrComment(repository, prNumber, formatReviewerComment(output.result, '🧹', 'Code Quality Review'));
  } else if (stepId === 'refute_findings') {
    await postPrComment(repository, prNumber, formatRefutedComment(output.result));
  } else if (stepId === 'develop_fix') {
    const { diff, summary } = parseDeveloperOutput(output.result);
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
\`\`\`

INSTRUCTIONS FOR EACH AGENT:

- Security reviewer: Create a sandbox, clone the repo, check out the PR head,
  run security linters (tsc --no-errors, eslint, bandit for Python), review the
  diff and changed files for vulnerabilities. Return findings as markdown.
- Performance reviewer: Create a sandbox, clone the repo, check out the PR head,
  review for performance issues (N+1, blocking I/O, memory, etc.). Return findings.
- Code quality reviewer: Create a sandbox, clone the repo, check out the PR head,
  run linters (eslint, prettier --check), review for code smells. Return findings.
- Refuter: Analyze all 3 sets of findings. Filter false positives and out-of-scope
  issues. Return accepted + rejected findings as markdown. NO sandbox needed.
- Developer: Create a sandbox, clone the repo, check out the PR head, implement
  fixes for accepted findings, run tests/linters, generate a git diff. Return the
  diff, changed file paths, and a summary as markdown with ## Summary, ## Branch,
  and ## Diff sections.`;

  // 4. Run the Mastra workflow with streaming
  const run = await reviewSwarmWorkflow.createRun();
  const workflowStream = run.stream({
    inputData: {
      repository: args.repository,
      prNumber: args.prNumber,
      task: taskString,
    },
  });

  // 5. Stream events — post PR comments as each step completes
  for await (const event of workflowStream) {
    if (event.type === 'workflow-step-result' && event.payload?.status === 'success') {
      await handleStepCompletion(event as StepResultEvent, args.repository, args.prNumber, ctx, args.debug);
    }
  }

  // 6. Safety-net: destroy any sandboxes agents failed to clean up
  await cleanupRemainingSandboxes();

  console.log('Review swarm complete.');
}

main().catch((err) => {
  console.error('Review swarm failed:', err);
  process.exit(1);
});
