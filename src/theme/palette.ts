// AudioNotes design system — LIGHT ONLY.
//
// Direction: "warm professional". The reference is Duolingo's physical, friendly chunkiness —
// solid fills, generous radii, a hard bottom edge that makes things look pressable — executed
// with the restraint a work tool needs. Friendly, not gamified. Nobody wants confetti in the
// middle of a client meeting.
//
// Why light only: the dark theme was a second, half-tuned palette that never matched the light
// one, and maintaining two is how both end up mediocre. One palette, properly tuned.
//
// Why solid colour instead of shadows: Android elevation renders as a soft grey blur that muddies
// a warm palette and costs a layer to composite. A 2-3px darker bottom border reads as physical
// depth, matches the reference, and is free.

export interface Colors {
  // Surfaces
  canvas: string; // page background — warm, never pure white
  card: string; // raised surface
  cardAlt: string; // subtle inset / secondary fill
  line: string; // hairline borders
  lineStrong: string; // the "hard edge" under pressable things

  // Ink
  ink: string; // primary text
  inkSoft: string; // secondary text
  inkFaint: string; // tertiary / placeholder

  // Brand
  primary: string;
  primaryEdge: string; // darker bottom edge for pressed depth
  primarySoft: string; // tinted background
  onPrimary: string;

  // Semantic
  success: string;
  successEdge: string;
  successSoft: string;
  warning: string;
  warningEdge: string;
  warningSoft: string;
  danger: string; // live recording + destructive
  dangerEdge: string;
  dangerSoft: string;

  // Speaker identity chips — distinguishable at a glance, none competing with `danger`,
  // all legible as text on their soft counterpart.
  speakers: readonly string[];
  speakersSoft: readonly string[];

  // Back-compat aliases (older screens referenced these names).
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  textDim: string;
  textFaint: string;
  accent: string;
  ok: string;
}

const ink = '#1A2233';
const inkSoft = '#5B6779';
const inkFaint = '#98A2B3';

export const lightColors: Colors = {
  canvas: '#F7F8FA',
  card: '#FFFFFF',
  cardAlt: '#F1F3F7',
  line: '#E6E9EF',
  lineStrong: '#D4D9E2',

  ink,
  inkSoft,
  inkFaint,

  // Indigo rather than a corporate navy: confident and calm, but with enough warmth to sit
  // beside the amber accent without going cold.
  primary: '#4763E4',
  primaryEdge: '#3049C4',
  primarySoft: '#EDF0FE',
  onPrimary: '#FFFFFF',

  success: '#10A96B',
  successEdge: '#0B8654',
  successSoft: '#E4F6ED',

  warning: '#F0A020',
  warningEdge: '#CC8410',
  warningSoft: '#FDF2DF',

  // Coral, not fire-engine red. It has to read as "live" for a whole meeting without feeling
  // like an error the user should be doing something about.
  danger: '#F0555F',
  dangerEdge: '#CE3B45',
  dangerSoft: '#FDECEE',

  speakers: ['#4763E4', '#10A96B', '#F0A020', '#8B5CF6', '#0EA5C4', '#E4576B'],
  speakersSoft: ['#EDF0FE', '#E4F6ED', '#FDF2DF', '#F3EDFE', '#E3F6FA', '#FDECEF'],

  bg: '#F7F8FA',
  surface: '#FFFFFF',
  surfaceAlt: '#F1F3F7',
  border: '#E6E9EF',
  text: ink,
  textDim: inkSoft,
  textFaint: inkFaint,
  accent: '#4763E4',
  ok: '#10A96B',
};

// The app is light-only now. Kept as an alias so any straggling import still compiles rather
// than crashing at runtime on an undefined palette.
export const darkColors: Colors = lightColors;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

// Generous radii — the single strongest signal of "friendly" in the reference.
export const radius = { sm: 10, md: 14, lg: 20, xl: 28, pill: 999 };

/**
 * Poppins, bundled in assets/fonts. React Native on Android resolves these by FILE name, so the
 * family string must match the .ttf exactly — `fontWeight` does NOT select a weight from a
 * bundled family; it would synthesise a fake bold over whichever file loaded. Always name the file.
 */
export const font = {
  regular: 'Poppins-Regular',
  medium: 'Poppins-Medium',
  semibold: 'Poppins-SemiBold',
  bold: 'Poppins-Bold',
  extrabold: 'Poppins-ExtraBold',
} as const;

/**
 * Type scale. Poppins runs optically large and its default line height is tight for UI, so each
 * step carries an explicit lineHeight; leaving it to the platform gives cramped multi-line titles.
 * Slight negative tracking on the display sizes — geometric faces look loose when scaled up.
 */
export const type = {
  display: { fontFamily: font.extrabold, fontSize: 30, lineHeight: 38, letterSpacing: -0.6 },
  title: { fontFamily: font.bold, fontSize: 22, lineHeight: 30, letterSpacing: -0.3 },
  heading: { fontFamily: font.semibold, fontSize: 17, lineHeight: 24, letterSpacing: -0.1 },
  body: { fontFamily: font.regular, fontSize: 15, lineHeight: 23 },
  bodyStrong: { fontFamily: font.medium, fontSize: 15, lineHeight: 23 },
  label: { fontFamily: font.semibold, fontSize: 13, lineHeight: 18 },
  caption: { fontFamily: font.medium, fontSize: 12, lineHeight: 16 },
  // Section headers: small, spaced, uppercase — quiet structure without another type size.
  overline: {
    fontFamily: font.bold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 1.1,
    textTransform: 'uppercase' as const,
  },
} as const;

/** Durations, in ms. Short enough to feel responsive; long enough to read as deliberate. */
export const motion = { fast: 130, base: 220, slow: 380, breathe: 2600 } as const;
