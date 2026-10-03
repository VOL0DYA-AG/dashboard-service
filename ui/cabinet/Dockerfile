FROM node:22-alpine AS build
WORKDIR /src
COPY contract ./contract
COPY ui/cabinet/package.json ./ui/cabinet/
WORKDIR /src/ui/cabinet
RUN npm install
COPY ui/cabinet ./
RUN npm run build
FROM alpine:3.20
COPY --from=build /src/ui/cabinet/dist /dist
CMD ["sh", "-c", "rm -rf /out/* && cp -a /dist/. /out/"]
