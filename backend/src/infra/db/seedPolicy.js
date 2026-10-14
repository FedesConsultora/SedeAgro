export function demoSeedEnabled(environment = process.env) {
  return environment.NODE_ENV !== 'production' && environment.SEED_MODE === 'demo';
}

export function assertDemoSeedConfig(environment = process.env) {
  if (!demoSeedEnabled(environment)) {
    throw new Error('Demo seeding requires a non-production environment and SEED_MODE=demo.');
  }
  if (typeof environment.DEMO_PASSWORD !== 'string' || environment.DEMO_PASSWORD.length < 12) {
    throw new Error('DEMO_PASSWORD must be at least 12 characters for demo seeding.');
  }
  return environment.DEMO_PASSWORD;
}
