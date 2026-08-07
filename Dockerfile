FROM node:20-slim

RUN apt-get update && apt-get install -y \
    chromium \
    fonts-noto-color-emoji \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV CHROME_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc && npm prune --production

# Borra locks de Chromium de runs anteriores al arrancar
CMD ["sh", "-c", "find /app/.wwebjs_auth /app/.wwebjs_cache -name 'Singleton*' -delete 2>/dev/null; exec node dist/index.js"]
