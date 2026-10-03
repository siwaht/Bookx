import { cloudflareHeaders, getCloudflareEndpoint, type CloudflareEndpoint } from "./providerCredentials";

/**
 * TypeSafe's Jev, as hosted on Cloudflare Workers AI.
 *
 * Jev is a "System One" model: it does not generate text. It takes one `state`
 * plus a set of typed `questions` and answers all of them in a single parallel
 * pass, returning calibrated probabilities instead of prose. That makes it the
 * wrong tool for anything that has to *write* something (the casting plan
 * itself, narration, summaries) and the right tool for the judgement calls
 * around those — "is this good enough", "which bucket", "how strongly".
 *
 * Note the model id has no `@cf/` prefix: third-party models on Workers AI are
 * addressed as `<vendor>/<model>`.
 */
export const JEV_MODEL = "typesafe/jev";

/**
 * Jev advertises 70-500ms end to end. A 15s ceiling is therefore pure headroom
 * for network and gateway overhead, and deliberately nothing like the 180s the
 * reasoning-model casting call needs — if a Jev call is slow, something is
 * wrong and failing fast is more useful than waiting.
 */
const JEV_TIMEOUT_MS = 15_000;

/** Jev's context window on Workers AI, used to sanity-check batch sizes. */
export const JEV_CONTEXT_TOKENS = 32_000;

// ---------------------------------------------------------------------------
// Question and answer shapes
// ---------------------------------------------------------------------------

/**
 * A true/false judgement. `criteria` is optional but sharpens calibration by
 * telling Jev what each side of the boolean actually means.
 */
export type JevNoulQuestion = {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
};

/** A pick-one judgement over named options. `criteria` maps option -> meaning. */
export type JevChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
};

/**
 * An ordinal judgement. `criteria` is an ordered array of band labels, so the
 * returned `score` is a float in `[0, criteria.length - 1]`.
 */
export type JevScoreQuestion = {
  type: "score";
  instructions: string;
  criteria: string[];
};

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;

/** Probability that the statement is true, in `[0, 1]`. */
export type JevNoulAnswer = { type: "noul"; noul: number };

export type JevChoiceAnswer = {
  type: "choice";
  choice: string;
  confidence?: number;
  probabilities?: Record<string, number>;
};

export type JevScoreAnswer = {
  type: "score";
  score: number;
  confidence?: number;
  legend?: Record<string, string>;
  probabilities?: Record<string, number>;
};

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export type JevResult = {
  /** Resolved model build, e.g. `jev-1.13.0`. */
  model?: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

/**
 * Jev is reachable only through a native Workers AI account URL.
 *
 * The `openai-compatible` mode in this codebase means "the endpoint exposes
 * `/chat/completions`". Jev has no chat-completions surface at all — its
 * request takes `state`/`questions` and its response has no `choices` and no
 * message content — so there is nothing for a compatibility layer to translate.
 * Naming that here beats surfacing it as an opaque 400 from a gateway.
 */
export function assertJevSupported(endpoint: CloudflareEndpoint): void {
  if (endpoint.mode !== "native") {
    throw new Error(
      "Jev requires a native Cloudflare account URL (https://api.cloudflare.com/client/v4/accounts/<account>/ai). " +
        "It is a structured-evaluation model with no chat-completions endpoint, so an OpenAI-compatible route cannot reach it.",
    );
  }
}

/**
 * Builds the HTTP request for a Jev run, following the same `{ url, init }`
 * shape as the TTS render path in `ttsRender.ts`.
 *
 * Jev uses the unified run endpoint — `POST {account}/ai/run` with the model
 * named in the body — rather than the per-model `/run/<model>` form the TTS and
 * STT paths use.
 */
export function buildJevRequest(input: {
  endpoint: CloudflareEndpoint;
  state: unknown;
  questions: Record<string, JevQuestion>;
}): { url: string; init: RequestInit } {
  assertJevSupported(input.endpoint);
  if (Object.keys(input.questions).length === 0) {
    throw new Error("A Jev run needs at least one question");
  }

  return {
    url: `${input.endpoint.apiBaseUrl}/run`,
    init: {
      method: "POST",
      headers: cloudflareHeaders(input.endpoint),
      body: JSON.stringify({
        model: JEV_MODEL,
        input: { state: input.state, questions: input.questions },
      }),
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
      redirect: "manual",
    },
  };
}

/**
 * Reads the answer set out of a Jev response.
 *
 * Cloudflare's REST API wraps model output in `{ result, success, errors }`,
 * while the Workers binding returns it bare. Both are accepted, the same way
 * `extractCloudflareTranscript` handles the STT responses.
 */
export function extractJevResult(payload: unknown): JevResult {
  const root = ((payload as { result?: unknown })?.result ?? payload) as {
    model?: string;
    answers?: Record<string, JevAnswer>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  if (!root?.answers || typeof root.answers !== "object") {
    throw new Error("Jev returned no answers");
  }
  return { model: root.model, answers: root.answers, usage: root.usage };
}

// ---------------------------------------------------------------------------
// Typed accessors
// ---------------------------------------------------------------------------

/** Probability that a noul question is true, or `null` when absent/mistyped. */
export function jevNoul(result: JevResult, key: string): number | null {
  const answer = result.answers[key];
  return answer?.type === "noul" && typeof answer.noul === "number" ? answer.noul : null;
}

export function jevChoice(result: JevResult, key: string): JevChoiceAnswer | null {
  const answer = result.answers[key];
  return answer?.type === "choice" ? answer : null;
}

export function jevScore(result: JevResult, key: string): JevScoreAnswer | null {
  const answer = result.answers[key];
  return answer?.type === "score" ? answer : null;
}

/**
 * Normalizes a score answer onto 0-100 so it can sit alongside the existing
 * cast `confidence` column.
 *
 * `score` is a float across the band indices, so the top band maps to 100 and
 * the bottom to 0. Jev's own `confidence` is reported separately rather than
 * folded in: multiplying the two conflates "this is a weak fit, stated firmly"
 * with "this is a strong fit, stated tentatively", which are different signals
 * and want different handling upstream.
 */
export function jevScorePercent(answer: JevScoreAnswer, bands: number): number {
  if (bands < 2) return 0;
  const clamped = Math.min(Math.max(answer.score, 0), bands - 1);
  return Math.round((clamped / (bands - 1)) * 100);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Runs one Jev evaluation against the configured Cloudflare endpoint.
 *
 * Every question is answered in the same pass, so batching related judgements
 * into a single call is both cheaper and faster than looping.
 */
export async function runJev(input: {
  state: unknown;
  questions: Record<string, JevQuestion>;
  ownerId?: number;
}): Promise<JevResult> {
  const endpoint = await getCloudflareEndpoint(input.ownerId);
  if (!endpoint) {
    throw new Error(
      "Cloudflare is not configured. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or add an account URL on the Settings screen.",
    );
  }

  const { url, init } = buildJevRequest({ endpoint, state: input.state, questions: input.questions });
  const response = await fetch(url, init);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Jev request failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  return extractJevResult(await response.json());
}

// ---------------------------------------------------------------------------
// Bookx application: calibrated cast confidence
// ---------------------------------------------------------------------------

/**
 * Band labels for voice fit. Ordered worst to best, so index 2 is the goal.
 */
const CAST_FIT_BANDS = [
  "Poor fit: the voice contradicts the character's age, role, or temperament as written",
  "Plausible fit: nothing contradicts the character, but nothing supports it strongly either",
  "Strong fit: the voice actively matches how this character reads on the page",
];

/**
 * Jev's context window caps how many characters one review can cover. The cast
 * schema allows up to 64, which alongside a manuscript excerpt risks crowding
 * 32k tokens, so reviews are batched.
 */
export const CAST_REVIEW_BATCH_SIZE = 16;

export type CastProposal = {
  name: string;
  role: string;
  voiceName: string;
  accent?: string;
};

export type CastReview = {
  name: string;
  /** Voice fit on 0-100, derived from Jev's ordinal score. */
  fitPercent: number;
  /** Jev's own calibration on that score, in `[0, 1]`, when reported. */
  calibration: number | null;
  /** True when Jev judges the assignment worth a human look. */
  needsReview: boolean;
};

/**
 * Scores an LLM-proposed cast against the manuscript it came from.
 *
 * The casting router currently asks the language model to self-report a
 * `confidence` number per character. Self-reported confidence is not
 * calibrated — the model has no access to its own error rate — so it tends to
 * cluster high regardless of fit. Jev answers the same question with real
 * probability mass behind it, for a fraction of a cent and in well under a
 * second, which is a better basis for deciding what to surface for review.
 *
 * One call covers the whole batch: two questions per character, all answered in
 * the same pass.
 */
export async function reviewCastProposals(input: {
  excerpt: string;
  proposals: CastProposal[];
  ownerId?: number;
}): Promise<CastReview[]> {
  const batch = input.proposals.slice(0, CAST_REVIEW_BATCH_SIZE);
  if (batch.length === 0) return [];

  const questions: Record<string, JevQuestion> = {};
  batch.forEach((proposal, index) => {
    questions[`fit_${index}`] = {
      type: "score",
      instructions: `How well does the voice "${proposal.voiceName}" suit the character "${proposal.name}" (${proposal.role || "unspecified role"}) as they appear in the manuscript?`,
      criteria: CAST_FIT_BANDS,
    };
    questions[`review_${index}`] = {
      type: "noul",
      instructions: `Should a human check the voice assigned to "${proposal.name}" before narration begins?`,
      criteria: {
        true: "The assignment is questionable, ambiguous, or the character is too thinly written to judge",
        false: "The assignment is clearly reasonable and can proceed unattended",
      },
    };
  });

  const result = await runJev({
    state: { manuscript_excerpt: input.excerpt, proposed_cast: batch },
    questions,
    ownerId: input.ownerId,
  });

  return batch.map((proposal, index) => {
    const fit = jevScore(result, `fit_${index}`);
    const review = jevNoul(result, `review_${index}`);
    return {
      name: proposal.name,
      fitPercent: fit ? jevScorePercent(fit, CAST_FIT_BANDS.length) : 0,
      calibration: typeof fit?.confidence === "number" ? fit.confidence : null,
      // Absent an answer, default to flagging: a missing judgement is not
      // evidence that the assignment is fine.
      needsReview: review == null ? true : review >= 0.5,
    };
  });
}
