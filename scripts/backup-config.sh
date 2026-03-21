#!/bin/bash
# Backup nanoclaw credentials and database to NAS
# Safe to run any time — non-destructive, timestamped

set -euo pipefail

NANOCLAW_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="/mnt/nas-archives/nanoclaw_backups"

# Inside containers, nas-archives isn't mounted — fall back to the container's NAS path
if [ ! -d "/mnt/nas-archives" ]; then
  if [ -d "/workspace/extra/nas" ]; then
    BACKUP_DIR="/workspace/extra/nas/backups/nanoclaw_backups"
  elif [ -d "/mnt/nas" ]; then
    BACKUP_DIR="/mnt/nas/backups/nanoclaw_backups"
  fi
fi
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

# All group files: *.md, *.json, *.py (including conversations/, excluding logs/)
find "$NANOCLAW_DIR/groups" \( -name "*.md" -o -name "*.MD" -o -name "*.json" -o -name "*.py" \) \
  ! -path "*/logs/*" | while read -r f; do
  rel="${f#$NANOCLAW_DIR/groups/}"
  mkdir -p "$DEST/groups/$(dirname "$rel")"
  cp "$f" "$DEST/groups/$rel"
done

# System config
cp ~/.config/nanoclaw/mount-allowlist.json "$DEST/mount-allowlist.json" 2>/dev/null || true
cp ~/.config/systemd/user/nanoclaw.service "$DEST/nanoclaw.service" 2>/dev/null || true

# Clean up backups older than 30 days
find "$BACKUP_DIR" -maxdepth 1 -type d -name "20*" -mtime +30 -exec rm -rf {} + 2>/dev/null || true

echo "Backup complete: $DEST"
ls "$DEST"
