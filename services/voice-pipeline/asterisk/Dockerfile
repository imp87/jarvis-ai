# Ubuntu 24.04 ships an Asterisk 20 package that predates chan_websocket.
# Build a pinned current LTS release from the official Asterisk source instead:
# the media bridge needs the WebSocket driver introduced in 20.16.0.
FROM ubuntu:24.04

ARG ASTERISK_VERSION=20.20.1

# The pipeline writes call files as Node's uid 1000. Asterisk must own the
# same numeric uid because pbx_spool sets their timestamps with utime(); its
# group is irrelevant and may already be occupied by the base image.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      gettext-base \
      libcurl4-openssl-dev \
      libedit-dev \
      libjansson-dev \
      libncurses-dev \
      libsqlite3-dev \
      libssl-dev \
      liburiparser-dev \
      libxml2-dev \
      pkg-config \
      uuid-dev \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL "https://downloads.asterisk.org/pub/telephony/asterisk/releases/asterisk-${ASTERISK_VERSION}.tar.gz" \
      | tar xz -C /tmp \
 && cd "/tmp/asterisk-${ASTERISK_VERSION}" \
 && ./configure --with-pjproject-bundled \
 && make menuselect.makeopts \
 && menuselect/menuselect --enable chan_websocket --enable res_websocket_client menuselect.makeopts \
 && make -j"$(nproc)" \
 && make install \
 && make samples \
 && test -f /usr/lib/asterisk/modules/chan_websocket.so \
 && test -f /usr/lib/asterisk/modules/res_websocket_client.so \
 && rm -rf "/tmp/asterisk-${ASTERISK_VERSION}" \
 && (getent group asterisk >/dev/null || groupadd --system asterisk) \
 && useradd --non-unique --uid 1000 --gid asterisk --home-dir /var/lib/asterisk --shell /usr/sbin/nologin asterisk \
 && mkdir -p /etc/asterisk/templates /var/lib/asterisk /var/run/asterisk /var/log/asterisk

COPY services/voice-pipeline/asterisk/pjsip.conf             /etc/asterisk/templates/pjsip.conf
COPY services/voice-pipeline/asterisk/extensions.conf        /etc/asterisk/templates/extensions.conf
COPY services/voice-pipeline/asterisk/websocket_client.conf  /etc/asterisk/templates/websocket_client.conf
COPY services/voice-pipeline/asterisk/chan_websocket.conf    /etc/asterisk/templates/chan_websocket.conf
COPY services/voice-pipeline/asterisk/entrypoint.sh          /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
 && mkdir -p /var/spool/asterisk/outgoing /var/spool/asterisk/staging \
 && chown -R asterisk:asterisk /etc/asterisk /var/lib/asterisk /var/run/asterisk /var/log/asterisk /var/spool/asterisk

EXPOSE 5060/udp 10000-10099/udp
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
