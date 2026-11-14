"""Pure data adapters for explicit exports; no files, network, DB or application imports."""


def normalize_event(event):
    # Caller supplies observed eventId/seq/provenance, never invented by adapters.
    if event.get('kind') == 'mobile_upload_receipt':
        payload = event.get('payload')
        if not isinstance(payload, dict):
            return event
        out = {k: event[k] for k in ('eventId', 'seq', 'provenance') if k in event}
        out['kind'] = 'upload'
        for field in ('recordingId', 'localId', 'sha256', 'bytes', 'duplicate'):
            if field in payload:
                out[field] = payload[field]
        return out
    if event.get('kind') == 'recording_transcript_export':
        payload = event.get('payload')
        if not isinstance(payload, dict):
            return event
        out = {k: event[k] for k in ('eventId', 'seq', 'provenance') if k in event}
        out['kind'] = 'transcript'
        if 'id' in payload:
            out['recordingId'] = payload['id']
        if 'transcript' in payload:
            out['segments'] = payload['transcript']
        return out
    # Task snapshots/confirmations alone cannot prove historical ordering, run
    # starts, or proposal validity at confirmation. Do not synthesize history.
    return event
