//! StartupApproved registry blob encode/decode (same format Task Manager uses).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ApproveStatus {
    pub enabled: bool,
    pub initialized: bool,
    pub editable: bool,
}

pub fn decode_approve_status(bytes: Option<&[u8]>) -> ApproveStatus {
    let Some(bytes) = bytes else {
        return ApproveStatus {
            enabled: true,
            initialized: false,
            editable: true,
        };
    };
    if bytes.is_empty() {
        return ApproveStatus {
            enabled: true,
            initialized: false,
            editable: true,
        };
    }
    let b0 = bytes[0];
    ApproveStatus {
        enabled: (b0 & 1) == 0,
        initialized: true,
        editable: (b0 & 8) == 0,
    }
}

pub fn encode_approve_status(enabled: bool, editable: bool) -> [u8; 12] {
    let mut bytes = [0u8; 12];
    if enabled {
        bytes[0] = 2;
    } else {
        bytes[0] = 3;
        let ts = chrono::Utc::now().timestamp();
        // FILETIME = (unix + 11644473600) * 10_000_000
        let filetime = (ts + 11_644_473_600) as i64 * 10_000_000;
        bytes[4..12].copy_from_slice(&filetime.to_le_bytes());
    }
    if !editable {
        bytes[0] += 8;
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_enabled() {
        let blob = encode_approve_status(true, true);
        let st = decode_approve_status(Some(&blob));
        assert!(st.enabled);
        assert!(st.editable);
        assert!(st.initialized);
    }

    #[test]
    fn round_trip_disabled() {
        let blob = encode_approve_status(false, true);
        let st = decode_approve_status(Some(&blob));
        assert!(!st.enabled);
        assert!(st.editable);
    }

    #[test]
    fn decode_taskmgr_disabled_sample() {
        // disabled: byte0 = 3
        let st = decode_approve_status(Some(&[3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
        assert!(!st.enabled);
        assert!(st.editable);
    }
}
