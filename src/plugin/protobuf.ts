/**
 * Manual protobuf wire-format helpers.
 *
 * Kept tiny and dependency-free so the plugin doesn't pull a full protobuf
 * runtime. Shared between production (grpc-client / cascade-client) and the
 * tests/live/* scripts so there's exactly one place to audit. Historical
 * bugs (silent corruption of field-≥-16 tags because the helpers wrote a
 * single byte instead of varint-encoding the tag) all stemmed from these
 * functions being duplicated and drifting; do not re-inline them anywhere.
 */

/** Unsigned varint encode. */
export function encodeVarint(value: number | bigint): number[] {
  const bytes: number[] = [];
  let v = BigInt(value);
  while (v > 127n) {
    bytes.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  bytes.push(Number(v));
  return bytes;
}

/**
 * Encode the field tag (field_number << 3 | wire_type) as a varint.
 *
 * Critical: field numbers ≥ 16 need a 2-byte tag. Writing the tag as a single
 * raw byte produces an invalid varint and the server quietly mis-parses
 * subsequent fields (you might see `neither PlanModel nor RequestedModel
 * specified` or `invalid UTF-8` for the *next* field instead of an obvious
 * error on the offending one). Always go through `encodeVarint`.
 */
export function encodeTag(fieldNum: number, wireType: number): number[] {
  return encodeVarint((fieldNum << 3) | wireType);
}

/** Length-delimited string (wire type 2). */
export function encodeString(fieldNum: number, str: string): number[] {
  const strBytes = Buffer.from(str, 'utf8');
  return [...encodeTag(fieldNum, 2), ...encodeVarint(strBytes.length), ...strBytes];
}

/** Length-delimited embedded message (wire type 2). */
export function encodeMessage(fieldNum: number, data: number[]): number[] {
  return [...encodeTag(fieldNum, 2), ...encodeVarint(data.length), ...data];
}

/** Varint scalar field (wire type 0). */
export function encodeVarintField(fieldNum: number, value: number | bigint): number[] {
  return [...encodeTag(fieldNum, 0), ...encodeVarint(value)];
}

/** Bool field (varint with 0/1 payload). */
export function encodeBoolField(fieldNum: number, value: boolean): number[] {
  return encodeVarintField(fieldNum, value ? 1 : 0);
}

/**
 * Decode a varint starting at `offset`. Returns `[value, bytesRead]`.
 */
export function decodeVarint(buffer: Buffer, offset: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let bytesRead = 0;
  while (offset + bytesRead < buffer.length) {
    const byte = buffer[offset + bytesRead];
    bytesRead++;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }
  return [result, bytesRead];
}
