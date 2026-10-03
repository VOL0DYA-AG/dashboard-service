FROM node:22-alpine
WORKDIR /app
COPY contract ./contract
COPY simulator/package.json ./simulator/package.json
RUN npm install --prefix simulator
COPY simulator ./simulator
WORKDIR /app/simulator
CMD ["npx", "tsx", "src/index.ts"]
