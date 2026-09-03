#!/usr/bin/env bash
#
# openwa:pipeline — QA→prod automático del servidor OpenWA.
#
# Flujo (cron horario):
#   1. Si prod tiene incidente activo (sesión no operativa) → SKIP (no meter
#      cambios durante un incidente).
#   2. Si main == stable → nada que promover.
#   3. canary.sh test origin/main  → test empírico del código QA contra WhatsApp
#      real (número desechable del volumen canary: reconexión sin QR + 180s sin LOGOUT).
#      FAIL → alerta Telegram + no toca prod.
#   4. promote.sh <sha>  → mueve stable + deploy Coolify + espera.
#   5. Post-deploy health (10 min): si aparece un ALERT engine_in_loop nuevo
#      (session reset/LOGOUT loop tras el deploy) → promote.sh --rollback + alerta.
#      Nota: qr_ready tras un deploy es esperable si el engine pidió re-link —
#      no dispara rollback (el admin re-escanea; ventana limpia del check.sh).
#
# Cron (VPS):  10 * * * * root /usr/local/bin/openwa-pipeline.sh >> /var/log/vendi/openwa-pipeline.log 2>&1

set -uo pipefail

FORK="${FORK:-RicardoRios07/OpenWA}"
WORKDIR="${OPENWA_CANARY_WORKDIR:-/opt/openwa-canary}"
APP="${OPENWA_APP_UUID:-n50tfqbjdl6d56vd2921c7bq}"
COOLIFY_API="${COOLIFY_API:-https://coolify-api.vendi.ec}"
OPENWA_BASE="${OPENWA_BASE_URL:-https://openwa.vendi.ec}"
LOG_FILE="${OPENWA_HEALTH_LOG:-/var/log/vendi/openwa-health.log}"
PLOG="${OPENWA_PIPELINE_LOG:-/var/log/vendi/openwa-pipeline.log}"
POST_DEPLOY_WAIT_S="${POST_DEPLOY_WAIT_S:-600}"
FAIL_MARKER="${OPENWA_PIPELINE_FAILMARKER:-/tmp/openwa-pipeline-postdeploy}"

mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$PLOG")"
log() { echo "$(date -u +%FT%TZ) $*" >> "$PLOG"; }
notify() { /usr/local/bin/openwa-notify.sh "$1" & }

COOLIFY_API_TOKEN="${COOLIFY_API_TOKEN:-}"
OPENWA_API_KEY="${OPENWA_API_KEY:-}"
if [ -f /etc/cron.d/vendi-openwa ]; then
  COOLIFY_API_TOKEN="${COOLIFY_API_TOKEN:-$(awk -F= '/^COOLIFY_API_TOKEN=/{print $2}' /etc/cron.d/vendi-openwa)}"
  OPENWA_API_KEY="${OPENWA_API_KEY:-$(awk -F= '/^OPENWA_API_KEY=/{print $2}' /etc/cron.d/vendi-openwa)}"
fi
[ -z "$COOLIFY_API_TOKEN" ] || [ -z "$OPENWA_API_KEY" ] && { log "pipeline ERROR credenciales"; exit 2; }

# Lock: el pipeline (con canary) puede tardar ~15 min; el cron horario no solapa.
exec 9>"${OPENWA_PIPELINE_LOCK:-/tmp/openwa-pipeline.lock}"
flock -n 9 || { log "pipeline skip lock (ya corriendo)"; exit 0; }

# ── 1. Prod estable: sin incidente activo ──
sesion_operativa() {
  curl -s -m 15 -H "Authorization: Bearer $OPENWA_API_KEY" -H "x-api-key: $OPENWA_API_KEY" \
    "$OPENWA_BASE/api/sessions" | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
    for s in d:
        if (s.get("status") or "").lower() in ("ready","connected","working","authenticated"):
            sys.exit(0)
except Exception: pass
sys.exit(1)'
}
if ! sesion_operativa; then
  log "pipeline skip: prod sin sesión operativa (incidente/re-link en curso) — no se promueve"
  exit 0
fi

# ── 2. main vs stable ──
cd "$WORKDIR" || { log "pipeline ERROR no workdir"; exit 1; }
git fetch -q origin main stable 2>/dev/null || { log "pipeline WARN fetch"; exit 0; }
MAIN_SHA="$(git rev-parse origin/main)"
STABLE_SHA="$(git rev-parse origin/stable)"
[ "$MAIN_SHA" = "$STABLE_SHA" ] && { log "pipeline nada que promover (main==stable)"; exit 0; }

log "pipeline start: main=${MAIN_SHA:0:7} stable=${STABLE_SHA:0:7} — canary test origin/main"

# ── 3. Canary del código QA ──
BEFORE_BAD="$(docker logs openwa 2>/dev/null | grep -cE 'Session disconnected: LOGOUT' || true)"
if ! /usr/local/bin/openwa-canary.sh test origin/main >> "$PLOG" 2>&1; then
  log "pipeline canary FAIL main=$MAIN_SHA — alerta, no se promueve"
  notify "❌ WhatsApp pipeline: canary de origin/main FALLÓ — QA no se promueve a prod. Revisa /var/log/vendi/openwa-canary.log"
  exit 1
fi
log "pipeline canary PASS main=$MAIN_SHA"

# ── 4. Promote a prod ──
if ! /usr/local/bin/openwa-promote.sh "$MAIN_SHA" >> "$PLOG" 2>&1; then
  log "pipeline promote FAIL main=$MAIN_SHA"
  notify "❌ WhatsApp pipeline: promote de main ($MAIN_SHA) falló — stable sin cambios. Revisa /var/log/vendi/openwa-pipeline.log"
  exit 1
fi
log "pipeline promoted main=$MAIN_SHA → stable — post-deploy health ${POST_DEPLOY_WAIT_S}s"
notify "🚀 WhatsApp pipeline: promoted main (${MAIN_SHA:0:7}) a prod. Post-deploy health en ${POST_DEPLOY_WAIT_S}s."

# ── 5. Post-deploy health: LOGOUT loop nuevo → rollback automático ──
sleep "$POST_DEPLOY_WAIT_S"
AFTER_BAD="$(docker logs $(docker ps --format '{{.Names}}' | grep n50tfq | head -1) --since "${POST_DEPLOY_WAIT_S}s" 2>&1 | grep -cE 'Session disconnected: LOGOUT' || true)"
if [ "${AFTER_BAD:-0}" -ge 2 ]; then
  log "pipeline post-deploy FAIL logouts=$AFTER_BAD — rollback automático"
  notify "🔁 WhatsApp pipeline: LOGOUT loop tras el deploy ($AFTER_BAD logouts) — rollback automático de stable."
  /usr/local/bin/openwa-promote.sh --rollback >> "$PLOG" 2>&1 && notify "✅ WhatsApp pipeline: rollback de stable completado."
  exit 1
fi

# Señal de éxito: marca el checkpoint para el siguiente ciclo
log "pipeline PASS main=$MAIN_SHA promovido y estable post-deploy"
notify "✅ WhatsApp pipeline: QA promovido a prod y estable (${MAIN_SHA:0:7})."
exit 0
