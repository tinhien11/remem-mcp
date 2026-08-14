#!/bin/bash
# Demo recording script for remem-mcp viewer
# Uses Chrome DevTools Protocol (CDP) for full Retina screenshots
# Requires: Chrome running with --remote-debugging-port=9222
#           Viewer running at http://localhost:7331/
#
# Usage: bash record-demo.sh
# Output: docs/screenshots/demo.gif + demo.mp4

set -e

VIEWER_URL="http://localhost:7331/"
FRAMES_DIR="$(dirname "$0")/frames"
OUT_DIR="$(dirname "$0")"
CDP_SCRIPT="/tmp/cdp-screenshot.mjs"

# CDP screenshot helper (uses Node 22+ built-in WebSocket)
cat > "$CDP_SCRIPT" << 'CDPEOF'
import { writeFileSync } from 'fs';
const outputPath = process.argv[2] || '/tmp/screenshot.png';
async function main() {
  const pagesRes = await fetch('http://127.0.0.1:9222/json');
  const pages = await pagesRes.json();
  const page = pages.find(p => p.url.includes('localhost:7331'));
  if (!page) { console.error('No viewer page found'); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id).resolve(msg); pending.delete(msg.id); }
  });
  function send(method, params = {}) {
    const id = ++msgId;
    return new Promise((resolve) => { pending.set(id, { resolve }); ws.send(JSON.stringify({ id, method, params })); });
  }
  await new Promise((resolve) => { ws.addEventListener('open', resolve); });
  const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const buffer = Buffer.from(result.result.data, 'base64');
  writeFileSync(outputPath, buffer);
  console.log(`Saved: ${outputPath} (${buffer.length} bytes)`);
  ws.close();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
CDPEOF

# Clean frames
mkdir -p "$FRAMES_DIR"
rm -f "$FRAMES_DIR"/*.png

echo "=== Recording demo frames via CDP ==="
echo "Make sure Chrome is running: bash ~/bin/start-chrome-debug.sh"
echo "Make sure viewer is running: remem-mcp viewer"
echo ""

# Set viewport to 1512x982 @ 2x DPR (3024x1964 full Retina)
# This must be done via chrome-devtools MCP or CDP directly
# For now, assume viewport is already set

FRAMES=(
  "01-memory.png"
  "02-codegraph.png"
  "03-codegraph-search.png"
  "04-symbol-detail.png"
  "05-impact-analysis.png"
  "06-wiki.png"
  "07-wiki-search.png"
)

echo "Capturing ${#FRAMES[@]} frames at 3024x1964 (2x Retina)..."
echo "Drive the viewer manually via chrome-devtools MCP, then run this script"
echo "to capture each frame:"
echo ""
for frame in "${FRAMES[@]}"; do
  echo "  node $CDP_SCRIPT $FRAMES_DIR/$frame"
done

echo ""
echo "=== Assembling GIF + MP4 ==="

# Create concat file with absolute paths
CONCAT_FILE="/tmp/concat-frames.txt"
> "$CONCAT_FILE"
for frame in "${FRAMES[@]}"; do
  echo "file '$FRAMES_DIR/$frame'" >> "$CONCAT_FILE"
  echo "duration 3" >> "$CONCAT_FILE"
done
# Last frame needs to be repeated (ffmpeg concat quirk)
echo "file '$FRAMES_DIR/${FRAMES[-1]}'" >> "$CONCAT_FILE"

echo "--- MP4 (full 3024x1964) ---"
ffmpeg -y -f concat -safe 0 -i "$CONCAT_FILE" \
  -fps_mode vfr -pix_fmt yuv420p -c:v libx264 -preset medium -crf 20 \
  "$OUT_DIR/demo.mp4" 2>&1 | tail -3

echo "--- GIF (1512x982, optimized palette) ---"
ffmpeg -y -f concat -safe 0 -i "$CONCAT_FILE" \
  -vf "scale=1512:982:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" \
  -loop 0 \
  "$OUT_DIR/demo.gif" 2>&1 | tail -3

echo ""
echo "=== Done ==="
ls -lh "$OUT_DIR/demo.gif" "$OUT_DIR/demo.mp4"
