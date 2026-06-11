const UINT16_MAX = 65535;

export function decodeOptionalUint16(view: DataView, offset: number, scale: number): number | undefined {
  const encoded = view.getUint16(offset, true);
  return encoded === UINT16_MAX ? undefined : encoded / scale;
}
