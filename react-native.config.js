// Bundles the Poppins family (SIL OFL 1.1, see assets/fonts/OFL.txt) so the UI does not fall
// back to the platform default. Typography is the single biggest lever on how finished the app
// feels, and Roboto reads as "unstyled Android" no matter how the rest is composed.
module.exports = {
  project: { android: {}, ios: {} },
  assets: ['./assets/fonts'],
};
