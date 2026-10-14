import config from '../server/src/config';

/** The part of Strapi's env helper used in tests. */
export const fakeEnv = (vars: Record<string, string> = {}) => ({
  bool: (key: string, d: boolean) => (key in vars ? vars[key] === 'true' : d),
  int: (key: string, d: number) => (key in vars ? parseInt(vars[key], 10) : d),
  array: (key: string, d: string[]) => (key in vars ? vars[key].split(',').map((v) => v.trim()) : d),
});

export const defaultConfig = (vars?: Record<string, string>) => config.default({ env: fakeEnv(vars) });
