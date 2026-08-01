import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RemoteRouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  params: Record<string, string>;
  url: URL;
}

export type RemoteRouteHandler = (context: RemoteRouteContext) => void | Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  parameterNames: string[];
  handler: RemoteRouteHandler;
}

function compilePath(path: string): { pattern: RegExp; parameterNames: string[] } {
  const parameterNames: string[] = [];
  const source = path
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) {
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      parameterNames.push(segment.slice(1));
      return '([^/]+)';
    })
    .join('/');
  return { pattern: new RegExp(`^${source}/?$`), parameterNames };
}

export class RemoteRouter {
  private readonly routes: Route[] = [];

  add(method: string, path: string, handler: RemoteRouteHandler): this {
    const compiled = compilePath(path);
    this.routes.push({
      method: method.toUpperCase(),
      pattern: compiled.pattern,
      parameterNames: compiled.parameterNames,
      handler,
    });
    return this;
  }

  async dispatch(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const method = request.method?.toUpperCase() ?? 'GET';
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(url.pathname);
      if (!match) continue;
      const params = Object.fromEntries(route.parameterNames.map((name, index) => [
        name,
        decodeURIComponent(match[index + 1] ?? ''),
      ]));
      await route.handler({ request, response, params, url });
      return true;
    }
    return false;
  }
}
