/**
 * The sound-design vocabulary.
 *
 * Every cue in a book uses one of these tags. A fixed vocabulary keeps the
 * scene analysis cheap and predictable (the model picks a tag instead of
 * writing a prompt), lets one generated sound be reused for every "rain" in the
 * book, and gives each tag a built-in recipe so sound design works with no
 * paid provider at all.
 *
 * Built-in sounds are synthesised with ffmpeg's `aevalsrc` / `anoisesrc`
 * sources. They are deliberately simple: at the levels Bookx mixes them (well
 * under the voice, for a second or two) a filtered-noise rain or a two-partial
 * sword ring reads as the real thing.
 */

export type SoundKind = "sfx" | "music";
export type SoundLevel = "ultra-subtle" | "extra-subtle" | "subtle";
export type SoundSourceSetting = "auto" | "elevenlabs" | "builtin";
export type SoundSource = "elevenlabs" | "builtin";

type SynthLayer = { source: string; filters?: string };
type SynthRecipe = { layers: SynthLayer[]; post?: string };

export type SoundTagDefinition = {
  tag: string;
  kind: SoundKind;
  label: string;
  /** What the tag is for, shown to the scene-analysis model. */
  hint: string;
  /** Text-to-sound prompt for ElevenLabs. */
  prompt: string;
  /** Length to generate, in seconds. */
  durationSeconds: number;
  /** Textures (rain, wind) fade in; impacts (a knock) start at once. */
  texture: "continuous" | "impact";
  /** Narration that describes this sound, for the rule-based fallback. */
  keywords?: RegExp;
  synth: SynthRecipe;
};

export const SAMPLE_RATE = 44_100;

/** Bump to invalidate every cached sound (e.g. after changing a recipe). */
export const SOUND_RECIPE_VERSION = "v2";

// ---------------------------------------------------------------------------
// Expression helpers. Expressions never contain ':' or '\'', so a single level
// of quoting is enough inside a filtergraph.
// ---------------------------------------------------------------------------

const round = (value: number) => Number(value.toFixed(4));

const tone = (d: number, expression: string): string => `aevalsrc=exprs='${expression}':s=${SAMPLE_RATE}:d=${d}`;

const noise = (d: number, color: "white" | "pink" | "brown", seed: number, amplitude = 0.5): string =>
  // Small frames so `volume` envelopes evaluated per frame stay smooth (~6 ms).
  `anoisesrc=r=${SAMPLE_RATE}:c=${color}:a=${amplitude}:s=${seed}:n=256:d=${d}`;

const envelope = (expression: string): string => `volume='${expression}':eval=frame`;

/** Exponentially decaying partials starting at `at` seconds: a clang, a knock, a bell. */
function strike(at: number, partials: Array<[number, number]>, decay: number, gain = 1): string {
  const tau = `(t-${round(at)})`;
  const body = partials.map(([frequency, weight]) => `${weight}*sin(2*PI*${frequency}*${tau})`).join("+");
  return `if(gte(t,${round(at)}),${gain}*exp(-${decay}*${tau})*(${body}),0)`;
}

/** A decaying low thump every `period` seconds, first at `offset` (steps, hooves). */
function pulse(period: number, offset: number, frequency: number, decay: number, gain: number): string {
  const tau = `mod(t+${round(period - offset)},${period})`;
  return `${gain}*exp(-${decay}*${tau})*sin(2*PI*${frequency}*${tau})`;
}

/** One voice of a chord: the fundamental plus integer harmonics, so a looped pad stays in phase. */
function voice(frequency: number, brightness: number): string {
  return `(sin(2*PI*${frequency}*t)+${brightness}*sin(2*PI*${round(frequency * 2)}*t)+${round(brightness / 3)}*sin(2*PI*${round(frequency * 3)}*t))`;
}

/** One sustained chord with a soft crossfade in and out, for music pads. */
function chord(notes: number[], from: number, to: number, brightness = 0.3, crossfade = 0.6): string {
  const shape = `clip((t-${from})/${crossfade},0,1)*clip((${to}-t)/${crossfade},0,1)`;
  return `${shape}*(${notes.map(frequency => voice(frequency, brightness)).join("+")})`;
}

/**
 * A chord held at full level for `d` seconds, for a looped bed: the loop point
 * hands off to itself without a dip. The mixer fades swells in and out, so the
 * recipe does not need its own.
 */
function loopChord(notes: number[], d: number, brightness: number): string {
  return notes.map(frequency => voice(frequency, brightness)).join("+");
}

/**
 * Three chords in an ABA arc over `d` seconds. The first chord returns at the
 * end, so the loop point is a clean hand-off between the same chord, and the
 * modulation period divides `d`, so the loop is seamless.
 */
function progression(d: number, first: number[], second: number[], brightness: number): string {
  const segment = d / 3;
  const crossfade = Math.min(0.5, segment / 2);
  const chords = [first, second, first];
  const parts = chords.map((notes, index) => {
    const from = index * segment;
    const to = (index + 1) * segment;
    const fadeIn = index === 0 ? 0.001 : crossfade;
    const fadeOut = index === chords.length - 1 ? 0.001 : crossfade;
    const shape = `clip((t-${round(from)})/${fadeIn},0,1)*clip((${round(to)}-t)/${fadeOut},0,1)`;
    return `${shape}*(${notes.map(frequency => voice(frequency, brightness)).join("+")})`;
  });
  return `0.075*(0.88+0.12*sin(2*PI*${round(1 / d)}*t))*(${parts.join("+")})`;
}

const pluck = (at: number, frequency: number, gain = 0.22) => strike(at, [[frequency, 1], [round(frequency * 2), 0.25]], 3.2, gain);

const room = "aecho=0.8:0.55:90|170:0.22|0.12";

// Note frequencies used by the music recipes (Hz).
const N = {
  C2: 65.41, D2: 73.42, Eb2: 77.78, G2: 98.0, A2: 110.0, Bb2: 116.54, B2: 123.47,
  C3: 130.81, D3: 146.83, Eb3: 155.56, E3: 164.81, F3: 174.61, G3: 196.0, A3: 220.0, Bb3: 233.08, B3: 246.94,
  C4: 261.63, Cs4: 277.18, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.0, A4: 440.0, B4: 493.88,
  C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.0, Cs6: 1108.73, D6: 1174.66,
};

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

const sfx = (definition: Omit<SoundTagDefinition, "kind">): SoundTagDefinition => ({ ...definition, kind: "sfx" });
const music = (definition: Omit<SoundTagDefinition, "kind" | "texture">): SoundTagDefinition => ({ ...definition, kind: "music", texture: "continuous" });

const knockTimes = [0.05, 0.29, 0.53];
const hoofOffsets = [0, 0.1, 0.19];

export const SOUND_TAGS: SoundTagDefinition[] = [
  sfx({
    tag: "rain", label: "Rain", hint: "rain falling, a shower, a downpour",
    prompt: "Soft steady rain falling outside a window, gentle and distant, no thunder, no music",
    durationSeconds: 3.2, texture: "continuous",
    keywords: /\b(rain(?:ing|ed|drops?|fall|water)?|downpour|drizzl\w*|showers? of rain)\b/i,
    synth: { layers: [
      { source: noise(3.2, "pink", 11, 0.6), filters: `highpass=f=450,lowpass=f=6500,${envelope("0.85+0.15*sin(2*PI*0.5*t)")}` },
      { source: tone(3.2, "gt(random(0),0.9994)*0.7"), filters: "highpass=f=2200,lowpass=f=9000" },
    ] },
  }),
  sfx({
    tag: "thunder", label: "Thunder", hint: "thunder, a storm breaking",
    prompt: "A single distant rumble of thunder rolling across the sky, soft, far away, no rain, no music",
    durationSeconds: 4, texture: "continuous",
    keywords: /\b(thunder(?:ed|ing|clap|claps|storm|storms)?|lightning)\b/i,
    synth: { layers: [
      { source: noise(4, "brown", 23, 0.9), filters: `lowpass=f=220,lowpass=f=420,${envelope("if(lt(t,0.18),t/0.18,exp(-1.1*(t-0.18)))*(0.75+0.25*sin(2*PI*2.3*t)*sin(2*PI*0.9*t))")}` },
    ] },
  }),
  sfx({
    tag: "wind", label: "Wind", hint: "wind, a gust, a gale",
    prompt: "A gentle gust of wind blowing past, airy and soft, no music",
    durationSeconds: 3.6, texture: "continuous",
    keywords: /\b(wind(?:s|y)?|gusts?|gusting|gale|breeze)\b/i,
    synth: { layers: [
      { source: noise(3.6, "pink", 31, 0.7), filters: `bandpass=f=520:width_type=q:w=0.9,lowpass=f=1600,${envelope("0.4+0.35*sin(2*PI*0.42*t)+0.25*sin(2*PI*1.07*t+1.3)")}` },
    ] },
  }),
  sfx({
    tag: "swords", label: "Swords clashing", hint: "blades clashing in a duel or fight",
    prompt: "Two steel swords clashing twice in a duel, distant, clean metallic ring, no voices, no music",
    durationSeconds: 1.8, texture: "impact",
    keywords: /\b(clash(?:ed|ing)? of (?:steel|swords|blades)|(?:swords?|blades?|steel)\b[^.]{0,40}\b(?:clash\w*|rang|ringing|struck|parr\w*|met))\b/i,
    synth: { layers: [
      { source: tone(1.8, `${strike(0.02, [[1873, 0.5], [2742, 0.35], [3851, 0.22], [5210, 0.12]], 7)}+${strike(0.66, [[1690, 0.5], [2521, 0.35], [3480, 0.22], [4730, 0.12]], 7.5, 0.85)}`), filters: "highpass=f=400" },
      { source: noise(1.8, "white", 41, 0.8), filters: `highpass=f=2500,${envelope("exp(-45*t)+if(gte(t,0.66),0.85*exp(-45*(t-0.66)),0)")}` },
    ] },
  }),
  sfx({
    tag: "battle", label: "Distant battle", hint: "a battle or melee raging around the characters",
    prompt: "Distant medieval battle, faint clash of swords and muffled shouts far away, no music",
    durationSeconds: 3.2, texture: "continuous",
    keywords: /\b(battle(?:field)?|skirmish|melee|war ?cr(?:y|ies)|the fighting|soldiers charged)\b/i,
    synth: { layers: [
      {
        source: tone(3.2, [
          strike(0.15, [[1920, 0.5], [2810, 0.3], [3990, 0.2]], 8, 0.7),
          strike(0.72, [[1650, 0.5], [2470, 0.3], [3520, 0.2]], 8, 0.55),
          strike(1.05, [[2210, 0.5], [3150, 0.3]], 9, 0.5),
          strike(1.8, [[1780, 0.5], [2650, 0.3], [3700, 0.2]], 8, 0.65),
          strike(2.35, [[2050, 0.5], [3010, 0.3]], 9, 0.45),
        ].join("+")),
        filters: "highpass=f=500,lowpass=f=5000",
      },
      { source: noise(3.2, "brown", 53, 0.8), filters: `lowpass=f=700,${envelope("0.6+0.25*sin(2*PI*0.8*t)+0.15*sin(2*PI*2.1*t)")}` },
    ] },
  }),
  sfx({
    tag: "footsteps", label: "Footsteps", hint: "footsteps, someone walking or pacing",
    prompt: "A few slow footsteps on a wooden floor, soft, no music",
    durationSeconds: 2.4, texture: "impact",
    keywords: /\b(footsteps?|footfalls?|(?:boots?|heels) (?:on|against|echo\w*|clicked)|steps? echo\w*)\b/i,
    synth: { layers: [
      { source: tone(2.4, `(0.8+0.2*mod(floor(t/0.52),2))*exp(-38*mod(t,0.52))*sin(2*PI*92*mod(t,0.52))`), filters: "lowpass=f=900" },
      { source: noise(2.4, "white", 61, 0.6), filters: `bandpass=f=1800:width_type=q:w=1.2,${envelope("exp(-60*mod(t,0.52))")}` },
    ] },
  }),
  sfx({
    tag: "door", label: "Door", hint: "a door creaking, opening, closing or slamming",
    prompt: "An old wooden door creaks open and closes softly, no music",
    durationSeconds: 1.8, texture: "impact",
    keywords: /\b(?:door|gate)s?\b[^.]{0,30}\b(creak\w*|slam\w*|shut|clos(?:ed|ing)|swung|bang\w*)\b/i,
    synth: { layers: [
      { source: tone(1.8, `if(lt(t,0.85),0.3*sin(PI*t/0.85)*sin(2*PI*(360*t+70*t*t)+2.4*sin(2*PI*8*t)),0)+${strike(0.95, [[70, 1], [140, 0.35]], 20, 0.9)}+${strike(0.99, [[2600, 1]], 160, 0.3)}`), filters: "lowpass=f=4000" },
      { source: noise(1.8, "brown", 71, 0.8), filters: `lowpass=f=600,${envelope("if(gte(t,0.95),exp(-28*(t-0.95)),0)")}` },
    ] },
  }),
  sfx({
    tag: "knock", label: "Knocking", hint: "a knock at a door",
    prompt: "Three soft knocks on a wooden door, no music",
    durationSeconds: 1.3, texture: "impact",
    keywords: /\b(knock(?:ed|ing|s)?|rapp(?:ed|ing) (?:at|on))\b/i,
    synth: { layers: [
      { source: tone(1.3, knockTimes.map(at => strike(at, [[165, 1], [330, 0.4], [520, 0.2]], 30, 0.8)).join("+")), filters: "lowpass=f=2400" },
      { source: noise(1.3, "white", 81, 0.5), filters: `bandpass=f=1200:width_type=q:w=1,${envelope(knockTimes.map(at => `if(gte(t,${at}),exp(-90*(t-${at})),0)`).join("+"))}` },
    ] },
  }),
  sfx({
    tag: "horse", label: "Horse", hint: "hooves, a horse galloping or trotting",
    prompt: "A horse galloping past on a dirt road, distant, no music",
    durationSeconds: 2.6, texture: "impact",
    keywords: /\b(hoof|hooves|hoofbeats?|gallop\w*|trott(?:ed|ing))\b/i,
    synth: { layers: [
      { source: tone(2.6, hoofOffsets.map(offset => pulse(0.62, offset, 115, 42, 0.6)).join("+")), filters: "lowpass=f=1500" },
      { source: noise(2.6, "white", 91, 0.5), filters: `bandpass=f=2200:width_type=q:w=1.5,${envelope(hoofOffsets.map(offset => `exp(-70*mod(t+${round(0.62 - offset)},0.62))`).join("+"))}` },
    ] },
  }),
  sfx({
    tag: "fire", label: "Fire crackling", hint: "a fire, hearth or campfire crackling",
    prompt: "A small fireplace crackling softly, warm and quiet, no music",
    durationSeconds: 3.2, texture: "continuous",
    keywords: /\b(fireplace|hearth|campfire|bonfire|crackl\w+|the fire (?:crackled|burned|roared|popped))\b/i,
    synth: { layers: [
      { source: noise(3.2, "brown", 101, 0.7), filters: `lowpass=f=500,${envelope("0.7+0.3*sin(2*PI*0.7*t)")}` },
      { source: tone(3.2, "gt(random(0),0.99955)*0.9"), filters: "highpass=f=1500,lowpass=f=7000" },
    ] },
  }),
  sfx({
    tag: "waves", label: "Waves", hint: "the sea, waves breaking on a shore",
    prompt: "Gentle ocean waves washing onto a sandy shore, calm and distant, no music",
    durationSeconds: 4.5, texture: "continuous",
    keywords: /\b(waves (?:crash\w*|broke|lapp\w*|roll\w*)|surf|the tide|breakers|shoreline|the sea (?:roared|hissed|sighed))\b/i,
    synth: { layers: [
      { source: noise(4.5, "pink", 111, 0.8), filters: `lowpass=f=1200,highpass=f=90,${envelope("0.15+0.85*pow(sin(PI*t/4.5),2)")}` },
    ] },
  }),
  sfx({
    tag: "birds", label: "Birdsong", hint: "birds singing, a quiet morning outdoors",
    prompt: "A few birds chirping softly in a quiet morning garden, no music",
    durationSeconds: 2.8, texture: "continuous",
    keywords: /\b(birds?(?:ong)? (?:sang|singing|chirp\w*|call\w*)|chirp\w*|twitter\w*|sparrows?|robins?|larks?)\b/i,
    synth: { layers: [
      {
        source: tone(2.8, "0.35*if(lt(mod(t,0.43),0.11),sin(PI*mod(t,0.43)/0.11),0)*sin(2*PI*(2900+450*mod(floor(t/0.43),3))*t+2.2*sin(2*PI*23*t))+0.25*if(lt(mod(t+0.21,0.61),0.08),sin(PI*mod(t+0.21,0.61)/0.08),0)*sin(2*PI*3800*t+1.6*sin(2*PI*31*t))"),
        filters: "highpass=f=1500",
      },
    ] },
  }),
  sfx({
    tag: "crickets", label: "Crickets", hint: "crickets on a quiet night",
    prompt: "Crickets chirping softly on a still summer night, no music",
    durationSeconds: 2.6, texture: "continuous",
    keywords: /\b(crickets?|cicadas?)\b/i,
    synth: { layers: [
      {
        source: tone(2.6, "0.4*sin(2*PI*4400*t)*lt(mod(t,0.042),0.018)*lt(mod(t,0.84),0.38)+0.3*sin(2*PI*4750*t)*lt(mod(t+0.013,0.038),0.016)*lt(mod(t+0.41,0.9),0.34)"),
        filters: "highpass=f=2500,lowpass=f=8000",
      },
    ] },
  }),
  sfx({
    tag: "bell", label: "Bell", hint: "a bell tolling or ringing",
    prompt: "A single distant church bell toll, soft reverb, no music",
    durationSeconds: 4.5, texture: "impact",
    keywords: /\b(bells? (?:toll\w*|rang|ringing|chim\w*)|toll(?:ed|ing) of|church bells?)\b/i,
    synth: { layers: [
      {
        source: tone(4.5, [
          [196, 0.9, 0.35], [392, 1.2, 0.3], [470.4, 1.5, 0.22], [588, 1.8, 0.15], [784, 2.2, 0.2], [1176, 3, 0.1],
        ].map(([frequency, decay, weight]) => `${weight}*exp(-${decay}*t)*sin(2*PI*${frequency}*t)`).join("+") + "+0.15*(2*random(0)-1)*exp(-80*t)"),
        filters: "lowpass=f=5000",
      },
    ] },
  }),
  sfx({
    tag: "clock", label: "Clock ticking", hint: "a clock ticking in a quiet room",
    prompt: "An old clock ticking quietly in a still room, no music",
    durationSeconds: 2.5, texture: "impact",
    keywords: /\b(clock (?:ticked|ticking|struck|chimed)|tick(?:ed|ing) of (?:a|the) clock|ticking)\b/i,
    synth: { layers: [
      { source: tone(2.5, "0.6*exp(-150*mod(t,0.5))*sin(2*PI*if(lt(mod(t,1),0.5),3100,2450)*t)+0.25*(2*random(0)-1)*exp(-320*mod(t,0.5))"), filters: "bandpass=f=2800:width_type=q:w=0.7" },
    ] },
  }),
  sfx({
    tag: "crowd", label: "Crowd murmur", hint: "a crowd, a busy tavern or market",
    prompt: "A murmuring crowd in the distance, indistinct voices, no clear words, no music",
    durationSeconds: 3.2, texture: "continuous",
    keywords: /\b(crowd(?:ed)?|murmur\w*|chatter\w*|tavern|marketplace|throng)\b/i,
    synth: { layers: [
      { source: noise(3.2, "pink", 121, 0.7), filters: `bandpass=f=480:width_type=q:w=1.1,${envelope("0.6+0.25*sin(2*PI*1.7*t)+0.15*sin(2*PI*3.3*t+0.7)")}` },
      { source: noise(3.2, "pink", 131, 0.6), filters: `bandpass=f=1250:width_type=q:w=1.6,${envelope("0.55+0.3*sin(2*PI*2.3*t+1.1)+0.15*sin(2*PI*4.1*t)")}` },
    ] },
  }),
  sfx({
    tag: "gunshot", label: "Gunshot", hint: "a gunshot",
    prompt: "A single distant gunshot echoing across a valley, muffled, no music",
    durationSeconds: 1.6, texture: "impact",
    keywords: /\b(gunshots?|gunfire|shots? rang out|pistol (?:shot|cracked|fired)|rifle (?:shot|cracked|fired))\b/i,
    synth: { layers: [
      { source: tone(1.6, "(2*random(0)-1)*if(lt(t,0.004),t/0.004,exp(-22*(t-0.004)))+0.6*exp(-9*t)*sin(2*PI*58*t)"), filters: "lowpass=f=2400,aecho=0.8:0.5:170|320:0.35|0.2" },
    ] },
  }),
  sfx({
    tag: "explosion", label: "Explosion", hint: "an explosion or blast",
    prompt: "A distant muffled explosion rumbling far away, no music",
    durationSeconds: 3.2, texture: "impact",
    keywords: /\b(explo(?:sion|sions|ded)|blast(?:ed)?|detonat\w*)\b/i,
    synth: { layers: [
      { source: noise(3.2, "brown", 141, 1), filters: `lowpass=f=260,lowpass=f=520,${envelope("if(lt(t,0.03),t/0.03,exp(-1.9*(t-0.03)))")}` },
      { source: tone(3.2, "0.7*exp(-2.4*t)*sin(2*PI*42*t)") },
    ] },
  }),
  sfx({
    tag: "heartbeat", label: "Heartbeat", hint: "a heartbeat heard in a tense silence",
    prompt: "A slow, soft human heartbeat, muffled and close, no music",
    durationSeconds: 2.6, texture: "impact",
    keywords: /\b(heart ?beats?|heart (?:pounded|hammered|thudded|thumped))\b/i,
    synth: { layers: [
      { source: tone(2.6, "0.9*exp(-26*mod(t,0.86))*sin(2*PI*52*mod(t,0.86))+if(gte(mod(t,0.86),0.21),0.7*exp(-30*(mod(t,0.86)-0.21))*sin(2*PI*46*(mod(t,0.86)-0.21)),0)"), filters: "lowpass=f=200" },
    ] },
  }),
  sfx({
    tag: "glass", label: "Glass", hint: "glasses clinking or glass breaking",
    prompt: "Two glasses clinking gently in a toast, no music",
    durationSeconds: 1.4, texture: "impact",
    keywords: /\b(glass(?:es)? (?:clink\w*|shatter\w*|broke|smash\w*)|clink(?:ed|ing)?|shatter(?:ed|ing))\b/i,
    synth: { layers: [
      { source: tone(1.4, `${strike(0.02, [[2750, 0.4], [4120, 0.3], [5590, 0.2], [7030, 0.1]], 7, 0.9)}+${strike(0.3, [[2890, 0.4], [4310, 0.3], [5810, 0.2]], 8, 0.6)}`), filters: "highpass=f=1200" },
    ] },
  }),
  sfx({
    tag: "page", label: "Page turn", hint: "a page turning, paper rustling",
    prompt: "A page of an old book being turned, soft paper rustle, no music",
    durationSeconds: 1.3, texture: "continuous",
    keywords: /\b(turn(?:ed|ing)? (?:the|a) page|pages? (?:turn\w*|rustl\w*|flutter\w*)|rustl\w* (?:of )?(?:paper|pages|parchment))\b/i,
    synth: { layers: [
      { source: tone(1.3, "(2*random(0)-1)*if(lt(t,0.7),pow(sin(PI*t/0.7),2),0)*(0.35+0.65*gt(random(0),0.93))"), filters: "highpass=f=1800,lowpass=f=9000" },
    ] },
  }),

  // ---- Music: short, soft mood swells at the start of a scene ---------------
  music({
    tag: "music-romantic", label: "Romantic", hint: "love, tenderness, longing",
    prompt: "Soft romantic underscore, warm strings and gentle piano swell, slow and tender, instrumental, no drums",
    durationSeconds: 6,
    synth: { layers: [{ source: tone(6, progression(6, [N.F3, N.A3, N.C4, N.E4], [N.D3, N.F3, N.A3, N.C4], 0.3)) }], post: `lowpass=f=2600,${room}` },
  }),
  music({
    tag: "music-tense", label: "Tense", hint: "suspense, threat, unease",
    prompt: "Quiet tense underscore, low sustained strings with a faint uneasy pulse, suspenseful, instrumental",
    durationSeconds: 6,
    synth: { layers: [
      { source: tone(6, `0.09*${loopChord([N.D2, N.Eb2, N.A2], 6, 0.45)}`) },
      { source: tone(6, `0.05*clip(t/1.5,0,1)*(0.5+0.5*sin(2*PI*7*t))*sin(2*PI*${N.A5}*t)`) },
    ], post: "lowpass=f=3000" },
  }),
  music({
    tag: "music-action", label: "Action", hint: "fights, chases, battles",
    prompt: "Soft driving action underscore, low pulsing strings and distant drums, urgent but quiet, instrumental",
    durationSeconds: 6,
    synth: { layers: [
      { source: tone(6, `0.12*pow(0.5+0.5*cos(2*PI*4*t),3)*${loopChord([N.D2, N.A2, N.D3], 6, 0.5)}`) },
      { source: tone(6, "0.5*exp(-18*mod(t,0.5))*sin(2*PI*62*mod(t,0.5))") },
    ], post: "lowpass=f=2500" },
  }),
  music({
    tag: "music-light", label: "Light", hint: "light, happy, playful moments",
    prompt: "Light pleasant underscore, gentle plucked strings and soft piano, cheerful, instrumental, no drums",
    durationSeconds: 6,
    synth: { layers: [
      { source: tone(6, progression(6, [N.C4, N.E4, N.G4, N.D5], [N.G3, N.B3, N.D4, N.A4], 0.45)) },
      { source: tone(6, [[0.2, N.C5], [0.7, N.E5], [1.2, N.G5], [1.7, N.D6], [3.2, N.G4], [3.7, N.B4], [4.2, N.D5], [4.7, N.A5]].map(([at, frequency]) => pluck(at!, frequency!)).join("+")) },
    ], post: `lowpass=f=5000,${room}` },
  }),
  music({
    tag: "music-sad", label: "Sad", hint: "grief, loss, sorrow",
    prompt: "Soft melancholic underscore, slow cello and piano, sorrowful, instrumental",
    durationSeconds: 6,
    synth: { layers: [{ source: tone(6, progression(6, [N.A2, N.A3, N.C4, N.E4], [N.F3, N.A3, N.C4, N.E4], 0.2)) }], post: `lowpass=f=1800,${room}` },
  }),
  music({
    tag: "music-mystery", label: "Mystery", hint: "puzzles, secrets, the strange or uncanny",
    prompt: "Quiet mysterious underscore, soft celesta and low pad, curious and eerie, instrumental",
    durationSeconds: 6,
    synth: { layers: [
      { source: tone(6, `0.07*${loopChord([N.D3, N.F3, N.A3, N.Cs4], 6, 0.25)}`) },
      { source: tone(6, [[0.6, N.A5], [1.4, N.F5], [2.2, N.Cs6], [3.4, N.E5]].map(([at, frequency]) => pluck(at!, frequency!, 0.18)).join("+")) },
    ], post: `lowpass=f=4000,${room}` },
  }),
  music({
    tag: "music-calm", label: "Calm", hint: "quiet, neutral or reflective scenes",
    prompt: "Calm ambient pad, warm and peaceful, soft and slow, instrumental",
    durationSeconds: 6,
    synth: { layers: [{ source: tone(6, progression(6, [N.G3, N.A3, N.D4], [N.G3, N.B3, N.D4, N.G4], 0.25)) }], post: `lowpass=f=2000,${room}` },
  }),
  music({
    tag: "music-hopeful", label: "Hopeful", hint: "relief, resolve, new beginnings",
    prompt: "Soft hopeful underscore, rising warm strings and piano, uplifting, instrumental",
    durationSeconds: 6,
    synth: { layers: [{ source: tone(6, progression(6, [N.C3, N.G3, N.D4, N.E4], [N.B2, N.G3, N.D4, N.G4], 0.35)) }], post: `lowpass=f=3500,${room}` },
  }),
  music({
    tag: "music-dark", label: "Dark", hint: "dread, cruelty, death",
    prompt: "Dark brooding underscore, low drones and deep strings, ominous and quiet, instrumental",
    durationSeconds: 6,
    synth: { layers: [
      { source: tone(6, `0.1*${loopChord([N.C2, N.G2, N.Eb3], 6, 0.35)}`) },
      { source: noise(6, "brown", 151, 0.6), filters: `lowpass=f=120,${envelope("0.5*pow(sin(PI*t/6),2)")}` },
    ], post: "lowpass=f=1500" },
  }),
  music({
    tag: "music-epic", label: "Epic", hint: "grand, momentous events",
    prompt: "Soft epic underscore, distant brass and strings swell with a low timpani roll, grand but restrained, instrumental",
    durationSeconds: 6,
    synth: { layers: [
      { source: tone(6, progression(6, [N.D2, N.A2, N.D3, N.F3], [N.Bb2, N.F3, N.Bb3, N.D4], 0.6)) },
      { source: tone(6, `${strike(0.05, [[65, 1], [98, 0.4]], 3, 0.5)}+${strike(3.1, [[58, 1], [87, 0.4]], 3, 0.45)}`) },
    ], post: `lowpass=f=3000,${room}` },
  }),
];

const BY_TAG = new Map(SOUND_TAGS.map(definition => [definition.tag, definition]));

export const soundTag = (tag: string): SoundTagDefinition | undefined => BY_TAG.get(tag);
export const isSoundTag = (tag: string, kind?: SoundKind): boolean => {
  const definition = BY_TAG.get(tag);
  return Boolean(definition && (!kind || definition.kind === kind));
};
export const sfxTags = () => SOUND_TAGS.filter(definition => definition.kind === "sfx");
export const musicTags = () => SOUND_TAGS.filter(definition => definition.kind === "music");

/** Used when a scene's mood cannot be read. */
export const DEFAULT_MUSIC_TAG = "music-calm";

// ---------------------------------------------------------------------------
// Levels and timing
// ---------------------------------------------------------------------------

/**
 * Cue level relative to the narration's own mean level, in dB.
 *
 * Two limits apply and the quieter one wins: `meanDb` sets how loud a
 * texture sits on average, `peakDb` stops a sharp sound (a knock, a clang)
 * from poking out even though its average is low.
 */
export const SOUND_LEVELS: Record<SoundLevel, Record<SoundKind, { meanDb: number; peakDb: number }>> = {
  "ultra-subtle": { sfx: { meanDb: -30, peakDb: -16 }, music: { meanDb: -32, peakDb: -20 } },
  "extra-subtle": { sfx: { meanDb: -24, peakDb: -10 }, music: { meanDb: -26, peakDb: -14 } },
  subtle: { sfx: { meanDb: -18, peakDb: -4 }, music: { meanDb: -20, peakDb: -8 } },
};

/** A project's level when it is unset or holds a value from an older vocabulary. */
export const DEFAULT_SOUND_LEVEL: SoundLevel = "extra-subtle";

/**
 * How long a cue plays and how much room it needs.
 *
 * Effects play in the pause after the line that describes them and are gone
 * about a second into the next line. Music swells in a pre-roll before a scene
 * opens and fades out under its first lines.
 */
export const CUE_TIMING: Record<SoundKind, {
  maxMs: number;
  fadeInMs: number;
  fadeOutMs: number;
  /** Delay after the anchor line ends ("after" placement). */
  afterOffsetMs: number;
  /** Minimum pause after the anchor line for an "after" cue. */
  gapAfterMs: number;
  /** How far before the anchor line a "before" cue starts. */
  preRollMs: number;
  /** Minimum pause before the anchor line for a "before" cue. */
  gapBeforeMs: number;
}> = {
  sfx: { maxMs: 1600, fadeInMs: 220, fadeOutMs: 650, afterOffsetMs: 120, gapAfterMs: 1000, preRollMs: 900, gapBeforeMs: 1100 },
  music: { maxMs: 5500, fadeInMs: 900, fadeOutMs: 2600, afterOffsetMs: 150, gapAfterMs: 1800, preRollMs: 1600, gapBeforeMs: 1800 },
};

/** An impact (a knock) needs its attack; only textures are faded in. */
export const IMPACT_FADE_IN_MS = 8;

// ---------------------------------------------------------------------------
// Built-in synthesis
// ---------------------------------------------------------------------------

/**
 * ffmpeg arguments that synthesise a tag's built-in sound into `output` as a
 * 44.1 kHz mono MP3. Pure, so the recipes can be checked without running ffmpeg.
 */
export function builtinSoundArgs(definition: SoundTagDefinition, output: string): string[] {
  const d = definition.durationSeconds;
  const layers = definition.synth.layers.map((layer, index) => `${layer.source}${layer.filters ? `,${layer.filters}` : ""}[l${index}]`);
  const inputs = definition.synth.layers.map((_, index) => `[l${index}]`).join("");
  const combine = definition.synth.layers.length > 1
    ? `${inputs}amix=inputs=${definition.synth.layers.length}:normalize=0:duration=longest`
    : `${inputs}anull`;
  const fadeIn = definition.texture === "impact" ? 0.005 : 0.08;
    // Music is looped as a bed, so it must not carry a baked-in fade: the mixer
    // fades swells and beds itself, and a baked fade would dip at every loop
    // point. Effects keep their fades so a lone sound never clicks.
    const post = [
      definition.synth.post,
      ...(definition.kind === "music" ? [] : [`afade=t=in:st=0:d=${fadeIn}`, `afade=t=out:st=${round(Math.max(0, d - 0.35))}:d=0.35`]),
      // Recipes are summed partials, so keep a hard ceiling under full scale.
      "alimiter=limit=0.89:level=0",
    ].filter(Boolean).join(",");
  const graph = [...layers, `${combine},${post}[out]`].join(";");
  return [
    "-filter_complex", graph,
    "-map", "[out]",
    "-ac", "1",
    "-ar", String(SAMPLE_RATE),
    "-c:a", "libmp3lame",
    "-b:a", "128k",
    "-write_xing", "0",
    "-id3v2_version", "0",
    "-map_metadata", "-1",
    "-f", "mp3",
    output,
  ];
}
