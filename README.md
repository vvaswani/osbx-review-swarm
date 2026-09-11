# Code Review Swarm

A code review swarm built with [Mastra](https://mastra.ai), [Bun 1.4](https://bun.sh), [Fastify](https://fastify.dev), and [OpenSandbox](https://github.com/ryanrjohnston/opensandbox). When triggered on a pull request, it spins up ephemeral sandboxes, runs 3 concurrent AI reviewers (security, performance, code quality), reconciles findings, and files a fix PR — all automated.

## Example

- Deliberately broken PR: https://github.com/vvaswani/osbx-self-healing-ci/pull/6
- Agent diagnosis: https://github.com/vvaswani/osbx-self-healing-ci/pull/6#issuecomment-5431021036
- Agent fix: https://github.com/vvaswani/osbx-self-healing-ci/pull/7

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     GitHub PR                                │
│         (opened or synchronize)                              │
└───────────────────────┬─────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  GitHub Actions (review-swarm.yml)                          │
│  1. Checkout repo                                           │
│  2. Setup Bun 1.4                                           │
│  3. Install OpenSandbox (pip — Python infrastructure only)   │
│  4. Start OpenSandbox server + MCP server                   │
│  5. bun install (agent deps)                                │
│  6. bun run src/main.ts --repository ... --pr-number ...    │
└───────────────────────┬─────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Agent (agent/src/main.ts — CLI script)                     │
│  ┌─────────────────────────────────────────┐                │
│  │ Mastra Workflow                         │                │
│  │  .parallel([                             │                │
│  │    ┌─ security_review ─┐               │                │
│  │    ├─ performance_    │                │                │
│  │    │  review          │                │                │
│  │    └─ code_quality_   │                │                │
│  │       │  review       │                │                │
│  │  ])                                   │                │
│  │       │ (AND: all 3 must finish)        │                │
│  │  .then(refute_findings)                 │                │
│  │  .then(develop_fix)                    │                │
│  └─────────────────────────────────────────┘                │
│                                                             │
│  Each reviewer/developer creates its own MCPClient →        │
│  sandbox (ephemeral Docker container). Refuter has no       │
│  sandbox (pure analysis of findings text).                  │
│                                                             │
│  GitHub operations (minimize old comments, post PR         │
│  comments, create fix branch + sub-PR) are in the service   │
│  layer — NOT inside the agents.                             │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  Sandbox (Docker container, image: review-swarm-sandbox)     │
│  ┌─────────────────────────────────────────┐                │
│  │ oven/bun:1.4-alpine base                │                │
│  │  - git, PostgreSQL (via entrypoint.sh)  │                │
│  │  - TS linters: eslint, prettier, tsc   │                │
│  │  - Polyglot linters: ruff, bandit, go  │                │
│  └─────────────────────────────────────────┘                │
└─────────────────────────────────────────────────────────────┘
```

## Monorepo structure

```
osbx-review-swarm/
├── app/                         # Books CRUD app (the "code under test")
│   ├── Dockerfile               # Container image (oven/bun:1.4-alpine)
│   ├── docker-compose.yml       # Local dev: app + PostgreSQL
│   ├── .env                     # App env (DB credentials)
│   ├── .gitignore
│   ├── package.json             # Bun dependencies
│   ├── tsconfig.json            # TypeScript config
│   ├── db.sql                   # Schema initialization
│   └── src/
│       ├── main.ts              # Fastify app factory
│       ├── routers.ts           # API routes (CRUD)
│       ├── models.ts            # Zod schemas + Drizzle table
│       ├── db.ts                # Drizzle database connection
│       ├── repositories.ts      # Data access layer
│       └── test/
│           └── main.test.ts     # Bun test runner tests
│
├── agent/                       # Code review swarm agent (CLI script)
│   ├── .env                     # ⚠️ Contains live secrets — rotate!
│   ├── .env.example             # Template for .env
│   ├── package.json             # Bun dependencies (Mastra, Octokit, Zod)
│   ├── tsconfig.json            # TypeScript config
│   └── src/
│       ├── main.ts              # Workflow + GitHub helpers + CLI entry (single file)
│       └── prompts.ts           # System prompts for 5 agents
│
├── sandbox/                     # Docker image for agent's execution sandbox
│   ├── Dockerfile               # oven/bun:1.4-alpine + linters + PostgreSQL
│   └── entrypoint.sh            # Starts PostgreSQL on container start
│
├── .github/
│   └── workflows/
│       └── review-swarm.yml     # Trigger agent on PR events
├── .gitignore
└── README.md
```

## Prerequisites

- Docker (with buildx for multi-platform)
- Bun 1.4+ ([install guide](https://bun.sh/docs/install/bun))
- OpenRouter API key ([openrouter.ai/keys](https://openrouter.ai/keys))
- GitHub token with `repo` scope (read + push to fix branches)

## Local setup

### 1. Build the sandbox image

```bash
docker build -t review-swarm-sandbox:latest -f sandbox/Dockerfile sandbox/
```

### 2. Start the OpenSandbox server

The agent needs an OpenSandbox server running on `localhost:8080`. Use `OPENSANDBOX_INSECURE_SERVER=YES` to skip API key authentication (recommended for local development):

```bash
pip install opensandbox opensandbox-mcp
OPENSANDBOX_INSECURE_SERVER=YES opensandbox-server
```

> **Note:** OpenSandbox is Python-only infrastructure for sandbox container management. This is the only Python dependency — all agent code, app code, and the sandbox image are TypeScript/Bun.

### 3. Start the OpenSandbox MCP server

The OpenSandbox MCP server bridges the agent's tools (file read/write, command execution) to the OpenSandbox server:

```bash
OPENSANDBOX_INSECURE_SERVER=YES opensandbox-mcp \
  --domain localhost:8080 --protocol http --transport streamable-http
```

### 4. Install agent dependencies

```bash
cd agent
cp .env.example .env        # edit with your real API keys
bun install --frozen-lockfile
```

### 5. Run the code review swarm

The agent is a **CLI script** (not an HTTP service). Run it directly:

```bash
bun run src/main.ts \
  --repository "owner/name" \
  --pr-number 123
```

By default the swarm runs in **review-only mode** — it runs the three reviewers
(security, performance, code quality), reconciles findings, and posts comments,
but does **not** apply fixes.

Pass `--fix` to also run the developer step, which implements fixes for accepted
findings, commits them to a fix branch, and opens a sub-PR:

```bash
bun run src/main.ts \
  --repository "owner/name" \
  --pr-number 123 \
  --fix
```

Use `--debug` to stream agent thinking as log lines:

```bash
bun run src/main.ts \
  --repository "owner/name" \
  --pr-number 123 \
  --debug
```

**Environment variables** (set in `agent/.env` or as job-level env in CI):

| Name | Required | Description |
|------|----------|-------------|
| `GH_TOKEN` | yes | GitHub token (`repo` scope) for PR comments, fix branches |
| `OPENROUTER_API_KEY` | yes | OpenRouter API key for LLM access |
| `OPENROUTER_MODEL` | no | Model path, e.g. `deepseek/deepseek-chat-v3.1:free` (default: `deepseek/deepseek-chat`) |
| `OPENSANDBOX_MCP_URL` | no | MCP server URL (default: `http://localhost:8000/mcp`) |

### 6. Run the books app locally

```bash
cd app
bun install --frozen-lockfile
docker-compose up -d db        # Start PostgreSQL
bun run src/main.ts            # Start Fastify on port 8000
```

API endpoints:
- `POST /api/books/` — Create a book
- `GET /api/books/` — List all books
- `GET /api/books/:id` — Get a book by ID
- `PUT /api/books/:id` — Update a book
- `DELETE /api/books/:id` — Delete a book

Run tests:
```bash
bun test
```

## GitHub CI (automated code review)

The workflow in `.github/workflows/review-swarm.yml` triggers on PRs that modify `app/**`.

```
┌─────────────────┐
│  pull_request   │
│  opened/sync    │
│  on app/**      │
└────────┬────────┘
         ▼
┌──────────────────────────────┐
│  jobs.review                 │
│  ├─ Checkout repo            │
│  ├─ Setup Bun 1.4             │
│  ├─ pip install opensandbox   │
│  │  (Python infrastructure)   │
│  ├─ Start OpenSandbox         │
│  ├─ bun install (agent)       │
│  └─ bun run src/main.ts       │
│     --repository owner/repo   │
│     --pr-number N             │
└──────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────┐
│  Mastra Workflow (in the CLI script)                │
│  1. Minimize old bot comments (GraphQL)             │
│  2. Fetch PR context (Octokit REST API)             │
│  3. .parallel() — 3 reviewers (concurrent:         │
│     each creates own sandbox, runs linters/tests)   │
│  4. .then() — refute findings (no sandbox)         │
│  5. .then() — develop fix (own sandbox, git diff)  │
│                                                     │
│  As each step completes (streamed events),          │
│  the CLI posts a PR comment:                        │
│  🔒 Security  ⚡ Performance  🧹 Quality             │
│  🎯 Summary  💻 Fix Applied (with sub-PR link)      │
└─────────────────────────────────────────────────────┘
```

### GitHub repository configuration

Before CI can run correctly, configure these in your GitHub repository:

#### Secrets

| Name | Description |
|------|-------------|
| `OPENROUTER_API_KEY` | Required. API key from [OpenRouter](https://openrouter.ai/keys). |
| `GH_TOKEN` | Required. GitHub token with `repo` scope (read + push to fix branches). Name matches GitHub Secrets convention. |

#### Variables

| Name | Default | Description |
|------|---------|-------------|
| `OPENROUTER_MODEL` | `deepseek/deepseek-chat` | OpenRouter model path (without `openrouter/` prefix). |
| `OPENSANDBOX_DOMAIN` | `localhost:8080` | Sandbox server address. |
| `OPENSANDBOX_MCP_URL` | `http://localhost:8000/mcp` | MCP server URL. |

#### Permissions

The workflow sets the following permissions:

```yaml
permissions:
  contents: write      # git push to create fix branches
  pull-requests: write # create fix PRs and post comments
```

### Sandbox image

The sandbox Docker image is **not built during CI** — it must be pre-built and pushed to GHCR before the workflow runs:

```bash
# Build and publish the sandbox image (replace <owner> with your GitHub username/org)
docker build -t ghcr.io/<owner>/review-swarm-sandbox:latest -f sandbox/Dockerfile sandbox/
docker push ghcr.io/<owner>/review-swarm-sandbox:latest
```

The agent's `OPENSANDBOX_IMAGE` env var (default: `review-swarm-sandbox:latest`) tells OpenSandbox which image to use when creating sandboxes.

## How the review swarm works

1. **GitHub PR event** (opened or synchronize on `app/**`) → GitHub Actions triggers
2. **CI setup**: Checkout → Setup Bun → Install OpenSandbox → Start OpenSandbox server + MCP server → `bun install` → `bun run src/main.ts`
3. **CLI script starts** (`agent/src/main.ts`):
   a. Minimizes old bot comments via GraphQL (`minimizeComment` with `OUTDATED` classifier)
   b. Fetches PR context (title, diff, changed files) via Octokit REST API
   c. Builds a task string with PR metadata
4. **Mastra workflow starts**:
   a. **3 parallel review steps** — each creates its own `MCPClient + Agent`, creates a sandbox, clones the repo, runs linters (`tsc --no-errors`, `eslint`, `prettier --check` for TS), analyzes code, returns **markdown** findings (no Zod schemas — plain text), then destroys its sandbox
   b. When ALL 3 reviews complete, **refute step** fires — creates an agent (no MCPClient, no sandbox), analyzes findings, returns a markdown summary of accepted/rejected findings
   c. After refutation, **develop step** fires — creates its own `MCPClient + Agent`, creates a sandbox, implements fixes, generates a git diff, returns markdown with `## Summary`, `## Branch`, and `## Diff` sections
5. **Event streaming**: As each step completes, the workflow streams `step-finished` events — the CLI script posts a PR comment via Octokit (🔒 Security, ⚡ Performance, 🧹 Quality, 🎯 Findings Summary, 💻 Fix Applied)
6. **Developer step completion**: CLI script parses the developer's markdown output, creates a fix branch from the PR head, commits the diff via GitHub Contents API, and opens a sub-PR
7. **Sandbox cleanup safety net**: Any remaining sandboxes destroyed
8. Script exits with code 0

### Markdown output format

Agents return **plain markdown** — no Zod schemas for structured output. Each reviewer formats findings with severity as headings and items as numbered bullets:

```markdown
## HIGH

1. **SQL Injection Risk** — `src/db.ts:42` — Description of the issue. Fix: use parameterized queries.

## MEDIUM

1. **Connection pool not configured** — `src/db.ts:1` — Description...
```

The refuter returns:

```markdown
## Accepted

1. HIGH — SQL Injection Risk — Reasoning...

## Rejected

1. MEDIUM — Unused variable — Out of scope for this PR...
```

The developer returns:

```markdown
## Summary
Fixed SQL injection by using parameterized queries.

## Branch
fix/review-swarm-a1b2c3d4

## Diff
```diff
--- a/src/db.ts
+++ b/src/db.ts
@@ -42,7 +42,7 @@
-  const query = `SELECT * FROM users WHERE id = ${userId}`;
+  const query = 'SELECT * FROM users WHERE id = $1';
```
```
```

## Technology stack

| Layer | Technology |
|-------|-----------|
| Agent orchestration | [Mastra](https://mastra.ai) v1.63.0 |
| Agent runtime | [Bun](https://bun.sh) 1.4 |
| MCP integration | `@mastra/mcp` (MCPClient with `listTools()` / `cleanup()`) |
| GitHub API | `@octokit/rest` + raw `fetch` (GraphQL for `minimizeComment`) |
| App framework | [Fastify](https://fastify.dev) v5 |
| App ORM | [Drizzle ORM](https://orm.drizzle.team) + `pg` (node-postgres) |
| App validation | [Zod](https://zod.dev) (API request/response typing via `@fastify/type-provider-zod`) |
| App testing | Bun built-in test runner |
| LLM provider | OpenRouter (via Mastra magic string model IDs) |
| Sandbox management | OpenSandbox (pip install — Python infrastructure only) |
| Sandbox image | `oven/bun:1.4-alpine` with PostgreSQL + polyglot linters |
