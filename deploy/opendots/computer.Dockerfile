# Each Dot's computer: the pinned OpenBot image plus the founder's coding CLIs.
# Built by deploy/opendots/install.sh; the supervisor runs it via compose.turicks.yml.
FROM opendots-computer:b6932d3

ARG CLAUDE_CODE_VERSION=2.1.287
# Test services (team-services): Postgres 16 with pgvector and Redis are installed but never started, and no default
# cluster is created. policy-rc.d (exit 101) stops the package scripts starting them; it is removed again afterwards.
RUN printf '%s\n' '#!/bin/sh' 'exit 101' > /usr/sbin/policy-rc.d && chmod +x /usr/sbin/policy-rc.d \
  && mkdir -p /etc/postgresql-common && echo 'create_main_cluster = false' > /etc/postgresql-common/createcluster.conf \
  && apt-get update && apt-get install -y --no-install-recommends git openssh-client tmux jq postgresql-16 postgresql-16-pgvector redis-server \
  && rm /usr/sbin/policy-rc.d \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && rm -rf /root/.npm /tmp/* /var/lib/apt/lists/*

# agy has no public package; install.sh copies the VPS's working binary into the build context.
COPY agy /usr/local/bin/agy
COPY run-bg /usr/local/bin/run-bg
COPY dot-login /usr/local/bin/dot-login
COPY team-shift /usr/local/bin/team-shift
COPY chief-run /usr/local/bin/chief-run
COPY team-lib.sh /usr/local/bin/team-lib.sh
COPY team-stream /usr/local/bin/team-stream
COPY team-services /usr/local/bin/team-services
# claude's role briefs, read by team-shift and chief-run.
COPY team /usr/local/share/team

# The Dot's shell is non-interactive, so no profile file is sourced: a wrapper hands claude the
# `claude setup-token` token that seed-cli-logins.sh stores on the persistent volume.
RUN ln -s "$(readlink -f /usr/local/bin/claude)" /usr/local/bin/claude-bin && rm /usr/local/bin/claude \
  && printf '%s\n' '#!/bin/sh' \
     't=${HOME:-/workspace}/.claude-token' \
     '[ -z "$CLAUDE_CODE_OAUTH_TOKEN" ] && [ -s "$t" ] && CLAUDE_CODE_OAUTH_TOKEN=$(head -n1 "$t") && export CLAUDE_CODE_OAUTH_TOKEN' \
     'export IS_SANDBOX=1' 'exec /usr/local/bin/claude-bin "$@"' > /usr/local/bin/claude \
  && chmod 755 /usr/local/bin/claude

# /workspace is the only volume that survives a computer restart, so CLI logins
# (~/.claude, ~/.gemini, gh, git config) live under it. The computer service also runs every shell
# command with HOME=/workspace (OpenBot shell.ts), so this must match.
ENV HOME=/workspace
# The container is the sandbox; Claude Code refuses skip-permissions as root without this.
ENV IS_SANDBOX=1
