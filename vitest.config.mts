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
          JWT_SECRET: 'test-jwt-secret-0123456789abcdef0123456789abcdef',
          ENABLED_PROVIDERS: 'eventuai,github,google,microsoft,apple',
          EVENTUAI_CLIENT_ID: 'test-eventuai-client',
          EVENTUAI_CLIENT_SECRET: 'test-eventuai-secret',
          GITHUB_CLIENT_ID: 'test-github-client',
          GITHUB_CLIENT_SECRET: 'test-github-secret',
          GOOGLE_CLIENT_ID: 'test-google-client',
          GOOGLE_CLIENT_SECRET: 'test-google-secret',
          MICROSOFT_CLIENT_ID: 'test-microsoft-client',
          MICROSOFT_CLIENT_SECRET: 'test-microsoft-secret',
          APPLE_CLIENT_ID: 'test.apple.client',
          APPLE_CLIENT_SECRET: 'test-apple-secret',
          OAUTH_REDIRECT_URI: 'https://cms.eventuai.com/auth/callback',
          CANONICAL_ORIGIN: 'https://cms.eventuai.com',
          SITE_TITLE: '0xCMS',
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
