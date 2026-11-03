//! The file list on the OS clipboard: what Explorer copies when the user
//! copies files, so the project view can paste them, and what the project view
//! writes so Explorer can paste the files it copied (IDEA does both). The
//! written list comes with the paths as text, so a paste into an editor
//! inserts them instead of doing nothing.
//!
//! Windows keeps it as `CF_HDROP`: a `DROPFILES` header and a double-NUL
//! terminated list of absolute paths, wide when `fWide` is set. The data is set
//! in full rather than rendered on demand, so no window or message loop is
//! needed and the list survives after `CloseClipboard`.
//!
//! macOS keeps one `public.file-url` item per file on the general
//! `NSPasteboard`; `NSURL` reads and writes them, so Finder's copies paste here
//! and ours paste in Finder.
//! On macOS, [`files`], [`has_files`], [`text`], [`set_text`], [`image`] and [`set_files`] must run on the main
//! thread: AppKit and WebKit also access the general pasteboard there, and its
//! mutable type cache cannot be protected by a mutex in this crate.
//!
//! Other platforms (`text/uri-list` on X11) are not wired up: [`files`] is
//! empty and [`set_files`] fails there.

use std::path::PathBuf;

/// Size of `DROPFILES`: `pFiles`, `pt` (two `LONG`s), `fNC`, `fWide`.
const HEADER: usize = 20;

/// The absolute paths on the clipboard, empty when it holds no file list.
/// Read failures remain errors so callers can retain an internal copy.
pub fn files() -> std::io::Result<Vec<PathBuf>> {
    imp::files()
}

/// Whether the clipboard holds a file list, without reading it.
pub fn has_files() -> bool {
    imp::has_files()
}

/// The clipboard's plain text, read natively: in the macOS webview,
/// `navigator.clipboard.readText()` outside a paste event makes WebKit ask the
/// user to confirm with a "Paste" callout, and reads nothing when it is
/// dismissed. Windows reads `CF_UNICODETEXT` the same way, so both apps
/// behave alike. On macOS it is empty while the clipboard holds a file list
/// (Finder adds the file name as text), as WebKit's own read is, so the caller
/// reads [`files`]. `None` when the clipboard stays busy or the platform is not
/// wired up (Linux): the webview reads it then.
pub fn text() -> Option<String> {
    imp::text()
}

/// Replaces the clipboard with `text`, natively for the same reason as
/// [`text`]: the webview's `writeText()` needs a user gesture, and a copy that
/// first waits for the backend (ClipCode) may have lost it. False when the
/// clipboard stayed busy or the platform is not wired up (Linux): the caller
/// then writes through the webview.
pub fn set_text(text: &str) -> bool {
    imp::set_text(text)
}

/// An image on the clipboard, encoded as `mime`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Image {
    pub mime: &'static str,
    pub data: Vec<u8>,
}

/// The clipboard's image, read natively for the same reason as [`text`]: a
/// menu paste reading it through the webview (`navigator.clipboard.read()`,
/// `execCommand("paste")`) makes WebKit ask the user to confirm. macOS gives
/// PNG, converting TIFF (what Preview and many apps copy) to PNG; Windows
/// gives its registered `PNG` format, else `CF_DIB` as a BMP file. `Some(None)`
/// when it holds no image, or a file list (the caller pastes the files).
/// `None` when the clipboard stays busy or the platform is not wired up
/// (Linux): the webview reads it then.
pub fn image() -> Option<Option<Image>> {
    imp::image()
}

/// A BMP file for a `CF_DIB` block: the `BITMAPFILEHEADER` it lacks, whose
/// pixel offset follows the info header, its colour masks and colour table.
/// `None` when the block is too short to hold what its header declares.
pub fn dib_to_bmp(dib: &[u8]) -> Option<Vec<u8>> {
    const BI_BITFIELDS: u32 = 3;
    let u16_at = |i: usize| Some(u16::from_le_bytes(dib.get(i..i + 2)?.try_into().ok()?));
    let u32_at = |i: usize| Some(u32::from_le_bytes(dib.get(i..i + 4)?.try_into().ok()?));
    let header = u32_at(0)? as usize;
    if header < 40 || dib.len() < header {
        return None;
    }
    let bits = u16_at(14)?;
    let used = u32_at(32)? as usize;
    // A BITMAPINFOHEADER keeps its three masks after itself; later headers hold them.
    let masks = if header == 40 && u32_at(16)? == BI_BITFIELDS { 12 } else { 0 };
    let colors = if used > 0 {
        used * 4
    } else if bits <= 8 {
        (1usize << bits) * 4
    } else {
        0
    };
    let offset = 14 + header + masks + colors;
    let size = 14 + dib.len();
    if offset > size {
        return None;
    }
    let mut bmp = Vec::with_capacity(size);
    bmp.extend_from_slice(b"BM");
    bmp.extend_from_slice(&u32::try_from(size).ok()?.to_le_bytes());
    bmp.extend_from_slice(&[0; 4]);
    bmp.extend_from_slice(&u32::try_from(offset).ok()?.to_le_bytes());
    bmp.extend_from_slice(dib);
    Some(bmp)
}

/// Replaces the clipboard with `paths`. True only when the file list was
/// accepted; writing just the accompanying text is not a successful hand-off.
pub fn set_files(paths: &[PathBuf]) -> bool {
    if paths.is_empty() {
        return false;
    }
    imp::set_files(paths)
}

/// `DROPFILES` for `paths`, in the wide form so names outside the ANSI code
/// page survive. Empty paths are skipped.
pub fn encode(paths: &[PathBuf]) -> Vec<u8> {
    let mut units: Vec<u16> = Vec::new();
    for path in paths {
        let path = path.to_string_lossy();
        if path.is_empty() {
            continue;
        }
        units.extend(path.encode_utf16());
        units.push(0);
    }
    // The list ends with an empty string: with one path, two NULs in a row.
    units.push(0);
    let mut out = Vec::with_capacity(HEADER + units.len() * 2);
    out.extend_from_slice(&(HEADER as u32).to_le_bytes()); // pFiles: list starts after the header
    out.extend_from_slice(&[0u8; 8]); // pt: the drop point, unused
    out.extend_from_slice(&0u32.to_le_bytes()); // fNC: not a file manager drop
    out.extend_from_slice(&1u32.to_le_bytes()); // fWide: UTF-16 paths
    for unit in units {
        out.extend_from_slice(&unit.to_le_bytes());
    }
    out
}

/// The paths of a `DROPFILES` block, stopping at the empty string that ends the
/// list. An ANSI list (pre-Unicode writers) is decoded as UTF-8, lossily.
pub fn decode(bytes: &[u8]) -> Vec<PathBuf> {
    if bytes.len() < HEADER {
        return Vec::new();
    }
    let offset = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    let wide = u32::from_le_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]) != 0;
    if offset >= bytes.len() {
        return Vec::new();
    }
    let body = &bytes[offset..];
    let mut out = Vec::new();
    if wide {
        let mut current: Vec<u16> = Vec::new();
        for chunk in body.as_chunks::<2>().0 {
            let unit = u16::from_le_bytes(*chunk);
            if unit != 0 {
                current.push(unit);
            } else if current.is_empty() {
                break;
            } else {
                out.push(PathBuf::from(String::from_utf16_lossy(&current)));
                current.clear();
            }
        }
    } else {
        for part in body.split(|b| *b == 0) {
            if part.is_empty() {
                break;
            }
            out.push(PathBuf::from(String::from_utf8_lossy(part).into_owned()));
        }
    }
    out
}

#[cfg(windows)]
mod imp {
    use super::{HEADER, decode, encode};
    use std::ffi::c_void;
    use std::path::PathBuf;
    use std::ptr;
    use std::time::Duration;

    /// `CF_HDROP`, the clipboard format holding a file list.
    const CF_HDROP: u32 = 15;
    /// `CF_UNICODETEXT`: plain text, and the paths written with a file list so
    /// an editor paste of copied files inserts them.
    const CF_UNICODETEXT: u32 = 13;

    /// An `HGLOBAL` or a `HANDLE`: both are opaque pointers here.
    type Handle = *mut c_void;

    const GMEM_MOVEABLE: u32 = 0x0002;
    /// Another process holds the clipboard only while it copies; retrying beats
    /// reporting "no files" for a paste the user just made.
    const OPEN_ATTEMPTS: usize = 10;
    const OPEN_RETRY: Duration = Duration::from_millis(20);

    /// `CF_DIB`: a device-independent bitmap without its file header.
    const CF_DIB: u32 = 8;

    #[link(name = "user32")]
    unsafe extern "system" {
        fn RegisterClipboardFormatW(name: *const u16) -> u32;
        fn OpenClipboard(owner: Handle) -> i32;
        fn CloseClipboard() -> i32;
        fn EmptyClipboard() -> i32;
        fn GetClipboardData(format: u32) -> Handle;
        fn SetClipboardData(format: u32, memory: Handle) -> Handle;
        fn IsClipboardFormatAvailable(format: u32) -> i32;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GlobalAlloc(flags: u32, bytes: usize) -> Handle;
        fn GlobalLock(memory: Handle) -> *mut c_void;
        fn GlobalUnlock(memory: Handle) -> i32;
        fn GlobalFree(memory: Handle) -> Handle;
        fn GlobalSize(memory: Handle) -> usize;
    }

    /// Opens the clipboard as its owner: the list is written in full, so no
    /// owning window is needed.
    fn open() -> bool {
        for _ in 0..OPEN_ATTEMPTS {
            if unsafe { OpenClipboard(ptr::null_mut()) } != 0 {
                return true;
            }
            std::thread::sleep(OPEN_RETRY);
        }
        false
    }

    pub fn has_files() -> bool {
        (unsafe { IsClipboardFormatAvailable(CF_HDROP) }) != 0
    }

    pub fn text() -> Option<String> {
        // Still busy after the retries: the webview's read is the fallback.
        if !open() {
            return None;
        }
        let text = if (unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT) }) == 0 {
            Some(String::new())
        } else {
            let memory = unsafe { GetClipboardData(CF_UNICODETEXT) };
            if memory.is_null() {
                None
            } else {
                // SAFETY: as in `files`; the text is UTF-16 up to its NUL,
                // and `GlobalSize` bounds the units read.
                unsafe {
                    let data = GlobalLock(memory) as *const u16;
                    if data.is_null() {
                        None
                    } else {
                        let units = std::slice::from_raw_parts(data, GlobalSize(memory) / 2);
                        let end = units.iter().position(|&u| u == 0).unwrap_or(units.len());
                        let text = String::from_utf16_lossy(&units[..end]);
                        GlobalUnlock(memory);
                        Some(text)
                    }
                }
            }
        };
        unsafe { CloseClipboard() };
        text
    }

    pub fn files() -> std::io::Result<Vec<PathBuf>> {
        if !open() {
            return Err(std::io::Error::last_os_error());
        }
        if !has_files() {
            unsafe { CloseClipboard() };
            return Ok(Vec::new());
        }
        let memory = unsafe { GetClipboardData(CF_HDROP) };
        let paths = if memory.is_null() {
            Err(std::io::Error::last_os_error())
        } else {
            // SAFETY: the clipboard keeps the block alive while it is open, and
            // `GlobalSize` bounds the bytes read from it.
            unsafe {
                let data = GlobalLock(memory);
                if data.is_null() {
                    Err(std::io::Error::last_os_error())
                } else {
                    let bytes = std::slice::from_raw_parts(data as *const u8, GlobalSize(memory));
                    let paths = decode(bytes);
                    GlobalUnlock(memory);
                    Ok(paths)
                }
            }
        };
        unsafe { CloseClipboard() };
        paths
    }

    /// An `HGLOBAL` holding `text` as UTF-16 with a terminating NUL, and its
    /// byte size. Null when the allocation failed.
    fn global_text(text: &str) -> (Handle, usize) {
        let mut units: Vec<u16> = text.encode_utf16().collect();
        units.push(0);
        let bytes = units.len() * 2;
        unsafe {
            let memory = GlobalAlloc(GMEM_MOVEABLE, bytes);
            if memory.is_null() {
                return (ptr::null_mut(), 0);
            }
            let data = GlobalLock(memory);
            if data.is_null() {
                GlobalFree(memory);
                return (ptr::null_mut(), 0);
            }
            ptr::copy_nonoverlapping(units.as_ptr() as *const u8, data as *mut u8, bytes);
            GlobalUnlock(memory);
            (memory, bytes)
        }
    }

    /// A copy of the clipboard's `format` block. Must run with the clipboard open.
    fn global_bytes(format: u32) -> Option<Vec<u8>> {
        // SAFETY: as in `files`; `GlobalSize` bounds the bytes read and the
        // block stays owned by the clipboard.
        unsafe {
            let memory = GetClipboardData(format);
            if memory.is_null() {
                return None;
            }
            let data = GlobalLock(memory) as *const u8;
            if data.is_null() {
                return None;
            }
            let bytes = std::slice::from_raw_parts(data, GlobalSize(memory)).to_vec();
            GlobalUnlock(memory);
            Some(bytes)
        }
    }

    pub fn image() -> Option<Option<super::Image>> {
        if has_files() {
            return Some(None);
        }
        let name: Vec<u16> = "PNG".encode_utf16().chain([0]).collect();
        let png = unsafe { RegisterClipboardFormatW(name.as_ptr()) };
        if !open() {
            return None;
        }
        // Snipping Tool, browsers and Office also put a PNG; plain bitmaps only a DIB.
        let image = if png != 0 && (unsafe { IsClipboardFormatAvailable(png) }) != 0 {
            global_bytes(png).map(|data| super::Image { mime: "image/png", data })
        } else if (unsafe { IsClipboardFormatAvailable(CF_DIB) }) != 0 {
            global_bytes(CF_DIB)
                .and_then(|dib| super::dib_to_bmp(&dib))
                .map(|data| super::Image { mime: "image/bmp", data })
        } else {
            None
        };
        unsafe { CloseClipboard() };
        Some(image)
    }

    pub fn set_text(text: &str) -> bool {
        // SAFETY: the block is handed to the clipboard or freed when it was
        // not taken, as in `set_files`.
        unsafe {
            let (memory, _) = global_text(text);
            if memory.is_null() {
                return false;
            }
            if !open() {
                GlobalFree(memory);
                return false;
            }
            if EmptyClipboard() == 0 {
                CloseClipboard();
                GlobalFree(memory);
                return false;
            }
            let taken = !SetClipboardData(CF_UNICODETEXT, memory).is_null();
            if !taken {
                GlobalFree(memory);
            }
            CloseClipboard();
            taken
        }
    }

    pub fn set_files(paths: &[PathBuf]) -> bool {
        let bytes = encode(paths);
        if bytes.len() <= HEADER {
            return false;
        }
        // The paths as text, newline-separated, so pasting into an editor
        // inserts them (IDEA writes the list and the text together).
        let text = paths.iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>().join("\r\n");
        // SAFETY: the blocks are allocated, filled, handed to the clipboard and
        // freed only on the paths where the clipboard did not take ownership.
        unsafe {
            let memory = GlobalAlloc(GMEM_MOVEABLE, bytes.len());
            if memory.is_null() {
                return false;
            }
            let data = GlobalLock(memory);
            if data.is_null() {
                GlobalFree(memory);
                return false;
            }
            ptr::copy_nonoverlapping(bytes.as_ptr(), data as *mut u8, bytes.len());
            GlobalUnlock(memory);
            if !open() {
                GlobalFree(memory);
                return false;
            }
            // Replacing the list also drops the text the user copied before;
            // the paths' own text is set back with it.
            if EmptyClipboard() == 0 {
                CloseClipboard();
                GlobalFree(memory);
                return false;
            }
            let taken = !SetClipboardData(CF_HDROP, memory).is_null();
            if !taken {
                GlobalFree(memory);
            }
            let (text_memory, _) = global_text(&text);
            if !text_memory.is_null() {
                // The text alone still pastes somewhere useful.
                let text_taken = !SetClipboardData(CF_UNICODETEXT, text_memory).is_null();
                if !text_taken {
                    GlobalFree(text_memory);
                }
            }
            CloseClipboard();
            taken
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use objc2::rc::{Retained, autoreleasepool};
    use objc2::runtime::{AnyClass, AnyObject, ProtocolObject};
    use objc2::{ClassType, MainThreadMarker};
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSPasteboard,
        NSPasteboardReadingOptionKey, NSPasteboardTypePNG, NSPasteboardTypeString, NSPasteboardTypeTIFF,
        NSPasteboardURLReadingFileURLsOnlyKey, NSPasteboardWriting,
    };
    use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString, NSURL};
    use std::path::PathBuf;

    /// `NSURL` as the one class to read, limited to file URLs: a web link the
    /// user copied is not a file to paste.
    fn read_file_urls<R>(
        f: impl FnOnce(&NSPasteboard, &NSArray<AnyClass>, &NSDictionary<NSPasteboardReadingOptionKey, AnyObject>) -> R,
    ) -> R {
        debug_assert!(MainThreadMarker::new().is_some(), "NSPasteboard access requires the main thread");
        autoreleasepool(|_| {
            let board = NSPasteboard::generalPasteboard();
            let classes = NSArray::from_slice(&[NSURL::class()]);
            let yes = NSNumber::new_bool(true);
            // SAFETY: the key is an AppKit constant, valid for the process' lifetime.
            let key = unsafe { NSPasteboardURLReadingFileURLsOnlyKey };
            let options = NSDictionary::from_slices(&[key], &[yes.as_ref() as &AnyObject]);
            f(&board, &classes, &options)
        })
    }

    pub fn has_files() -> bool {
        // SAFETY: the class list holds `NSURL`, which reads from pasteboards,
        // and the option takes an `NSNumber`.
        read_file_urls(|board, classes, options| unsafe {
            board.canReadObjectForClasses_options(classes, Some(options))
        })
    }

    pub fn text() -> Option<String> {
        if has_files() {
            return Some(String::new());
        }
        debug_assert!(MainThreadMarker::new().is_some(), "NSPasteboard access requires the main thread");
        autoreleasepool(|_| {
            let board = NSPasteboard::generalPasteboard();
            // SAFETY: the type is an AppKit constant, valid for the process' lifetime.
            let text = board.stringForType(unsafe { NSPasteboardTypeString });
            Some(text.map(|t| t.to_string()).unwrap_or_default())
        })
    }

    pub fn files() -> std::io::Result<Vec<PathBuf>> {
        read_file_urls(|board, classes, options| {
            // SAFETY: as in `has_files`; every object read for `NSURL` is one.
            let Some(objects) = (unsafe { board.readObjectsForClasses_options(classes, Some(options)) }) else {
                return if unsafe { board.canReadObjectForClasses_options(classes, Some(options)) } {
                    Err(std::io::Error::other("Cannot read clipboard files"))
                } else {
                    Ok(Vec::new())
                };
            };
            Ok(objects
                .iter()
                .filter_map(|object| object.downcast::<NSURL>().ok())
                .filter_map(|url| url.to_file_path())
                // Finder ends a folder's URL in `/`; the project view names it without.
                .map(|path| path.components().collect())
                .collect())
        })
    }

    pub fn image() -> Option<Option<super::Image>> {
        if has_files() {
            return Some(None);
        }
        debug_assert!(MainThreadMarker::new().is_some(), "NSPasteboard access requires the main thread");
        autoreleasepool(|_| {
            let board = NSPasteboard::generalPasteboard();
            // SAFETY: the types are AppKit constants, valid for the process' lifetime.
            if let Some(png) = board.dataForType(unsafe { NSPasteboardTypePNG }) {
                return Some(Some(super::Image { mime: "image/png", data: png.to_vec() }));
            }
            let Some(tiff) = board.dataForType(unsafe { NSPasteboardTypeTIFF }) else {
                return Some(None);
            };
            let properties = NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::new();
            // SAFETY: the properties dictionary is empty, so its values have no type to violate.
            let png = NSBitmapImageRep::imageRepWithData(&tiff).and_then(|rep| unsafe {
                rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)
            });
            Some(Some(match png {
                Some(png) => super::Image { mime: "image/png", data: png.to_vec() },
                None => super::Image { mime: "image/tiff", data: tiff.to_vec() },
            }))
        })
    }

    pub fn set_text(text: &str) -> bool {
        debug_assert!(MainThreadMarker::new().is_some(), "NSPasteboard access requires the main thread");
        autoreleasepool(|_| {
            let board = NSPasteboard::generalPasteboard();
            board.clearContents();
            // SAFETY: the type is an AppKit constant, valid for the process' lifetime.
            board.setString_forType(&NSString::from_str(text), unsafe { NSPasteboardTypeString })
        })
    }

    pub fn set_files(paths: &[PathBuf]) -> bool {
        debug_assert!(MainThreadMarker::new().is_some(), "NSPasteboard access requires the main thread");
        autoreleasepool(|_| {
            // Folders get a directory URL (ending in `/`), as Finder writes them.
            let urls: Vec<Retained<NSURL>> = paths
                .iter()
                .filter_map(|p| if p.is_dir() { NSURL::from_directory_path(p) } else { NSURL::from_file_path(p) })
                .collect();
            if urls.is_empty() {
                return false;
            }
            let writers: Vec<&ProtocolObject<dyn NSPasteboardWriting>> =
                urls.iter().map(|url| ProtocolObject::from_ref(&**url)).collect();
            let board = NSPasteboard::generalPasteboard();
            // Replacing the list also drops the text the user copied before;
            // the paths' own text is set back with it, so an editor paste
            // inserts them (IDEA writes the list and the text together).
            board.clearContents();
            let written = board.writeObjects(&NSArray::from_slice(&writers));
            let text = NSString::from_str(
                &paths.iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>().join("\n"),
            );
            board.setString_forType(&text, unsafe { NSPasteboardTypeString });
            written
        })
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
    use std::path::PathBuf;

    pub fn has_files() -> bool {
        false
    }

    pub fn text() -> Option<String> {
        None
    }

    pub fn files() -> std::io::Result<Vec<PathBuf>> {
        Ok(Vec::new())
    }

    pub fn set_files(_paths: &[PathBuf]) -> bool {
        false
    }

    pub fn set_text(_text: &str) -> bool {
        false
    }

    pub fn image() -> Option<Option<super::Image>> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(list: &[&str]) -> Vec<PathBuf> {
        list.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn a_written_list_reads_back_unchanged() {
        let list = paths(&["C:/work/project/a.txt", "C:/work/project/sub"]);
        assert_eq!(decode(&encode(&list)), list);
    }

    #[test]
    fn the_header_says_where_the_paths_start_and_that_they_are_wide() {
        let bytes = encode(&paths(&["C:/a"]));
        assert_eq!(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]), HEADER as u32);
        assert_eq!(u32::from_le_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]), 1);
        // `C:/a` plus its NUL, then the empty string that ends the list.
        assert_eq!(bytes.len(), HEADER + (4 + 1 + 1) * 2);
        assert_eq!(&bytes[HEADER + 6..HEADER + 8], b"a\0");
        assert_eq!(&bytes[bytes.len() - 4..], &[0, 0, 0, 0]);
    }

    #[test]
    fn names_outside_the_ansi_code_page_survive() {
        let list = paths(&["C:/工作/文档/测试.txt", "C:/a/"]);
        assert_eq!(decode(&encode(&list)), list);
    }

    #[test]
    fn an_empty_list_has_no_paths() {
        assert_eq!(decode(&encode(&[])), Vec::<PathBuf>::new());
        // A lone terminator is enough for the reader to stop.
        assert_eq!(decode(&[0u8; HEADER]), Vec::<PathBuf>::new());
    }

    #[test]
    fn a_truncated_or_foreign_block_reads_as_no_paths() {
        assert_eq!(decode(&[]), Vec::<PathBuf>::new());
        assert_eq!(decode(&[1, 2, 3]), Vec::<PathBuf>::new());
        let mut far = encode(&paths(&["C:/a"]));
        far[0] = 0xff; // pFiles past the end
        assert_eq!(decode(&far), Vec::<PathBuf>::new());
    }

    #[test]
    fn an_ansi_list_is_still_read_before_the_terminator() {
        let mut bytes = vec![0u8; HEADER];
        bytes[..4].copy_from_slice(&(HEADER as u32).to_le_bytes());
        bytes[16] = 0; // fWide: the list is single-byte
        bytes.extend_from_slice(b"C:\\a\\b.txt\0C:\\c\0\0");
        assert_eq!(decode(&bytes), paths(&["C:\\a\\b.txt", "C:\\c"]));
    }

    /// A `BITMAPINFOHEADER` of `header` bytes for a 1x1 bitmap, then `pixels`.
    fn dib(header: u32, bits: u16, compression: u32, used: u32, extra: usize) -> Vec<u8> {
        let mut dib = vec![0; header as usize];
        dib[0..4].copy_from_slice(&header.to_le_bytes());
        dib[4..8].copy_from_slice(&1i32.to_le_bytes());
        dib[8..12].copy_from_slice(&1i32.to_le_bytes());
        dib[12..14].copy_from_slice(&1u16.to_le_bytes());
        dib[14..16].copy_from_slice(&bits.to_le_bytes());
        dib[16..20].copy_from_slice(&compression.to_le_bytes());
        dib[32..36].copy_from_slice(&used.to_le_bytes());
        dib.extend(std::iter::repeat_n(0xAB, extra));
        dib
    }

    fn offset(bmp: &[u8]) -> u32 {
        u32::from_le_bytes(bmp[10..14].try_into().unwrap())
    }

    #[test]
    fn a_true_colour_dib_gets_a_file_header_pointing_past_the_info_header() {
        let block = dib(40, 32, 0, 0, 4);
        let bmp = dib_to_bmp(&block).unwrap();
        assert_eq!(&bmp[0..2], b"BM");
        assert_eq!(u32::from_le_bytes(bmp[2..6].try_into().unwrap()) as usize, 14 + block.len());
        assert_eq!(offset(&bmp), 14 + 40);
        assert_eq!(&bmp[14..], &block[..]);
    }

    #[test]
    fn the_pixel_offset_skips_bitfield_masks_and_the_colour_table() {
        assert_eq!(offset(&dib_to_bmp(&dib(40, 32, 3, 0, 16)).unwrap()), 14 + 40 + 12);
        assert_eq!(offset(&dib_to_bmp(&dib(40, 8, 0, 0, 1024 + 4)).unwrap()), 14 + 40 + 256 * 4);
        assert_eq!(offset(&dib_to_bmp(&dib(40, 8, 0, 2, 8 + 4)).unwrap()), 14 + 40 + 2 * 4);
        // A BITMAPV5HEADER holds its masks itself.
        assert_eq!(offset(&dib_to_bmp(&dib(124, 32, 3, 0, 4)).unwrap()), 14 + 124);
    }

    #[test]
    fn a_block_shorter_than_its_header_is_not_a_bitmap() {
        assert_eq!(dib_to_bmp(&[]), None);
        assert_eq!(dib_to_bmp(&dib(40, 32, 0, 0, 0)[..30]), None);
        // A 12-byte BITMAPCOREHEADER is not what CF_DIB holds.
        let core: Vec<u8> = 12u32.to_le_bytes().into_iter().chain([0; 36]).collect();
        assert_eq!(dib_to_bmp(&core), None);
    }
}
