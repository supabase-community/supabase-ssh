#!/usr/bin/env bash
# Load test for the SSH docs server.
# Usage: ./scripts/load-test.sh [host] [max_connections]
#
# Ramps up concurrent connections, each running a heavy command.
# Watch memory in another terminal: fly logs --app supabase-ssh

HOST="${1:-localhost}"
MAX="${2:-20}"
COMMAND="grep -r 'auth' /supabase/docs"

echo "Target: $HOST | Max connections: $MAX"
echo "Command: $COMMAND"
echo ""

pids=()

for i in $(seq 1 "$MAX"); do
  ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
    "$HOST" "$COMMAND" > /dev/null 2>&1 &
  pids+=($!)
  echo "[$i/$MAX] spawned (pid $!)"
done

echo ""
echo "All $MAX connections spawned. Waiting for completion..."

failed=0
for pid in "${pids[@]}"; do
  if ! wait "$pid"; then
    ((failed++))
  fi
done

echo "Done. $failed/$MAX failed."
