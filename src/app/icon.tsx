import { ImageResponse } from 'next/og';

export const size = { width: 48, height: 48 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    <div style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', borderRadius: 11, backgroundColor: '#224c82', color: '#f1f6ff', fontSize: 24, fontWeight: 700 }}>IT</div>,
    size,
  );
}
