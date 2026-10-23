'use strict';

/**
 * WebSocket-Hub: verteilt Push-Ereignisse (neue Mails, Ordnerzähler,
 * Kontostatus) an alle offenen Browser-Tabs eines Benutzers.
 */
const { WebSocketServer } = require('ws');

const clients = new Map(); // userId -> Set<ws>

function attach(server, authenticate) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    if (!req.url.startsWith('/ws')) {
      socket.destroy();
      return;
    }
    let user = null;
    try {
      user = await authenticate(req);
    } catch (_) { /* ignore */ }
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.userId = user.id;
      ws.isAlive = true;
      if (!clients.has(user.id)) clients.set(user.id, new Set());
      clients.get(user.id).add(ws);
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('close', () => {
        const set = clients.get(user.id);
        if (set) {
          set.delete(ws);
          if (!set.size) clients.delete(user.id);
        }
      });
      ws.on('message', () => { /* Client sendet nur Pings */ });
      ws.send(JSON.stringify({ t: 'hello' }));
    });
  });

  // Heartbeat, damit Proxies die Verbindung offen halten und tote Sockets verschwinden.
  setInterval(() => {
    for (const set of clients.values()) {
      for (const ws of set) {
        if (!ws.isAlive) { ws.terminate(); continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch (_) { /* ignore */ }
      }
    }
  }, 30000).unref();
}

function send(userId, msg) {
  const set = clients.get(userId);
  if (!set) return;
  const data = JSON.stringify(msg);
  for (const ws of set) {
    if (ws.readyState === 1) ws.send(data);
  }
}

module.exports = { attach, send };
