#!/usr/bin/env bash
#
# openwa:pin — mantiene el pin de WhatsApp Web (WWEBJS_WEB_VERSION) al día.
#
# Selección automática de la versión "correcta":
#   - El registry wppconnect-team/wa-version publica `currentVersion` (lo que WhatsApp
#     sirve AHORA) y cada versión tiene fecha `expire` (~60 días). Una versión expirada
#     ya no la sirve WhatsApp -> pinearla = LOGOUT en bucle (fue la causa raíz del
#     incidente de la cuenta de CAOS en revisión).
#   - Este script solo toca el ENV del pin en Coolify; nunca el código del servidor.
#     El servidor queda pineado en la rama `stable` y solo avanza deliberadamente
#     con promote.sh tras pasar el canary.
#
# Rate-limit: 1 bump cada 6h (el registry se mueve cada pocas horas; un redeploy por
# bump reinicia sesiones ~1 min, asumido).
#
# Uso:
#   pin.sh            # bump automático si hay versión nueva y pasó el rate-limit
#   pin.sh --force    # ignora el rate-limit
#   DRY_RUN=1 pin.sh  # solo reporta
#   MIN_INTERVAL_S=0  pin.sh  # sin rate-limit (tests)
#
# Crontab (VPS): */5 * * * * root /usr/local/bin/openwa-pin.sh >> /var/log/vendi/openwa-pin.log 2>&1

set -uo pipefail

COOLIFY_API="${COOLIFY_API:-https://coolify-api.vendi.ec}"
APP="${OPENWA_APP_UUID:-n50tfqbjdl6d56vd2921c7bq}"
REGISTRY="https://raw.githubusercontent.com/wppconnect-team/wa-version/main/versions.json"
STATE_FILE="${OPENWA_PIN_STATE:-/tmp/openwa-last-bump}"
MIN_INTERVAL_S="${MIN_INTERVAL_S:-21600}"   # 6h
LOG_FILE="${OPENWA_HEALTH_LOG:-/var/log/vendi/openwa-health.log}"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

mkdir -p "$(dirname "$LOG_FILE")"
log() { echo "$(date -u +%FT%TZ) $*" >> "$LOG_FILE"; }

# Token de Coolify: env o el cron del VPS.
COOLIFY_API_TOKEN="${COOLIFY_API_TOKEN:-}"
if [ -z "$COOLIFY_API_TOKEN" ] && [ -f /etc/cron.d/vendi-openwa ]; then
  COOLIFY_API_TOKEN="$(awk -F= '/^COOLIFY_API_TOKEN=/{print $2}' /etc/cron.d/vendi-openwa)"
fi
if [ -z "$COOLIFY_API_TOKEN" ]; then echo "COOLIFY_API_TOKEN required" >&2; exit 2; fi

# 1. Versión actual del registry.
CUR="$(curl -s -m 10 "$REGISTRY" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("currentVersion") or "")
except Exception: print("")' 2>/dev/null)"
if [ -z "$CUR" ]; then log "pin WARN registry_unreachable"; exit 3; fi

# 2. Pin actual en Coolify (producción, no preview).
PIN="$(curl -s -m 15 -H "Authorization: Bearer $COOLIFY_API_TOKEN" \
  "$COOLIFY_API/api/v1/applications/$APP/envs" | python3 -c '
import json,sys
try:
    for e in json.load(sys.stdin):
        if e.get("key")=="WWEBJS_WEB_VERSION" and not e.get("is_preview"):
            print(e.get("real_value") or ""); break
except Exception: pass' 2>/dev/null)"

# Builds marcadas rotas (engine_in_loop) y última estable conocida: inputs del
# auto-rollback y del skip. check.sh escribe ambos; pin.sh solo decide.
BAD_FILE="${OPENWA_BAD_VERSIONS:-/var/lib/vendi/openwa-bad-versions.txt}"
LAST_STABLE="${OPENWA_LAST_STABLE:-/var/lib/vendi/openwa-last-stable.txt}"

# Auto-rollback: si el pin actual está marcado roto (engine_in_loop) y existe una
# última estable conocida distinta, revierte inmediatamente (sin rate-limit: es
# corrección de emergencia). Ventana de loop pasa de horas a ~1 ciclo del check.
LAST_STABLE_V="$(cat "$LAST_STABLE" 2>/dev/null || echo "")"
if [ -n "$PIN" ] && [ -n "$LAST_STABLE_V" ] && [ "$LAST_STABLE_V" != "$PIN" ] \
   && grep -qx "$PIN" "$BAD_FILE" 2>/dev/null; then
  log "pin ROLLBACK $PIN -> $LAST_STABLE_V (pin marcado roto, auto-rollback a última estable)"
  if [ "${DRY_RUN:-0}" = "1" ]; then
    echo "DRY-RUN: rollback $PIN -> $LAST_STABLE_V"
    exit 0
  fi
  if curl -s -m 20 -X PATCH -H "Authorization: Bearer $COOLIFY_API_TOKEN" -H "Content-Type: application/json" \
       -d "{\"key\":\"WWEBJS_WEB_VERSION\",\"value\":\"$LAST_STABLE_V\"}" \
       "$COOLIFY_API/api/v1/applications/$APP/envs" | grep -q \"uuid\"; then
    DEP="$(curl -s -m 30 -X POST -H "Authorization: Bearer $COOLIFY_API_TOKEN" \
      "$COOLIFY_API/api/v1/deploy?uuid=$APP&force=true" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("deployments",[{}])[0].get("deployment_uuid",""))
except Exception: print("")' 2>/dev/null)"
    log "pin rollback deployed deployment=$DEP"
  else
    log "pin ERROR rollback patch_env"
  fi
  exit 0
fi


# Builds marcadas rotas por el watchdog (engine_in_loop -> bad-versions) se
# saltan: el auto-update de 6h continúa cuando el registry publique una distinta.
BAD_FILE="${OPENWA_BAD_VERSIONS:-/var/lib/vendi/openwa-bad-versions.txt}"
if grep -qx "$CUR" "$BAD_FILE" 2>/dev/null; then
  log "pin skip current=$CUR marcada rota (bad-versions, ver openwa-check.sh)"
  exit 0
fi

if [ "$PIN" = "$CUR" ]; then log "pin OK current=$CUR"; exit 0; fi

# 3. Rate-limit.
NOW=$(date +%s); LAST=0
[ -f "$STATE_FILE" ] && LAST="$(cat "$STATE_FILE" 2>/dev/null || echo 0)"
if [ "$FORCE" != "1" ] && [ $(( NOW - LAST )) -lt "$MIN_INTERVAL_S" ]; then
  log "pin skip rate-limit pinned=$PIN current=$CUR next_in=$(( MIN_INTERVAL_S - (NOW-LAST) ))s"
  exit 0
fi

if [ "${DRY_RUN:-0}" = "1" ]; then
  log "pin DRY_RUN bump $PIN -> $CUR"
  echo "DRY-RUN: WWEBJS_WEB_VERSION $PIN -> $CUR"
  exit 0
fi

# 4. Bump: PATCH env (ruta correcta: /envs sin key en el path) + deploy.
log "pin bump $PIN -> $CUR"
if ! curl -s -m 20 -X PATCH -H "Authorization: Bearer $COOLIFY_API_TOKEN" -H "Content-Type: application/json" \
     -d "{\"key\":\"WWEBJS_WEB_VERSION\",\"value\":\"$CUR\"}" \
     "$COOLIFY_API/api/v1/applications/$APP/envs" | grep -q '"uuid"'; then
  log "pin ERROR patch_env"
  exit 4
fi
DEP="$(curl -s -m 30 -X POST -H "Authorization: Bearer $COOLIFY_API_TOKEN" \
  "$COOLIFY_API/api/v1/deploy?uuid=$APP&force=true" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("deployments",[{}])[0].get("deployment_uuid",""))
except Exception: print("")' 2>/dev/null)"
echo "$NOW" > "$STATE_FILE"
log "pin deployed deployment=$DEP"