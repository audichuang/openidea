# OpenIDEA (fork)

Terms this fork uses where the code or UI could say the same thing several ways.

## Language

### ClipCode

**Payload**:
The text ClipCode puts on the clipboard: file entries in Files mode, or commits in Commits mode.
_Avoid_: export, dump, snippet

**Non-text file** (zh UI: 非文本文件):
A file whose bytes are not strict UTF-8 text: it contains a NUL byte or fails UTF-8 decoding. Images, archives and Big5 or UTF-16 text files are all non-text files.
_Avoid_: binary file, non-UTF-8 file (each names only half of the set)

**Placeholder**:
A file entry whose body starts with `// File skipped: ` and so is never written on paste by a reader that does not understand it.
_Avoid_: skip marker, stub
