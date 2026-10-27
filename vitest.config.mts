import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: { provider: 'v8', include: ['src/main/{paths,store,env,providers,sessions,handoff,validate,usage,pty,limit,prefs}.ts'] }
  }
})
