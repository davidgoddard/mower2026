const INT16_MIN = -32768;
const INT16_MAX = 32767;
const UINT16_MAX = 65535;

export function roundScaled(value: number, scale: number): number {
  return Math.round(value * scale);
}

export function clampInt16(value: number): number {
  if (!Number.isFinite(value) || value < INT16_MIN || value > INT16_MAX) {
    throw new RangeError(`Value ${value} out of int16 range`);
  }
  return value;
}

export function clampUint16(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > UINT16_MAX) {
    throw new RangeError(`Value ${value} out of uint16 range`);
  }
  return value;
}

export function encodeOptionalInt16(view: DataView, offset: number, value: number | undefined, scale: number): void {
  view.setInt16(offset, value === undefined ? INT16_MAX : clampInt16(roundScaled(value, scale)), true);
}

export function decodeOptionalInt16(view: DataView, offset: number, scale: number): number | undefined {
  const encoded = view.getInt16(offset, true);
  return encoded === INT16_MAX ? undefined : encoded / scale;
}

export function encodeOptionalUint16(view: DataView, offset: number, value: number | undefined, scale: number): void {
  view.setUint16(offset, value === undefined ? UINT16_MAX : clampUint16(roundScaled(value, scale)), true);
}

export function decodeOptionalUint16(view: DataView, offset: number, scale: number): number | undefined {
  const encoded = view.getUint16(offset, true);
  return encoded === UINT16_MAX ? undefined : encoded / scale;
}
