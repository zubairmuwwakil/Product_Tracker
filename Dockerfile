FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npx prisma generate && npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
# Prisma CLI is a dev dependency; generated client artifacts are copied from the build stage below.
RUN npm install --omit=dev --ignore-scripts
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist
COPY prisma ./prisma
CMD ["node", "dist/src/server.js"]
