#!/bin/bash
set -e

# Resolve PostgreSQL bin directory (Alpine: /usr/bin, Debian: /usr/lib/postgresql/*/bin)
PG_BIN=$(find /usr/lib/postgresql/*/bin -maxdepth 0 -type d 2>/dev/null | sort -V | tail -1)
if [ -z "$PG_BIN" ]; then
  PG_BIN="/usr/bin"
fi
export PATH="$PG_BIN:$PATH"

# Initialize and start PostgreSQL (needed for repos with DB-dependent tests)
echo "Starting PostgreSQL..."
mkdir -p /var/run/postgresql /var/lib/postgresql/data
chown -R postgres:postgres /var/run/postgresql /var/lib/postgresql/data

if [ ! -f /var/lib/postgresql/data/PG_VERSION ]; then
  echo "Initializing PostgreSQL data directory..."
  su postgres -c "$PG_BIN/initdb -D /var/lib/postgresql/data"
fi

su postgres -c "$PG_BIN/pg_ctl start -D /var/lib/postgresql/data -l /var/lib/postgresql/data/postgresql.log -w"

echo "Waiting for PostgreSQL to accept connections..."
until su postgres -c "$PG_BIN/pg_isready -q"; do
  sleep 0.1
done
echo "PostgreSQL ready"

# Configure git for any fix-branch work
git config --global user.email "review-swarm@example.com"
git config --global user.name "Review Swarm"

echo "Sandbox ready for code review"
wait
