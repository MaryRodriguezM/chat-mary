FROM node:20-alpine

WORKDIR /app

# Primero las dependencias (así Docker las reutiliza si no cambian).
# "package*.json" funciona con o sin package-lock.json.
COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./

# Se puede cambiar al desplegar: dominio exacto del frontend, separados por coma
ENV PORT=3000
ENV ALLOWED_ORIGINS=http://localhost:8080

EXPOSE 3000

# No correr como administrador dentro del contenedor
USER node

CMD ["node", "server.js"]