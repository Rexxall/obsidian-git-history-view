# History source bus

## Purpose

The source bus answers two separate questions without conflating them:

1. Which history providers may contain versions of this note?
2. Which versions can this plugin actually read and compare now?

Git, an unsaved workspace state, a plugin-local snapshot, File Recovery, and
Obsidian Sync do not have the same durability, identity, retention, or API
surface. The UI therefore presents a capability map first and a mixed direct
version timeline second.

## Source contract

Each adapter declares:

- access: direct, provider handoff, or unavailable;
- confidence: exact commit, captured snapshot, or provider-managed;
- capabilities: list, read, compare, restore, capture, and delete;
- retention and trust boundaries;
- versions that belong only to its own source namespace.

The bus runs adapters independently. A failed provider becomes an error card;
it does not erase readable Git or local versions. Invalid dates, duplicate IDs,
and cross-source records are rejected before the mixed timeline is built.

## Provider boundaries

Git uses the existing read-only client. Workspace content is sampled when the
page refreshes. Plugin-local snapshots are explicit user captures stored in
plugin data with fingerprints and capacity limits.

File Recovery and Obsidian Sync are handoffs. Their private stores are not part
of the public plugin API, so this plugin does not scrape them, infer counts, or
claim their versions are available. The source cards direct the reader to the
native Obsidian surfaces instead.

## Local snapshot limits

- maximum content per snapshot: 2 MB;
- maximum snapshots per note: 12;
- maximum snapshots across the plugin: 96;
- maximum retained snapshot content: 12 MB;
- identical content for the same path is deduplicated;
- fingerprint mismatch, malformed time, or future/invalid record shape is
  rejected during schema migration.

Local snapshots never create Markdown files under `backup/` and therefore
cannot be mistaken for the current note or Git history.
