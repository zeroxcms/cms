// Minimal typings for the Node APIs available under the nodejs_compat
// flag that @cloudflare/workers-types does not declare.
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
  }
}
