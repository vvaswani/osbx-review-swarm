"""Pydantic models for structured agent output.

Each stage of the review swarm returns one of these models via
Strands ``Agent(structured_output_model=...)``, ensuring the service
layer receives consistently typed findings that it can format and post
as PR comments.
"""

from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


class Severity(str, Enum):
    """Findings severity levels (no critical tier — the swarm is advisory)."""
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class Finding(BaseModel):
    """A single review finding from a reviewer agent."""
    severity: Severity
    title: str
    description: str
    file_path: str | None = None
    line_number: int | None = None
    code_snippet: str | None = None
    suggestion: str | None = Field(default=None, max_length=500)


class ReviewFindings(BaseModel):
    """Output of one of the three reviewer agents."""
    reviewer: str
    findings: list[Finding]
    summary: str
    confidence: Literal["high", "medium", "low"]


class RefutedFindings(BaseModel):
    """Output of the refuter agent — filters the 3 reviews down to actionables."""
    accepted: list[Finding]
    rejected: list[Finding]
    summary: str


class Changeset(BaseModel):
    """Output of the developer agent — proposed fix for the PR."""
    changes: list[str]       # file paths changed
    diff: str                # unified diff of changes
    summary: str             # what was fixed and why
    branch_name: str          # fix branch name
