#!/usr/bin/env bash
# Nightly backup: Postgres dump + MinIO artifact mirror, with retention.
# Cron example (02:30 daily):
#   30 2 * * * cd /opt/diplommn-v2 && ./scripts/backup.sh >> /var/log/diplommn-backup.log 2>&1
#
# Off-site copies must stay INSIDE Mongolia (domestic DR requirement) —
# sync $BACKUP_DIR to the DR site, never to foreign object storage.

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/diplommn}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
COMPOSE="docker compose -f docker-compose.prod.yml"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR/postgres" "$BACKUP_DIR/minio"

echo "[backup] $STAMP postgres dump…"
$COMPOSE exec -T postgres pg_dump -U "${POSTGRES_USER:-diplommn}" -d "${POSTGRES_DB:-diplommn}" \
  | gzip > "$BACKUP_DIR/postgres/diplommn-$STAMP.sql.gz"

echo "[backup] $STAMP minio artifacts…"
$COMPOSE exec -T minio sh -c 'tar -C /data -cf - .' \
  | gzip > "$BACKUP_DIR/minio/artifacts-$STAMP.tar.gz"

echo "[backup] pruning older than $RETENTION_DAYS days…"
find "$BACKUP_DIR" -type f -mtime +"$RETENTION_DAYS" -delete

echo "[backup] done: $(du -sh "$BACKUP_DIR" | cut -f1) total"
