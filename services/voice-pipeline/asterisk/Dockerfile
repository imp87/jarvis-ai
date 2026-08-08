# Asterisk from Ubuntu's own package (Debian dropped it after bullseye) rather than a third-party image: the SIP
# stack sits between your phone line and an LLM-driven agent, and an unaudited
# image from Docker Hub is not something to put there.
FROM ubuntu:24.04

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      asterisk \
      asterisk-modules \
      gettext-base \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 # Debian ships a large sample configuration that would shadow ours.
 && rm -f /etc/asterisk/pjsip.conf /etc/asterisk/extensions.conf

COPY services/voice-pipeline/asterisk/pjsip.conf     /etc/asterisk/templates/pjsip.conf
COPY services/voice-pipeline/asterisk/extensions.conf /etc/asterisk/templates/extensions.conf
COPY services/voice-pipeline/asterisk/entrypoint.sh   /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Shared with the pipeline container so call files land where Asterisk polls.
RUN mkdir -p /var/spool/asterisk/outgoing /var/spool/asterisk/staging \
 && chown -R asterisk:asterisk /var/spool/asterisk

EXPOSE 5060/udp 10000-10099/udp
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
