# ClipCode: copying non-text files

Shared spec for the four ClipCode implementations: OpenIDEA (`crates/ide-clip`), the IntelliJ plugin, the VS
Code plugin and the Orca fork. A payload copied by any of them must paste the same way on the others, on macOS,
Windows and Linux. OpenIDEA is built first, and its `crates/ide-clip/fixtures/clipboard-contract.json` cases are
the reference the other three copy.

Terms follow [GLOSSARY.md](../../GLOSSARY.md): a **non-text file** is one whose bytes contain a NUL or are not
strict UTF-8 (images, archives, Big5 or UTF-16 text). Before this change every copy dropped them, so syncing a
project with a `static/` folder of images lost the images.

## What is carried

- Every non-text file the copy reaches is carried byte for byte as Base64, when the user agrees (see
  [Asking the user](#asking-the-user)).
- Files that cannot be read (permission denied, dangling symlink, a directory that cannot be listed) are still
  skipped. The completion notice counts them and names the first few paths, including those dropped while a
  selected folder is expanded or a selection is resolved, not only those that fail at read time. A selected
  folder that cannot be listed is skipped and named like any other unreadable item; it never fails the whole copy.
- A symlink to a directory is not followed; it is counted and named as skipped (reason: symlinked folder). This
  holds whether the symlink is selected directly (alone or in a multi-selection) or found while a selected folder
  is expanded; a project tree that shows the symlink as a folder does not change this. A symlink to a file is
  followed and carries the target's bytes. (Found by deep testing round 3: a directly selected symlinked folder
  was followed and its contents copied.)
- A file whose name cannot be carried portably (it contains `\`, `"`, a tab or another character the payload path
  rules reject) is skipped and named with that reason and its real name, not reported as unreadable.
- **Exclude** keeps today's result exactly, including today's "Nothing to copy" when nothing but size
  placeholders would be copied from a files selection.
- File modes (the executable bit) and Git LFS are out of scope: text files carry neither today.
- Deleted entries (`[DELETED]`) keep today's body: paste deletes the file and never reads it.

## Size limits

| Limit                    | Default | Setting key                                       | Measured on        |
| ------------------------ | ------- | ------------------------------------------------- | ------------------ |
| Text file                | 500 KB  | `maxFileSizeKB` (existing)                        | raw bytes          |
| Non-text file            | 2 MB    | `maxNonTextFileSizeKB` (new, positive number, KB) | raw bytes          |
| Whole payload (OpenIDEA) | 50 MiB  | none (constant)                                   | serialized payload |

- A file larger than both per-file limits is not read; it becomes today's size placeholder.
- Any other file is read and classified, then held to its own limit: a 700 KB `.json` is over the text limit, a
  700 KB `.png` fits the non-text one. Over its limit, it becomes today's placeholder
  (`// File skipped: size exceeds limit (<n> bytes)`).
- The whole-payload limit is a technical ceiling, not a warning. Below it nothing is blocked; the dialog shows the
  estimated size so the user knows what is coming.

## Asking the user

Whenever a copy (files and folders, Git working or staged changes, or commits) finds at least one non-text file
within its limit, it asks before writing the clipboard. A copy without non-text files never asks.

The dialog shows:

- how many non-text files were found and their total raw size;
- the estimated payload size with them included;
- the first 10 paths with their sizes, then "and N more";
- how many non-text files are over the non-text limit and will not be copied.

- how many files over both per-file limits were not read (their kind is unknown) and are copied as size
  placeholders.

Every number, path and the estimate describe exactly what **Include** would put on the clipboard, after the
file-count limit (`setMaxFileCount` / `fileCountLimit`) is applied. Non-text files count toward that limit like
text files, in the copy's normal file order. When the limit cuts files off, the dialog says so (how many files the
limit left out), and the decision to ask is made on the Include result: the dialog appears exactly when
Include would carry at least one non-text file. When files ordered first fill the limit so that Include would
carry no non-text file, Include and Exclude are the same payload, so there is no dialog; the completion notice
still says how many files the limit left out. The count, the list, the left-out number and the estimate are
derived from the Include result itself (the same ordered entry list and the same counting of size placeholders
and unreadable items toward the limit that the Include copy uses), not from a parallel estimate kept while the
Exclude copy runs; the dialog and the Include notice must agree.
(Found by deep testing: the dialog said 40 files while 30 were copied; in round 3 it said 31 non-text files and
11 left out while Include carried 29 and left out 13, with size placeholders in the selection.)

Buttons: **Include** (default focus), **Exclude** (today's behaviour: non-text files are left out) and
**Cancel** (nothing is copied). Include is disabled, with the reason shown, when the estimate is over the
whole-payload limit; focus then starts on Exclude. Esc is Cancel. The choice is not remembered.

Counts in UI text are phrased so they read correctly for 1 and for many (e.g. "Non-text files copied as Base64:
1."), unless the platform has plural support. Long paths are shortened in the middle so the file name stays
visible (e.g. `d11long/a-really-long…/name-alpha.png`): the folder part shrinks first, down to its first segment
and an ellipsis, before any character of the file name is dropped; a file name that alone does not fit is itself
shortened in the middle, keeping its extension. Sizes never wrap. Notices that list several categories (e.g.
Unreadable, Symlinked folder, Name not portable) show one category per line. After Include, the completion notice
says "Unreadable" for what was skipped, not "non-text file or unreadable".

UI text says "non-text file" (Simplified zh: 非文本文件; Traditional zh: 非文字檔), never "binary file" or "non-UTF-8 file".

## Files-mode wire format

A non-text entry's body is a placeholder line followed by the Base64 of the raw bytes (values below are
illustrative):

```text
// file: public/static/logo.png
// File skipped: non-text file, 4128 bytes, sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08; base64 follows
iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACx
jwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAZdEVYdFNvZnR3YXJlAHBhaW50Lm5ldCA0LjAu
...
```

- The first body line matches exactly
  `^// File skipped: non-text file, (\d+) bytes, sha256 ([0-9a-f]{64}); base64 follows$`
  (after stripping a trailing `\r`). Size is the raw byte count in decimal; the hash is lowercase hex SHA-256 of
  the raw bytes.
- The Base64 is standard (RFC 4648 §4, `A–Z a–z 0–9 + /`, `=` padding), wrapped at 76 characters per line.
- The body goes through the same content escaping as any other body (`//clipcode-esc: ` before header-shaped
  lines), and the reader un-escapes before decoding. Base64 has no space or `:`, so the built-in header pattern
  cannot match it; the escaping covers a loose custom `headerFormat`.
- Header labels (`[NEW]`, `[MOVED]`, ...) and the `clipcode-root` line work as for text entries.
- A **text** entry whose first body line matches the placeholder pattern above (a real text file that happens to
  start with that line) is escaped on copy: the writer prefixes that first line with `//clipcode-esc: `. The
  reader tests for the non-text placeholder on the raw first line, before un-escaping, so an escaped line is
  never decoded; after un-escaping, the text is restored as written. (Found by deep testing: without this, such a
  text file was pasted as the 3 decoded bytes.)

### Why the placeholder prefix

All four readers skip any entry whose first body line starts with `// File skipped: ` (OpenIDEA
`is_placeholder_body`, IntelliJ `RestorePlan.kt`, VS Code `restore.ts`, Orca). A reader that predates this spec
therefore skips a non-text entry instead of writing Base64 text into `logo.png`. The four implementations need
not release on the same day.

## Commits-mode wire format (OpenIDEA only)

Only OpenIDEA implements commits mode (`// snip-sync commits v1`). The marker stays `v1`. A non-text file keeps
`"content": null` and its `notCopied` reason (`BINARY` or `NON_UTF8`), and gains one field:

```json
{
  "path": "img/logo.png",
  "oldPath": null,
  "change": "ADDED",
  "content": null,
  "notCopied": "BINARY",
  "nonText": { "size": 4128, "sha256": "9f86…0a08", "base64": "iVBORw0KGgo…" }
}
```

- `base64` is unwrapped (JSON has no line-length concern).
- An older OpenIDEA ignores the unknown field and skips the file as not copied, exactly as today. Putting Base64
  in `content` would make it commit the Base64 text, so that is never done.
- **Deletions and renames of non-text files are replayed whatever the mode.** A deletion needs no content: the
  replay deletes the path (and a rename moves it) even without `nonText`. Before this spec, a deleted non-text
  file was marked `notCopied` and the replay skipped it, so a commit that deleted an image left the image in
  place (pre-existing behaviour found by deep testing; fixed together with this feature).
- Several commits are replayed as one sequence: a later commit may rewrite a path an earlier commit of the same
  batch wrote as non-text (for example Big5 → UTF-8), and that rewrite must not be refused by the non-UTF-8
  overwrite guard.
- The replay preview labels a non-text row "non-text file · <size>" and a corrupt one with a Corrupt badge; it
  never shows the raw `notCopied` enum (`BINARY`, `NON_UTF8`).

## Pasting

- Recognize the placeholder line above before the generic placeholder check, or the entry is skipped.
- Remove every ASCII whitespace character (`\r`, `\n`, space, tab) from the Base64 lines, decode strictly, then
  compare length and SHA-256 with the placeholder line. Any mismatch or decode error skips that file and lists it
  in the result as corrupted; the rest of the paste continues.
- The non-UTF-8 overwrite guard (OpenIDEA `must_not_overwrite`) does not apply: the bytes are written as is. An
  existing target follows the same overwrite option as a text entry. A target whose bytes already equal the
  decoded bytes is reported unchanged and not written.
- The paste preview shows a non-text entry as "non-text file · 4.0 KB" and, for an existing target, whether it
  is identical or different. It never shows the Base64 or a diff.
- An identical target shows an **Unchanged** badge, is not counted in "Overwrite all N existing files", and needs
  no overwrite permission.
- A corrupt entry shows a **Corrupt** badge (not a long inline note), with "Corrupt non-text file" in the tooltip
  and the detail pane. The file name keeps priority in the row, in flat and nested (indented) rows alike: badges
  and notes shrink or drop before the name does, a name that still does not fit is shortened in the middle
  keeping its extension, and 30–60 character names that share a prefix stay distinguishable.
- Commits replay writes and commits the decoded bytes, after the same length and SHA-256 check.
- A **text** write over an existing non-UTF-8 file stays refused by the non-UTF-8 overwrite guard, outside the
  batch case in [Commits-mode](#commits-mode-wire-format-openidea-only) (decided by the user, deep round 3). The
  preview shows the reason in user text ("Existing file is not UTF-8; not overwritten"). A replayed commit whose
  every file change was refused or skipped is not created as an empty commit: the replay names it as not created,
  with the reason, and continues with the next commit.
- Read-only targets (mode 444) follow the overwrite option like any other existing file, with no extra note; this
  is today's behaviour for text files too (decided by the user, deep round 3: keep as is).
- The whole-payload limit on paste counts the payload as the parser sees it: each CRLF pair counts as one byte (a
  Windows clipboard must not push a valid payload over the limit), but a lone CR counts in full (it must not let
  oversized input bypass the limit).
- One entry that cannot be applied (its target path is a directory, a parent is not writable, two entries map to
  the same file on a case-insensitive file system such as `IMG.png` and `img.png` on APFS) skips that row (for a
  collision: every colliding row) with its reason in user text; the rest of the paste continues. It never aborts
  the whole paste. A row that fails while writing counts as skipped in the notice title, not only in its body.
  (Case-only collisions aborted the whole paste with the raw `IpcError: target collision` text before this spec:
  pre-existing, found by deep testing round 3.)
- The paste and replay previews never show raw reason codes (`BINARY`, `NON_UTF8`, `NON_UTF8_TARGET`); each
  reason has user text.
- Known, not handled: with `core.autocrlf=true` in the destination repository, git's own line-ending conversion
  can rewrite a committed non-text file that has no NUL (e.g. Big5 with CRLF); the working-tree file is correct.
  This is git's documented behaviour for that setting and applies to text files too.

## Required test cases

Each implementation adds these to its contract tests (OpenIDEA: `clipboard-contract.json`):

1. PNG with NUL bytes round-trips byte for byte.
2. Big5 text file (no NUL, invalid UTF-8) round-trips byte for byte.
3. A 1-byte `0x00` file round-trips (an empty file is text and stays a text entry).
4. Payload with CRLF line endings (Windows clipboard) still decodes.
5. Base64 line that is header-shaped under a custom `headerFormat` round-trips through escaping.
6. Truncated Base64 and a wrong SHA-256 each skip only that file and report it.
7. Non-text file over `maxNonTextFileSizeKB` becomes a size placeholder; 700 KB text over `maxFileSizeKB` does too
   while a 700 KB non-text file is carried.
8. A reader without this feature (the previous release) skips the entry and leaves the target untouched.
9. Existing identical target is unchanged; existing different target follows the overwrite option.
10. Commits mode: a commit adding an image replays with the image; an older reader skips it.
11. Exclude in the dialog produces today's payload byte for byte.
12. A text file whose first line is a valid-looking non-text placeholder round-trips as the original text.
13. Commits mode: image added, modified, then deleted across three commits replays to the same tree as the
    source (the deletion happens); a rename of an image moves it.
14. Commits mode: Big5 file rewritten as UTF-8 in a later commit of the same batch keeps the rewrite.
15. File-count limit: 40 small images with a limit of 30 — the dialog's count, list and estimate match the
    Include payload; the same with size placeholders in the selection (a folder with files over both limits
    plus 40 images): dialog numbers equal the Include payload and notice. 30 text files ordered before 5 images:
    no dialog, and the notice reports 5 left out by the limit.
16. Unreadable files dropped during folder expansion (chmod 000 file and folder, dangling symlink) are named in
    the completion notice.
17. CRLF growth near the whole-payload limit is accepted on paste; lone CRs past the limit are refused.
18. Base64 strictness is the same in all implementations: missing padding, non-zero trailing bits and characters
    outside the alphabet (other than ASCII whitespace) make the entry corrupt.
19. A selected unreadable folder plus a readable file: the file is copied, the folder is named as unreadable.
20. Paste where a target path is a directory: only that row is skipped; the others restore.
21. Names shown in the dialog and preview: three 58–60 character names sharing a prefix are distinguishable; a
    file under a 150-character folder path shows its whole file name (extension included) in the dialog and in a
    nested preview row with an Unchanged badge.
22. A symlink to a folder selected directly (alone and in a multi-selection) is not followed and is named as a
    symlinked folder.
23. A payload with `IMG.png` and `img.png` pasted on a case-insensitive file system skips both with a collision
    reason and restores the other entries.
24. Commits replay of a single commit whose only change is refused by the non-UTF-8 guard: the preview shows the
    reason, no empty commit is created, later commits of the replay still apply.

## Open items for the other implementations

- `clipboard-contract.json` is generated by `ClipCodeVSCode/scripts/gen-contract-fixtures.cjs`; its
  `nonTextBuildCases` / `nonTextRestoreCases` were added in OpenIDEA by hand. Teach the generator these sections
  (and cases 12–18) before regenerating, or they are lost.

## Change log

Each review or test round folds its findings back into this spec.

- Round 1 review (3 Opus lenses + Codex): commits batch rewrite (Big5 → UTF-8) kept; Exclude keeps "Nothing to
  copy"; CRLF counting on the paste limit. Round 2 (Codex): lone CR must count. Round 3 (Codex): approved.
- Hands-on testers, round 1: identical targets as Unchanged; corrupt rows and replay preview labels; count
  phrasing for 1; long paths; focus when Include is disabled. Round 2: unreadable paths from folder expansion;
  Corrupt badge instead of a squeezed note.
- Codex review round 4 (approved by the user): five findings, all confirmed and all in code this branch added:
  a non-text rename chain bypassed overwrite consent; a custom `headerFormat` made a real non-text entry paste as
  text; a skipped rename aborted the replay; a fully refused source group crashed the copy; a folder symlink to
  the project root was followed. Fixed.
- Deep testers, round 4 (three testers, D1–D18): D1–D10 pass for all three. Open: (1) spec hole — under a custom
  `headerFormat` that matches the placeholder line (e.g. `// $FILE_PATH`), a real placeholder (header escape) and a
  placeholder-shaped text line (placeholder escape) both carry one `//clipcode-esc: ` prefix, so the reader
  cannot tell them apart (text pasted as decoded bytes or reported Corrupt); escape rule pending the user. (2) A
  header format with no fixed prefix (`$FILE_PATH`) cannot be escaped at all: Base64 lines become file headers
  (text payloads break the same way, pre-existing). (3) Over the whole-payload limit the dialog's estimate is the
  size where planning stopped, below the raw total (introduced by the round 3 fix). (4) Badges shrunk to an 8 px
  sliver instead of dropping. (5) A row's reason can be a raw OS error (`Permission denied (os error 13)`).
- Deep testers, round 3 (three testers, D1–D17 matrix): a directly selected symlinked folder was followed (code
  did not match the rule; rule now says "selected or expanded"); dialog numbers disagreed with Include when size
  placeholders shared the file-count limit (code bug in the round 2 fix); dialog paths and nested preview rows cut
  the file name's end instead of the folder part (round 2 fix incomplete; rule made concrete); notice categories
  ran together on one line; text-first file-count case clarified (no dialog, notice reports what was left out);
  case-only path collisions abort the paste (pre-existing); a failed write row was not counted as skipped.
  User decisions: the Big5 → UTF-8 rewrite outside a batch stays refused, with the reason shown and no empty
  commit; read-only (444) targets keep today's behaviour (replaced under the overwrite option, no note).
- Deep testers, round 2 (three testers, D1–D13 matrix): selected unreadable folder fails the copy
  (pre-existing); directory at a target path aborts the paste (pre-existing); symlinked folders silently dropped
  (pre-existing); non-portable names reported as unreadable; raw reason codes in previews; middle ellipsis for
  long paths; Include notice wording. Open for the user: a Big5 → UTF-8 rewrite outside a batch is refused by the
  non-UTF-8 overwrite guard; read-only (444) targets are replaced without a note (text files too).
- Deep testers, round 1: commits-mode deletion of non-text files (pre-existing); dialog vs file-count limit
  (spec gap); placeholder-shaped text (spec gap); long-name readability in the preview.
