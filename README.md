# Self-Healing CI

A self-healing CI system built on [OpenSandbox](https://github.com/ryanrjohnston/opensandbox) and [MCP](https://modelcontextprotocol.io/). When the agent is invoked on a pull request, it creates an ephemeral sandbox, diagnoses the failures, fixes the source code, and opens a fix branch + PR comment, all automatically.

## Example

- Deliberately broken PR: https://github.com/vvaswani/osbx-self-healing-ci/pull/6
- Agent diagnosis: https://github.com/vvaswani/osbx-self-healing-ci/pull/6#issuecomment-5431021036
- Agent fix: https://github.com/vvaswani/osbx-self-healing-ci/pull/7

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     GitHub PR                               │
│         (tests fail → webhook)                              │
└───────────────┬─────────────────────────────────────────────┘
                │ POST /fix
                ▼
┌─────────────────────────────────────────────────────────────┐
│  Agent Service (agent/main.py, port 8081)                   │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ FastAPI  │  │ Google ADK   │  │ OpenSandbox MCP      │   │
│  │  /fix    │  │  agent       │  │  Toolset (@8000)     │   │
│  │ endpoint │  │  (LLM via    │  │  connects to         │   │
│  │          │  │  OpenRouter) │  │  opensandbox-server  │   │
│  └──────────┘  └──────┬───────┘  └──────────────────────┘   │
│                        │                                    │
│                        ▼                                    │
│  1. Create sandbox (fixer-agent-sandbox image)              │
│  2. Run entrypoint (starts PostgreSQL)                      │
│  3. Clone PR repo + checkout PR head                        │
│  4. Run pytest baseline                                     │
│  5. Agent loop: fix → pytest → verify (up to 5 iters)       │
│  6. Push fix branch + post PR comment                       │
└─────────────────────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────────────┐
│  Sandbox (Docker container @localhost:8080)                 │
│  ┌──────────────────────────────────────────────────┐       │
│  │ fixer-agent-sandbox:latest                       │       │
│  │  - Python 3.11-slim base                         │       │
│  │  - PostgreSQL (started via entrypoint.sh)        │       │
│  │  - git, curl, libpq-dev                          │       │
│  └──────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────┘
```

## Monorepo structure

```
osbx-self-healing-ci/
├── app/                    # FastAPI application (the code under test)
│   ├── Dockerfile          # Container image for the app
│   ├── docker-compose.yml  # Local dev: app + PostgreSQL
│   ├── .env                # App env (DB credentials)
│   ├── main.py             # FastAPI app factory (create_app)
│   ├── routers.py          # API routes
│   ├── models.py           # SQLAlchemy models
│   ├── repositories.py     # Data access layer
│   ├── dependencies.py     # DB dependency injection
│   ├── conftest.py         # pytest fixtures (sys.path fix for imports)
│   ├── pytest.ini          # pytest config (pythonpath=.)
│   ├── test_main.py        # Unit tests
│   └── db.sql              # Schema initialization
│
├── agent/                  # Self-healing agent service
│   ├── .env                # Agent env (API keys, sandbox config)
│   ├── .env.example        # Template for .env
│   ├── requirements.txt    # google-adk[mcp], litellm, opensandbox, etc.
│   ├── main.py             # FastAPI service with /fix endpoint
│   └── prompts.py          # AGENT_INSTRUCTION + DEBUG_MESSAGE
│
├── sandbox/                # Docker image for agent's execution sandbox
│   ├── Dockerfile          # python:3.11-slim + PostgreSQL
│   └── entrypoint.sh       # Starts PostgreSQL on container start
│
├── .gitignore
└── README.md
```

## Prerequisites

- Docker (with buildx for multi-platform)
- Python 3.11+
- OpenRouter API key
- GitHub token with `repo` scope (read + push to fix branches)

## Local setup

### 1. Build the sandbox image

```bash
cd sandbox
docker build -t fixer-agent-sandbox:latest .
```

### 2. Start the OpenSandbox server

The agent needs an OpenSandbox server running on `localhost:8080`. Use `OPENSANDBOX_INSECURE_SERVER=YES` to skip API key authentication (recommended for local development):

```bash
OPENSANDBOX_INSECURE_SERVER=YES opensandbox-server
```

### 3. Start the OpenSandbox MCP server

The OpenSandbox MCP server bridges the agent's tools (file read/write, command execution) to the OpenSandbox server. With `OPENSANDBOX_INSECURE_SERVER=YES` on the server, no `--api-key` is needed here either:

```bash
OPENSANDBOX_INSECURE_SERVER=YES opensandbox-mcp \
  --domain localhost:8080 \
  --protocol http \
  --transport streamable-http
```

### 4. Install agent dependencies and run the agent service

```bash
cd agent
cp .env.example .env        # edit with your real API keys
pip install -r requirements.txt
python main.py              # starts FastAPI on port 8081
```

The service will log `Session ready` on startup. When you POST to `/fix`, it will:
1. Create a sandbox from `fixer-agent-sandbox:latest`
2. Run `/entrypoint.sh` to start PostgreSQL inside the sandbox
3. Clone the PR's repository and checkout the PR head
4. Run pytest to capture the baseline failures
5. Run the Google ADK agent (up to 5 iterations) to fix the code
6. Push the changes to a new `fix/pr-{pr_number}-{hash}` branch
7. Post a structured comment on the PR describing the fix

### 5. Run the self-healing agent on a PR branch.

`POST /fix`

**Request body:**
| Field           | Type     | Required | Default | Description                                      |
|-----------------|----------|----------|---------|--------------------------------------------------|
| `repository`     | string   | yes      | —       | `"owner/repo"`                                   |
| `pr_number`      | integer  | yes      | —       | GitHub PR number                                 |
| `pytest_output`  | string   | no       | `""`    | Caller-supplied failing test log (CI paste)      |
| `open_pr`        | boolean  | no       | `true`  | Whether to open/fix the PR                       |
| `debug`          | boolean  | no       | `false` | Stream agent thinking as `[think]` log lines     |

A sample request:

```bash
curl -sf -X POST localhost:8081/fix \
  -H 'Content-Type: application/json' \
  -d '{
    "repository": "myorg/myrepo",
    "pr_number": 12,
    "debug": true
  }'
```

## GitHub CI (automated self-healing)

The workflow in `.github/workflows/ci.yml` automatically runs the self-healing agent when tests fail in a PR. It has two jobs:

```
┌─────────────────┐           ┌────────────────────┐
│  tests         │   fail   │  fix-failing-tests │
│  ───────────── │───────▶  │  ────────────────  │
│  ┌─────────┐   │           │  1. Download      │
│  │ pytest  │   │           │     test output   │
│  │ + Postgres│ │           │  2. Start         │
│  │  service  │  │           │     sandbox + MCP │
│  └─────────┘   │           │  3. Run agent     │
│  Upload failure│           │     (POST /fix)   │
│  ──────output   │           │  4. Open fix PR   │
│                 │           │  5. Comment on    │
│                 │           │     original PR  │
└─────────────────┘           └────────────────────┘
```

**Triggers**: `pull_request` → `opened` event on files matching `app/**`.

**Job 1 — `tests`**: Runs `pytest app/` with a PostgreSQL service container. If tests pass, no fixer runs. If tests fail, the output is saved as a `pytest-output` artifact.

**Job 2 — `fix-failing-tests`**: Runs only if job 1 fails (`if: failure()`). It:
1. Downloads the `pytest-output` artifact
2. Starts the OpenSandbox server + MCP server
3. Starts the fixer agent service (`python agent/main.py`)
4. Sends a `POST /fix` with the failed test output
5. Dumps all service logs (`server.log`, `mcp.log`, `service.log`) on failure for debugging

The `GITHUB_TOKEN` (auto-provided by GitHub Actions) is used for:
- **Git operations** (clone, fetch, push) inside the sandbox — embedded in HTTPS URLs
- **GHCR authentication** — pulls the `fixer-agent-sandbox` Docker image

## GitHub repository configuration

Before CI can run correctly, the following must be configured in your GitHub repository:

### Secrets

| Name | Description |
|------|-------------|
| `OPENROUTER_API_KEY` | Required. API key from [OpenRouter](https://openrouter.ai/keys) for the LLM model that fixes code. |

### Variables

| Name | Default | Description |
|------|---------|-------------|
| `OPENSANDBOX_DOMAIN` | `localhost:8080` | Sandbox server address. |
| `OPENSANDBOX_MCP_URL` | `http://localhost:8000/mcp` | MCP server URL for sandbox tools. |
| `OPENSANDBOX_IMAGE` | `ghcr.io/{owner}/fixer-agent-sandbox:latest` | Docker image for execution sandbox. |
| `OPENROUTER_MODEL` | `openrouter/deepseek/deepseek-chat-v3.1:free` | OpenRouter model identifier. |

> **Note:** If you change any of the above variables, re-run the CI workflow to pick up the new values.

### Image publishing

The sandbox Docker image is **not built during CI** — it must be pre-built and published to GHCR before the fixer job runs:

```bash
# Build and publish the sandbox image (replace <owner> with your GitHub username/org)
cd sandbox
docker build -t ghcr.io/<owner>/fixer-agent-sandbox:latest .
docker push ghcr.io/<owner>/fixer-agent-sandbox:latest
```

The `docker/login-action` in CI authenticates using `GITHUB_TOKEN` (not a PAT), which is possible when `packages: read` permission is granted and the token owner has write access to the package.

### Permissions

The workflow sets the following permissions at the job level:

```yaml
permissions:
  contents: write      # git push to create fix branches
  pull-requests: write # create fix PRs and post comments
  packages: read       # pull the sandbox image from GHCR
```

## Environment variables

### agent/.env

```bash
OPENROUTER_API_KEY=sk-or-v1-...        # Required: LLM access
GITHUB_TOKEN=ghp_...                   # Required: GitHub API access (clone/push/PR comments)
OPENROUTER_MODEL=...                   # Optional: LLM model override
OPENSANDBOX_DOMAIN=localhost:8080      # Optional: sandbox server address
OPENSANDBOX_MCP_URL=http://localhost:8000/mcp  # Optional: MCP server URL
OPENSANDBOX_INSECURE_SERVER=YES        # Use insecure mode instead of API key auth
OPENSANDBOX_IMAGE=fixer-agent-sandbox:latest  # Optional: sandbox image (local tag)
HOST=0.0.0.0                           # Optional: agent service bind
PORT=8081                              # Optional: agent service port
```

> In CI, `GITHUB_TOKEN`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OPENSANDBOX_DOMAIN`, `OPENSANDBOX_MCP_URL`, `OPENSANDBOX_IMAGE`, and `OPENSANDBOX_INSECURE_SERVER=YES` are all set as job-level env vars in the workflow — the `.env` file is only needed for local development.
