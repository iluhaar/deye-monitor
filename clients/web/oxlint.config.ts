import cloudflare from '@cloudflare/oxlint-config';
import { defineConfig } from 'oxlint';

export default defineConfig({
  ...cloudflare,
  ignorePatterns: [...(cloudflare.ignorePatterns ?? []), "worker-configuration.d.ts"],
});
