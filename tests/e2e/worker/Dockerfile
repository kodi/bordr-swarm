FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    procps \
  && rm -rf /var/lib/apt/lists/*

# Install real Herdr CLI & headless server for Linux.
RUN curl -fsSL https://herdr.dev/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

# Install real Vercel CLI and @vercel/board (`vb`) globally so both CLIs can be exercised.
RUN npm install -g --no-audit --no-fund vercel@latest @vercel/board@0.56.1

# Install hermetic fake `claude` CLI on PATH.
COPY tests/e2e/worker/fake-claude.mjs /usr/local/bin/claude
COPY tests/e2e/worker/entrypoint.sh /usr/local/bin/worker-entrypoint.sh
RUN chmod +x /usr/local/bin/claude /usr/local/bin/worker-entrypoint.sh

# Pre-install bordr-swarm runtime dependency (zod) into /workspace-deps so mounted /workspace stays Linux-clean.
WORKDIR /workspace
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

CMD ["/usr/local/bin/worker-entrypoint.sh"]
