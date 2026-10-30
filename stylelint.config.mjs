// Mirrors the CSS checks of the Obsidian community directory scorecard, so a release cannot ship a warning it would show.
export default {
  plugins: ["stylelint-no-unsupported-browser-features"],
  rules: {
    "declaration-no-important": true,
    "property-disallowed-list": ["all"],
    "selector-pseudo-class-disallowed-list": ["has"],
    // Obsidian's Chromium; partial support counts as a problem, as it does in the directory.
    "plugin/no-unsupported-browser-features": [true, { browsers: ["Chrome 142"] }],
  },
};
