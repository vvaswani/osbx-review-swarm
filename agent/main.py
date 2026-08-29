"""Code review swarm service.

POST /review takes {repository, pr_number[, debug]} and runs a five-agent
Strands GraphBuilder pipeline:

    distributor → [security_review || performance_review || code_quality_review]
                                ↓ (conditional edges — AND)
                          refute_findings
                                ↓
                           develop_fix

Each reviewer/developer creates its own sandbox via a dedicated MCPClient,
runs linters/tests, and returns structured findings. The service layer
(everything below) handles all GitHub API work: minimizing old bot comments
(via GraphQL), posting PR comments, and opening a sub-PR with the fix branch.

Run:  python agent/main.py

Prereqs (assumed running):
-  OPENSANDBOX_INSECURE_SERVER=YES opensandbox-server   (localhost:8080)
-  opensandbox-mcp --domain localhost:8080 --protocol http --transport streamable-http
  (listens on localhost:8000/mcp)
"""

import base64
import logging
import os
import textwrap
import traceback
import uuid
from datetime import datetime, timezone

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from github import Auth, Github
from strands import Agent
from strands.models import LiteLLMModel
from strands.multiagent import GraphBuilder
from strands.tools.mcp import MCPClient

import requests as _r  # for GitHub REST/GraphQL calls in the service layer

from models import Changeset, RefutedFindings, ReviewFindings
from prompts import (
    DEVELOPER_INSTRUCTION,
    PERFORMANCE_INSTRUCTION,
    QUALITY_INSTRUCTION,
    REFUTER_INSTRUCTION,
    SECURITY_INSTRUCTION,
)

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

# ── Configuration ───────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler()],
)
logger = logging.getLogger(__name__)

host = os.getenv("HOST", "0.0.0.0")
port = int(os.getenv("PORT", "8081"))

MODEL = LiteLLMModel(
    model_id=os.getenv("OPENROUTER_MODEL", "openrouter/deepseek/deepseek-chat-v3.1:free"),
    api_key=os.getenv("OPENROUTER_API_KEY"),
)

MCP_URL = os.getenv("OPENSANDBOX_MCP_URL", "http://localhost:8000/mcp")
SANDBOX_IMAGE = os.getenv("OPENSANDBOX_IMAGE", "review-swarm-sandbox:latest")

GH_MARKER = "<!-- REVIEW_SWARM_COMMENT -->"
BOT_NAME = "review-swarm[bot]"

GH_TOKEN = os.getenv("GITHUB_TOKEN")
GH_GRAPHQL_URL = "https://api.github.com/graphql"
GH_API_BASE = "https://api.github.com"

app = FastAPI()


# ── GitHub helpers (service-layer only — never inside an agent) ────────────

def _github() -> Github:
    if not GH_TOKEN:
        raise RuntimeError("GITHUB_TOKEN env var is required")
    return Github(auth=Auth.Token(GH_TOKEN))


def get_pr_context(repository: str, pr_number: int) -> dict:
    """Fetch PR metadata and the full diff for the task string."""
    g = _github()
    repo = g.get_repo(repository)
    pr = repo.get_pull(pr_number)

    # Fetch the PR diff via the REST API (returns raw text)
    headers = {"Accept": "application/vnd.github.v3.diff", "Authorization": f"token {GH_TOKEN}"}
    resp = _r.get(
        f"{GH_API_BASE}/repos/{repository}/pulls/{pr_number}",
        headers=headers,
    )
    diff = resp.text if resp.status_code == 200 else ""

    files = [f.path for f in pr.get_files() if f.filename.endswith(".py") or f.filename.endswith(".js") or f.filename.endswith(".ts")]

    return {
        "title": pr.title,
        "body": pr.body or "",
        "head_ref": pr.head.ref,
        "base_ref": pr.base.ref,
        "diff": diff,
        "changed_files": files,
        "pr": pr,
        "repo": repo,
    }


def minimize_old_comments(repository: str, pr_number: int):
    """Find previous bot comments on the PR and minimize them as OUTDATED via GraphQL."""
    g = _github()
    pr = g.get_repo(repository).get_pull(pr_number)

    for comment in pr.get_issue_comments():
        if GH_MARKER not in comment.body:
            continue
        logger.info(f"Minimizing old comment id={comment.id}")
        _graphql_minimize_comment(str(comment.id))


def _graphql_minimize_comment(comment_id: str):
    """Use GitHub GraphQL to minimize a comment as OUTDATED."""
    query = """
    mutation($input: MinimizeCommentInput!) {
      minimizeComment(input: $input) {
        clientMutationId
        minimizedComment { id }
      }
    }
    """
    variables = {
        "input": {
            "subjectId": comment_id,
            "classifier": "OUTDATED",
            "clientMutationId": str(uuid.uuid4()),
        }
    }
    headers = {
        "Authorization": f"bearer {GH_TOKEN}",
        "Accept": "application/vnd.github+json",
    }
    resp = _r.post(GH_GRAPHQL_URL, json={"query": query, "variables": variables}, headers=headers)
    if resp.status_code != 200:
        logger.warning(f"GraphQL minimize failed: {resp.status_code} {resp.text}")


def post_pr_comment(repository: str, pr_number: int, body: str) -> str:
    """Post a comment on a PR and return its URL."""
    g = _github()
    pr = g.get_repo(repository).get_pull(pr_number)
    comment = pr.create_issue_comment(f"{GH_MARKER}\n{body}")
    logger.info(f"Posted comment: {comment.html_url}")
    return comment.html_url


def create_fix_branch_and_pr(repository: str, pr_head_ref: str, changeset: Changeset, pr_number: int) -> str:
    """Create a fix branch with the developer's diff and open a sub-PR.

    Uses the GitHub API directly (NOT inside an agent). The diff from the
    developer agent is parsed into per-file content and committed via the
    GitHub Contents API.
    """
    g = _github()
    repo = g.get_repo(repository)

    fix_branch = f"fix/review-swarm-{uuid.uuid4().hex[:8]}"
    api_url = f"{GH_API_BASE}/repos/{repository}/git"
    headers = {"Authorization": f"token {GH_TOKEN}", "Accept": "application/vnd.github+json"}

    # Resolve the PR head commit SHA via the branch ref
    branch_resp = _r.get(
        f"{GH_API_BASE}/repos/{repository}/branches/{pr_head_ref}",
        headers=headers,
    )
    if branch_resp.status_code != 200:
        raise RuntimeError(f"Could not get base branch ref: {branch_resp.text}")
    base_sha = branch_resp.json()["commit"]["sha"]

    # Create the fix branch from the PR head
    br_resp = _r.post(
        f"{api_url}/refs",
        json={"ref": f"refs/heads/{fix_branch}", "sha": base_sha},
        headers=headers,
    )
    if br_resp.status_code != 201:
        raise RuntimeError(f"Could not create branch {fix_branch}: {br_resp.text}")

    # Parse the diff to extract per-file new content, then commit each file
    # via the GitHub Contents API
    diff_lines = changeset.diff.splitlines()
    current_file = None
    current_content = []
    file_contents = {}  # path -> list of lines

    i = 0
    while i < len(diff_lines):
        line = diff_lines[i]
        if line.startswith("diff --git "):
            # Save previous file
            if current_file and current_content:
                file_contents[current_file] = current_content

            # Parse new file header (+++ b/path)
            i += 1
            if i < len(diff_lines) and diff_lines[i].startswith("+++"):
                current_file = diff_lines[i].split("+++ b/")[-1].strip()
            i += 1
            current_content = []
        elif line.startswith("+ ") or line.startswith("+++") or line == "":
            current_content.append(line[2:] if line.startswith("+ ") else (line[1:] if line.startswith("+") else line))
            i += 1
        else:
            i += 1
    if current_file and current_content:
        file_contents[current_file] = current_content

    for file_path, lines in file_contents.items():
        content = "\n".join(lines)
        # Get the current file SHA on the base branch
        sha_resp = _r.get(
            f"{GH_API_BASE}/repos/{repository}/contents/{file_path}?ref={fix_branch}",
            headers=headers,
        )
        if sha_resp.status_code == 200:
            file_sha = sha_resp.json()["sha"]
            message = "Update from review swarm"
        else:
            file_sha = None
            message = "Add from review swarm"

        put_resp = _r.put(
            f"{GH_API_BASE}/repos/{repository}/contents/{file_path}",
            json={
                "message": message,
                "content": _r_base64(content),
                "sha": file_sha,
                "branch": fix_branch,
            },
            headers=headers,
        )
        if put_resp.status_code not in (200, 201):
            logger.warning(f"Could not update {file_path}: {put_resp.text}")

    # Open the sub-PR
    fix_pr = repo.create_pull(
        title=f"fix: {changeset.summary[:80]}",
        body=f"""Automated fix generated by review swarm for PR #{pr_number}.

## Summary
{changeset.summary}

## Changes
{changeset.diff}""",
        head=fix_branch,
        base=pr_head_ref,
    )
    logger.info(f"Fix PR created: {fix_pr.html_url}")
    return fix_pr.html_url


def _r_base64(content: str) -> str:
    return base64.b64encode(content.encode()).decode()


def cleanup_remaining_sandboxes():
    """Safety-net: destroy any sandboxes that agents failed to clean up."""
    try:
        resp = _r.get(
            f"http://localhost:8080/sandboxes",
            headers={"Authorization": f"Bearer {os.getenv('OPENSANDBOX_API_KEY', '')}"} if os.getenv("OPENSANDBOX_API_KEY") else {},
        )
        if resp.status_code == 200:
            sandboxes = resp.json().get("sandboxes", [])
            for sb in sandboxes:
                lid = sb.get("id")
                if lid:
                    logger.info(f"Cleaning up leftover sandbox {lid}")
                    _r.delete(
                        f"http://localhost:8080/sandboxes/{lid}",
                        headers={"Authorization": f"Bearer {os.getenv('OPENSANDBOX_API_KEY', '')}"} if os.getenv("OPENSANDBOX_API_KEY") else {},
                    )
    except Exception as e:
        logger.warning(f"Sandbox cleanup (best-effort) failed: {e}")


# ── Formatting helpers for PR comments ──────────────────────────────────────

def _format_findings(findings: ReviewFindings, emoji: str, title: str) -> str:
    """Format a ReviewFindings model into a markdown PR comment."""
    lines = [
        f"### {emoji} {title}",
        "",
        f"**Reviewer:** {findings.reviewer}  ",
        f"**Confidence:** {findings.confidence}  ",
        "",
        f"**Summary:** {findings.summary}",
        "",
    ]

    if not findings.findings:
        lines.append("*No findings.*")
    else:
        # Group by severity (high → medium → low)
        for sev in ("high", "medium", "low"):
            items = [f for f in findings.findings if f.severity.value == sev]
            if not items:
                continue
            sev_title = sev.upper()
            lines.append(f"#### {sev_title}")
            lines.append("")
            for f in items:
                loc = f" — `{f.file_path}:{f.line_number}`" if f.file_path else ""
                lines.append(f"- **{f.title}**{loc}")
                lines.append(f"  {f.description}")
                if f.suggestion:
                    lines.append(f"  💡 *Suggestion:* {f.suggestion}")
                if f.code_snippet:
                    lines.append(f"  ```")
                    lines.append(f"  {f.code_snippet}")
                    lines.append(f"  ```")
                lines.append("")

    return "\n".join(lines)


def _format_refuted(refuted: RefutedFindings) -> str:
    """Format refuted findings for the PR comment."""
    lines = [
        "### 🎯 Findings Summary",
        "",
        f"**Summary:** {refuted.summary}",
        "",
    ]

    if refuted.accepted:
        lines.append("#### ✅ Accepted Findings")
        lines.append("")
        for f in refuted.accepted:
            loc = f" — `{f.file_path}:{f.line_number}`" if f.file_path else ""
            lines.append(f"- **{f.severity.value.upper()}** — {f.title}{loc}")
            lines.append(f"  {f.description}")
            if f.suggestion:
                lines.append(f"  💡 *Suggestion:* {f.suggestion}")
            lines.append("")
    else:
        lines.append("*No findings accepted.*")
        lines.append("")

    if refuted.rejected:
        lines.append("#### ❌ Rejected Findings (false positives / out of scope)")
        lines.append("")
        for f in refuted.rejected:
            loc = f" — `{f.file_path}:{f.line_number}`" if f.file_path else ""
            lines.append(f"- **{f.severity.value.upper()}** — {f.title}{loc}")
            lines.append(f"  {f.description}")
            lines.append("")

    return "\n".join(lines)


def _format_changeset(changeset: Changeset, sub_pr_url: str) -> str:
    """Format the developer's changeset for the final PR comment."""
    ts = datetime.now(timezone.utc).strftime("%d %B %Y %H:%M UTC")
    lines = [
        "### 💻 Fix Applied",
        "",
        f"**Branch:** `{changeset.branch_name}`",
        "",
        f"**Summary:** {changeset.summary}",
        "",
        "#### Changed files",
        "",
    ]
    for f in changeset.changes:
        lines.append(f"- `{f}`")
    lines.append("")
    lines.append(f"#### Sub-PR: {sub_pr_url}")
    lines.append("")
    lines.append("#### Diff")
    lines.append("```diff")
    lines.append(changeset.diff[:3000])
    if len(changeset.diff) > 3000:
        lines.append(f"\n... ({len(changeset.diff) - 3000} more chars)")
    lines.append("```")
    lines.append("")
    lines.append(f"---")
    lines.append(f"*Fix generated at {ts}*")
    return "\n".join(lines)


def _coerce_review_findings(output) -> ReviewFindings:
    """Coerce a graph node result into a ReviewFindings model."""
    if isinstance(output, ReviewFindings):
        return output
    if isinstance(output, dict):
        return ReviewFindings(**output)
    return ReviewFindings.model_validate_json(output)


def _coerce_refuted_findings(output) -> RefutedFindings:
    if isinstance(output, RefutedFindings):
        return output
    if isinstance(output, dict):
        return RefutedFindings(**output)
    return RefutedFindings.model_validate_json(output)


def _coerce_changeset(output) -> Changeset:
    if isinstance(output, Changeset):
        return output
    if isinstance(output, dict):
        return Changeset(**output)
    return Changeset.model_validate_json(output)


def _format_reviewer_comment(findings: ReviewFindings, emoji: str, title: str) -> str:
    """Alias for _format_findings for clarity in the streaming loop."""
    return _format_findings(findings, emoji, title)


# ── GraphBuilder orchestration ─────────────────────────────────────────────

# Conditional-edge predicate: refuter fires only when ALL 3 reviewers complete
_ALL_REVIEWS_DONE = frozenset(["security_review", "performance_review", "code_quality_review"])


def _all_reviews_complete(state) -> bool:
    """Predicate for the conditional edge: wait for ALL reviewers."""
    return all(
        nid in state.results and state.results[nid].status == "COMPLETED"
        for nid in _ALL_REVIEWS_DONE
    )


async def run_review_swarm(repository: str, pr_number: int, debug: bool = False):
    """Run the full code review swarm using Strands GraphBuilder.

    Creates 5 agents (distributor + 3 reviewers + refuter + developer),
    builds a Graph with fan-out → fan-in (AND) → sequential, and streams
    events to post PR comments as each node completes.
    """

    # 1. Minimize old bot comments from previous runs
    minimize_old_comments(repository, pr_number)

    # 2. Fetch PR context (diff, changed files, metadata)
    ctx = get_pr_context(repository, pr_number)
    repo_obj = ctx["repo"]
    pr_obj = ctx["pr"]

    logger.info(f"PR #{pr_number}: {pr_obj.title!r} head={ctx['head_ref']!r}")

    # 3. Build the 5 agents
    #    - Each reviewer/developer gets its own MCPClient (sandbox isolation)
    #    - Refuter gets NO MCPClient (pure filter, no sandbox needed)
    #    - Distributor is a lightweight pass-through agent

    distributor = Agent(
        name="task_distributor",
        model=MODEL,
        system_prompt=(
            "You are a task dispatcher. Your only job is to acknowledge the "
            "incoming task and pass it through to the downstream agents. "
            "Do not modify or summarize — output the task verbatim."
        ),
        callback_handler=None,
        # Suppress the default Strands callback so we rely on structured output
        # from downstream nodes, not the distributor's text output.
    )

    # Security reviewer — own MCPClient for sandbox isolation
    security = Agent(
        name="security_reviewer",
        model=MODEL,
        system_prompt=SECURITY_INSTRUCTION,
        tools=[MCPClient(url=MCP_URL)],
        structured_output_model=ReviewFindings,
        callback_handler=None,
    )

    # Performance reviewer — own MCPClient
    performance = Agent(
        name="performance_reviewer",
        model=MODEL,
        system_prompt=PERFORMANCE_INSTRUCTION,
        tools=[MCPClient(url=MCP_URL)],
        structured_output_model=ReviewFindings,
        callback_handler=None,
    )

    # Code quality reviewer — own MCPClient
    quality = Agent(
        name="code_quality_reviewer",
        model=MODEL,
        system_prompt=QUALITY_INSTRUCTION,
        tools=[MCPClient(url=MCP_URL)],
        structured_output_model=ReviewFindings,
        callback_handler=None,
    )

    # Refuter — NO MCPClient (pure filter, no sandbox needed)
    refuter = Agent(
        name="refuter",
        model=MODEL,
        system_prompt=REFUTER_INSTRUCTION,
        structured_output_model=RefutedFindings,
        callback_handler=None,
    )

    # Developer — own MCPClient for sandbox (to apply fixes)
    developer = Agent(
        name="developer",
        model=MODEL,
        system_prompt=DEVELOPER_INSTRUCTION,
        tools=[MCPClient(url=MCP_URL)],
        structured_output_model=Changeset,
        callback_handler=None,
    )

    # 4. Build the Graph
    builder = GraphBuilder()
    builder.add_node(distributor, "distribute_task")
    builder.add_node(security, "security_review")
    builder.add_node(performance, "performance_review")
    builder.add_node(quality, "code_quality_review")
    builder.add_node(refuter, "refute_findings")
    builder.add_node(developer, "develop_fix")

    builder.set_entry_point("distribute_task")

    # Fan-out: distributor → all 3 reviewers (they start in parallel)
    builder.add_edge("distribute_task", "security_review")
    builder.add_edge("distribute_task", "performance_review")
    builder.add_edge("distribute_task", "code_quality_review")

    # Fan-in with AND semantics: refuter waits for ALL 3 reviewers to complete
    builder.add_conditional_edge("security_review", "refute_findings", _all_reviews_complete)
    builder.add_conditional_edge("performance_review", "refute_findings", _all_reviews_complete)
    builder.add_conditional_edge("code_quality_review", "refute_findings", _all_reviews_complete)

    # Sequential: refuter → developer
    builder.add_edge("refute_findings", "develop_fix")

    builder.set_execution_timeout(1800)  # 30 min total
    graph = builder.build()

    # 5. Build the task string with full context
    changed_files = "\n".join(f"- `{f}`" for f in ctx["changed_files"][:20]) or "*No files changed*"
    diff_preview = ctx["diff"][:6000] if ctx["diff"] else "*No diff available*"

    task = textwrap.dedent(f"""\
    PR REVIEW SWARM TASK
    ====================

    Repository: {repository}
    PR #{pr_number}: {ctx['title']}
    Head branch: {ctx['head_ref']}
    Base branch: {ctx['base_ref']}

    PR description:
    {ctx['body'][:1000] if ctx['body'] else '(no description)'}

    Changed files:
    {changed_files}

    PR diff:
    ```diff
    {diff_preview}
    ```

    INSTRUCTIONS FOR EACH AGENT:

    - Security reviewer: Create a sandbox, clone the repo, check out the PR head,
      run security linters (bandit for Python), review the diff and changed files
      for vulnerabilities. Return structured findings by severity.
    - Performance reviewer: Create a sandbox, clone the repo, check out the PR head,
      review for performance issues (N+1, blocking I/O, memory, etc.). Return findings.
    - Code quality reviewer: Create a sandbox, clone the repo, check out the PR head,
      run linters (ruff, flake8), review for code smells and quality issues.
    - Refuter: Analyze all 3 sets of findings. Filter false positives and out-of-scope
      issues. Return accepted + rejected findings. NO sandbox needed.
    - Developer: Create a sandbox, clone the repo, check out the PR head, implement
      fixes for accepted findings, run tests/linters, generate a diff. Return a Changeset.
    """)

    # 6. Run the graph with event streaming — post comments as nodes complete
    async for event in graph.stream_async(task):
        event_type = event.get("type", "")
        node_id = event.get("node_id", "")

        if debug:
            logger.info(f"Graph event: {event_type} node={node_id}")

        if event_type == "node_completed" and node_id in ("security_review", "performance_review", "code_quality_review", "refute_findings", "develop_fix"):
            result = event.get("node_result")
            if result is None:
                logger.warning(f"Node {node_id} completed but no result")
                continue

            output = result.result if hasattr(result, "result") else result

            try:
                if node_id == "security_review":
                    review = _coerce_review_findings(output)
                    body = _format_reviewer_comment(review, "🔒", "Security Review")
                    post_pr_comment(repository, pr_number, body)

                elif node_id == "performance_review":
                    review = _coerce_review_findings(output)
                    body = _format_reviewer_comment(review, "⚡", "Performance Review")
                    post_pr_comment(repository, pr_number, body)

                elif node_id == "code_quality_review":
                    review = _coerce_review_findings(output)
                    body = _format_reviewer_comment(review, "🧹", "Code Quality Review")
                    post_pr_comment(repository, pr_number, body)

                elif node_id == "refute_findings":
                    refuted = _coerce_refuted_findings(output)
                    body = _format_refuted(refuted)
                    post_pr_comment(repository, pr_number, body)

                elif node_id == "develop_fix":
                    changeset = _coerce_changeset(output)
                    sub_pr_url = create_fix_branch_and_pr(
                        repository, ctx["head_ref"], changeset, pr_number
                    )
                    body = _format_changeset(changeset, sub_pr_url)
                    post_pr_comment(repository, pr_number, body)

            except Exception as e:
                logger.error(f"Failed to post comment for {node_id}: {e}")
                post_pr_comment(
                    repository, pr_number,
                    f"### ⚠️ Agent `{node_id}` completed with an error\n\n{type(e).__name__}: {e}",
                )

    # 7. Safety-net: destroy any sandboxes agents failed to clean up
    cleanup_remaining_sandboxes()

    logger.info("Review swarm complete.")


# ── FastAPI endpoint ────────────────────────────────────────────────────────

@app.post("/review")
async def review_endpoint(request: Request):
    body = await request.json()
    logger.info(f"Received review request: {body}")

    repository = body.get("repository")
    pr_number = body.get("pr_number")
    debug = body.get("debug", False)

    if not repository:
        raise HTTPException(status_code=400, detail="repository is required")
    if "/" not in repository:
        raise HTTPException(status_code=400, detail="repository must be owner/name")
    if pr_number is None:
        raise HTTPException(status_code=400, detail="pr_number is required")
    try:
        pr_number = int(pr_number)
    except ValueError:
        raise HTTPException(status_code=400, detail="pr_number must be an integer")

    try:
        await run_review_swarm(repository, pr_number, debug=debug)
        return {
            "status": "success",
            "repository": repository,
            "pr_number": pr_number,
        }
    except Exception as error:
        traceback.print_exc()
        logger.error(f"{type(error)} - {repr(error)}")
        raise HTTPException(status_code=500, detail=str(error) or "Unknown error")


if __name__ == "__main__":
    print(f"Review swarm service listening on {host}:{port}")
    uvicorn.run(app, host=host, port=port)
