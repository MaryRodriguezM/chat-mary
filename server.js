const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

// ---------- Configuración ----------
const PORT = process.env.PORT || 3000;

// Dominios del frontend que pueden conectarse. Nunca "*".
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:8080'
)
  .split(',')
  .map((o) => o.trim().replace(/\/$/, ''))
  .filter(Boolean);

if (ALLOWED_ORIGINS.includes('*')) {
  console.error('ALLOWED_ORIGINS no puede ser "*". Pon el dominio de tu frontend.');
  process.exit(1);
}

const HISTORY_SIZE = Number(process.env.MAX_HISTORY) || 50;
const MAX_MESSAGE_LENGTH = 500;
const MAX_NAME_LENGTH = 20;
const PING_INTERVAL_MS = 30000;
const RATE_LIMIT_MAX = 5; // mensajes
const RATE_LIMIT_WINDOW_MS = 5000; // cada 5 segundos
const MAX_PAYLOAD_BYTES = 4 * 1024;

const history = [];

// ---------- Servidor HTTP (health check y revisión del origen) ----------
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        conectados: userList().length,
        mensajesEnHistorial: history.length,
        uptimeSegundos: Math.round(process.uptime()),
      })
    );
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Servidor de chat funcionando');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

// Aquí se decide si la conexión se acepta ("upgrade")
server.on('upgrade', (req, socket, head) => {
  const origin = (req.headers.origin || '').replace(/\/$/, '');
  if (!ALLOWED_ORIGINS.includes(origin)) {
    console.warn(`[rechazo] origen no permitido: ${origin || '(vacío)'}`);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  console.log(`[upgrade] aceptado origin=${origin}`);
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// ---------- Utilidades ----------
function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function broadcast(data, except) {
  const payload = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client === except) return;
    if (client.readyState === WebSocket.OPEN && client.name) {
      client.send(payload);
    }
  });
}

function userList() {
  return [...wss.clients]
    .filter((c) => c.readyState === WebSocket.OPEN && c.name)
    .map((c) => c.name);
}

// Ventana deslizante: ¿esta persona mandó demasiado rápido?
function rateLimited(ws) {
  const now = Date.now();
  ws.hits = ws.hits.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (ws.hits.length >= RATE_LIMIT_MAX) return true;
  ws.hits.push(now);
  return false;
}

// ---------- Conexiones ----------
wss.on('connection', (ws) => {
  ws.name = null;
  ws.hits = [];
  ws.alive = true;

  ws.on('pong', () => {
    ws.alive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, { type: 'error', text: 'Mensaje inválido' });
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'join') {
      if (ws.name) return send(ws, { type: 'error', text: 'Ya estás conectado' });
      const name = String(msg.name || '').trim();
      if (!name) {
        return send(ws, { type: 'error', text: 'El nombre no puede estar vacío' });
      }
      if (name.length > MAX_NAME_LENGTH) {
        return send(ws, {
          type: 'error',
          text: `El nombre admite máximo ${MAX_NAME_LENGTH} caracteres`,
        });
      }
      if (userList().some((n) => n.toLowerCase() === name.toLowerCase())) {
        return send(ws, { type: 'error', text: 'Ese nombre ya está en uso' });
      }
      ws.name = name;
      send(ws, { type: 'joined', name, users: userList(), history });
      console.log(`[ws] conectado nombre="${name}" total=${userList().length}`);
      broadcast({ type: 'system', text: `${name} entró al chat`, ts: Date.now() });
      broadcast({ type: 'users', users: userList() });
      return;
    }

    if (msg.type === 'message') {
      if (!ws.name) {
        return send(ws, { type: 'error', text: 'Primero debes elegir un nombre' });
      }
      const text = String(msg.text || '').trim();
      if (!text) {
        return send(ws, { type: 'error', text: 'No se puede enviar un mensaje vacío' });
      }
      if (text.length > MAX_MESSAGE_LENGTH) {
        return send(ws, {
          type: 'error',
          text: `Mensaje demasiado largo (máximo ${MAX_MESSAGE_LENGTH})`,
        });
      }
      if (rateLimited(ws)) {
        return send(ws, { type: 'error', text: 'Vas muy rápido. Espera unos segundos' });
      }
      const out = { type: 'message', name: ws.name, text, ts: Date.now() };
      history.push(out);
      if (history.length > HISTORY_SIZE) history.shift();
      console.log(`[ws] mensaje de="${ws.name}" bytes=${Buffer.byteLength(text)}`);
      broadcast(out);
      return;
    }

    if (msg.type === 'typing') {
      if (!ws.name) return;
      broadcast({ type: 'typing', name: ws.name }, ws);
    }
  });

  ws.on('close', (code) => {
    console.log(`[cierre] nombre="${ws.name || '-'}" code=${code}`);
    if (ws.name) {
      broadcast({ type: 'system', text: `${ws.name} salió del chat`, ts: Date.now() });
      broadcast({ type: 'users', users: userList() });
    }
  });

  ws.on('error', (err) => console.error('Error de socket:', err.message));
});

// ---------- Ping/pong: corta a los que no responden ----------
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.alive) {
      console.log(`[ping] nombre="${ws.name || '-'}" no respondió: se corta`);
      return ws.terminate();
    }
    ws.alive = false;
    ws.ping();
  });
}, PING_INTERVAL_MS);

// ---------- Apagado limpio: cierra a todos con el código 1000 ----------
function shutdown() {
  console.log('[apagado] cerrando conexiones con código 1000');
  clearInterval(heartbeat);
  wss.clients.forEach((ws) => ws.close(1000, 'Servidor apagándose'));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, () => {
  console.log(`servidor escuchando en el puerto ${PORT}`);
  console.log(`orígenes permitidos: ${ALLOWED_ORIGINS.join(', ')}`);
});