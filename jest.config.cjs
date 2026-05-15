module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.js'],
  moduleNameMapper: {
    '^whatsapp-rust-bridge$': '<rootDir>/test/__mocks__/whatsapp-rust-bridge.js',
  },
}
