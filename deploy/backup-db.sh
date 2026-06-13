#!/usr/bin/env bash
# FounderOS — nightly Postgres backup. Dumps the DB to a local dir and prunes
# backups older than 14 days. Wire via cron on the server:
#
#   crontab -e
#   0 3 * * *  /opt/founderos/deploy/backup-db.sh >> /var/log/founderos-backup.log 2>&1
#
# For off-box durability, sync BACKUP_DIR to a Hetzner Storage Box / S3 after
# the dump (rclone/restic) — a backup on the same disk does not survive disk loss.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/founderos/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/founderos-$STAMP.sql.gz"

mkdir -p "$BACKUP_DIR"

echo "==> Dumping founderos -> $OUT"
docker exec founderos-postgres pg_dump -U founderos founderos | gzip > "$OUT"

echo "==> Pruning backups older than ${RETENTION_DAYS}d"
find "$BACKUP_DIR" -name 'founderos-*.sql.gz' -mtime "+$RETENTION_DAYS" -delete

echo "==> Backup complete: $(du -h "$OUT" | cut -f1)"
