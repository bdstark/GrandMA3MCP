#!/bin/sh
# Writes .mcp.json (Claude Code project-scope MCP config) with the absolute path of this checkout,
# so the file never has to contain anyone's home directory. .mcp.json is git-ignored; run this once
# per clone (and again if you move the directory).
#
#   sh scripts/mcp-config.sh                      write .mcp.json
#   sh scripts/mcp-config.sh --bridge-port 19800  also set GMA3_BRIDGE_PORT (e.g. for an SSH tunnel on another local port)
#   sh scripts/mcp-config.sh --print              print the JSON instead of writing (paste into claude_desktop_config.json)
set -e
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PORT=""
PRINT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --bridge-port) PORT="$2"; shift 2 ;;
    --print)       PRINT=1; shift ;;
    -h|--help)     sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$PORT" in
  ""|*[!0-9]*) [ -z "$PORT" ] || { echo "--bridge-port must be a number" >&2; exit 2; } ;;
esac
# Escape backslashes and double quotes for JSON (paths with either are rare on POSIX, but cheap to handle).
ENTRY="$(printf '%s' "$HERE/dist/index.js" | sed 's/\\/\\\\/g; s/"/\\"/g')"
ENV_BLOCK=""
[ -n "$PORT" ] && ENV_BLOCK=",
      \"env\": { \"GMA3_BRIDGE_PORT\": \"$PORT\" }"
JSON="{
  \"mcpServers\": {
    \"gma3\": {
      \"command\": \"node\",
      \"args\": [\"$ENTRY\"]$ENV_BLOCK
    }
  }
}"
if [ "$PRINT" = 1 ]; then
  printf '%s\n' "$JSON"
else
  printf '%s\n' "$JSON" > "$HERE/.mcp.json"
  echo "Wrote $HERE/.mcp.json"
  [ -f "$HERE/dist/index.js" ] || echo "note: dist/index.js does not exist yet; run 'npm run build'" >&2
fi
