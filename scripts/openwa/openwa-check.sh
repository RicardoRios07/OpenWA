#!/usr/bin/env bash
#
# openwa:check — salud + watchdog del OpenWA (WhatsApp).
# Corre en el VPS por cron (recomendado cada 5 min). Escribe a un log.
#
# Chequeos:
#  1. Estado de cada sesión (ready vs qr_ready/disconnected/…).
#  2. Eventos recientes de LOGOUT / "Execution context destroyed".
#  3. Versión pineada (WWEBJS_WEB_VERSION) vs currentVersion del registry.
# Watchdog:
#  - Sesión no operacional > RECONNECT_AFTER_S (300) → POST /start.
#  - Sigue caída > RESTART_AFTER_S (900)  → redeploy del contenedor vía Coolify
#    (solo si COOLIFY_API_TOKEN está seteado; es el último recurso).
#
# Uso: OPENWA_API_KEY=… COOLIFY_API_TOKEN=… scripts/openwa/check.sh
# Crontab: */5 * * * * /usr/local/bin/openwa-check.sh

set -uo pipefail

OPENWA_BASE_URL="${OPENWA_BASE_URL:-https://openwa.vendi.ec}"
OPENWA_API_KEY="${OPENWA_API_KEY:-}"
OPENWA_CONTAINER="${OPENWA_CONTAINER:-}"
OPENWA_APP_UUID="${OPENWA_APP_UUID:-n50tfqbjdl6d56vd2921c7bq}"
COOLIFY_API="${COOLIFY_API:-https://coolify-api.vendi.ec}"
COOLIFY_API_TOKEN="${COOLIFY_API_TOKEN:-}"
REGISTRY="https://raw.githubusercontent.com/wppconnect-team/wa-version/main/versions.json"

LOG_FILE="${OPENWA_HEALTH_LOG:-/var/log/vendi/openwa-health.log}"
STATE_FILE="${OPENWA_STATE_FILE:-/tmp/openwa-not-ready-since}"
SESSIONS_FILE="$(mktemp)"
RECONNECT_AFTER_S=300
RESTART_AFTER_S=900

mkdir -p "$(dirname "$LOG_FILE")"

log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG_FILE"; }

if [ -z "$OPENWA_API_KEY" ]; then
  echo "OPENWA_API_KEY required" >&2
  exit 2
fi

# Resolver el contenedor del OpenWA si no se pasó.
if [ -z "$OPENWA_CONTAINER" ]; then
  OPENWA_CONTAINER="$(docker ps --format '{{.Names}}' | grep -E '^n50tfqbjdl6d56vd2921c7bq-' | head -1)"
fi

# ── 1. Estado de sesiones ──
if ! curl -s -m 15 -H "Authorization: Bearer $OPENWA_API_KEY" \
     -H "x-api-key: $OPENWA_API_KEY" \
     "$OPENWA_BASE_URL/api/sessions" -o "$SESSIONS_FILE"; then
  log "WARN openwa api unreachable (base=$OPENWA_BASE_URL)"
  rm -f "$SESSIONS_FILE"
  exit 0
fi

NOT_READY=""
read -r SESSION_LINE < <(curl -s -m 15 -H "Authorization: Bearer $OPENWA_API_KEY" -H "x-api-key: $OPENWA_API_KEY" "$OPENWA_BASE_URL/api/sessions" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    print("PARSE_ERROR"); sys.exit(0)
for s in data:
    phone = s.get("phone") or ""
    status = (s.get("status") or "").lower()
    name = s.get("name") or ""
    if phone and status not in ("ready", "connected", "authenticated", "working"):
        print(f"{name}|{phone}|{status}")
        break
')
if [ -z "$SESSION_LINE" ]; then
  log "OK all sessions operational"
  rm -f "$STATE_FILE"
  rm -f "$SESSIONS_FILE"
  exit 0
fi

SESSION_NAME="${SESSION_LINE%%|*}"
SESSION_PHONE="$(echo "$SESSION_LINE" | cut -d'|' -f2)"
SESSION_STATUS="$(echo "$SESSION_LINE" | cut -d'|' -f3)"

# ── 2. Eventos recientes de desconexión ──
LOGOUTS=0
CTX_DESTROYED=0
if [ -n "$OPENWA_CONTAINER" ]; then
  LOGOUTS="$(docker logs "$OPENWA_CONTAINER" --since 10m 2>&1 | grep -c "Session disconnected: LOGOUT" || true)"
  CTX_DESTROYED="$(docker logs "$OPENWA_CONTAINER" --since 10m 2>&1 | grep -c "Execution context was destroyed" || true)"
fi

# ── 3. Versión pineada vs registry ──
PINNED=""
if [ -n "$OPENWA_CONTAINER" ]; then
  PINNED="$(docker inspect "$OPENWA_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^WWEBJS_WEB_VERSION=' | cut -d= -f2)"
fi
CURRENT="$(curl -s -m 10 "$REGISTRY" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("currentVersion") or "")
except Exception: print("")' 2>/dev/null)"
STALE=""
if [ -n "$PINNED" ] && [ -n "$CURRENT" ] && [ "$PINNED" != "$CURRENT" ]; then
  STALE="1"
fi

log "STATE session=$SESSION_NAME phone=$SESSION_PHONE status=$SESSION_STATUS logouts_10m=$LOGOUTS ctx_destroyed_10m=$CTX_DESTROYED pinned=$PINNED current=$CURRENT stale=${STALE:-0}"

# Registra la build como última estable cuando la sesión está operativa y sin
# logouts: es el input del auto-rollback de pin.sh (revertir builds marcadas rotas).
if [ "${LOGOUTS:-0}" -eq 0 ] && [ "${CTX_DESTROYED:-0}" -eq 0 ] \
   && [ "$SESSION_STATUS" = "connected" ] && [ -n "$PINNED" ]; then
  LAST_STABLE="${OPENWA_LAST_STABLE:-/var/lib/vendi/openwa-last-stable.txt}"
  mkdir -p "$(dirname "$LAST_STABLE")" 2>/dev/null || true
  echo "$PINNED" > "$LAST_STABLE"
fi

if [ "${CTX_DESTROYED:-0}" -gt 0 ] || [ "${LOGOUTS:-0}" -gt 3 ]; then
  # Marca la build pineada como rota: pin.sh la salta hasta que el registry publique otra.
  BAD_FILE="${OPENWA_BAD_VERSIONS:-/var/lib/vendi/openwa-bad-versions.txt}"
  mkdir -p "$(dirname "$BAD_FILE")" 2>/dev/null || true
  [ -n "$PINNED" ] && ! grep -qx "$PINNED" "$BAD_FILE" 2>/dev/null && echo "$PINNED" >> "$BAD_FILE"
  log "ALERT engine_in_loop (logouts=$LOGOUTS ctx_destroyed=$CTX_DESTROYED) — probable version de WhatsApp Web rota. Bump WWEBJS_WEB_VERSION a $CURRENT y redeploy del OpenWA."
fi

if [ -n "$STALE" ]; then
  # Si la current está marcada rota, el hold es intencional (no un bump pendiente).
  if grep -qx "$CURRENT" "${OPENWA_BAD_VERSIONS:-/var/lib/vendi/openwa-bad-versions.txt}" 2>/dev/null; then
    log "INFO version_pin_held pinned=$PINNED current=$CURRENT — current marcada rota; esperando nueva build de wppconnect."
  else
    log "WARN version_pin_stale pinned=$PINNED current=$CURRENT — considerar bump (ver runbook en AGENTS.md)."
  fi
fi

# ── Watchdog ──
NOW="$(date +%s)"
NOT_READY_SINCE=0
if [ -f "$STATE_FILE" ]; then NOT_READY_SINCE="$(cat "$STATE_FILE")"; fi
if [ "$NOT_READY_SINCE" -eq 0 ]; then
  echo "$NOW" > "$STATE_FILE"
  NOT_READY_SINCE="$NOW"
fi
DOWN_FOR=$(( NOW - NOT_READY_SINCE ))

SESSION_ID="$(curl -s -m 15 -H "Authorization: Bearer $OPENWA_API_KEY" -H "x-api-key: $OPENWA_API_KEY" "$OPENWA_BASE_URL/api/sessions" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for s in data:
    if (s.get("phone") or "") and (s.get("status") or "").lower() not in ("ready", "connected", "authenticated", "working"):
        print(s.get("id") or ""); break
')"

if [ "$DOWN_FOR" -ge "$RECONNECT_AFTER_S" ] && [ -n "$SESSION_ID" ]; then
  log "WATCHDOG reconnect session $SESSION_ID (down ${DOWN_FOR}s)"
  curl -s -m 20 -X POST -H "Authorization: Bearer $OPENWA_API_KEY" -H "x-api-key: $OPENWA_API_KEY" \
    -H "content-type: application/json" -d '{}' \
    "$OPENWA_BASE_URL/api/sessions/$SESSION_ID/start" >/dev/null 2>&1
fi

if [ "$DOWN_FOR" -ge "$RESTART_AFTER_S" ] && [ -n "$COOLIFY_API_TOKEN" ]; then
  log "WATCHDOG redeploy openwa container (down ${DOWN_FOR}s)"
  curl -s -m 30 -X POST -H "Authorization: Bearer $COOLIFY_API_TOKEN" \
    "$COOLIFY_API/api/v1/deploy?uuid=$OPENWA_APP_UUID&force=true" >/dev/null 2>&1
  rm -f "$STATE_FILE"
fi

rm -f "$SESSIONS_FILE"
