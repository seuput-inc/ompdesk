pub const WINDOW_BYTES: usize = 1024 * 1024;
pub const WINDOW_CHUNKS: usize = 16;
pub const CHUNK_BYTES: usize = WINDOW_BYTES / WINDOW_CHUNKS;

#[derive(Debug, Default)]
pub struct Credit {
    bytes: usize,
    chunks: usize,
}

impl Credit {
    pub fn receive(&mut self, bytes: usize) -> Result<(), &'static str> {
        if bytes == 0
            || bytes > CHUNK_BYTES
            || self.bytes + bytes > WINDOW_BYTES
            || self.chunks == WINDOW_CHUNKS
        {
            return Err("protocol producer exceeded its receive window");
        }
        self.bytes += bytes;
        self.chunks += 1;
        Ok(())
    }

    pub fn consumed(&mut self, bytes: usize, chunks: usize) -> Result<(), &'static str> {
        if bytes > self.bytes || chunks > self.chunks || (bytes == 0 && chunks == 0) {
            return Err("protocol consumer returned invalid credit");
        }
        self.bytes -= bytes;
        self.chunks -= chunks;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slow_consumers_bound_bytes_and_tiny_chunk_count() {
        let mut credit = Credit::default();
        for _ in 0..WINDOW_CHUNKS {
            credit.receive(CHUNK_BYTES).unwrap();
        }
        assert!(credit.receive(1).is_err());
        credit.consumed(CHUNK_BYTES, 1).unwrap();
        credit.receive(CHUNK_BYTES).unwrap();
        assert!(credit.receive(CHUNK_BYTES + 1).is_err());
        assert!(credit.consumed(WINDOW_BYTES + 1, 1).is_err());
        credit.consumed(WINDOW_BYTES, WINDOW_CHUNKS).unwrap();
        for _ in 0..WINDOW_CHUNKS {
            credit.receive(1).unwrap();
        }
        assert!(credit.receive(1).is_err());
    }

    #[test]
    fn partial_native_reads_return_bytes_without_freeing_a_chunk_slot() {
        let mut credit = Credit::default();
        for _ in 0..WINDOW_CHUNKS {
            credit.receive(CHUNK_BYTES).unwrap();
        }
        credit.consumed(1, 0).unwrap();
        assert!(credit.receive(1).is_err());
        credit.consumed(CHUNK_BYTES - 1, 1).unwrap();
        credit.receive(CHUNK_BYTES).unwrap();
    }
}
