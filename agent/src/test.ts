// test.ts — run with: bun run test.ts
// Standalone smoke test for the report-tool forcing mechanism, isolated
// from sandboxes/GitHub/git-clone. Exercises only the LLM + toolChoice path.

import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { config } from 'dotenv';
config();

const MODEL = process.env.OPENROUTER_MODEL || 'openrouter/nvidia/nemotron-3.5-lightning:free';

// ── Copied unchanged from main.ts ──────────────────────────────────────────

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

async function generateWithRetry(
  agent: Agent,
  prompt: string,
  opts: Record<string, unknown> | undefined,
  label: string,
): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return opts ? await agent.generate(prompt, opts as any) : await agent.generate(prompt);
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

async function generateWithReportTool<T>(
  agent: Agent,
  prompt: string,
  reportTool: { id: string; getResult: () => T | undefined },
  fallback: T,
  opts: { maxSteps?: number },
  label: string,
): Promise<{ value: T; finishReason: string }> {
  const result = await generateWithRetry(agent, prompt, opts, label);
  let captured = reportTool.getResult();
  // TEMPORARY — run once to identify which field actually holds the full
  // phase-1 investigation trace (not just the final turn). Remove after use.
  console.log(`[DIAGNOSTIC] ${label} result.steps: ${Array.isArray((result as any).steps) ? (result as any).steps.length : 'not array'} steps`);
  if (Array.isArray((result as any).steps)) {
    (result as any).steps.forEach((s: any, i: number) => {
      console.log(
        `[DIAGNOSTIC] ${label} step ${i}: finishReason=${s.finishReason}, ` +
        `toolCalls=${s.toolCalls?.length ?? 0}, toolResults=${s.toolResults?.length ?? 0}, ` +
        `textPreview=${JSON.stringify(s.text?.slice(0, 100))}`,
      );
    });
  }
  console.log(`[DIAGNOSTIC] ${label} result.messages count: ${(result as any).messages?.length ?? 'undefined'}`);
  console.log(`[DIAGNOSTIC] ${label} result.rememberedMessages count: ${(result as any).rememberedMessages?.length ?? 'undefined'}`);
  console.log(`[DIAGNOSTIC] ${label} result.response.messages count: ${result.response?.messages?.length ?? 'undefined'}`);
  console.log(`[DIAGNOSTIC] ${label} result.toolCalls (top-level) count: ${(result as any).toolCalls?.length ?? 'undefined'}`);
  console.log(`[DIAGNOSTIC] ${label} result.toolResults (top-level) count: ${(result as any).toolResults?.length ?? 'undefined'}`);

  // ALWAYS run the forced call if nothing was captured yet — regardless of
  // finishReason (covers both 'stop' with prose, and 'tool-calls' from
  // hitting maxSteps mid-loop without ever calling the report tool).
  if (captured === undefined) {
    console.log(`[generateWithReportTool] ${label} — running guaranteed forced report step (finishReason was: ${result.finishReason}).`);
    await generateWithRetry(
      agent,
      `${prompt}\n\nCall ${reportTool.id} now with your complete results.`,
      { ...opts, toolChoice: { type: 'tool', toolName: reportTool.id } },
      `${label} (forced)`,
    );
    captured = reportTool.getResult();
    if (captured === undefined) {
      console.warn(`[generateWithReportTool] ${label} forced call still failed to report — using fallback.`);
    }
  }

  return { value: captured ?? fallback, finishReason: result.finishReason };
}

// ── Test ─────────────────────────────────────────────────────────────────

const TestSchema = z.object({
  findings: z.array(z.object({ title: z.string(), severity: z.enum(['HIGH', 'MEDIUM', 'LOW']) })),
});

async function main() {
  console.log(`Testing model: ${MODEL}`);

  const reportTool = createReportTool(
    'report_findings',
    'Call this exactly once with your findings. Do not answer in plain text.',
    TestSchema,
  );

  const agent = new Agent({
    id: 'test-reviewer',
    name: 'test-reviewer',
    model: MODEL,
    instructions: 'You are a reviewer. When done, call report_findings — do not write plain text.',
    tools: { report_findings: reportTool.tool },
  });

  // Deliberately low maxSteps + a prompt that invites rambling, to try to
  // reproduce both failure modes: finishReason 'stop' (prose instead of
  // tool call) and finishReason 'tool-calls' (step-limit exhaustion
  // mid-loop, before the tool was ever called).
  const { value, finishReason } = await generateWithReportTool(
    agent,
    'Review this snippet for issues:\n\nfunction add(a,b){return a+b}\n\nThink out loud extensively before deciding.',
    reportTool,
    { findings: [] },
    { maxSteps: 1 },
    'test',
  );

  console.log('finishReason:', finishReason);
  console.log('captured value:', JSON.stringify(value, null, 2));
  console.log('PASS:', value.findings.length > 0 ? 'got findings' : 'FAILED — fallback returned, forced call did not work');
}

main().catch((e) => {
  console.error('Test script error:', e);
  process.exit(1);
});
