#!/bin/bash
# Backup nanoclaw credentials and database to NAS
# Safe to run any time — non-destructive, timestamped

set -euo pipefail

NANOCLAW_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="/mnt/nas-archives/nanoclaw_backups"
DATE=$(date +%Y-%m-%d)
DEST="$BACKUP_DIR/$DATE"

mkdir -p "$DEST"

# Database
if [ -f "$NANOCLAW_DIR/store/messages.db" ]; then
  cp "$NANOCLAW_DIR/store/messages.db" "$DEST/messages.db"
fi

# Environment / secrets
if [ -f "$NANOCLAW_DIR/.env" ]; then
  cp "$NANOCLAW_DIR/.env" "$DEST/.env"
fi

# All group files: CLAUDE.md, *.json, *.py, *.md
find "$NANOCLAW_DIR/groups" -maxdepth 2 \( -name "*.md" -o -name "*.MD" -o -name "*.json" -o -name "*.py" \) \
  ! -path "*/logs/*" | while read -r f; do
  group=$(basename "$(dirname "$f")")
  mkdir -p "$DEST/groups/$group"
  cp "$f" "$DEST/groups/$group/"
done

# System config
cp ~/.config/nanoclaw/mount-allowlist.json "$DEST/mount-allowlist.json" 2>/dev/null || true
cp ~/.config/systemd/user/nanoclaw.service "$DEST/nanoclaw.service" 2>/dev/null || true

# Clean up backups older than 30 days
find "$BACKUP_DIR" -maxdepth 1 -type d -name "20*" -mtime +30 -exec rm -rf {} + 2>/dev/null || true

echo "Backup complete: $DEST"
ls "$DEST"
