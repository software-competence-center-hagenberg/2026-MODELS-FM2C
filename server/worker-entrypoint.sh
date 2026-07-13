#!/bin/sh
# Egress lockdown for the worker container.
# Runs as the `node` user with CAP_NET_ADMIN. Allows: loopback, established
# connections, DNS, the configured Valkey, and the configured LLM provider.
# Everything else is REJECT'd so a compromised agent can't phone home.

log() {
  printf '[entrypoint] %s\n' "$*" >&2
}

# Hard requirement: iptables must exist (the Dockerfile installs it).
if ! command -v iptables >/dev/null 2>&1; then
  log "FATAL: iptables not installed; refusing to start without egress lockdown"
  exit 1
fi

# --- Default-allow baseline ---
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

# --- Valkey (Redis-compatible queue) ---
VALKEY_HOST="${VALKEY_HOSTNAME:-valkey}"
VALKEY_PORT="${VALKEY_PORT:-6379}"
VALKEY_IPS=$(getent hosts "$VALKEY_HOST" 2>/dev/null | awk '{print $1}')
if [ -n "$VALKEY_IPS" ]; then
  for IP in $VALKEY_IPS; do
    iptables -A OUTPUT -d "$IP" -p tcp --dport "$VALKEY_PORT" -j ACCEPT
    log "allow valkey $VALKEY_HOST ($IP):$VALKEY_PORT"
  done
else
  log "WARN: could not resolve $VALKEY_HOST"
fi

# --- LLM endpoint (extracted from VLLM_BASE_URL or OPENAI_BASE_URL) ---
extract_host() {
  printf '%s' "$1" | sed -E 's|^[a-zA-Z]+://||; s|/.*$||; s|:.*$||'
}
extract_port() {
  printf '%s' "$1" | sed -E 's|^[a-zA-Z]+://[^:/]+:||; s|/.*$||; s|^.*:||; s|[^0-9].*$||'
}

LLM_URL="${VLLM_BASE_URL:-}${OPENAI_BASE_URL:-}"
if [ -n "$LLM_URL" ]; then
  LLM_HOST=$(extract_host "$LLM_URL")
  LLM_PORT=$(extract_port "$LLM_URL")
  LLM_PORT="${LLM_PORT:-443}"
  LLM_IPS=$(getent hosts "$LLM_HOST" 2>/dev/null | awk '{print $1}')
  if [ -n "$LLM_IPS" ]; then
    for IP in $LLM_IPS; do
      iptables -A OUTPUT -d "$IP" -p tcp --dport "$LLM_PORT" -j ACCEPT
      log "allow llm $LLM_HOST ($IP):$LLM_PORT"
    done
  else
    log "FATAL: could not resolve LLM host: $LLM_HOST"
    exit 1
  fi
fi

# --- Default deny ---
iptables -A OUTPUT -j REJECT
if command -v ip6tables >/dev/null 2>&1; then
  ip6tables -A OUTPUT -j REJECT 2>/dev/null || true
fi

# --- Hand off to the worker ---
exec node server/worker-standalone.js
