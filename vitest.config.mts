import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: {
          JWT_SECRET: 'test-jwt-secret',
          ENABLED_PROVIDERS: 'eventuai,github',
          EVENTUAI_CLIENT_ID: 'test-eventuai-client',
          EVENTUAI_CLIENT_SECRET: 'test-eventuai-secret',
          GITHUB_CLIENT_ID: 'test-github-client',
          GITHUB_CLIENT_SECRET: 'test-github-secret',
          OAUTH_REDIRECT_URI: 'https://cms.eventuai.com/auth/callback',
          CANONICAL_ORIGIN: 'https://cms.eventuai.com',
          SITE_TITLE: 'Worker CMS',
          TEST_MIGRATIONS: await readD1Migrations(path.join(rootDir, 'migrations')),
          TEST_PUBLISHED_MIGRATIONS: await readD1Migrations(path.join(rootDir, 'migrations/published')),
        },
      },
    })),
  ],
  test: {
    setupFiles: ['./test/setup.ts'],
  },
});
