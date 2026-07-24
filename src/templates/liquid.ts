import { currentCspNonce } from '../utils/request-context';

export interface ClientView {
  __cmsClientView: true;
  viewPath: string;
  data: Record<string, unknown>;
  plugin?: boolean;
  viewBasePath?: string;
  viewRevision?: string;
  /** Mirrors the plugin manifest's `i18n` opt-in: the client only fetches
   *  `<viewBasePath>/locales/*.json` for plugins that ship catalogs. */
  i18n?: boolean;
}

export type RenderedView = string | ClientView;

export function isClientView(value: RenderedView): value is ClientView {
  return typeof value === 'object' && value !== null && (value as ClientView).__cmsClientView === true;
}

export async function renderView(
  _views: Fetcher,
  viewPath: string,
  data: Record<string, unknown>,
): Promise<ClientView> {
  return {
    __cmsClientView: true,
    viewPath,
    data: withRequestGlobals(data),
  };
}

export function pluginClientView(
  viewPath: string,
  data: Record<string, unknown>,
  viewBasePath?: string,
  viewRevision?: string,
  i18n?: boolean,
): ClientView {
  return {
    __cmsClientView: true,
    viewPath,
    data: withRequestGlobals(data),
    plugin: true,
    viewBasePath,
    viewRevision,
    i18n: i18n === true,
  };
}

/** Inject request-scoped globals (the CSP nonce) every template can rely on. */
function withRequestGlobals(data: Record<string, unknown>): Record<string, unknown> {
  return { nonce: currentCspNonce(), ...data };
}
