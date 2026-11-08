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
  selected folder is expanded or a selection is resolved, not only those that fail at read time.
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
limit left out), and the decision to ask is made on the Include result: a copy whose Exclude result has no
non-text file but whose Include result would carry some (for example text files filling the limit first under
Exclude) still asks. (Found by deep testing: the dialog said 40 files while 30 were copied, and with text files
first the images were dropped without a dialog.)

Buttons: **Include** (default focus), **Exclude** (today's behaviour: non-text files are left out) and
**Cancel** (nothing is copied). Include is disabled, with the reason shown, when the estimate is over the
whole-payload limit; focus then starts on Exclude. Esc is Cancel. The choice is not remembered.

Counts in UI text are phrased so they read correctly for 1 and for many (e.g. "Non-text files copied as Base64:
1."), unless the platform has plural support. Long paths ellipsize; sizes never wrap.

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
  and the detail pane. The file name keeps priority in the row: notes shrink or drop before the name does, and
  30–60 character names that share a prefix stay distinguishable.
- Commits replay writes and commits the decoded bytes, after the same length and SHA-256 check.
- The whole-payload limit on paste counts the payload as the parser sees it: each CRLF pair counts as one byte (a
  Windows clipboard must not push a valid payload over the limit), but a lone CR counts in full (it must not let
  oversized input bypass the limit).
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
    Include payload; 30 text files ordered before 5 images still ask and report what the limit left out.
16. Unreadable files dropped during folder expansion (chmod 000 file and folder, dangling symlink) are named in
    the completion notice.
17. CRLF growth near the whole-payload limit is accepted on paste; lone CRs past the limit are refused.
18. Base64 strictness is the same in all implementations: missing padding, non-zero trailing bits and characters
    outside the alphabet (other than ASCII whitespace) make the entry corrupt.

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
- Deep testers, round 1: commits-mode deletion of non-text files (pre-existing); dialog vs file-count limit
  (spec gap); placeholder-shaped text (spec gap); long-name readability in the preview.
