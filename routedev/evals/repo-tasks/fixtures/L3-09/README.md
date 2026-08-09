# fixture-l3-09

A small config service: `parseConfig` + `loadConfig` + `logger`.

Example:

```ts
const cfg = parseConfig({ name: 'svc' });
log('info', 'started ' + cfg.name);
```
