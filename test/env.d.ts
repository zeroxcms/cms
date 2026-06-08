import type { D1Migration } from 'cloudflare:test';
import type { Env as AppEnv } from '../src/types';

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
      TEST_PUBLISHED_MIGRATIONS: D1Migration[];
    }

  }
}

declare module 'cloudflare:workers' {
  interface ProvidedEnv extends AppEnv {
    TEST_MIGRATIONS: D1Migration[];
    TEST_PUBLISHED_MIGRATIONS: D1Migration[];
  }
}
