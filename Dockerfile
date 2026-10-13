# Himalayan Voyage Nepal — production image
#
# Node 22 is required: the app still uses the built-in `node:sqlite` module for
# the local/fallback driver. In production it runs against PostgreSQL when
# DATABASE_URL is set. `node:22-slim` keeps the image small while still
# providing glibc for pdfkit's bundled fonts.
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first so Docker can cache this layer between builds.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application source (data/, .env and node_modules are excluded by .dockerignore).
COPY . .

# DATABASE_URL (set on the host) switches the app to PostgreSQL, which survives
# redeploys and spin-downs. DB_PATH stays as the SQLite fallback for local runs
# and for hosts without a database. /data is created so that fallback always has
# a writable directory.
ENV PORT=3400
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3400

# Report unhealthy if the HTTP server stops answering, so the platform can restart it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3400)+'/api/packages').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
