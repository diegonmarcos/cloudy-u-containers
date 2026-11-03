# Antigravity (agy) web terminal image for Cloud Run: ttyd on 127.0.0.1:7681 behind oauth2-proxy on $PORT (8080).
# Runtime (region, CPU, memory, GCS volume, secrets) is declared in cloudy-t-infra c_vps/vps_gcloud/src/terraform.json cloud_run_services[agy].
# Build: .github/workflows/cloud-run-images.yml (linux/amd64). seed_git/ is empty in CI; entrypoint.sh skips the seed when absent.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TERM=xterm-256color

RUN sed -i 's/Components: main restricted/Components: main restricted universe multiverse/' /etc/apt/sources.list.d/ubuntu.sources 2>/dev/null || true

# Full Linux Dev Suite, Compilers, Tools & Shells (Fish + Zsh)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    git \
    bash \
    fish \
    zsh \
    tar \
    gzip \
    unzip \
    zip \
    procps \
    build-essential \
    make \
    cmake \
    gcc \
    g++ \
    python3 \
    python3-pip \
    python3-venv \
    tmux \
    vim \
    nano \
    neovim \
    htop \
    jq \
    ripgrep \
    tree \
    wget \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 22 LTS & Official Claude Code CLI
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g @anthropic-ai/claude-code \
    && rm -rf /var/lib/apt/lists/*

# Install ttyd web terminal
RUN (curl -fsSL https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 -o /usr/local/bin/ttyd || (apt-get update && apt-get install -y ttyd)) \
    && chmod +x /usr/local/bin/ttyd

# Injected mobile/desktop responsive UI into ttyd
RUN mkdir -p /usr/local/share/ttyd
COPY toolbar_inject.html /tmp/toolbar_inject.html
RUN ttyd -p 7699 bash & PID=$! && sleep 2 \
    && curl -fsSL http://127.0.0.1:7699/ > /tmp/base_index.html \
    && kill $PID || true \
    && sed -i '/<\/body>/e cat /tmp/toolbar_inject.html' /tmp/base_index.html \
    && mv /tmp/base_index.html /usr/local/share/ttyd/index.html

# Install oauth2-proxy
RUN curl -fsSL https://github.com/oauth2-proxy/oauth2-proxy/releases/download/v7.6.0/oauth2-proxy-v7.6.0.linux-amd64.tar.gz | tar -xz \
    && mv oauth2-proxy-v7.6.0.linux-amd64/oauth2-proxy /usr/local/bin/ \
    && rm -rf oauth2-proxy*

# Install Google Antigravity CLI
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash

ENV PATH="/usr/local/bin:/root/.local/bin:${PATH}"
RUN if [ -f /root/.local/bin/agy ]; then cp /root/.local/bin/agy /usr/local/bin/agy; fi

COPY seed_git /seed_git
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /root
EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
