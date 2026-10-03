FROM node:22-alpine
WORKDIR /app
COPY contract ./contract
COPY simulator/package.json simulator/package-lock.json ./simulator/
RUN npm ci --prefix simulator
COPY simulator ./simulator
WORKDIR /app/simulator
CMD ["npx", "tsx", "src/index.ts"]
