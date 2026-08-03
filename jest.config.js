module.exports = {
  preset: '@react-native/jest-preset',
  setupFiles: ['<rootDir>/jest.setup.js'],
  // This is an Android-first app; the preset would otherwise resolve Platform.ios.
  haste: {defaultPlatform: 'android', platforms: ['android', 'native']},
  // react-navigation, react-native-screens and react-native-svg ship untranspiled
  // ESM, so they must go through babel rather than being skipped like the rest
  // of node_modules.
  transformIgnorePatterns: [
    'node_modules/(?!(?:@react-native|react-native|@react-navigation|react-native-screens|react-native-svg|react-native-safe-area-context|react-freeze)/)',
  ],
};
