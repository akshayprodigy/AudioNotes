import React from 'react';
import Svg, { Path, Circle, Line, Polyline, Rect } from 'react-native-svg';

// Curated stroke-icon set (Feather-style, MIT-derived geometry). Themeable via `color`.
export type IconName =
  | 'mic'
  | 'stop'
  | 'search'
  | 'settings'
  | 'record'
  | 'list'
  | 'users'
  | 'share'
  | 'download'
  | 'trash'
  | 'merge'
  | 'ai'
  | 'check'
  | 'chevronRight'
  | 'plus'
  | 'sun'
  | 'moon'
  | 'shield'
  | 'refresh'
  | 'clock'
  | 'alert'
  | 'edit'
  | 'x';

interface Props {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}

export default function Icon({ name, size = 24, color = '#000', strokeWidth = 2 }: Props) {
  const common = {
    stroke: color,
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none',
  };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {render(name, common, color)}
    </Svg>
  );
}

function render(name: IconName, c: object, color: string) {
  switch (name) {
    case 'mic':
      return (
        <>
          <Path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" {...c} />
          <Path d="M19 10v1a7 7 0 0 1-14 0v-1" {...c} />
          <Line x1="12" y1="18" x2="12" y2="22" {...c} />
          <Line x1="8" y1="22" x2="16" y2="22" {...c} />
        </>
      );
    case 'stop':
      return <Rect x="6" y="6" width="12" height="12" rx="2" {...c} fill={color} stroke={color} />;
    case 'refresh':
      return (
        <>
          <Polyline points="23 4 23 10 17 10" {...c} />
          <Polyline points="1 20 1 14 7 14" {...c} />
          <Path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" {...c} />
        </>
      );
    case 'record':
      return <Circle cx="12" cy="12" r="7" {...c} fill={color} stroke={color} />;
    case 'search':
      return (
        <>
          <Circle cx="11" cy="11" r="7" {...c} />
          <Line x1="21" y1="21" x2="16.65" y2="16.65" {...c} />
        </>
      );
    case 'settings':
      return (
        <>
          <Line x1="4" y1="21" x2="4" y2="14" {...c} />
          <Line x1="4" y1="10" x2="4" y2="3" {...c} />
          <Line x1="12" y1="21" x2="12" y2="12" {...c} />
          <Line x1="12" y1="8" x2="12" y2="3" {...c} />
          <Line x1="20" y1="21" x2="20" y2="16" {...c} />
          <Line x1="20" y1="12" x2="20" y2="3" {...c} />
          <Line x1="1" y1="14" x2="7" y2="14" {...c} />
          <Line x1="9" y1="8" x2="15" y2="8" {...c} />
          <Line x1="17" y1="16" x2="23" y2="16" {...c} />
        </>
      );
    case 'list':
      return (
        <>
          <Line x1="8" y1="6" x2="21" y2="6" {...c} />
          <Line x1="8" y1="12" x2="21" y2="12" {...c} />
          <Line x1="8" y1="18" x2="21" y2="18" {...c} />
          <Circle cx="3.5" cy="6" r="1" fill={color} stroke={color} />
          <Circle cx="3.5" cy="12" r="1" fill={color} stroke={color} />
          <Circle cx="3.5" cy="18" r="1" fill={color} stroke={color} />
        </>
      );
    case 'users':
      return (
        <>
          <Path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" {...c} />
          <Circle cx="9" cy="7" r="4" {...c} />
          <Path d="M23 21v-2a4 4 0 0 0-3-3.87" {...c} />
          <Path d="M16 3.13a4 4 0 0 1 0 7.75" {...c} />
        </>
      );
    case 'share':
      return (
        <>
          <Circle cx="18" cy="5" r="3" {...c} />
          <Circle cx="6" cy="12" r="3" {...c} />
          <Circle cx="18" cy="19" r="3" {...c} />
          <Line x1="8.6" y1="13.5" x2="15.4" y2="17.5" {...c} />
          <Line x1="15.4" y1="6.5" x2="8.6" y2="10.5" {...c} />
        </>
      );
    case 'download':
      return (
        <>
          <Path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" {...c} />
          <Polyline points="7 10 12 15 17 10" {...c} />
          <Line x1="12" y1="15" x2="12" y2="3" {...c} />
        </>
      );
    case 'trash':
      return (
        <>
          <Polyline points="3 6 5 6 21 6" {...c} />
          <Path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" {...c} />
        </>
      );
    case 'merge':
      return (
        <>
          <Circle cx="6" cy="18" r="3" {...c} />
          <Circle cx="6" cy="6" r="3" {...c} />
          <Path d="M6 9v6a9 9 0 0 0 9 3" {...c} />
          <Circle cx="18" cy="18" r="3" {...c} />
        </>
      );
    case 'ai':
      return <Polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" {...c} />;
    case 'check':
      return <Polyline points="20 6 9 17 4 12" {...c} />;
    case 'chevronRight':
      return <Polyline points="9 18 15 12 9 6" {...c} />;
    case 'plus':
      return (
        <>
          <Line x1="12" y1="5" x2="12" y2="19" {...c} />
          <Line x1="5" y1="12" x2="19" y2="12" {...c} />
        </>
      );
    case 'sun':
      return (
        <>
          <Circle cx="12" cy="12" r="4" {...c} />
          <Line x1="12" y1="1" x2="12" y2="3" {...c} />
          <Line x1="12" y1="21" x2="12" y2="23" {...c} />
          <Line x1="4.2" y1="4.2" x2="5.6" y2="5.6" {...c} />
          <Line x1="18.4" y1="18.4" x2="19.8" y2="19.8" {...c} />
          <Line x1="1" y1="12" x2="3" y2="12" {...c} />
          <Line x1="21" y1="12" x2="23" y2="12" {...c} />
          <Line x1="4.2" y1="19.8" x2="5.6" y2="18.4" {...c} />
          <Line x1="18.4" y1="5.6" x2="19.8" y2="4.2" {...c} />
        </>
      );
    case 'moon':
      return <Path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" {...c} />;
    case 'shield':
      return <Path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" {...c} />;
    case 'clock':
      return (
        <>
          <Circle cx="12" cy="12" r="9" {...c} />
          <Polyline points="12 7 12 12 15.5 14" {...c} />
        </>
      );
    case 'alert':
      return (
        <>
          <Circle cx="12" cy="12" r="9" {...c} />
          <Line x1="12" y1="8" x2="12" y2="13" {...c} />
          <Line x1="12" y1="16.5" x2="12" y2="16.5" {...c} />
        </>
      );
    case 'edit':
      return (
        <>
          <Path d="M12 20h9" {...c} />
          <Path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" {...c} />
        </>
      );
    case 'x':
      return (
        <>
          <Line x1="18" y1="6" x2="6" y2="18" {...c} />
          <Line x1="6" y1="6" x2="18" y2="18" {...c} />
        </>
      );
    default:
      return null;
  }
}
