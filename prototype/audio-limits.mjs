// Bounded single-file pilot: a 1h 16 kHz mono PCM16 WAV is 115,200,044 bytes.
// This is not an unlimited upload service or a claim about long BLE transfers.
export const maxAudioBytes = 256 * 1024 * 1024;
export const audioLimitLabel = '256 MiB';
export const uploadTimeoutMs = 15 * 60 * 1000;
