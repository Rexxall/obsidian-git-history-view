# Historical sandbox design

## Product contract

A historical sandbox answers a Vault-wide question that a single-file Diff cannot:
what did the complete note world look like at one commit, and what happens if it
is edited without touching the current workspace?

The lifecycle has two explicit modes:

1. **Read-only capsule** — a locked, detached worktree whose note content has
   write bits removed.
2. **Editable sandbox** — the same isolated worktree after an explicit
   confirmation restores user-write permission.

Neither mode changes the current Vault's HEAD, index, branch, files, or Obsidian
configuration.

## Filesystem and Git boundaries

- Only a fully resolved 40–64 character hexadecimal commit hash is accepted.
- The repository and Vault roots are resolved physically before path
  containment is checked.
- `git worktree add --detach --lock` creates the isolated tree.
- Git commands use `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, and
  `GIT_LFS_SKIP_SMUDGE=1`.
- The historical Vault root must be a normal directory inside the new worktree.
- Managed lifecycle operations require a matching marker inside the sandbox.
  Missing and identity-mismatched directories are never treated as equivalent.
- File reads reject path traversal, symlinks, non-regular files, Vault-external
  paths, and Markdown files above 2 MiB.
- Removal uses `git worktree remove --force` only after the managed marker and
  storage boundary have been verified.

## Obsidian configuration isolation

Historical `.obsidian` content is untrusted executable configuration. The
sandbox removes it from the worktree copy and constructs a minimal configuration:

- historical community plugins are disabled;
- only the current installed Git Note History bundle is copied;
- no plugin `data.json` is copied from the current Vault;
- a CSS snippet displays `只读时间胶囊` or `可编辑历史沙盒` with the source hash;
- the injected plugin reads the local marker and repeats the identity in the
  status bar and startup notice.

The source commit is immutable and remains available through Git; removing its
configuration from the disposable worktree does not rewrite history.

## Opening flow

Obsidian 1.12 cannot open an arbitrary, never-registered folder as a Vault
directly through CLI or URI. The first-open action therefore:

1. copies the sandbox Vault path;
2. opens the official Vault selector;
3. instructs the user to choose “Open folder as vault”.

After that one registration, the manager uses the official
`obsidian://open?path=` URI to open the historical anchor. The plugin does not
silently edit Obsidian's global Vault registry.

## Bringing experiments back

The editable worktree remains isolated. It does not merge or apply itself.

- A tracked Markdown change opens as a frozen comparison against the current
  note. Direct restore is disabled; individual raw hunks or YAML properties can
  be collected into the existing recovery basket.
- The recovery basket retains its normal frozen baseline, conflict checks,
  complete Markdown preview, one-write apply, receipt, and undo behavior.
- A new untracked Markdown note requires an explicit copy confirmation and
  refuses to overwrite any current Vault path.
- `git diff --binary` can be exported with a JSON manifest. Untracked paths are
  listed explicitly because a Git patch does not contain them.

## Lifecycle and failure semantics

- At most eight active and twenty-four total sandboxes are managed.
- Active records can be archived without deleting their locked worktrees.
- Deleting a valid sandbox warns about unexported changes and removes only its
  verified managed worktree.
- A missing directory can be forgotten.
- An existing directory with a missing or mismatched marker is `untrusted`.
  Removing its record never deletes that directory.
- Schema v4 persists records. Malformed, path-inconsistent, or forged records
  are isolated during migration.

## References

- [Git worktree documentation](https://git-scm.com/docs/git-worktree)
- [Obsidian URI documentation](https://help.obsidian.md/Extending%2BObsidian/Obsidian%2BURI)
- [Obsidian forum: opening an unregistered folder remains a feature request](https://forum.obsidian.md/t/open-folder-as-an-obsidian-vault-from-terminal-command-line-cli/111805)
