import * as net from 'node:net';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { socketPathFor } from './socketPath';

export type Handler = (req: any) => Promise<void>;

/**
 * Unix-socket server the hook shim connects to.
 *
 * Requests are serialised: Claude Code can issue several file writes in one
 * turn, and watching them animate one after another is the whole point. Each
 * connection is held open for the duration of its animation — that block is
 * what gives us time to type before the real write lands.
 */
export class HookServer implements vscode.Disposable {
  private server: net.Server | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly projectDir: string,
    private readonly handle: Handler,
    private readonly log: vscode.OutputChannel
  ) {}

  start(): void {
    const path = socketPathFor(this.projectDir);

    // A previous window that didn't shut down cleanly leaves the socket file
    // behind. Binding would fail with EADDRINUSE, so clear it first.
    try {
      fs.unlinkSync(path);
    } catch {
      /* not there, which is the normal case */
    }

    this.server = net.createServer((sock) => this.onConnection(sock));
    this.server.on('error', (err) => this.log.appendLine(`server error: ${err}`));
    this.server.listen(path, () => this.log.appendLine(`listening on ${path}`));
  }

  private onConnection(sock: net.Socket): void {
    let buf = '';
    sock.on('error', () => sock.destroy());

    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;

      let req: any;
      try {
        req = JSON.parse(buf.slice(0, nl));
      } catch (e) {
        this.log.appendLine(`bad request: ${e}`);
        sock.end('{"status":"skipped"}\n');
        return;
      }
      buf = '';

      // Chain onto the queue so animations never overlap.
      this.queue = this.queue
        .then(() => this.handle(req))
        .catch((e) => this.log.appendLine(`animation failed: ${e}`))
        .then(() => {
          try {
            sock.end('{"status":"done"}\n');
          } catch {
            /* hook gave up and disconnected */
          }
        });
    });
  }

  dispose(): void {
    this.server?.close();
    try {
      fs.unlinkSync(socketPathFor(this.projectDir));
    } catch {
      /* already gone */
    }
  }
}
