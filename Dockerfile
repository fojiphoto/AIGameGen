# Web half of Forge: generation, play, arcade, credits, admin.
#
# APK EXPORT IS NOT IN THIS IMAGE, on purpose. It needs a JDK plus the Android SDK, which
# is ~3.5 GB — far past every free hosting tier, and it would make this image slow to build
# and deploy for a capability most page views never touch. The server detects the missing
# toolchain at boot (apps/api/src/toolchain.mjs) and the export page says so plainly instead
# of offering a button that fails.
#
# To build APKs in the cloud, run tools/build-apk.mjs in CI — GitHub Actions' ubuntu runners
# already have the Android SDK installed. See the README.

FROM node:24-slim

WORKDIR /app

# Dependencies first so a source-only change does not reinstall them.
COPY package.json package-lock.json ./
COPY packages/ai/package.json            packages/ai/
COPY packages/bundler/package.json       packages/bundler/
COPY packages/db/package.json            packages/db/
COPY packages/engine-runner/package.json packages/engine-runner/
COPY packages/generation/package.json    packages/generation/
COPY packages/schema/package.json        packages/schema/
COPY apps/api/package.json               apps/api/

# esbuild needs its postinstall to place the platform binary; npm >= 11 blocks that unless
# the script is approved, and package.json already carries the approval.
RUN npm ci --no-audit --no-fund

COPY . .

# Bundle the Phaser engine once at image build time. Every generated game reuses this exact
# file, so it must exist before the server can package anything.
RUN npm run build:engine

# SQLite file and generated bundles. Mount a volume here to keep games across deploys.
RUN mkdir -p /app/data /app/artifacts
ENV DB_PATH=/app/data/forge.db \
    ARTIFACTS_DIR=/app/artifacts \
    NODE_ENV=production \
    PORT=8787

EXPOSE 8787

# Fails the container if the app stops answering, rather than serving errors silently.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/src/server.mjs"]
