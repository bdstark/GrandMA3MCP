#!/bin/sh
# Copies the bridge plugin into the grandMA3 user library so it can be imported in onPC with:
#   Import Plugin Library "gma3_mcp_bridge.xml" At Plugin <free slot>
set -e
HERE="$(cd "$(dirname "$0")/.." && pwd)"
case "$(uname -s)" in
  Darwin) LIB="$HOME/MALightingTechnology/gma3_library" ;;
  *)      LIB="${GMA3_LIBRARY:-$HOME/MALightingTechnology/gma3_library}" ;;
esac
DEST="$LIB/datapools/plugins"
if [ ! -d "$LIB" ]; then
  echo "grandMA3 library folder not found at $LIB (set GMA3_LIBRARY to override)" >&2
  exit 1
fi
mkdir -p "$DEST"
cp "$HERE/plugin/gma3_mcp_bridge.lua" "$HERE/plugin/gma3_mcp_bridge.xml" "$DEST/"
echo "Installed to $DEST"
echo "In grandMA3 onPC, type in the command line:"
echo "  Import Plugin Library \"gma3_mcp_bridge.xml\" At Plugin <free slot number>"
echo 'then start it with:'
echo '  Plugin "gma3_mcp_bridge"'
