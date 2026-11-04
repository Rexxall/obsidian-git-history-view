# Contributing

```bash
npm ci
npm run build          # type-check, then src/ -> main.js
npm run lint           # Obsidian's lint rules on src/, stylelint on the CSS
npm test               # builds styles.css from styles/, then runs Vitest
npm run check          # build, lint and tests together
npm run release:check  # check, release zip and a byte check of the build
```

The integration tests create throwaway Git repositories, so Git must be installed. `styles.css` is generated: edit `styles/` and commit the rebuilt file with it. Versions are in [CHANGELOG.md](CHANGELOG.md); the release checklist is in [RELEASING.md](RELEASING.md).

The README promises that the plugin only reads Git and never touches the network (*Safety and privacy*). Open an issue first for any change that would alter that, and update the *What the plugin touches* table in both READMEs when a change adds a new kind of access.

CI runs lint, tests and a build on every push to `main` and every pull request, and fails if the committed `styles.css` differs from the build. Pushing a version tag such as `0.12.2` runs the release workflow: it checks the tag against the version files, runs `release:check`, attests `main.js`, `manifest.json` and `styles.css`, and creates the release with that version's CHANGELOG section as its notes.

## Issues

Report bugs and ideas in [GitHub Issues](https://github.com/Rexxall/obsidian-git-history-view/issues). For a bug, include the plugin and Obsidian versions, your OS, `git --version`, and what the sidebar says. Do not paste private note content; a short made-up note that shows the problem is enough.
