use super::Decoder;

const GZIP: &[u8] = &[
    31, 139, 8, 0, 0, 0, 0, 0, 2, 255, 75, 203, 44, 42, 46, 201, 73, 44, 46, 1, 0, 206, 217, 88,
    151, 9, 0, 0, 0,
];
const DEFLATE: &[u8] = &[
    120, 156, 75, 203, 44, 42, 46, 201, 73, 44, 46, 1, 0, 19, 40, 3, 221,
];

#[test]
fn compressed_response_decodes_across_single_byte_network_chunks() {
    for (encoding, bytes) in [("gzip", GZIP), ("deflate", DEFLATE)] {
        let mut decoder = Decoder::new(&[("content-encoding".into(), encoding.into())], true);
        let mut output = Vec::new();
        for byte in bytes {
            decoder
                .push(std::slice::from_ref(byte), |chunk| {
                    output.extend_from_slice(chunk)
                })
                .unwrap();
        }
        decoder.finish().unwrap();
        assert_eq!(output, b"firstlast");
    }
}

#[test]
fn truncated_response_does_not_report_successful_end() {
    let mut decoder = Decoder::new(&[("content-encoding".into(), "gzip".into())], true);
    let mut output = Vec::new();
    decoder
        .push(&GZIP[..GZIP.len() - 1], |chunk| {
            output.extend_from_slice(chunk)
        })
        .unwrap();
    assert_eq!(output, b"firstlast");
    assert_eq!(
        decoder.finish().unwrap_err(),
        "truncated compressed HTTP body"
    );
}
