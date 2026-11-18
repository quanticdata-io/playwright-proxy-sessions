import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * A test proxy on 127.0.0.1 that answers absolute-form requests itself:
 * `http://echo.test/...` gets an IP echo for a fixed exit, any other host gets
 * a page that prints what the browser reports (timezone, language). It
 * requires `user:pass` and can be told to block every page with 403.
 */
export interface TestProxy {
  url: string;
  port: number;
  hits: string[];
  block: boolean;
  close(): Promise<void>;
}

export interface Exit {
  ip: string;
  countryCode: string;
  timezone: string;
  latitude: number;
  longitude: number;
}

const PAGE = `<!doctype html><title>t</title><pre id="out"></pre><script>
document.getElementById('out').textContent = JSON.stringify({
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  language: navigator.language,
});
</script>`;

export async function startProxy(exit: Exit, credentials = { username: 'user-session-1', password: 'p@ss:1' }): Promise<TestProxy> {
  const state: TestProxy = { url: '', port: 0, hits: [], block: false, close: async () => {} };
  const expected = 'Basic ' + Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
  // Sockets that came in through an authenticated CONNECT: their requests are
  // origin-form and carry no proxy credentials.
  const tunnelled = new WeakSet<Socket>();
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const inTunnel = tunnelled.has(req.socket);
    if (!inTunnel && req.headers['proxy-authorization'] !== expected) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="test"' }).end();
      return;
    }
    const url = inTunnel ? new URL(req.url ?? '/', `http://${req.headers.host}`) : new URL(req.url ?? '/', 'http://invalid');
    state.hits.push(`${url.host}${url.pathname}`);
    if (url.host === 'echo.test') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ type: 'response', payload: exit }));
    } else if (state.block) {
      res.writeHead(403, { 'Content-Type': 'text/html' }).end('<h1>blocked</h1>');
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
    }
  });
  // CONNECT (used by Playwright's request client even for http:// URLs): answer
  // 200 and serve the tunnel with this same server, as if we were the target.
  server.on('connect', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (req.headers['proxy-authorization'] !== expected) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\n\r\n');
      return;
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    tunnelled.add(socket);
    if (head.length) socket.unshift(head);
    server.emit('connection', socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = (server.address() as AddressInfo).port;
  state.url = `http://${encodeURIComponent(credentials.username)}:${encodeURIComponent(credentials.password)}@127.0.0.1:${state.port}`;
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}
