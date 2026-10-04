// Servidor de sinalização opcional da Telinha.
// Só repassa mensagens curtas de conexão entre quem está na mesma sala;
// o vídeo nunca passa por aqui.
import http from 'node:http';
import { createWsRelayServer } from '@trystero-p2p/ws-relay/server';

const port = Number(process.env.PORT) || 8080;

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Servidor da Telinha em funcionamento.\n');
});

const relay = createWsRelayServer({
  server,
  maxPayload: 64 * 1024,
  onError: (error) => console.error('Erro no relay:', error.message),
});

server.listen(port, () => {
  console.log(`Servidor de sinalização ouvindo na porta ${port}`);
});

setInterval(() => {
  console.log(`Conexões ativas: ${relay.wss.clients.size}`);
}, 10 * 60 * 1000).unref();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await relay.close().catch(() => {});
    server.close(() => process.exit(0));
  });
}
