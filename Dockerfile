# HAMA — AI Support Agent Console
#
# WHY A CONTAINER
# This is a stateful Node server, not a static site: it writes JSON to `data/`,
# keeps a workspace tree per conversation on disk, spawns child processes for
# `run_shell` / `run_script`, and holds long-lived SSE connections open for the
# length of a turn. That rules out static hosts and pure serverless runtimes —
# a container on a host that gives you a real filesystem and long requests is
# the only shape that works.
#
# WHAT IT CAN DO INSIDE
# python3 and git are installed because the agent's tools shell out to them; bash
# is present so `run_shell` has a POSIX shell (the PowerShell branch is Windows
# only and is skipped). The image runs as a non-root user, so a command the model
# runs is not root by default.
FROM node:22-bookworm-slim

# python3 for run_script(.py) and the agent's data-extraction scripts, git for
# repository work, ca-certificates for HTTPS to the model providers, tini so the
# Node process is PID 1 and signals reach it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv git bash ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first: this layer is cached until the lockfile changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# The two directories the app writes to. Declared as volumes so a host with
# persistent storage (or a mount) keeps chats, providers and workspaces across
# restarts; without one they reset with the container.
RUN mkdir -p /app/data /app/workspace \
 && chown -R node:node /app
VOLUME ["/app/data", "/app/workspace"]
USER node

# Listen on every interface INSIDE the container — the host decides what is
# exposed. HAMA_TOKEN must be provided at runtime: the server refuses a
# non-loopback bind without it, because this console can run shell commands.
ENV HOST=0.0.0.0 \
    PORT=3000 \
    NODE_ENV=production \
    HAMA_DATA_DIR=/app/data \
    HAMA_WORKSPACE_DIR=/app/workspace

EXPOSE 3000

# The health route is public, so the platform can probe it through the gate.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
