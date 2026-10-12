# Himalayan Voyage Nepal — production image
#
# Node 22 is required: the app uses the built-in `node:sqlite` module, which
# only exists from Node 22 onwards. `node:22-slim` keeps the image small while
# still providing glibc for pdfkit's bundled fonts.
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first so Docker can cache this layer between builds.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application source (data/, .env and node_modules are excluded by .dockerignore).
COPY . .

# The database lives on a mounted volume so it survives redeploys.
ENV DB_PATH=/data/travel.db
ENV PORT=3400
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3400

# Report unhealthy if the HTTP server stops answering, so the platform can restart it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3400)+'/api/packages').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
