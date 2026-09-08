#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE_DIR="${CODEGRAPH_BUNDLE_DIR:-$ROOT/release/codegraph}"
LOG_DIR="${CODEGRAPH_MCP_LOG_DIR:-$ROOT/release/logs/mcp-server}"
PID_FILE="${CODEGRAPH_MCP_PID_FILE:-$LOG_DIR/mcp-server.pid}"
MODE="${MCP_MODE:-streamable-http-stateless}"
PORT="${MCP_PORT:-3001}"
DB_ROOT="${INGESTION_DB_ROOT:-$ROOT/codegraph-dbs}"
ACTION="${1:-start}"

mkdir -p "$LOG_DIR"

bundle_binary="$BUNDLE_DIR/bin/codegraph-mcp"
if [ ! -x "$bundle_binary" ] && [ ! -f "$BUNDLE_DIR/bin/codegraph-mcp.cmd" ]; then
  echo "[mcp] error: bundle not found at $BUNDLE_DIR" >&2
  exit 1
fi

is_running() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

start_server() {
  if is_running; then
    echo "[mcp] already running: $(cat "$PID_FILE")"
    echo "[mcp] logs: $LOG_DIR"
    exit 0
  fi

  nohup env \
    MCP_MODE="$MODE" \
    MCP_PORT="$PORT" \
    INGESTION_DB_ROOT="$DB_ROOT" \
    "$bundle_binary" \
    >>"$LOG_DIR/mcp-server.out.log" 2>>"$LOG_DIR/mcp-server.err.log" < /dev/null &
  echo $! >"$PID_FILE"
  echo "[mcp] started pid=$(cat "$PID_FILE")"
  echo "[mcp] logs: $LOG_DIR"
}

stop_server() {
  if ! [ -f "$PID_FILE" ]; then
    echo "[mcp] not running (pid file missing): $PID_FILE"
    exit 0
  fi

  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -z "$pid" ]; then
    rm -f "$PID_FILE"
    echo "[mcp] removed empty pid file"
    exit 0
  fi

  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      if kill -0 "$pid" 2>/dev/null; then
        sleep 1
      else
        break
      fi
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
    echo "[mcp] stopped pid=$pid"
  else
    echo "[mcp] process not found: $pid"
  fi

  rm -f "$PID_FILE"
}

status_server() {
  if is_running; then
    echo "[mcp] running: $(cat "$PID_FILE")"
    echo "[mcp] logs: $LOG_DIR"
  else
    echo "[mcp] not running"
  fi
}

case "$ACTION" in
  start) start_server ;;
  stop) stop_server ;;
  status) status_server ;;
  *)
    echo "Usage: $0 {start|stop|status}" >&2
    exit 1
    ;;
esac
