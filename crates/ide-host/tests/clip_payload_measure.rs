//! Measurement for the whole-payload cap (docs/clipcode/non-text-files.md): a ~49 MiB files-mode payload of
//! non-text files through copy, paste preview and paste apply, with wall time and peak RSS (Linux VmHWM).
//! Run: `cargo test -p ide-host --test clip_payload_measure -- --ignored --nocapture`.

use ide_clip::settings::Settings;
use ide_host::ops::clip::{
    ClipCopySource, ClipNonTextMode, ClipPasteApply, copy_with, paste_apply, paste_preview_into,
};
use std::fs;
use std::time::Instant;

fn peak_rss_mib() -> f64 {
    let status = fs::read_to_string("/proc/self/status").unwrap_or_default();
    status
        .lines()
        .find_map(|l| l.strip_prefix("VmHWM:"))
        .and_then(|v| v.trim().trim_end_matches("kB").trim().parse::<f64>().ok())
        .map_or(f64::NAN, |kb| kb / 1024.0)
}

fn random_bytes(seed: u64, len: usize) -> Vec<u8> {
    let mut x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    let mut out = Vec::with_capacity(len);
    while out.len() < len {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        out.extend_from_slice(&x.to_le_bytes());
    }
    out.truncate(len);
    out
}

#[test]
#[ignore = "measurement: ~49 MiB payload, run explicitly"]
fn measure_50_mib_non_text_payload() {
    let src_tmp = tempfile::tempdir().unwrap();
    let src = fs::canonicalize(src_tmp.path()).unwrap();
    fs::create_dir_all(src.join("data")).unwrap();
    let mut raw = 0usize;
    for i in 0..37u64 {
        let len = if i == 36 { 900 * 1024 } else { 1024 * 1024 };
        raw += len;
        fs::write(src.join(format!("data/f{i:02}.bin")), random_bytes(i + 1, len)).unwrap();
    }
    let settings = Settings { file_count_limit: 100.0, ..Settings::default() };
    println!("raw bytes {raw} ({:.1} MiB), baseline peak RSS {:.0} MiB", raw as f64 / 1048576.0, peak_rss_mib());

    let t = Instant::now();
    let copied =
        copy_with(&src, ClipCopySource::Files { paths: vec![src.join("data")] }, &settings, ClipNonTextMode::Include)
            .unwrap();
    println!(
        "copy/plan: {:.2?}, payload {:.1} MiB, files {}, peak RSS {:.0} MiB",
        t.elapsed(),
        copied.text.len() as f64 / 1048576.0,
        copied.files,
        peak_rss_mib()
    );

    let dst_tmp = tempfile::tempdir().unwrap();
    let dst = fs::canonicalize(dst_tmp.path()).unwrap();
    let t = Instant::now();
    let preview = paste_preview_into(&dst, None, &[], &copied.text, false, &[], &settings).unwrap();
    println!("paste_preview: {:.2?}, rows {}, peak RSS {:.0} MiB", t.elapsed(), preview.files.len(), peak_rss_mib());

    let t = Instant::now();
    let result = paste_apply(ClipPasteApply { id: preview.id, ..Default::default() }).unwrap();
    println!("paste_apply: {:.2?}, created {}, peak RSS {:.0} MiB", t.elapsed(), result.created, peak_rss_mib());
    assert_eq!(result.created, 37);
    assert_eq!(fs::read(dst.join("data/f00.bin")).unwrap(), random_bytes(1, 1024 * 1024));
}
