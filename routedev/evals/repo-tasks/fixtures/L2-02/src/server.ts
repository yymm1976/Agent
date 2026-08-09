// src/server.ts
// 服务启动器：消费 timeoutSeconds 作为请求超时
export interface ServerOptions {
  name: string;
  timeoutSeconds: number;
}

export function startServer(opts: ServerOptions): { name: string; timeoutSeconds: number } {
  return { name: opts.name, timeoutSeconds: opts.timeoutSeconds };
}
