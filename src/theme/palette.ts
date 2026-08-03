// Corporate palette — stable, professional, built for meeting/work contexts.
// Blue primary, green for success/done, light orange as the warm accent, red only for live recording.
// Two full themes (light default for corporate, plus dark).

export interface Colors {
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;

  text: string;
  textDim: string;
  textFaint: string;

  primary: string; // blue — primary actions, links, active
  onPrimary: string; // text/icon on a primary fill
  primarySoft: string; // tinted primary background

  success: string; // green — done / positive
  successSoft: string;
  warning: string; // light orange — attention / secondary accent
  warningSoft: string;
  danger: string; // red — reserved for the live recording state
  dangerSoft: string;

  // Back-compat aliases used across older screens.
  accent: string; // = primary
  ok: string; // = success
}

export const lightColors: Colors = {
  bg: '#F5F7FA',
  surface: '#FFFFFF',
  surfaceAlt: '#EDF1F6',
  border: '#DCE2EA',

  text: '#0F1B2D',
  textDim: '#5A6675',
  textFaint: '#8A96A5',

  primary: '#2563EB',
  onPrimary: '#FFFFFF',
  primarySoft: '#E6EEFE',

  success: '#15A05A',
  successSoft: '#E3F5EC',
  warning: '#F59E3C',
  warningSoft: '#FDEEDD',
  danger: '#E5484D',
  dangerSoft: '#FCE9EA',

  accent: '#2563EB',
  ok: '#15A05A',
};

export const darkColors: Colors = {
  bg: '#0E1116',
  surface: '#171B22',
  surfaceAlt: '#1F242D',
  border: '#2A303B',

  text: '#EAEEF4',
  textDim: '#9AA6B4',
  textFaint: '#68727F',

  primary: '#4F8CFF',
  onPrimary: '#08122A',
  primarySoft: '#16233F',

  success: '#3ECf8E',
  successSoft: '#12291F',
  warning: '#FBB264',
  warningSoft: '#2E2213',
  danger: '#FF6B6B',
  dangerSoft: '#2E1516',

  accent: '#4F8CFF',
  ok: '#3ECf8E',
};

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 };
export const radius = { sm: 8, md: 12, lg: 20, pill: 999 };
