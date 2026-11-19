import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations, SITE_URL: 'http://app.test', ALLOWED_EMAILS: '', DEFAULT_RETENTION_DAYS: '30', SHARD_PERIOD: 'day', INGEST_HOSTS: 'ingest.test' } },
    })],
    test: { setupFiles: ['./tests/setup.ts'], include: ['tests/**/*.test.ts'] },
  };
});
