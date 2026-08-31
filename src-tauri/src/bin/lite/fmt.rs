//! Small formatting helpers shared across the lite views.

/// Bytes/sec → human string (B/s, KB/s, MB/s, GB/s).
pub fn rate(bps: f64) -> String {
    if bps < 1024.0 {
        format!("{bps:.0} B/s")
    } else if bps < 1_048_576.0 {
        format!("{:.1} KB/s", bps / 1024.0)
    } else if bps < 1_073_741_824.0 {
        format!("{:.1} MB/s", bps / 1_048_576.0)
    } else {
        format!("{:.2} GB/s", bps / 1_073_741_824.0)
    }
}

/// Bytes → human string (KB/MB/GB).
pub fn bytes(b: f64) -> String {
    if b < 1024.0 {
        format!("{b:.0} B")
    } else if b < 1_048_576.0 {
        format!("{:.0} KB", b / 1024.0)
    } else if b < 1_073_741_824.0 {
        format!("{:.0} MB", b / 1_048_576.0)
    } else {
        format!("{:.1} GB", b / 1_073_741_824.0)
    }
}

/// Megabytes → compact string; switches to GB above 1024 MB.
pub fn mb(mb: f64) -> String {
    if mb >= 1024.0 {
        format!("{:.2} GB", mb / 1024.0)
    } else {
        format!("{mb:.0} MB")
    }
}
