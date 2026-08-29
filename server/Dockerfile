# The licence server.
#
# One process, one SQLite file on a volume. Nothing here needs a build step, a bundler or a second
# stage: the image is the interpreter, five pinned dependencies and eight files.

FROM python:3.13-slim

# Fail fast and log straight through to Docker rather than into a buffer nobody reads when the
# container is dying.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    DATABASE_PATH=/data/licences.db \
    PORT=8787

WORKDIR /srv

# Dependencies first, so editing a route does not reinstall cryptography.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Unprivileged, and the owner of /data — a named volume takes its ownership from the image the
# first time it is created, which is what lets a non-root process write the database.
RUN useradd --system --uid 10001 --create-home audionotes \
 && mkdir -p /data \
 && chown -R audionotes:audionotes /data /srv
USER audionotes

EXPOSE 8787

# Compose restarts an unhealthy container; without this it would happily keep a process that is
# listening but answering nothing.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8787/healthz',timeout=4).status==200 else 1)"

# --factory, because the app is built by a function that loads the signing key: a server with no
# key must fail here, at boot, with one clear message.
#
# --proxy-headers with a wildcard is safe only because this port is never published; Caddy is the
# only thing that can reach it.
CMD ["sh", "-c", "exec uvicorn app.main:create_app --factory --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
