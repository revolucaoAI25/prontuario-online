#!/usr/bin/env bash
# Restores a FastClinic SQL Server .bak file into a disposable SQL Server
# container so migrate_fastclinic.py can read it. Re-run this with a fresh
# .bak whenever a new backup is taken (e.g. the final sync before cutover) --
# it replaces the previous restore.
#
# Usage: ./restore_fastclinic_backup.sh /path/to/clinica.bak
set -euo pipefail

BAK_FILE="${1:?Usage: $0 /path/to/clinica.bak}"
BAK_DIR="$(cd "$(dirname "$BAK_FILE")" && pwd)"
BAK_NAME="$(basename "$BAK_FILE")"
SA_PASSWORD="${MSSQL_SA_PASSWORD:-Prontuario#2026!}"
CONTAINER_NAME="${MSSQL_CONTAINER_NAME:-sqlserver}"

docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

docker run -d --name "$CONTAINER_NAME" \
  -e "ACCEPT_EULA=Y" \
  -e "MSSQL_SA_PASSWORD=$SA_PASSWORD" \
  -e "MSSQL_PID=Express" \
  -p 1433:1433 \
  -v "$BAK_DIR:/backup" \
  mcr.microsoft.com/mssql/server:2019-latest

echo "Waiting for SQL Server to accept connections..."
for i in $(seq 1 30); do
  if docker exec "$CONTAINER_NAME" /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$SA_PASSWORD" -C -Q "SELECT 1" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

FILELISTONLY_OUT=$(docker exec "$CONTAINER_NAME" /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$SA_PASSWORD" -C -h -1 -W -s"|" -Q \
  "SET NOCOUNT ON; RESTORE FILELISTONLY FROM DISK = N'/backup/$BAK_NAME'")
DATA_LOGICAL=$(echo "$FILELISTONLY_OUT" | awk -F'|' '$3=="D"{print $1; exit}')
LOG_LOGICAL=$(echo "$FILELISTONLY_OUT" | awk -F'|' '$3=="L"{print $1; exit}')

echo "Data logical file: $DATA_LOGICAL / Log logical file: $LOG_LOGICAL"

docker exec "$CONTAINER_NAME" /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "$SA_PASSWORD" -C -Q "
RESTORE DATABASE clinica
FROM DISK = N'/backup/$BAK_NAME'
WITH MOVE '$DATA_LOGICAL' TO '/var/opt/mssql/data/clinica.mdf',
     MOVE '$LOG_LOGICAL' TO '/var/opt/mssql/data/clinica_log.ldf',
     REPLACE, STATS = 10;
"

echo "Restored. Connect with MSSQL_HOST=localhost MSSQL_PORT=1433 MSSQL_USER=sa MSSQL_PASSWORD='$SA_PASSWORD' MSSQL_DB=clinica"
