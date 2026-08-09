#!/bin/sh
set -eu

# Substitutes deployment values into the Asterisk configuration at start, so no
# credential is ever baked into the image.
#
# The explicit variable list is essential: the dialplan is full of Asterisk's
# own ${CALLERID(num)}, ${DECISION} and ${JARVIS_CALL_ID}. A bare `envsubst`
# would replace those with empty strings and leave a dialplan that silently
# rejects every call.
SUBST='$SIP_ADRESS $SIP_USER $SIP_PASSWORD $SERVICE_TOKEN $PIPELINE_HTTP $PIPELINE_MEDIA_HOST'

: "${SIP_ADRESS:?SIP_ADRESS is required}"
: "${SIP_USER:?SIP_USER is required}"
: "${SIP_PASSWORD:?SIP_PASSWORD is required}"
: "${SERVICE_TOKEN:?SERVICE_TOKEN is required}"
: "${PIPELINE_HTTP:=http://127.0.0.1:8082}"
: "${PIPELINE_MEDIA_HOST:=127.0.0.1:8082}"
export PIPELINE_HTTP PIPELINE_MEDIA_HOST

envsubst "$SUBST" < /etc/asterisk/templates/pjsip.conf      > /etc/asterisk/pjsip.conf
envsubst "$SUBST" < /etc/asterisk/templates/extensions.conf > /etc/asterisk/extensions.conf
envsubst "$SUBST" < /etc/asterisk/templates/websocket_client.conf > /etc/asterisk/websocket_client.conf
cp /etc/asterisk/templates/chan_websocket.conf /etc/asterisk/chan_websocket.conf
chown asterisk:asterisk /etc/asterisk/pjsip.conf /etc/asterisk/extensions.conf /etc/asterisk/websocket_client.conf /etc/asterisk/chan_websocket.conf

# Calls use MaxRetries: 0, so an outgoing file older than five minutes is
# definitively stale. Keep it out of the active spool before repairing old
# ownership: otherwise a restart could turn a historical, failed call into a
# fresh attempt. It is archived rather than deleted for diagnostics.
mkdir -p /var/spool/asterisk/stale
find /var/spool/asterisk/outgoing -maxdepth 1 -type f -name '*.call' -mmin +5 \
  -exec mv -t /var/spool/asterisk/stale -- {} +

# Existing files can predate the shared-UID fix. New files already use the
# same numeric uid, but repairing the remaining bounded spool avoids utime()
# warnings for a call queued during a container restart.
chown -R asterisk:asterisk /var/spool/asterisk

# Fail loudly if a placeholder survived — a half-substituted registration would
# otherwise just never connect, with nothing in the log explaining why.
if grep -q '\${SIP_' /etc/asterisk/pjsip.conf; then
  echo "entrypoint: SIP placeholders were not substituted" >&2
  exit 1
fi

echo "entrypoint: registering as ${SIP_USER}@${SIP_ADRESS}, media at ${PIPELINE_MEDIA_HOST}"
exec asterisk -f -U asterisk -G asterisk -vvv
