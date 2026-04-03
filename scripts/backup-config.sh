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

# All group files: *.md, *.json, *.py (including conversations/, excluding logs/)
find "$NANOCLAW_DIR/groups" \( -name "*.md" -o -name "*.MD" -o -name "*.json" -o -name "*.py" \) \
  ! -path "*/logs/*" | while read -r f; do
  rel="${f#$NANOCLAW_DIR/groups/}"
  mkdir -p "$DEST/groups/$(dirname "$rel")"
  cp "$f" "$DEST/groups/$rel"
done

# Source files (host orchestrator, agent runner, setup scripts)
for dir in src container setup; do
  if [ -d "$NANOCLAW_DIR/$dir" ]; then
    find "$NANOCLAW_DIR/$dir" \( -name "*.ts" -o -name "*.js" -o -name "*.sh" -o -name "*.py" -o -name "Dockerfile*" \) \
      ! -path "*/node_modules/*" | while read -r f; do
      rel="${f#$NANOCLAW_DIR/}"
      mkdir -p "$DEST/$(dirname "$rel")"
      cp "$f" "$DEST/$rel"
    done
  fi
done

# System config
cp ~/.config/nanoclaw/mount-allowlist.json "$DEST/mount-allowlist.json" 2>/dev/null || true
cp ~/.config/systemd/user/nanoclaw.service "$DEST/nanoclaw.service" 2>/dev/null || true

# Session history (.jsonl files)
if [ -d "$NANOCLAW_DIR/data/sessions" ]; then
  find "$NANOCLAW_DIR/data/sessions" -name "*.jsonl" | while read -r f; do
    rel="${f#$NANOCLAW_DIR/}"
    mkdir -p "$DEST/$(dirname "$rel")"
    cp "$f" "$DEST/$rel"
  done
fi

# Clean up daily backups older than 30 days
find "$BACKUP_DIR" -maxdepth 1 -type d -name "20*" -mtime +30 -exec rm -rf {} + 2>/dev/null || true

# Monthly snapshot: keep the 1st successful backup of each month for 24 months
MONTH=$(date +%Y-%m)
MONTHLY_DIR="$BACKUP_DIR/monthly"
mkdir -p "$MONTHLY_DIR"
if [ ! -d "$MONTHLY_DIR/$MONTH" ]; then
  cp -r "$DEST" "$MONTHLY_DIR/$MONTH"
  echo "Monthly snapshot saved: $MONTHLY_DIR/$MONTH"
fi

# Clean up monthly snapshots older than 24 months
find "$MONTHLY_DIR" -maxdepth 1 -type d -name "20*" | sort | head -n -24 | xargs -r rm -rf

echo "Backup complete: $DEST"
ls "$DEST"

# Write status file so the agent can monitor without NAS access
STATUS_FILE="$NANOCLAW_DIR/groups/discord_main/backup_status.json"
FILE_COUNT=$(ls "$DEST" | wc -l | tr -d ' ')
cat > "$STATUS_FILE" <<JSON
{"status":"success","date":"$DATE","dest":"$DEST","files":$FILE_COUNT,"timestamp":"$(date -Iseconds)"}
JSON
