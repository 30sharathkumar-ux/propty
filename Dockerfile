FROM node:20-slim

# Non-root user
RUN groupadd -r lablink && useradd -r -g lablink lablink

WORKDIR /app

# Install dependencies first (cached layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY src/ ./src/
COPY public/ ./public/
COPY data/ ./data/

# Set ownership
RUN chown -R lablink:lablink /app

USER lablink

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "src/server.js"]
