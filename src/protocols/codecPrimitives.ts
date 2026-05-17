const INT16_MAX = 32767;
const INT32_MAX = 2147483647;
const UINT16_MAX = 65535;

export function decodeOptionalInt16(view: DataView, offset: number, scale: number): number | undefined {
  const encoded = view.getInt16(offset, true);
  return encoded === INT16_MAX ? undefined : encoded / scale;
}

export function decodeOptionalInt32(view: DataView, offset: number, scale: number): number | undefined {
  const encoded = view.getInt32(offset, true);
  return encoded === INT32_MAX ? undefined : encoded / scale;
}

export function decodeOptionalUint16(view: DataView, offset: number, scale: number): number | undefined {
  const encoded = view.getUint16(offset, true);
  return encoded === UINT16_MAX ? undefined : encoded / scale;
}
