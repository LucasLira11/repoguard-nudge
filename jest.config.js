/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  // As fixtures contêm package.json próprios (colisão no haste map) e código
  // propositalmente suspeito: o Jest não deve indexá-las nem executá-las.
  modulePathIgnorePatterns: ['<rootDir>/test/fixtures/'],
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/test/fixtures/'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
};
