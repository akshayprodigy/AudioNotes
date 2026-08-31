// Verbale design tokens — transcribed from the Claude Design source
// ("Mobile app redesign concept" / Meetings App.dc.html). Values here are the DESIGN's values,
// not approximations: where the design says #4A56D2, this says #4A56D2.
//
// Two ideas carry the whole look, and both were under-done in the first pass:
//
//  1. HARD OFFSET SHADOWS. Every raised surface sits on a solid, un-blurred shadow of 4-10px
//     (`0 6px 0 #E4E7F1`), not a soft blur and not 2px. That single value is most of why the
//     reference feels physical and toy-like rather than flat.
//  2. SLIGHT ROTATION. Cards are tilted a fraction of a degree in alternating directions
//     (-0.6, +0.8, -1.2, +0.4, -0.9). It reads as hand-placed rather than machine-stacked, and
//     it is the detail that makes the layout look designed instead of generated.

export interface Colors {
  canvas: string;
  card: string;
  cardAlt: string;
  line: string;
  lineStrong: string;

  ink: string;
  inkSoft: string;
  inkDim: string;
  inkFaint: string;

  primary: string;
  primaryLight: string; // gradient end
  // The lighter TOP of a primary gradient fill — the CTA button and the record button both run
  // this into `primary`. It is a shade of its own in the design, not `primaryLight`, which is the
  // end of the 135deg card gradients.
  primaryTop: string;
  // Primary used as FOREGROUND — a label or glyph sitting on a card or a tinted fill, the same
  // role `successDeep` and `warningDeep` play for their hues. In light it is `primary` exactly,
  // because #4A56D2 already reads on a pale ground; in dark it has to LIFT, since the brand indigo
  // at #5F6BE0 only clears 3.6:1 on a near-black card and small type disappears into it.
  primaryDeep: string;
  primaryEdge: string; // hard shadow under primary surfaces
  primarySoft: string;
  primarySoft2: string; // gradient end for tinted fills
  primarySoftEdge: string;
  onPrimary: string;

  success: string;
  successDeep: string; // large numerals on tinted fills
  successSoft: string;
  successSoft2: string;
  successEdge: string;

  warning: string;
  warningDeep: string;
  warningSoft: string;
  warningSoft2: string;
  warningEdge: string;
  gold: string; // streak fill

  danger: string;
  dangerLight: string;
  dangerEdge: string;
  dangerSoft: string;
  wave1: string;
  wave2: string;
  wave3: string;

  blush: string;
  handle: string;

  // Asleep / not-running. The mascot's body when it is dozing and the PiP mic button when capture
  // is paused are the same idea — present, obviously inert — and they need the same three-part
  // treatment every live surface gets: a lighter gradient top, a fill, and a hard shadow under it.
  dormantLight: string;
  dormant: string;
  dormantEdge: string;

  // Pip's face plate and the features drawn on it. These do NOT follow the page: the face stays a
  // light disc in both themes (that is the character), so its eyes and mouth must stay dark in
  // both. Reaching for `card`/`ink` here would give the dark theme a white-on-white face.
  mascotFace: string;
  mascotEye: string;
  mascotBlush: string;

  /** Full-bleed dim behind a modal sheet, drawn at low opacity over whatever is beneath. */
  scrim: string;
  /** The warm radial wash behind the live recorder, fading out into `canvas`. */
  warmWash: string;

  speakers: readonly string[];
  speakersSoft: readonly string[];

  // Back-compat aliases for screens not yet migrated.
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

export const lightColors: Colors = {
  canvas: '#F5F7FA',
  card: '#FFFFFF',
  cardAlt: '#F1F3FA',
  line: '#E4E7F1',
  lineStrong: '#E2E6F0',

  ink: '#16192C',
  inkSoft: '#6B7185',
  inkDim: '#8A90A6',
  inkFaint: '#A2A8BC',

  primary: '#4A56D2',
  primaryLight: '#6C74E8',
  primaryTop: '#5A66DE',
  primaryDeep: '#4A56D2',
  primaryEdge: '#3A45B4',
  primarySoft: '#EEF0FF',
  primarySoft2: '#DFE3FF',
  primarySoftEdge: '#CDD3F6',
  onPrimary: '#FFFFFF',

  success: '#12A870',
  successDeep: '#0E8F5F',
  successSoft: '#E9FBF1',
  successSoft2: '#D8F5E7',
  successEdge: '#C9EBDA',

  warning: '#C77700',
  warningDeep: '#8A5A00',
  warningSoft: '#FFF3DF',
  warningSoft2: '#FFE7C2',
  warningEdge: '#F0DDBE',
  gold: '#FFD166',

  danger: '#E9575A',
  dangerLight: '#F0696C',
  dangerEdge: '#C6474A',
  dangerSoft: '#FFEBEC',
  wave1: '#F0A5A7',
  wave2: '#EC7A7C',
  wave3: '#E9575A',

  blush: '#FFC9CE',
  handle: '#C9CEDD',

  dormantLight: '#A2A8BC',
  dormant: '#8A90A6',
  dormantEdge: '#7C84A6',

  mascotFace: '#FFFFFF',
  mascotEye: '#16192C',
  mascotBlush: '#FFC9CE',

  scrim: '#0B1030',
  warmWash: '#FFF0F0',

  speakers: ['#4A56D2', '#12A870', '#C77700', '#8B5CF6', '#0EA5C4', '#E4576B'],
  speakersSoft: ['#EEF0FF', '#E9FBF1', '#FFF3DF', '#F3EDFE', '#E3F6FA', '#FDECEF'],

  bg: '#F5F7FA',
  surface: '#FFFFFF',
  surfaceAlt: '#F1F3FA',
  border: '#E4E7F1',
  text: '#16192C',
  textDim: '#6B7185',
  textFaint: '#A2A8BC',
  accent: '#4A56D2',
  ok: '#12A870',
};

/**
 * The dark palette, designed AGAINST the light one rather than derived from it.
 *
 * Dark mode was removed once before because an inverted light theme looked wrong beside it. Three
 * things are what make an inversion fail, and each is handled here deliberately:
 *
 *  1. THE HARD SHADOW HAS TO INVERT ITS LOGIC, NOT ITS VALUE. In the light theme every raised
 *     surface sits on a solid offset shadow LIGHTER than the page (#E4E7F1 on #F5F7FA). Lightening
 *     a dark ground the same way makes cards glow at the bottom edge. Here every `*Edge` token is
 *     DARKER than the surface it sits under, so the same 6px offset still reads as a physical
 *     lip — the effect the design is built on survives.
 *  2. SATURATED BRAND COLOUR MUST LIFT. #4A56D2 on a near-black canvas is a hole, not an accent:
 *     it loses against the surrounding text. Primary lifts to #5F6BE0 (white on it still clears
 *     4.5:1) and its light/edge pair move with it.
 *  3. TINTED FILLS INVERT, THEY DO NOT DIM. The light theme's pale wash fills (#EEF0FF) become
 *     dark tints of the same hue (#1C2039), and the "deep" tokens — large numerals set ON those
 *     fills — flip from darker-than-the-hue to BRIGHTER, because they are now on a dark ground.
 *  4. A HUE USED AS INK IS NOT THE SAME VALUE AS THE HUE USED AS PAINT. `primary` has to stay dark
 *     enough that white sits on it, which leaves it at 3.6:1 against a near-black card — fine for
 *     a 2.4pt icon stroke, unreadable for a 12pt tab label. `primaryDeep` is the ink version, and
 *     in LIGHT it is `primary` unchanged, so reaching for it never alters the light theme.
 *
 * Every token is a real chosen value. Nothing here is a programmatic inversion of the line above.
 */
export const darkColors: Colors = {
  canvas: '#0E1017',
  card: '#171A24',
  cardAlt: '#1E222E',
  line: '#262B39',
  lineStrong: '#2F3546',

  ink: '#F2F4FA',
  inkSoft: '#A8AFC4',
  inkDim: '#878EA4',
  inkFaint: '#666D82',

  primary: '#5F6BE0',
  primaryLight: '#7C86F0',
  primaryTop: '#6E79EA',
  primaryDeep: '#98A2F5',
  primaryEdge: '#38409C',
  primarySoft: '#1C2039',
  primarySoft2: '#232848',
  primarySoftEdge: '#141731',
  onPrimary: '#FFFFFF',

  success: '#2FBF85',
  successDeep: '#6FE3B4',
  successSoft: '#10241C',
  successSoft2: '#152F24',
  successEdge: '#0A1913',

  warning: '#E2A038',
  warningDeep: '#FFCB6B',
  warningSoft: '#2A2113',
  warningSoft2: '#342818',
  warningEdge: '#1D160C',
  gold: '#FFD166',

  danger: '#F0696C',
  dangerLight: '#F58A8C',
  dangerEdge: '#A63A3D',
  dangerSoft: '#2C1618',
  // The darkest of the three meter shades had to come up: at #8E4C4E it sat at 2.7:1 against the
  // warm wash the recorder draws behind it, so a third of the bars all but vanished at rest.
  wave1: '#9E5457',
  wave2: '#C25D60',
  wave3: '#F0696C',

  blush: '#7A4147',
  handle: '#3A4053',

  dormantLight: '#5C6479',
  dormant: '#4A5165',
  dormantEdge: '#343A4A',

  // The face keeps its light disc, pulled off pure white so it does not glare out of a black
  // screen, and the features stay dark BECAUSE the ground under them is still light.
  mascotFace: '#E8EBF5',
  mascotEye: '#191D2E',
  // Not `blush`: the cheeks are painted on that light face, so they need the light theme's soft
  // pink, only a shade deeper to hold against #E8EBF5. `blush` itself stays a dark-ground value.
  mascotBlush: '#F0A9B0',

  // Near-black rather than the light theme's indigo-black: a scrim over a dark page has almost no
  // room to darken, so it has to spend all of it on neutral depth.
  scrim: '#04060C',
  // Ember rather than pink. The light theme's #FFF0F0 is a blush over white; on #0E1017 the same
  // idea is a warm coal that the canvas fades out of.
  warmWash: '#2A1519',

  speakers: ['#7C86F0', '#2FBF85', '#E2A038', '#A78BFA', '#38BDF8', '#F4778C'],
  speakersSoft: ['#1C2039', '#10241C', '#2A2113', '#231B3A', '#0F2733', '#2E171E'],

  bg: '#0E1017',
  surface: '#171A24',
  surfaceAlt: '#1E222E',
  border: '#262B39',
  text: '#F2F4FA',
  textDim: '#A8AFC4',
  textFaint: '#666D82',
  accent: '#5F6BE0',
  ok: '#2FBF85',
};

// ---------------------------------------------------------------------------------------------
// Responsive scale
// ---------------------------------------------------------------------------------------------

import { Dimensions, PixelRatio } from 'react-native';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

/** The design canvas: a 374pt-wide phone screen inside the mockup's device frame. */
const BASE_W = 374;

/**
 * Scale a design value to this device.
 *
 * LINEAR in screen width, deliberately: the design's proportions — a 148pt record button on a
 * 374pt screen, a 62pt clock — are the thing being asked for, and damping the ratio quietly
 * changes every one of them. Clamped either side so a very small phone stays legible and a
 * tablet-ish width does not blow the layout up.
 *
 * Rounded to the pixel grid; fractional sizes make text render blurry on Android.
 */
export function s(size: number): number {
  const ratio = Math.min(1.22, Math.max(0.85, SCREEN_W / BASE_W));
  return PixelRatio.roundToNearestPixel(size * ratio);
}

/** Scale that also respects height — for the few elements that must fit a short screen. */
export function sv(size: number): number {
  const byW = Math.min(1.22, Math.max(0.85, SCREEN_W / BASE_W));
  const byH = Math.min(1.22, Math.max(0.8, SCREEN_H / 812));
  return PixelRatio.roundToNearestPixel(size * Math.min(byW, byH));
}

export const screen = {
  width: SCREEN_W,
  height: SCREEN_H,
  isShort: SCREEN_H < 720,
  isNarrow: SCREEN_W < 360,
} as const;

export const spacing = { xs: 4, sm: 6, md: 10, lg: 14, xl: 20, xxl: 26 };

/**
 * Radii straight from the design, SCALED like every other dimension.
 *
 * They were raw px, which quietly broke the proportion between a card's corner and its size on
 * anything but a 374pt screen — a design-26 corner on a 1.10-scaled phone reads as 23.6 against
 * padding that did grow. Every entry here is a real value from the source: controls 14/18/20,
 * tiles 12/22, cards 24/26, the consent sheet 30.
 */
export const radius = {
  sm: s(12),
  md: s(14),
  lg: s(18),
  ctl: s(20), // consent CTA, checklist active row, transcript bubble
  xl: s(22),
  card24: s(24), // gist card, amber card
  card: s(26),
  sheet: s(30),
  pill: 999,
};

/**
 * Nunito, instanced from the upstream variable font into true statics (400/600/700/800/900).
 *
 * React Native on Android resolves a bundled family by FILE name, and `fontWeight` cannot pick an
 * instance out of a variable font — it would synthesise a fake bold instead. The design leans on
 * 800/900 almost everywhere, so shipping real cut weights rather than smeared ones matters.
 */
export const font = {
  regular: 'Nunito-Regular',
  semibold: 'Nunito-SemiBold',
  bold: 'Nunito-Bold',
  extrabold: 'Nunito-ExtraBold',
  black: 'Nunito-Black',
} as const;


/**
 * Type scale, in DESIGN units — resolved through `s()` at the point of use.
 *
 * Tokens are named `size/weight` wherever the design uses the same size at more than one weight,
 * because it does so constantly and a single token per size silently flattens the hierarchy: the
 * design has 12px at both 800 (timestamps, stat labels, count chips) and 900 (status pills,
 * overlines, transcript headers), and 15px at 600 / 700 / 800 / 900 on four different elements.
 * An earlier single-token-per-size table rendered a dozen of them at the wrong weight.
 *
 * Weights map to Nunito cuts, never numeric `fontWeight` — on Android that synthesises a fake
 * bold over whichever file loaded instead of selecting the real cut.
 */
export const type = {
  screenTitle: { family: font.black, size: 34, line: 34, tracking: -1 }, // 34/900
  clock: { family: font.black, size: 62, line: 62, tracking: -2 }, // 62/900
  display: { family: font.black, size: 25, line: 30, tracking: -0.5 }, // 25/900
  statNum: { family: font.black, size: 28, line: 28, tracking: 0 }, // 28/900
  statNumSm: { family: font.black, size: 22, line: 24, tracking: 0 }, // 22/900 amber value
  sectionTitle: { family: font.black, size: 20, line: 22, tracking: 0 }, // 20/900
  cardTitle: { family: font.black, size: 19, line: 24, tracking: 0 }, // 19/900 lh1.25
  cta: { family: font.black, size: 17, line: 22, tracking: 0 }, // 17/900 CTA + FAB
  gist: { family: font.black, size: 17, line: 23, tracking: 0 }, // 17/900 lh1.35
  cardTitleSm: { family: font.black, size: 16, line: 21, tracking: 0 }, // 16/900
  minuteBody: { family: font.extrabold, size: 16, line: 22, tracking: 0 }, // 16/800 lh1.35
  // 16/600 lh1.6 — the only token meant for READING rather than scanning. Everything else in this
  // scale is 800 or 900, which is right for a label, a stat or a one-line gist and wrong for a
  // paragraph: set at that weight a summary stops being emphasis and becomes a wall. Loose leading
  // for the same reason.
  prose: { family: font.semibold, size: 16, line: 26, tracking: 0 },
  bodyBlack: { family: font.black, size: 15, line: 20, tracking: 0 }, // 15/900
  bodyStrong: { family: font.extrabold, size: 15, line: 20, tracking: 0 }, // 15/800
  transcript: { family: font.bold, size: 15, line: 21, tracking: 0 }, // 15/700 lh1.4
  body: { family: font.semibold, size: 15, line: 23, tracking: 0 }, // 15/600 lh1.5
  label: { family: font.black, size: 14, line: 18, tracking: 0 }, // 14/900 footer buttons
  sub: { family: font.bold, size: 14, line: 19, tracking: 0 }, // 14/700 sub-lines, proc body
  metaBlack: { family: font.black, size: 13, line: 17, tracking: 0 }, // 13/900 pills, actions
  meta: { family: font.extrabold, size: 13, line: 17, tracking: 0 }, // 13/800
  chip: { family: font.black, size: 12, line: 15, tracking: 0 }, // 12/900 pills, headers
  chipSoft: { family: font.extrabold, size: 12, line: 15, tracking: 0 }, // 12/800 times, labels
  chipSm: { family: font.black, size: 11, line: 14, tracking: 0 }, // 11/900
  overline: { family: font.black, size: 12, line: 15, tracking: 1.4 }, // 12/900 ls1.4
  overlineSm: { family: font.black, size: 11, line: 14, tracking: 1.2 }, // 11/900 ls1.2
} as const;

export type TypeKey = keyof typeof type;

/** Resolve a type token into a React Native text style at this device's scale. */
export function text(key: TypeKey, color?: string) {
  const t = type[key];
  return {
    fontFamily: t.family,
    fontSize: s(t.size),
    lineHeight: s(t.line),
    // Tracking scales with the type. It is a design-canvas px value sitting next to the font
    // size, so leaving it raw makes the 62px clock's -2 read as -1.6 once the size grows to 76.
    letterSpacing: t.tracking === 0 ? 0 : s(t.tracking),
    ...(color ? { color } : null),
  };
}

/** Durations, in ms. */
export const motion = { fast: 130, base: 220, slow: 380, breathe: 2600 } as const;

/**
 * The alternating card tilts from the design, in order of appearance. Kept as a shared list so
 * the rhythm stays consistent wherever cards are stacked.
 */
export const TILT = [-0.6, 0.8, -1.2, 0.4, -0.9, 0.6] as const;
export const tilt = (i: number) => `${TILT[i % TILT.length]}deg`;
