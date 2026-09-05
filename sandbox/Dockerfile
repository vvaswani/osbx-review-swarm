FROM oven/bun:1.4-alpine

# System packages: build tools, git, polyglot runtimes + PostgreSQL
RUN apk add --no-cache \
    git curl jq bash \
    build-base \
    postgresql postgresql-contrib \
    nodejs npm \
    go \
    openjdk17 \
    python3 py3-pip

# TypeScript linters + formatters (global) — primary linters for TS app testing
RUN bun add -g eslint prettier typescript@latest

# Python linters + security scanners — for polyglot code analysis inside sandboxes
# --break-system-packages: Alpine's Python is externally managed (PEP 668);
# acceptable in this disposable container context
RUN pip3 install --no-cache-dir --break-system-packages ruff flake8 bandit

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
