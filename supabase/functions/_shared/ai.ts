import type {
  CandidateMatch,
  CommentIntent,
  DesignReadinessAssessment,
  IncomingComment,
  ParsedPromoSpec,
  QaVerdict,
} from "./types.ts";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";

// Thinking counts toward max_tokens on current models, so leave headroom
// beyond the short JSON answers.
const MAX_TOKENS = 16000;

// Only these models take output_config.effort; ANTHROPIC_MODEL may point back
// at an older one to roll back without a redeploy.
const EFFORT_MODEL =
  /^claude-(?:opus-4-[5-9]|opus-[5-9]|sonnet-4-6|sonnet-[5-9]|haiku-[5-9]|fable-|mythos-)/;
// Claude 3.x models cap output well below MAX_TOKENS.
const LEGACY_MAX_TOKENS = 8192;
// Models that accept server-side refusal fallback (`fallbacks: "default"`).
const DEFAULT_FALLBACK_MODELS = new Set([
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-fable-5-1",
]);

export function buildMessageRequest(
  model: string,
  system: string,
  input: unknown,
): { headers: Record<string, string>; body: Record<string, unknown> } {
  const headers: Record<string, string> = {};
  const body: Record<string, unknown> = {
    model,
    max_tokens: /^claude-3/.test(model) ? LEGACY_MAX_TOKENS : MAX_TOKENS,
    system,
    messages: [{
      role: "user",
      content: JSON.stringify(input),
    }],
  };
  if (EFFORT_MODEL.test(model)) {
    // Extraction and classification: low effort keeps thinking short.
    body.output_config = { effort: "low" };
  }
  if (DEFAULT_FALLBACK_MODELS.has(model)) {
    headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    body.fallbacks = "default";
  }
  return { headers, body };
}

/** Stores Claude answers so an unchanged question isn't asked twice. */
export interface AiAnswerCache {
  get(key: string): Promise<unknown | null>;
  set(key: string, value: unknown): Promise<void>;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export class AnthropicClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly cache: AiAnswerCache | null;

  constructor(
    apiKey: string,
    model = DEFAULT_ANTHROPIC_MODEL,
    cache: AiAnswerCache | null = null,
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.cache = cache;
  }

  /**
   * Same model + prompt + input returns the stored answer. Only for questions
   * whose answer depends on nothing but the input (store, design readiness,
   * comment intent), which cron and webhooks otherwise re-ask on every pass.
   */
  private async cachedJsonMessage<T>(
    kind: string,
    system: string,
    input: unknown,
    validate: (value: T) => void,
  ): Promise<T> {
    const key = this.cache
      ? `${kind}:${await sha256Hex(
        JSON.stringify([this.model, system, input]),
      )}`
      : null;
    if (this.cache && key) {
      const hit = await this.cache.get(key).catch(() => null);
      if (hit !== null && hit !== undefined) {
        try {
          validate(hit as T);
          return hit as T;
        } catch {
          // A stored answer that no longer validates is asked again.
        }
      }
    }
    const value = await this.jsonMessage<T>(system, input);
    validate(value);
    if (this.cache && key) {
      await this.cache.set(key, value).catch((error) =>
        console.error("Failed to store Claude answer:", error)
      );
    }
    return value;
  }

  private async jsonMessage<T>(
    system: string,
    input: unknown,
  ): Promise<T> {
    const request = buildMessageRequest(this.model, system, input);
    const response = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        ...request.headers,
      },
      body: JSON.stringify(request.body),
    });

    const payload = await response.json().catch(() => null) as {
      content?: Array<{ type: string; text?: string }>;
      stop_reason?: string;
      stop_details?: { category?: string | null } | null;
      error?: { message?: string };
    } | null;
    if (!response.ok) {
      throw new Error(
        payload?.error?.message ??
          `Anthropic request failed (${response.status})`,
      );
    }
    if (payload?.stop_reason === "refusal") {
      throw new Error(
        `Claude declined the request (${
          payload.stop_details?.category ?? "no category"
        })`,
      );
    }
    if (payload?.stop_reason === "max_tokens") {
      throw new Error("Claude response was cut off at max_tokens");
    }

    const text = payload?.content
      ?.filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n") ?? "";
    return parseJsonResponse<T>(text);
  }

  async parsePromoSpec(input: {
    taskName: string;
    taskNotes: string;
    parentName?: string;
    parentNotes?: string;
    currentDate: string;
  }): Promise<ParsedPromoSpec> {
    const parsed = await this.jsonMessage<ParsedPromoSpec>(
      `You extract a Shopify promotion specification from Asana task text.
Return JSON only with this exact shape:
{"banners":[{"label":"string","promo_link":"string|null","start_date":"YYYY-MM-DD|null","end_date":"YYYY-MM-DD|null","copy":"string|null"}],"summary":"string","timezone":"string|null","confidence":0.0,"ambiguities":["string"]}
Rules:
- Read both the QA task and parent task; either may contain the specification.
- Each separately scheduled banner/version is a separate banners entry.
- Resolve month/day dates to a year using the provided currentDate and task context.
- Preserve inclusive dates. A one-day banner has the same start_date and end_date.
- Do not invent missing values. Put null and explain in ambiguities.
- confidence is 0..1 and must be below 0.8 if schedule or matching link is ambiguous.`,
      input,
    );

    validateParsedSpec(parsed);
    return parsed;
  }

  async verifyCandidates(input: {
    spec: ParsedPromoSpec;
    candidates: CandidateMatch[];
    configuredThemeId: string;
    publishedThemeId: string;
  }): Promise<QaVerdict> {
    const compactCandidates = input.candidates.map((candidate) => ({
      expected: candidate.expected,
      matchedBy: candidate.matchedBy,
      matchScore: candidate.matchScore,
      block: candidate.block
        ? {
          sectionId: candidate.block.sectionId,
          sectionType: candidate.block.sectionType,
          blockId: candidate.block.blockId,
          blockType: candidate.block.blockType,
          disabled: candidate.block.disabled,
          settings: candidate.block.settings,
        }
        : null,
    }));

    const verdict = await this.jsonMessage<QaVerdict>(
      `You verify Shopify homepage banner schedule configuration against a parsed Asana spec.
Return JSON only:
{"passed":false,"confidence":0.0,"summary":"string","banners":[{"label":"string","matched_block_id":"string|null","start_field":"string|null","end_field":"string|null","link_field":"string|null","found_start":"YYYY-MM-DD|null","found_end":"YYYY-MM-DD|null","found_link":"string|null","ok":false,"issues":["string"]}],"warnings":["string"]}
Rules:
- Identify semantically equivalent date/link fields even if names vary by theme.
- Compare dates exactly and inclusively. Never treat a one-day difference as acceptable.
- Match expected banners to provided blocks; do not use a block that was not provided.
- Disabled blocks fail.
- Missing expected links/dates or missing matching blocks lower confidence and fail.
- URL encoding differences are acceptable only when decoded URL semantics are identical.
- Shopify smart links such as shopify://collections/handle are equivalent to storefront /collections/handle URLs.
- If configuredThemeId differs from publishedThemeId, add a warning but do not fail solely for that.
- passed can be true only when every expected banner is matched and all dates/links match.
- confidence is 0..1.`,
      {
        spec: input.spec,
        candidates: compactCandidates,
        configuredThemeId: input.configuredThemeId,
        publishedThemeId: input.publishedThemeId,
      },
    );

    validateQaVerdict(verdict);
    return verdict;
  }

  async assessDesignReadiness(input: {
    qaTaskName: string;
    qaTaskNotes: string;
    parentName?: string;
    parentNotes?: string;
    subtasks: Array<{
      name: string;
      completed: boolean;
      notes?: string;
      assignee?: string;
    }>;
    comments: Array<{ author?: string; text: string }>;
  }): Promise<DesignReadinessAssessment> {
    return await this.cachedJsonMessage<DesignReadinessAssessment>(
      "design",
      `You decide whether a Shopify promo banner has finished design work and is realistically ready to be scheduled next.
Return JSON only:
{"designed":false,"confidence":0.0,"summary":"string","signals":["string"]}
Rules:
- Use the parent promo task notes, designer subtasks, and comments as evidence.
- designed=true only when design/creative work appears finished or approved (for example completed design subtasks, uploaded banner assets, explicit design approval, or handoff language like "design done" / "ready to schedule").
- designed=false when design is not started, still in progress, blocked, waiting on designer, or only brief/planning exists.
- QA subtasks alone do not prove design is done.
- If evidence is weak or mixed, set designed=false and explain in summary/signals.
- confidence is 0..1. Keep confidence below 0.7 when uncertain.`,
      input,
      validateDesignReadiness,
    );
  }

  async inferStoreSlug(input: {
    taskName: string;
    parentName?: string;
    taskNotes: string;
    parentNotes?: string;
    projectNames: string[];
    stores: Array<{
      store_slug: string;
      display_name: string | null;
      shop_domain: string;
    }>;
  }): Promise<{ store_slug: string | null; confidence: number; reason: string }> {
    return await this.cachedJsonMessage<{
      store_slug: string | null;
      confidence: number;
      reason: string;
    }>(
      "store",
      `You identify which registered Shopify store a promo QA Asana task belongs to.
Return JSON only:
{"store_slug":"string|null","confidence":0.0,"reason":"string"}
Rules:
- Choose only from the provided stores list using the exact store_slug value.
- Use task title, parent title, notes, and project names as evidence.
- Brand or client names in titles often map to one store (for example "Power Planter" -> power-planter-augers).
- Return null with low confidence when the store is ambiguous or not in the list.
- confidence is 0..1.`,
      input,
      (result) => {
        if (typeof result?.confidence !== "number") {
          throw new Error("Claude store inference omitted confidence");
        }
      },
    );
  }

  async interpretTaskComment(input: {
    incoming: IncomingComment;
    recentComments: Array<{
      author?: string;
      text: string;
      createdAt: string;
    }>;
    qaTaskName: string;
    parentName?: string;
    hasEditorLink: boolean;
    storeRegistered: boolean;
    lastQaStatus?: string | null;
    lastQaSummary?: string | null;
  }): Promise<CommentIntent> {
    const intent = await this.cachedJsonMessage<CommentIntent>(
      "intent",
      `You are Emil's Promo QA automation on Asana. Someone just commented on a promo QA task (or tagged Emil on the parent promo card).
Decide how to react. Return JSON only:
{"action":"run_qa"|"reply"|"ignore","runQa":false,"forceQa":false,"replyNeeded":false,"reply":"string|null","reason":"string"}
Rules:
- action=run_qa when they say the banner is ready, uploaded, fixed, added a link, or ask you to check/QA again.
- forceQa=true when they claim something changed since the last check (fixed, enabled, updated dates, added the editor link, "set for your QA").
- action=reply when they ask a question, push back, explain a blocker, or need a human-sounding answer. You may also set runQa=true if a fresh check would help.
- action=ignore for unrelated team chatter that is not directed at QA / Emil.
- replyNeeded=true whenever you should post a comment back. Write reply as Emil: casual, short (1-2 sentences), specific, no markdown, no @mentions.
- If hasEditorLink is false, tell them you still need the Shopify theme editor / promo scheduler link in the Banner Upload QA notes.
- If storeRegistered is false, explain Theme Access is not configured for that store yet, so you cannot inspect the theme.
- Do not invent Shopify findings. If you have not just verified the theme, do not claim the banner is correct or wrong.
- Use lastQaStatus/lastQaSummary only as prior context, not as a new check.
- reply can be null when replyNeeded is false.`,
      input,
      (value) => {
        if (
          value?.action !== "run_qa" &&
          value?.action !== "reply" &&
          value?.action !== "ignore"
        ) {
          throw new Error("Claude comment intent returned an invalid action");
        }
      },
    );
    return {
      action: intent.action,
      runQa: Boolean(intent.runQa) || intent.action === "run_qa",
      forceQa: Boolean(intent.forceQa),
      replyNeeded: Boolean(intent.replyNeeded) || intent.action === "reply",
      reply: typeof intent.reply === "string" && intent.reply.trim()
        ? intent.reply.trim()
        : null,
      reason: intent.reason ?? "",
    };
  }

  async composeQaReply(input: {
    incoming: IncomingComment;
    draftReply?: string | null;
    qaTaskName: string;
    parentName?: string;
    outcome: string;
    outcomeSummary: string;
    issues?: string[];
    hasEditorLink: boolean;
    storeRegistered: boolean;
  }): Promise<string> {
    const result = await this.jsonMessage<{ reply: string }>(
      `You write Emil's follow-up Asana comment after Promo QA looked at a tagged message.
Return JSON only: {"reply":"string"}
Rules:
- Super casual, like Slack. 1 sentence, 2 max. No "Hi", no "Thanks for", no corporate tone.
- Answer their comment using the QA outcome. Do not invent extra issues.
- No markdown and no @mentions (the system tags them separately).
- If outcome is skipped_not_ready, just ask for the theme editor link in the Banner Upload QA notes.
- If outcome is skipped_unregistered, say that store isn't set up in Promo QA yet so you can't check the theme.
- If outcome is failed, name the issue in plain English.
- If outcome is passed, say it looks good and you completed it.`,
      input,
    );
    if (!result.reply?.trim()) {
      throw new Error("Claude reply omitted text");
    }
    return result.reply.trim();
  }
}

function parseJsonResponse<T>(text: string): T {
  const trimmed = text.trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Claude did not return JSON");
  return JSON.parse(trimmed.slice(start, end + 1)) as T;
}

function validateParsedSpec(value: ParsedPromoSpec): void {
  if (!Array.isArray(value?.banners) || !value.banners.length) {
    throw new Error("Claude returned no expected banners");
  }
  if (typeof value.confidence !== "number") {
    throw new Error("Claude spec response omitted confidence");
  }
}

function validateQaVerdict(value: QaVerdict): void {
  if (!Array.isArray(value?.banners) || typeof value.passed !== "boolean") {
    throw new Error("Claude returned an invalid QA verdict");
  }
  if (typeof value.confidence !== "number") {
    throw new Error("Claude QA response omitted confidence");
  }
}

function validateDesignReadiness(value: DesignReadinessAssessment): void {
  if (typeof value?.designed !== "boolean") {
    throw new Error("Claude design readiness response omitted designed");
  }
  if (typeof value.confidence !== "number") {
    throw new Error("Claude design readiness response omitted confidence");
  }
  if (!Array.isArray(value.signals)) {
    throw new Error("Claude design readiness response omitted signals");
  }
}
