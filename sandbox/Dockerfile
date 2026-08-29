FROM python:3.11-slim

# System packages: build tools, git, language runtimes, linters + PostgreSQL
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    wget \
    ca-certificates \
    netcat-openbsd \
    jq \
    build-essential \
    gcc \
    g++ \
    make \
    cmake \
    python3-dev \
    libpq-dev \
    postgresql \
    postgresql-client \
    nodejs \
    npm \
    golang-go \
    openjdk-17-jdk \
    && rm -rf /var/lib/apt/lists/*

# Python linters + security scanners
RUN pip install --no-cache-dir ruff flake8 pylint bandit

# Node linters + formatters
RUN npm install -g eslint prettier

# Copy entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
