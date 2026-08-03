module.exports = {
  root: true,
  extends: '@react-native',
  overrides: [
    {
      // Test setup and suites run under jest, which supplies these globals.
      files: ['jest.setup.js', '__tests__/**/*'],
      env: {jest: true, node: true},
    },
  ],
};
