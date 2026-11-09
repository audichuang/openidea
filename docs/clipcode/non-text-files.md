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
  folder that cannot be listed is skipped and named like any other unreadable item; it never fails the whole copy
  (selected alone, nothing is left to copy: see "Nothing to copy" below).
- A symlink to a directory is not followed; it is counted and named as skipped (reason: symlinked folder). This
  holds whether the symlink is selected directly (alone or in a multi-selection) or found while a selected folder
  is expanded; a project tree that shows the symlink as a folder does not change this. (Found by deep testing
  round 3: a directly selected symlinked folder was followed and its contents copied.) The copy root itself
  (project, workspace or worktree root) is walked even when it is reached through a symlink; only symlinked
  folders below or beside it are refused.
- A symlink to a file is followed and carries the target's bytes when its target lies inside a copy root; a target
  outside every root is skipped and named as Unreadable (decided by the user, X7: the clipboard often goes to an
  LLM, so a link such as `CLAUDE.md -> ~/.agents/...` must not carry a file from outside the project). A
  Git-tracked symlink (mode 120000) to a file follows the same rule as any symlink to a file; paste writes a
  regular file (links are not carried, like file modes).
- Classification uses the bytes only, never an IDE file type: a file whose bytes are strict UTF-8 without a NUL
  is text, whatever the IDE calls it.
- In a files and folders copy, a file or folder whose name is not portable is skipped and named under "Name not
  portable" with its real name, not reported as unreadable. The check is OpenIDEA's `is_exportable_relative_path`
  (`crates/ide-clip/src/paths.rs`) applied to the file's path relative to its copy root, segments joined with `/`.
  The path is not portable when:
  - a name in it is not valid UTF-8 (Windows: not valid UTF-16);
  - a segment is `..`;
  - a segment contains `<`, `>`, `:`, `"`, `|`, `?`, `*`, `\` (on Unix, where it is not a separator) or a control
    character U+0000–U+001F (tab and newline included);
  - the whole path starts or ends with ASCII whitespace (space, tab, LF, VT, FF, CR): a trailing space on the file
    name fails, a trailing space on a folder in the middle of the path does not.

  Every other character is allowed: U+007F, non-ASCII letters, emoji, spaces inside a name. On every platform the
  same rule applies, so one payload restores identically everywhere. OpenIDEA applies it per file: a UTF-8 folder
  with a non-portable name is still walked and each file under it is skipped and named with its full path; a
  non-UTF-8 name directly under the project root, when the root itself is selected, is named once and not walked.
  Another implementation may name such a folder once instead, as long as none of its files is copied. Symlinked
  folders are never followed (above). Where the runtime cannot see a name's raw bytes (JVM, Node string readdir),
  a non-UTF-8 name may be named as Unreadable instead; it is never copied either way. A name the platform's file
  view does not list need not be named.

  Git-change copies apply the same rule to each changed path: a path that is not portable is skipped and named
  under "Name not portable"; it is never written into a header, and the other changes are still copied (decided
  by the user, X1: a working-tree file named `x\n// file: [DELETED] …` must not forge a deletion, and one odd name
  must not fail every Git copy). This holds for every Git source an implementation has (working, staged, a
  commit, a range or history, a pull request, a graph). Commits mode carries paths in JSON and is not affected.

  A file outside every copy root: if its header is an absolute path, a control character anywhere in that path
  or a non-portable file name skips it under "Name not portable"; other characters in its folders are allowed
  (it may not resolve on paste, as today).

- **Exclude** keeps today's payload exactly, with the exceptions case 11 lists.
- A copy that would carry no file (everything selected was skipped, or a files selection would copy nothing but
  size placeholders) never writes the clipboard: it says "Nothing to copy" and names what was skipped, one
  category per line (Unreadable, Name not portable, Symlinked folder), as the completion notice does. An empty or
  wrapper-only payload is never written over the clipboard (decided by the user, X3).
- File modes (the executable bit) and Git LFS are out of scope: text files carry neither today.
- Non-text content read from Git rather than the working tree (staged changes, a file at a past commit, commits
  mode) is optional per implementation; one that does not carry it leaves those files out as today. IntelliJ
  supports working-tree files only (decided by the user, cross-implementation port).
- Deleted entries (`[DELETED]`) keep today's body: paste deletes the file and never reads it.

## Size limits

| Limit                   | Default | Setting key                                       | Measured on        |
| ----------------------- | ------- | ------------------------------------------------- | ------------------ |
| Text file               | 500 KB  | `maxFileSizeKB` (existing)                        | raw bytes          |
| Non-text file           | 2 MB    | `maxNonTextFileSizeKB` (new, positive number, KB) | raw bytes          |
| Whole payload (Include) | 50 MiB  | none (constant)                                   | serialized payload |

- A file at exactly the limit is within it (over means larger than).
- A file larger than both per-file limits is not read; it becomes today's size placeholder. Where the size is
  not known before reading (Git blobs), an implementation may read first; the file then counts as over its own
  limit, not as not read. The payload is the same.
- Any other file is read and classified, then held to its own limit: a 700 KB `.json` is over the text limit, a
  700 KB `.png` fits the non-text one. Over its limit, it becomes today's placeholder
  (`// File skipped: size exceeds limit (<n> bytes)`).
- The whole-payload limit is a technical ceiling, not a warning. Below it nothing is blocked; the dialog shows the
  estimated size so the user knows what is coming. Every implementation disables Include when its estimate is
  over 50 MiB (decided by the user, X2), so no Include payload is larger than what the others accept. Exclude
  and text-only copies, and a limit on the paste side, are each implementation's choice: OpenIDEA also caps every
  copy and refuses a larger paste; the others need not. A paste-side limit, where there is one, counts CRLF as
  in [Pasting](#pasting).
- Where a host has no settings UI (Orca), the limits are the defaults.

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
still says how many files the limit left out. The left-out number is counted up to 1000; beyond that it is shown
as "1000+" (OpenIDEA: `limitLeftOut` 1000 with `limitLeftOutAtLeast`). When the counted number is 0 the
left-out clause is omitted ("File limit N reached."), even when counting stopped early; "0+" is never shown.
Orca has no file-count limit; the file-count rules do not apply to it. Implementations must not walk the rest of
the tree only to count: a folder walk stops once the limit is filled, and a number it could not finish counting
is shown with "+" as well. The payload never depends on this number. The count, the list, the left-out number and
the estimate are derived from the Include result itself (the same ordered entry list and the same counting of size
placeholders and unreadable items toward the limit that the Include copy uses), not from a parallel estimate kept
while the Exclude copy runs; the dialog and the Include notice must agree.
(Found by deep testing: the dialog said 40 files while 30 were copied; in round 3 it said 31 non-text files and
11 left out while Include carried 29 and left out 13, with size placeholders in the selection.)

Buttons: **Include** (default focus), **Exclude** (today's behaviour: non-text files are left out) and
**Cancel** (nothing is copied). A dialog line whose count is 0 is omitted. Include is disabled, with the reason
shown, when the estimate is over the whole-payload limit; focus then starts on Exclude. In that case the dialog
never shows an estimate below the raw total: it says the payload would be more than 50 MiB (or shows a real
estimate of the full Include size), next to the raw total. Include is also disabled, with the reason shown, when
the `headerFormat` cannot be escaped: some line Include writes (the placeholder line or a Base64 line) matches the header pattern both as written and with
`//clipcode-esc: ` in front, so it would be read as a file header. With one `$FILE_PATH` this happens when the text
before `$FILE_PATH` is a prefix of `//clipcode-esc: ` (empty, `/`, `//`, ...) and such a line can end with the text
after it: `$FILE_PATH` alone, `//$FILE_PATH` (matches the placeholder), `$FILE_PATH==` (matches a Base64 line
`AA==`). Decided by the user, deep round 4; the class widened from "no fixed text before `$FILE_PATH`" by Codex
review. Where a dialog cannot disable a button (VS Code modal), Include is left out and the message gives the
reason; Exclude is then the default. Esc is Cancel. The choice is not remembered.

Counts in UI text are phrased so they read correctly for 1 and for many (e.g. "Non-text files copied as Base64:
1."), unless the platform has plural support. Long paths are shortened in the middle so the file name stays
visible (e.g. `d11long/a-really-long…/name-alpha.png`): the folder part shrinks first, down to its first segment
and an ellipsis, before any character of the file name is dropped; a file name that alone does not fit is itself
shortened in the middle, keeping its extension. A shortened name or folder part ends on a whole character before
the ellipsis (never half a letter, e.g. `lon…` not a cut `g` that reads as `ç`), and the ellipsis sits directly
against the text that follows (no gap). Distinguishability (case 21) is required at the default dialog and
preview sizes; when narrower, the folder-first order wins. Sizes never wrap. Sizes use one format everywhere:
under 1024 → "N B"; otherwise one decimal below 10, none above (4.0 KB, 12 KB, 1.5 MB); the whole-payload limit
is spelled "50 MiB". Notices that list several categories (e.g. Unreadable, Symlinked folder, Name not portable)
show one category per line; where a notice is a single line (VS Code toast), categories are separate sentences,
each ending with "."; a "Show details" view is optional. After Include, the completion notice says "Unreadable"
for what was skipped, not "non-text file or unreadable".

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
  `^// File skipped: non-text file, ([0-9]+) bytes, sha256 ([0-9a-f]{64}); base64 follows$`
  (after stripping a trailing `\r`). Size is the raw byte count in decimal; the hash is lowercase hex SHA-256 of
  the raw bytes.
- The Base64 is standard (RFC 4648 §4, `A–Z a–z 0–9 + /`, `=` padding), wrapped at 76 characters per line.
- The body goes through the same content escaping as any other body (`//clipcode-esc: ` before header-shaped
  lines), and the reader un-escapes before decoding. Base64 has no space or `:`, so the built-in header pattern
  cannot match it; the escaping covers a loose custom `headerFormat`.
- Header labels (`[NEW]`, `[MOVED]`, ...) and the `clipcode-root` line work as for text entries.
- Cross-tool paste holds when both sides use the same `headerFormat`; Orca reads the built-in header only.
- A **text** entry whose first body line is placeholder-shaped gets two layers of escaping (decided by the user,
  deep round 4). Placeholder-shaped means: after removing any number of leading `//clipcode-esc: ` prefixes, the
  line matches the placeholder pattern above (so a text line that already starts with `//clipcode-esc: // File
  skipped: non-text file, …` counts too).
  1. The writer first prefixes that first line with `//clipcode-esc: ` (the placeholder escape).
  2. The body then goes through the normal content escaping like any other body. A line starting with
     `//clipcode-esc: ` is always escaped, so the first line now carries two prefixes:
     `//clipcode-esc: //clipcode-esc: // File skipped: non-text file, …`.

  "First line" means the first body line that is not blank (only space, `\t`, `\n`, VT, `\f`, `\r`) in the text
  itself, on both sides: the writer applies the placeholder escape to that line, not to a blank one before it,
  and the reader, after un-escaping one level, looks for the placeholder escape on its first non-blank line. A
  whitespace-only line that the header format matches (e.g. `   ` under ` $FILE_PATH`) is escaped on the wire and
  kept by the reader, so the reader cannot simply take line 0. (Found by Codex review: with leading blank lines
  the writer and reader picked different lines; text lost a literal `//clipcode-esc: ` or was decoded as
  bytes.) The other readers (IntelliJ, VS Code, Orca) need the same rule.

  A real non-text placeholder line carries zero prefixes (built-in header) or one (a custom `headerFormat` that
  matches it, e.g. `// $FILE_PATH`). The reader un-escapes one level per line as for any body, then looks at
  the first line: the exact placeholder means a non-text entry; a line starting with `//clipcode-esc: ` that is
  placeholder-shaped means text, so the reader strips exactly one remaining prefix and restores the text as
  written. This works under every header format without guessing from the body. A reader that predates this
  rule un-escapes one level and writes the text with a literal `//clipcode-esc: ` first line (before this rule it
  skipped such a file). (Found by deep testing: with one shared prefix, a custom header made such a text file
  paste as decoded bytes or show as Corrupt.)

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
- Remove space, `\t`, `\n`, `\f`, `\r` (not VT) from the Base64 lines, decode strictly, then compare length and
  SHA-256 with the placeholder line. Any mismatch or decode error skips that file and lists it
  in the result as corrupted; the rest of the paste continues.
- The non-UTF-8 overwrite guard (OpenIDEA `must_not_overwrite`) does not apply: the bytes are written as is. An
  existing target follows the same overwrite option as a text entry. A target whose bytes already equal the
  decoded bytes is reported unchanged and not written.
- A write replaces the target's bytes exactly, keeps its permission bits, and never writes through a symlink at
  the target. Writing in place (one inode, so hard links see the new bytes) or through a temporary file and a
  rename (owner, ACLs, extended attributes and resource forks need not survive) are both allowed. A temporary
  file is created 0600 and set to the final mode before the rename: the target's mode, or for a new file the mode
  a new file gets in that folder (0666 less the umask). Undo after paste is per host: IntelliJ uses the IDE
  command; the others have none.
- The paste preview shows a non-text entry as "non-text file · 4.0 KB" and, for an existing target, whether it
  is identical or different. It never shows the Base64 or a diff.
- An identical target shows an **Unchanged** badge, is not counted in "Overwrite all N existing files", and needs
  no overwrite permission.
- A corrupt entry shows a **Corrupt** badge (not a long inline note), with "Corrupt non-text file" in the tooltip
  and the detail pane. The file name keeps priority in the row, in flat and nested (indented) rows alike: badges
  and notes shrink or drop before the name does, a name that still does not fit is shortened in the middle
  keeping its extension, and 30–60 character names that share a prefix stay distinguishable. A badge or a size
  note shows whole or not at all: never a clipped word, a partial number or a sliver of padding. Middle
  ellipsis shows as one continuous name (no visible gap between its two halves, no partly drawn character before
  the ellipsis). A host whose paste preview is plain text (IntelliJ Messages) lists Unchanged and Corrupt rows in
  their own sections with the same user text instead of badges; the badge and row-layout rules apply to row-based
  previews.
- Commits replay writes and commits the decoded bytes, after the same length and SHA-256 check.
- A **text** write over an existing non-UTF-8 file stays refused by the non-UTF-8 overwrite guard, outside the
  batch case in [Commits-mode](#commits-mode-wire-format-openidea-only) (decided by the user, deep round 3). The
  preview shows the reason in user text ("Existing file is not UTF-8; not overwritten"). A replayed commit whose
  every file change was refused or skipped is not created as an empty commit: the replay names it as not created,
  with the reason, and continues with the next commit.
- Read-only targets (mode 444) follow the overwrite option like any other existing file, with no extra note; this
  is today's behaviour for text files too (decided by the user, deep round 3: keep as is).
- A whole-payload limit on paste, where an implementation has one, counts the payload as the parser sees it: each
  CRLF pair counts as one byte (a Windows clipboard must not push a valid payload over the limit), but a lone CR
  counts in full (it must not let oversized input bypass the limit).
- One entry that cannot be applied (its target path is a directory, one of its parent paths is an existing file
  ("A file is in the way of its parent folder"), a parent is not writable, two entries map to
  the same file on a case-insensitive file system such as `IMG.png` and `img.png` on APFS, or two spellings that
  differ only in Unicode normalization (NFC/NFD) on macOS) skips that row (for a
  collision: every colliding row) with its reason in user text (a write error such as permission denied is shown
  as user text, e.g. "Folder is not writable", not the raw OS message); the rest of the paste continues. It never aborts
  the whole paste. A row that fails while writing counts as skipped in the notice title, not only in its body.
  Letter case folds only where the target file system does not tell case apart (probe the destination; where
  that cannot be done, assume it on macOS and Windows); NFC/NFD folds on macOS only (decided by the user, X4).
  A collision row's reason reads "Another entry writes the same file", whatever made the two paths the same
  (letter case, normalization, a symlinked parent). "Parent not writable" may be found only while writing; the
  preview need not predict it.
  (Case-only collisions aborted the whole paste with the raw `IpcError: target collision` text before this spec:
  pre-existing, found by deep testing round 3.)
- The paste and replay previews never show raw reason codes (`BINARY`, `NON_UTF8`, `NON_UTF8_TARGET`); each
  reason has user text.
- Known, not handled (deep round 6, judged not worth another round): a file name with consecutive spaces is
  shortened in the preview although it fits; a replayed commit whose every write is already identical at the
  destination is created as an empty commit (text too, likely pre-existing). (#198, an all-skipped selection
  failing with a raw "Nothing to copy", is fixed: see X3 under [What is carried](#what-is-carried).)
- Known, not handled: a custom `headerFormat` that matches the end marker with non-empty post text: the footer
  joins the last entry (pre-existing for text).
- Known, not handled: FIFOs, sockets and devices are skipped; OpenIDEA names them as Unreadable, others may drop
  them silently.
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
11. Exclude in the dialog produces today's payload byte for byte, when nothing was skipped as unreadable, as a
    symlinked folder or as not portable (those are named in the notice now, which today's copy did not do), or a
    file IntelliJ's file type called binary. "Today" is that implementation's pre-feature payload, except where
    this spec's size rules now give a size placeholder (a file over both limits, the byte count in it).
12. A text file whose first line is a valid-looking non-text placeholder round-trips as the original text, under
    the built-in header and under `// $FILE_PATH` (also when its second line is valid Base64, e.g. `YWJj`), in
    the same payload as a real non-text file that round-trips byte for byte; a text file whose first line is
    `//clipcode-esc: ` plus a placeholder line round-trips too.
13. Commits mode: image added, modified, then deleted across three commits replays to the same tree as the
    source (the deletion happens); a rename of an image moves it.
14. Commits mode: Big5 file rewritten as UTF-8 in a later commit of the same batch keeps the rewrite.
15. File-count limit: 40 small images with a limit of 30 — the dialog's count, list and estimate match the
    Include payload; the same with size placeholders in the selection (a folder with files over both limits
    plus 40 images): dialog numbers equal the Include payload and notice. 30 text files ordered before 5 images:
    no dialog, and the notice reports 5 left out by the limit. 1,101 picked files with a limit of 3: the left-out
    number is "1000+" in the dialog and the notice (exactly 1,000 past the limit still reads "1000"), and the
    payload is the same as without the cap.
16. Unreadable files dropped during folder expansion (chmod 000 file and folder, dangling symlink) are named in
    the completion notice.
17. Implementations with a paste-side limit: CRLF growth near the whole-payload limit is accepted on paste; lone
    CRs past the limit are refused.
18. Base64 strictness is the same in all implementations: missing padding, non-zero trailing bits and characters
    outside the alphabet (other than the whitespace removed in [Pasting](#pasting)) make the entry corrupt.
19. A selected unreadable folder plus a readable file: the file is copied, the folder is named as unreadable.
20. Paste where a target path is a directory: only that row is skipped; the others restore.
21. Names shown in the dialog and preview: three 58–60 character names sharing a prefix are distinguishable; a
    file under a 150-character folder path shows its whole file name (extension included) in the dialog and in a
    nested preview row whose target is identical (the Unchanged badge shows when it fits whole, otherwise it is
    hidden; the name keeps priority).
22. A symlink to a folder selected directly (alone and in a multi-selection) is not followed and is named as a
    symlinked folder.
23. A payload with `IMG.png` and `img.png` pasted on a case-insensitive file system skips both with a collision
    reason and restores the other entries.
24. Commits replay of a single commit whose only change is refused by the non-UTF-8 guard: the preview shows the
    reason, no empty commit is created, later commits of the replay still apply.
25. With `headerFormat` set to `$FILE_PATH`, the dialog disables Include with its reason; Exclude still works.
26. Over the whole-payload limit (e.g. six 9 MB non-text files with a 10000 KB non-text limit), the dialog never
    shows an estimate below the raw total.
27. Paste where a parent path of an entry is an existing file (`d3/a` is a file, the payload has `d3/a/deep.png`
    and `d3/ok.txt`): only that row is skipped with user text; `d3/ok.txt` restores; no raw OS error.
28. The names of case 21 at the default dialog and preview sizes, light and dark, en and zh: no partly drawn
    character before an ellipsis and no gap after it.
29. Git copy (working changes and a commit; every Git source the implementation has) with a changed file named
    `q"uote.txt` or `tab<TAB>name.txt` next to `a.txt`: `a.txt` is copied, the others are named under "Name not
    portable" and appear in no header; when such a file is the only change, case 30 applies. On Linux a
    non-UTF-8 name is named the same way (lossily) or, per the platform rule, as Unreadable.
30. A selection whose every file is skipped (a folder holding only a mode-000 file, a folder holding only
    `q"uote.txt`, a lone unreadable folder, a lone symlinked folder): the clipboard keeps its previous content, the
    notice says "Nothing to copy" and names each skipped path under its category.
31. A symlink to a file inside the copy root carries the target's bytes; one whose target is outside every copy
    root is not followed and is named as Unreadable.
32. On macOS, a payload with `café.png` spelled in NFC and in NFD skips both rows with the collision reason and
    restores the others.
33. Paste writes through a temporary file that is 0600 while the bytes are written; a new file then has the mode
    a new file gets in its folder, an existing file keeps its mode.
34. Every collision row's reason reads "Another entry writes the same file" (case, normalization or a symlinked
    parent).
35. Include is disabled, with the reason, when its estimate is over 50 MiB, in every implementation.
36. A file-count limit whose left-out number is 0: the notice says "File limit N reached." and never "0+".
37. A file of exactly `maxNonTextFileSizeKB` × 1024 bytes is carried; one byte more is over the limit.

## Open items for the other implementations

- `clipboard-contract.json` is generated by `ClipCodeVSCode/scripts/gen-contract-fixtures.cjs`; its
  `nonTextBuildCases` / `nonTextRestoreCases` were added in OpenIDEA by hand. Teach the generator these sections
  (and cases 12–18) before regenerating, or they are lost.

## Change log

Each review or test round folds its findings back into this spec.

- Cross-implementation port (IntelliJ, VS Code, Orca), 2026-11-09. User decisions: (D1) the file-count limit's
  left-out number is counted up to 1000 and shown as "1000+" beyond that, without walking the rest of the tree to
  count; OpenIDEA counted every remaining file before. (D2) a file or folder with a non-portable name is skipped
  and named under "Name not portable", with the portability rule spelled out; symlinked folders are never
  followed; case 11 holds when nothing was skipped as unreadable, symlinked folder or not portable. (D3) non-text
  content from Git staged changes or history is optional per implementation; IntelliJ supports working-tree files
  only.
  Coordination round (X1–X38, `COORDINATION.md`), user decisions: (X1) Git copies skip a changed path that is not
  portable and name it under "Name not portable" instead of failing the copy or writing it into a header; the old
  line saying OpenIDEA's Git copies do not report this category is replaced. (X2) every implementation disables
  Include over 50 MiB; Exclude, text-only and paste-side limits are per implementation. (X3) when everything
  selected is skipped the clipboard is untouched and "Nothing to copy" names the skipped files per category
  (#198 removed from Known). (X7) a symlink to a file outside every copy root is not followed and is named as
  Unreadable. (X4) on macOS collisions are judged after NFC normalization. Also settled from the coordination
  table: collision reason text (X6), copy root through a symlink (X8), no "0+" (X9), write rules and a 0600
  temporary file (X12), absolute-path headers (X15), bytes-only classification (X16), case 11's "today" (X17),
  whitespace sets (X18), `[0-9]` in the regex (X19), the limit boundary (X20), zero-count dialog lines (X21), one
  size format and "50 MiB" (X28), Git blob reads (X30), post-text and special-file Known items (X31, X37), parent
  not writable found at write time (X33), Git-tracked symlinks (X34), folder-first shortening (X35), unlisted
  names (X36); allowed platform differences X11, X14, X22–X27. Required cases 29–37 added. OpenIDEA code for X1,
  X3, X4, X6, X12 and X28 in PR #208.

- Round 1 review (3 Opus lenses + Codex): commits batch rewrite (Big5 → UTF-8) kept; Exclude keeps "Nothing to
  copy"; CRLF counting on the paste limit. Round 2 (Codex): lone CR must count. Round 3 (Codex): approved.
- Hands-on testers, round 1: identical targets as Unchanged; corrupt rows and replay preview labels; count
  phrasing for 1; long paths; focus when Include is disabled. Round 2: unreadable paths from folder expansion;
  Corrupt badge instead of a squeezed note.
- Codex review round 4 (approved by the user): five findings, all confirmed and all in code this branch added:
  a non-text rename chain bypassed overwrite consent; a custom `headerFormat` made a real non-text entry paste as
  text; a skipped rename aborted the replay; a fully refused source group crashed the copy; a folder symlink to
  the project root was followed. Fixed.
- Codex review round 5 (after the deep round 4 fixes): (1) the unescapable-`headerFormat` check only looked for
  "no fixed text before `$FILE_PATH`", so `//$FILE_PATH` (placeholder stays a header when escaped) and
  `$FILE_PATH==` (`AA==` becomes a header) kept Include enabled and pasted a non-text file as an empty file or as
  Corrupt plus a phantom entry; the rule is now the class above. (2) Writer and reader picked different "first
  lines" when the text starts with blank lines: a literal `//clipcode-esc: ` was lost, or `\n<placeholder>\nAQID`
  pasted as bytes (pre-existing). Fixed on both sides, including an escaped whitespace-only line under
  ` $FILE_PATH`; contract cases added.
- Deep testers, round 6 (three testers): the ellipsis and parent-path-is-a-file fixes pass (cases 27, 28); every
  data case (D1–D11, D13, D15, D16, D18) passes for all three. Remaining items are cosmetic or pre-existing and
  were listed under Known instead of opening another round (user: avoid over-polishing). Case 21 reworded: a
  nested row's Unchanged badge hides when it does not fit whole.
- Deep testers, round 5 (three testers, D1–D18 plus their own cases): escape, unescapable header, estimate,
  badges and OS error text pass. Open: (1) the middle ellipsis cuts a letter in half before the `…` and leaves a
  ~3 px gap after a shortened folder part in the dialog and detail header (introduced by the round 4/5 layout
  fixes; rule made explicit above, case 28). (2) A non-text entry whose parent path is an existing file aborts the
  whole paste with `IpcError: Not a directory (os error 20)` (text payloads abort the same way on develop,
  pre-existing; for non-text entries it is new, since an older reader skips the placeholder); case 27. (3) Leading
  blank or whitespace-only lines of a text file are dropped on paste under the built-in header and kept under
  ` $FILE_PATH` (pre-existing, identical on develop; same class as the final-newline item); open for the user.
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
