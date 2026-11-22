const MAX_FRAME_JSON = 768 * 1024;
const CHUNK_BYTES = 576 * 1024;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;

export function* nativeResponseFrames(response) {
  const bytes = new TextEncoder().encode(JSON.stringify(response));
  if (bytes.length <= MAX_FRAME_JSON) {
    yield response;
    return;
  }
  const { id } = response;
  if (bytes.length > MAX_RESPONSE_BYTES) {
    yield { id, error: { code: 'OUTPUT_TOO_LARGE', message: 'The result exceeds the response limit.' } };
    return;
  }
  const total = Math.ceil(bytes.length / CHUNK_BYTES);
  for (let index = 0; index < total; index++) {
    const frame = bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
    let data = '';
    for (let offset = 0; offset < frame.length; offset += 8192) {
      data += String.fromCharCode(...frame.subarray(offset, offset + 8192));
    }
    yield { id, chunk: { index, total, data: btoa(data) } };
  }
}
