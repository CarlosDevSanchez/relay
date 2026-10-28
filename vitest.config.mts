import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: { provider: 'v8', include: ['src/main/{paths,codex,store,env,providers,sessions,handoff,validate,usage,pty,limit,prefs,shared,catalog,mcp,cli,rates,registry}.ts', 'src/main/transcript/*.ts', 'src/main/bridge.ts', 'src/shared/usage.ts', 'src/shared/transcript.ts', 'src/shared/screen.ts', 'src/shared/composer.ts'] }
  }
})
