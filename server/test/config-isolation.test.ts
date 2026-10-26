import { env } from "cloudflare:test"
import { expect, it } from "vitest"

it("exposes only configured test bindings, not operator secrets", () => {
  const expectedBindings = new Set([
    "API_AUTH_RATE_LIMITER",
    "API_READ_RATE_LIMITER",
    "DB",
    "FRESHNESS_THRESHOLD_SECONDS",
    "TEST_MIGRATIONS",
  ])

  const bindingNames = Object.keys(env).filter((name) => !name.startsWith("__VITEST_POOL_WORKERS_"))

  expect(bindingNames.length).toBe(expectedBindings.size)
  expect(bindingNames.every((name) => expectedBindings.has(name))).toBe(true)
  expect(env.DB).toBeDefined()
  expect(env.TEST_MIGRATIONS.length).toBeGreaterThan(0)
})
