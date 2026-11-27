FROM node:24-alpine

WORKDIR /app
RUN npm init -y >/dev/null && npm install --no-audit --no-fund @vercel/board@0.56.1
COPY server.mjs ./server.mjs

EXPOSE 4100
CMD ["node", "server.mjs"]
