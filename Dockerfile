# JellyShell server images. Targets:
#   jellyshell  (default) page server: built web UI + Seerr/*arr/Bazarr proxies, port 8097. Stdlib Python, no pip deps.
#   dash        optional TV dashboard backend + UI, port 8098. Stdlib Python, no pip deps.
#   nowplaying  optional HomePod / Apple TV now-playing sidecar for the dash (pyatv + aiohttp), port 8102.
#
#   docker build -t jellyshell .
#   docker build --target dash -t jellyshell-dash .
#   docker build --target nowplaying -t jellyshell-nowplaying .
# Configuration is environment variables only (docs/configuration.md); docker-compose.yml wires them from .env.

# ---------------------------------------------------------------- web UI build
FROM node:22-slim AS web-build
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---------------------------------------------------------------- dash UI build
FROM node:22-slim AS dash-build
WORKDIR /src/dash/web
COPY dash/web/package.json dash/web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY dash/web/ ./
RUN npm run build

# ---------------------------------------------------------------- shared python base
FROM python:3.13-slim AS py-base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 JELLYSHELL_DOCKER=1
RUN groupadd --system --gid 10001 jellyshell \
 && useradd --system --uid 10001 --gid jellyshell --home-dir /data --no-create-home jellyshell \
 && mkdir -p /data && chown jellyshell:jellyshell /data
VOLUME ["/data"]

# ---------------------------------------------------------------- page server (default target is last: see bottom)
FROM py-base AS jellyshell
WORKDIR /app/web-poc
COPY web-poc/ /app/web-poc/
COPY --from=web-build /src/web/dist /app/web/dist
ENV JELLYSHELL_BIND=0.0.0.0 JELLYSHELL_PORT=8097 JELLYSHELL_DATA_DIR=/data JELLYSHELL_LOG_FILE=/data/client.log
USER jellyshell
EXPOSE 8097
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python3", "-c", "import os,urllib.request as u; h=os.environ.get('JELLYSHELL_BIND') or ''; h='127.0.0.1' if h in ('', '0.0.0.0', '::') else h; u.urlopen('http://%s:%s/api/config' % (h, os.environ.get('JELLYSHELL_PORT') or '8097'), timeout=4)"]
CMD ["python3", "/app/web-poc/server.py"]

# ---------------------------------------------------------------- dash
FROM py-base AS dash
WORKDIR /app/dash/server
COPY dash/server/server.py dash/server/dashconfig.py /app/dash/server/
COPY --from=dash-build /src/dash/web/dist /app/dash/web/dist
ENV DASH_BIND=0.0.0.0 DASH_PORT=8098 DASH_DATA_DIR=/data
USER jellyshell
EXPOSE 8098
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python3", "-c", "import os,urllib.request as u; h=os.environ.get('DASH_BIND') or ''; h='127.0.0.1' if h in ('', '0.0.0.0', '::') else h; u.urlopen('http://%s:%s/api/config' % (h, os.environ.get('DASH_PORT') or '8098'), timeout=4)"]
CMD ["python3", "/app/dash/server/server.py"]

# ---------------------------------------------------------------- now-playing sidecar (optional)
FROM py-base AS nowplaying
WORKDIR /app/dash/server
COPY dash/server/requirements-nowplaying.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && rm /tmp/requirements.txt
COPY dash/server/nowplaying.py dash/server/dashconfig.py /app/dash/server/
ENV NP_BIND=0.0.0.0 NP_PORT=8102
USER jellyshell
EXPOSE 8102
CMD ["python3", "/app/dash/server/nowplaying.py"]

# ---------------------------------------------------------------- default target
FROM jellyshell
