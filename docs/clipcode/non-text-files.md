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
  skipped. The completion notice counts them and names the first few paths.
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

Buttons: **Include** (default focus), **Exclude** (today's behaviour: non-text files are left out) and
**Cancel** (nothing is copied). Include is disabled, with the reason shown, when the estimate is over the
whole-payload limit. The choice is not remembered.

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
- The Base64 is standard (RFC 4648 §4, `A–Z a–z 0–9 + /`, `=` padding), wrapped at 76 characters per line. - The body goes through the same content escaping as any other body (`//clipcode-esc: ` before header-shaped
  lines), and the reader un-escapes before decoding. Base64 has no space or `:`, so the built-in header pattern
  cannot match it; the escaping covers a loose custom `headerFormat`.
- Header labels (`[NEW]`, `[MOVED]`, ...) and the `clipcode-root` line work as for text entries.

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
- Commits replay writes and commits the decoded bytes, after the same length and SHA-256 check.

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
