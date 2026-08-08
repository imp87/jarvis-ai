#!/bin/sh
set -eu

# Substitutes deployment values into the Asterisk configuration at start, so no
# credential is ever baked into the image.
#
# The explicit variable list is essential: the dialplan is full of Asterisk's
# own ${CALLERID(num)}, ${DECISION} and ${JARVIS_CALL_ID}. A bare `envsubst`
# would replace those with empty strings and leave a dialplan that silently
# rejects every call.
SUBST='$SIP_ADRESS $SIP_USER $SIP_PASSWORD $SERVICE_TOKEN $PIPELINE_HTTP $PIPELINE_AUDIO'

: "${SIP_ADRESS:?SIP_ADRESS is required}"
: "${SIP_USER:?SIP_USER is required}"
: "${SIP_PASSWORD:?SIP_PASSWORD is required}"
: "${SERVICE_TOKEN:?SERVICE_TOKEN is required}"
: "${PIPELINE_HTTP:=http://127.0.0.1:8082}"
: "${PIPELINE_AUDIO:=127.0.0.1:8090}"
export PIPELINE_HTTP PIPELINE_AUDIO

envsubst "$SUBST" < /etc/asterisk/templates/pjsip.conf      > /etc/asterisk/pjsip.conf
envsubst "$SUBST" < /etc/asterisk/templates/extensions.conf > /etc/asterisk/extensions.conf
chown asterisk:asterisk /etc/asterisk/pjsip.conf /etc/asterisk/extensions.conf

# Fail loudly if a placeholder survived — a half-substituted registration would
# otherwise just never connect, with nothing in the log explaining why.
if grep -q '\${SIP_' /etc/asterisk/pjsip.conf; then
  echo "entrypoint: SIP placeholders were not substituted" >&2
  exit 1
fi

echo "entrypoint: registering as ${SIP_USER}@${SIP_ADRESS}, pipeline at ${PIPELINE_AUDIO}"
exec asterisk -f -U asterisk -G asterisk -vvv
