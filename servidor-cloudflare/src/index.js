// Servidor da Telinha no Cloudflare.
//
// - WebSocket (qualquer caminho): sinalização, compatível com o relay do Trystero
//   (mensagens subscribe / unsubscribe / publish por tópico). Só passam as
//   mensagens curtas para os PCs se encontrarem; voz e vídeo nunca passam aqui.
// - GET /turn: credenciais temporárias do TURN do Cloudflare, usado quando duas
//   redes não conseguem se conectar direto. As chaves ficam só no servidor.
import { DurableObject } from 'cloudflare:workers';

const MAX_MESSAGE = 64 * 1024;
const MAX_TOPICS = 300;
const TURN_TTL = 24 * 60 * 60; // segundos
const APP_HEADER = 'telinha-app-v1-7d3f91c2';

let turnCache = null; // { body, expires }

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const relay = env.RELAY.get(env.RELAY.idFromName('telinha'));
      return relay.fetch(request);
    }
    if (url.pathname === '/turn') return turn(request, env);
    return new Response('Servidor da Telinha em funcionamento.\n', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
};

async function turn(request, env) {
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  if (request.headers.get('x-telinha') !== APP_HEADER) {
    return new Response('{"error":"forbidden"}', { status: 403, headers });
  }
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
    return new Response('{"iceServers":[]}', { headers });
  }
  const now = Date.now();
  if (!turnCache || turnCache.expires - now < 6 * 60 * 60 * 1000) {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TURN_TTL }),
    });
    if (!res.ok) return new Response('{"iceServers":[]}', { status: 502, headers });
    const data = await res.json();
    // A porta 53 é bloqueada pelos navegadores e só atrasaria a conexão.
    const iceServers = (data.iceServers || []).map((server) => ({
      ...server,
      urls: [].concat(server.urls).filter((u) => !/:53(\?|$)/.test(u)),
    })).filter((server) => server.urls.length);
    turnCache = { body: JSON.stringify({ iceServers, expires: now + TURN_TTL * 1000 }), expires: now + TURN_TTL * 1000 };
  }
  return new Response(turnCache.body, { headers });
}

// Um único objeto guarda as conexões de sinalização. Usa a API de hibernação:
// sem mensagens, ele dorme e não gasta nada. Os tópicos de cada conexão ficam
// no "attachment" do próprio WebSocket, então sobrevivem à hibernação.
export class Relay extends DurableObject {
  async fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ topics: [] });
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > MAX_MESSAGE) return;
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg.topic !== 'string' || msg.topic.length > 200) return;

    if (msg.type === 'subscribe' || msg.type === 'unsubscribe') {
      const att = ws.deserializeAttachment() || { topics: [] };
      const topics = new Set(att.topics);
      if (msg.type === 'subscribe') {
        if (topics.size >= MAX_TOPICS) return;
        topics.add(msg.topic);
      } else {
        topics.delete(msg.topic);
      }
      ws.serializeAttachment({ topics: [...topics] });
      return;
    }

    if (msg.type === 'publish' && msg.payload !== undefined) {
      const out = JSON.stringify({ topic: msg.topic, payload: msg.payload });
      for (const socket of this.ctx.getWebSockets()) {
        const att = socket.deserializeAttachment();
        if (att?.topics?.includes(msg.topic)) {
          try { socket.send(out); } catch { /* conexão fechando */ }
        }
      }
    }
  }

  webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, 'tchau'); } catch { /* já fechada */ }
  }

  webSocketError(ws) {
    try { ws.close(1011, 'erro'); } catch { /* já fechada */ }
  }
}
