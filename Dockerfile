FROM node:22-alpine
WORKDIR /app
COPY bridge-server.js .
ENV PORT=7331
EXPOSE 7331
CMD ["node", "bridge-server.js"]
