# QS668 Ogg wrapper provenance

Unmodified `qs668_raw_opus_to_ogg.py` and MIT LICENSE from Zoty's 2026-11-14
`protocol-replay.zip`, archive SHA-256:
`0a3da6f89831bc11829ccbd6dc6937bd915b7ac57c27f6327020b5a1f61ed2a5`.
Vendor: NextProto (2026). Original path: `third_party/qs668/`.
The surrounding JS adapter validates the restricted 40-byte device profile before
calling this wrapper, and requires real macOS decoding afterwards.
Framing reference: https://www.rfc-editor.org/rfc/rfc6716.html#section-3.2.5
