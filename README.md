# Code Review Swarm

A code review swarm built with [Mastra](https://mastra.ai), [Bun](https://bun.sh), [OpenSandbox](https://github.com/ryanrjohnston/opensandbox), and OpenRouter. For a pull request, three specialized reviewers inspect the proposed changes in parallel. A validity step scores each finding, then an optional developer agent can implement accepted findings and open a fix pull request.

## Example

- PR: https://github.com/vvaswani/osbx-review-swarm/pull/1
- Reviews:
  - Security: https://github.com/vvaswani/osbx-review-swarm/pull/1#issuecomment-5896593316
  - Code quality: https://github.com/vvaswani/osbx-review-swarm/pull/1#issuecomment-5896602909
  - Performance: https://github.com/vvaswani/osbx-review-swarm/pull/1#issuecomment-5896601972
- Review analysis: https://github.com/vvaswani/osbx-review-swarm/pull/1#issuecomment-5896605049

## How the swarm works

```text
CLI input: repository + PR number
                 │
                 ├── Fetch PR metadata, diff, and changed code files
                 ├── Minimize older swarm comments (review/full runs)
                 │
                 ├── Security reviewer ───┐
                 ├── Performance reviewer ├── run concurrently
                 └── Code quality reviewer┘
                           │
                 Each reports typed findings
                 through a schema-validated tool
                           │
                 Jev scores each finding's validity
                 using OpenRouter Decisions API
                 Accept if probability is at least 75%
                           │
                 ┌─────────┴─────────┐
                 │                   │
             --review             full run
             stop here          developer fixes accepted
                                     │
                           commit + push fix branch
                           and open a sub-PR to PR head
```

Each reviewer gets its own temporary OpenSandbox container and MCP connection. The container clones the repository, checks out the pull request's head branch, installs the app dependencies, and gives the reviewer tools to inspect and run commands against that checkout. Reviewers use different instructions for security, performance, and code quality, but share the configured reviewer model.

The refuter does not use a sandbox or generate free-form scores. It sends each finding, the PR context, and the relevant diff hunk to the configured Jev Decisions model. A finding is accepted at a validity probability of `0.75` or higher.

When fixes are enabled, the developer gets a separate sandbox and works from the PR head branch. The agent reports a summary, proposed diff, branch, test results, and changed files through a schema-validated `report_fix` tool. The service commits and pushes the sandbox checkout to a fix branch and opens a sub-PR against the original PR's head branch. A fix comment is posted only after a commit was pushed and GitHub returned a sub-PR URL.

GitHub API operations are handled by the CLI service layer: retrieving PR data, minimizing marked comments, posting review comments, pushing the fix branch, and creating the sub-PR. Agent tools operate on their sandbox checkout.

## Run the agent

### Prerequisites

- Bun 1.4 or newer
- Docker, for building the sandbox image
- An OpenSandbox server and MCP server
- An OpenRouter API key and model references
- A GitHub token that can read the repository, post issue comments, push branches, and create pull requests

### 1. Build the sandbox image

```bash
docker build -t review-swarm-sandbox:latest -f sandbox/Dockerfile sandbox/
```

The image is based on `oven/bun:1.4-alpine` and includes Git, Bun/Node tooling, PostgreSQL, Go, Java, and Python tools such as Ruff, Flake8, and Bandit. The agent starts `/entrypoint.sh` in each sandbox to initialize PostgreSQL for repositories that need a database during checks.

### 2. Start OpenSandbox and its MCP server

Install the Python infrastructure packages and start the API server:

```bash
pip install opensandbox opensandbox-server opensandbox-mcp
OPENSANDBOX_INSECURE_SERVER=YES opensandbox-server --port 8080
```

In another terminal, start the MCP bridge:

```bash
OPENSANDBOX_INSECURE_SERVER=YES opensandbox-mcp \
  --domain localhost:8080 --protocol http --transport streamable-http
```

The agent uses the OpenSandbox API at `http://localhost:8080` and MCP at `http://localhost:8000/mcp` by default. These can be changed with `OPENSANDBOX_API_URL` and `OPENSANDBOX_MCP_URL`.

### 3. Configure the agent

```bash
cd agent
cp .env.example .env
bun install --frozen-lockfile
```

Set these values in `agent/.env` or the process environment:

| Variable | Required | Purpose |
|---|---:|---|
| `GITHUB_TOKEN` or `GH_TOKEN` | Yes | GitHub API access and authenticated push for the fix branch |
| `OPENROUTER_API_KEY` | Yes | OpenRouter access for review, validity scoring, and development |
| `OPENROUTER_REVIEWER_MODEL` | Yes | Model used by the three reviewers |
| `OPENROUTER_REFUTER_MODEL` | Yes | Jev Decisions model for typed validity probabilities, e.g. `typesafe/jev-1.13` |
| `OPENROUTER_DEVELOPER_MODEL` | Yes | Model used by the fix agent |
| `OPENSANDBOX_MCP_URL` | No | MCP endpoint; default `http://localhost:8000/mcp` |
| `OPENSANDBOX_API_URL` | No | OpenSandbox API endpoint; default `http://localhost:8080` |
| `OPENSANDBOX_API_KEY` or `OPEN_SANDBOX_API_KEY` | No | API key if the OpenSandbox server requires one |
| `SANDBOX_IMAGE` | No | Sandbox image; default `review-swarm-sandbox:latest` |
| `DATABASE_URL` | No | Database URL passed into the sandbox; default is local PostgreSQL credentials |

The model variables must be set. The refuter must use a Jev Decisions model, not `typesafe/jev-router`.

### 4. Run a review

```bash
bun run src/main.ts --repository "owner/name" --pr-number 123
```

The default is the full pipeline: parallel reviews, validity scoring, then development of fixes for accepted findings.

Choose a mode with flags:

```bash
# Review and score findings; skip the developer
bun run src/main.ts --repository "owner/name" --pr-number 123 --review

# Skip review; apply findings from the latest Review Analysis comment
bun run src/main.ts --repository "owner/name" --pr-number 123 --fix

# Explicitly request the full pipeline (same as omitting both flags)
bun run src/main.ts --repository "owner/name" --pr-number 123 --review --fix
```

`--fix` mode requires a prior swarm `Review Analysis` comment with an `## Accepted` section. It uses that section as the developer's input and does not minimize existing comments during that run. `--review` runs the three reviewers and the refuter, posts their comments, and skips fix development. The full and review-only modes attempt to minimize older swarm comments before starting; a failure to minimize is logged and the run continues.

Pass `--debug` to print model configuration and workflow event details:

```bash
bun run src/main.ts --repository "owner/name" --pr-number 123 --debug
```

## Findings and comments

Reviewers submit structured findings with these fields: severity (`HIGH`, `MEDIUM`, or `LOW`), title, file/line location, description, and suggestion. Mastra validates the data from the local `report_findings` tool. If an agent fails to call its report tool, the runner makes one constrained recovery call; if that also fails, it uses an empty findings list. Transient model/network failures are retried up to three times.

The CLI streams completed workflow steps and posts comments as they finish:

- A reviewer comment for each reviewer that returns findings
- A `Review Analysis` comment listing accepted and rejected findings with Jev probabilities
- A `Fix Applied` comment after a real fix sub-PR has been created

Comments include a hidden swarm marker so later review/full runs can identify and minimize earlier swarm comments. Findings are scored one at a time against the PR context and their relevant changed-file diff hunk.

## Sandbox behavior

For each reviewer and developer task, the service:

1. Creates an isolated sandbox (1 CPU, 2 GiB memory, one-hour TTL by default).
2. Starts the sandbox image's background services.
3. Clones the repository and checks out the PR head branch.
4. Runs `bun install` in `app/` when preparing the checkout. If installation fails, setup logs a warning and continues.
5. Registers that sandbox with its own MCP client and gives the agent the sandbox's file/command tools.
6. Disconnects and kills the sandbox when the agent finishes. A final cleanup handler also kills remaining sandboxes on errors and shutdown signals.

The clone is public-URL based (`https://github.com/<owner>/<repo>.git`); private repositories need a clone setup that supplies credentials. The GitHub token is used for GitHub API calls and the fix push, but is not currently injected into the clone URL.

The reviewer prompts describe code inspection and checks, but the runner itself only guarantees dependency installation; it does not automatically invoke a fixed lint or test command. The agents choose which available inspection and command tools to use. `sandbox/Dockerfile` provides several language tools, while project-specific checks still depend on the repository and the agent's work.

## Repository layout

```text
osbx-review-swarm/
├── agent/
│   ├── src/main.ts       # CLI, workflow, sandbox lifecycle, GitHub service layer
│   ├── src/prompts.ts    # Reviewer and developer instructions
│   └── .env.example      # Agent configuration template
├── app/                  # Example Fastify books API repository content
├── sandbox/
│   ├── Dockerfile        # Runtime and analysis tools for agent sandboxes
│   └── entrypoint.sh     # Initializes PostgreSQL in each sandbox
└── README.md
```

## Technology stack

| Area | Technology |
|---|---|
| Workflow and agents | [Mastra](https://mastra.ai) |
| Runtime | [Bun](https://bun.sh) |
| Sandbox lifecycle | [OpenSandbox](https://github.com/opensandbox-group/OpenSandbox) JavaScript SDK |
| Sandbox tools | OpenSandbox MCP server |
| GitHub operations | Octokit REST API and GitHub GraphQL API |
| Review/development models | OpenRouter |
| Finding validity | Jev Decisions API with typed Noul probabilities |
