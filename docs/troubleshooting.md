Copy a prompt into your AI coding assistant and replace `<vault>` with your vault folder.

## No history appears

```text
Git Note History shows no history for my note. Help me find and fix the cause.
You may inspect and change only <vault>/.obsidian/plugins/git-note-history/. If needed, read only the note I name. Do not access other plugins or notes, or change any note. Do not inspect or change the repository outside that folder; ask me for any needed Git or Obsidian output. Stop and ask before deleting anything.
Check manifest.json, the installed plugin files, and gitExecutable and repositoryRoot in data.json. Ask me to confirm desktop Obsidian 1.13 or later, Git availability, and the exact sidebar message. Distinguish a missing Git program, no repository, no commits, an untracked or ignored note, a staged but uncommitted note, and a note outside the detected repository. Do not initialise, commit, stage, or edit ignore rules. If Git setup is missing, explain the required user action instead of treating it as a plugin bug.
To confirm the fix, have me open a note I know has committed history, click the clock icon, select a version and choose Compare with current. The timeline must show that note’s versions and the comparison must open. If setup is still missing, report that blocker and have me run See an example (no repository needed); its three demo versions should open. A working demo alone does not confirm real history works.
```

## A search stops or older content is missing

```text
Git Note History stops while reading history or searching old content, or cannot find an older sentence. Help me find and fix the cause.
You may inspect and change only <vault>/.obsidian/plugins/git-note-history/. If needed, read only the note I name. Do not access other plugins or notes, or change any note. Do not inspect or change the repository outside that folder; ask me for any needed Git or Obsidian output. Stop and ask before deleting anything.
Check maxCommits in data.json (default 100; settings allow 10–1000), history loading, content-search cancellation and timeout handling in the installed plugin. Ask me for the exact message and whether I stopped the search. Git commands time out after 120 seconds. Distinguish a history limit from a shallow or partial clone, an LFS pointer or a missing object. Do not fetch, repair the repository, remove the timeout or make reads unbounded.
To confirm the fix, have me choose Read again after a stopped read, then search for text I know exists within the loaded history. The expected version should appear. Have me stop a longer search and retry; the interface should respond and retry should load results. If the required Git objects are unavailable, report that limit instead of claiming the text never existed.
```

## A renamed note loses its history

```text
Git Note History treats my moved or renamed note as untracked before I commit the move. Help me find and fix the cause.
You may inspect and change only <vault>/.obsidian/plugins/git-note-history/. If needed, read only the note I name. Do not access other plugins or notes, or change any note. Do not inspect or change the repository outside that folder; ask me for any needed Git or Obsidian output. Stop and ask before deleting anything.
Check manifest.json and the installed rename-detection logic; support for uncommitted moves was added in 0.12.2. Ask me for the old and new relative note names and the sidebar message. The plugin can use a staged Git rename, an identical deleted note, or one clearly closest deleted note with at least half its content retained. With ambiguous candidates it does not guess. Do not stage or commit the move, rename notes or inspect deleted notes outside the allowed scope.
To confirm the fix, have me open the named moved note. For an unambiguous move, its earlier versions should appear with Renamed, and Compare with last commit should use the old path. The working-copy counts should compare against that old version rather than count the whole note as new. If candidates remain ambiguous, explain why no rename was selected.
```

## Restore or undo stops after an edit

```text
Git Note History stops a restore or undo because the note changed. Help me determine whether the safety check is working or there is a bug.
You may inspect and change only <vault>/.obsidian/plugins/git-note-history/. If needed, read only the note I name. Do not access other plugins or notes, or change any note. Do not inspect or change the repository outside that folder; ask me for any needed Git or Obsidian output. Stop and ask before deleting anything.
Ask me for the full message and whether I edited after opening the preview or after the restore. Inspect the plugin’s restore checks and saved undo history, which keeps up to 12 steps. Stopping when the note changes is expected. Keep the guard, settings and undo records intact; do not force a write or reset data.json.
To check the result without changing notes, have me reopen the comparison and restore preview; it should reflect the current named note. Have me try an in-memory restore in See an example (no repository needed); the demo should update while my note stays unchanged. Verify any change-detection fix with in-memory inputs: an unchanged input may proceed and a changed input must stop. If current edits still prevent undo, report that expected limit.
```

Still stuck? [Open an issue](https://github.com/Rexxall/obsidian-git-history-view/issues/new/choose).
