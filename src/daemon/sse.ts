// SSE hub: attach/send/broadcast/ping over a plain node:http response.
import type { ServerResponse } from "node:http";

export class SseHub {
  private clients = new Set<ServerResponse>();
  onChange?: () => void;

  get size(): number {
    return this.clients.size;
  }

  attach(res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": ok\n\n");
    this.clients.add(res);
    res.on("close", () => {
      this.clients.delete(res);
      this.onChange?.();
    });
    this.onChange?.();
  }

  send(res: ServerResponse, event: string, data: unknown): void {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* client gone; its close handler cleans up */
    }
  }

  broadcast(event: string, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const r of this.clients) {
      try {
        r.write(frame);
      } catch {
        /* ignore */
      }
    }
  }

  ping(): void {
    for (const r of this.clients) {
      try {
        r.write(": ka\n\n");
      } catch {
        /* ignore */
      }
    }
  }

  closeAll(): void {
    for (const r of this.clients) {
      try {
        r.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }
}
