import { Liquid } from 'liquidjs';

const engine = new Liquid({
  cache: true,
});

export function renderLiquid(template: string, data: Record<string, unknown>): string {
  return String(engine.parseAndRenderSync(template, data));
}
