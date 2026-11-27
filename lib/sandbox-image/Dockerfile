# The integrated dev agent's sandbox computer (Lambda MicroVMs image, built by the service from
# this directory): Node 22 + npm + git + headless Chromium (Playwright build), and a tiny,
# dependency-free control server (server.mjs). App port 8080 = the control API (reached only
# through the MicroVM's authenticated endpoint); port 9000 = lifecycle hooks. Nothing in this
# image is per-VM: per-VM state is created on /run (snapshot uniqueness rule).
#
# ⚠️ The base container's package manager is MICRODNF (`dnf` is a symlink to it): dnf-only
# options such as --allowerasing make the build fail at once (CONTAINER_BUILD_FAILED). curl is
# already there as curl-minimal, so it is not installed again (the full curl would conflict).
# Verify any change with `docker build --platform linux/arm64 .` before publishing.
FROM public.ecr.aws/lambda/microvms:al2023-minimal

ARG NODE_VERSION=22.12.0
RUN microdnf install -y --setopt=install_weak_deps=0 tar xz gzip git findutils procps-ng shadow-utils \
      nss atk at-spi2-atk cups-libs libdrm libxkbcommon libXcomposite libXdamage libXrandr \
      libXfixes libXext libX11 libxcb mesa-libgbm pango alsa-lib \
  && microdnf clean all \
  && ARCH=$(uname -m | sed 's/aarch64/arm64/;s/x86_64/x64/') \
  && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${ARCH}.tar.xz" \
     | tar -xJ -C /usr/local --strip-components=1 \
  && node --version && npm --version

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
WORKDIR /opt/sandbox
COPY package.json server.mjs ./
RUN npm install --omit=dev --no-audit --no-fund && npx playwright install --only-shell chromium

# The workspace and the user commands run unprivileged.
RUN useradd -m -u 1001 agent && mkdir -p /workspace && chown agent:agent /workspace
ENV WORKSPACE=/workspace HOME=/home/agent
EXPOSE 8080 9000
CMD ["node", "/opt/sandbox/server.mjs"]
