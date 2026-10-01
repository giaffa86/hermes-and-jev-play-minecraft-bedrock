# Dockerfile per l'agente Minecraft Bedrock di Hermes + Jev.
# Contiene Node.js, il progetto e tutte le dipendenze.
# L'agente espone l'HTTP harness su :3077 e si connette al BDS via NetherNet.
FROM node:24-slim

WORKDIR /app

# Installiamo git e ca-certificates per eventuali dipendenze git-based
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copia e installa dipendenze Node
COPY package*.json ./
RUN npm install --ignore-scripts

# Copia il codice sorgente
COPY . .

# Porta del harness HTTP
EXPOSE 3077

# Default: avvia il Bedrock harness
CMD ["node", "bedrock-harness.mjs"]
