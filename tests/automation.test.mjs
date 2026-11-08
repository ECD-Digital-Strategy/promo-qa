import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAsanaCommentHtml,
  getMissingLinkRecipient,
  isPromoQaTask,
  parseShopifyEditorUrl,
} from "../supabase/functions/_shared/asana.ts";
import {
  applyDeterministicGuards,
  collectBannerBlocks,
  failureIssuesCoveredBy,
  formatFailureComment,
  matchExpectedBanners,
  urlsEquivalent,
} from "../supabase/functions/_shared/verify.ts";

test("recognizes intended QA task names", () => {
  assert.equal(isPromoQaTask({ name: "Banner Upload QA" }), true);
  assert.equal(isPromoQaTask({ name: "Promo Banner QA" }), true);
  assert.equal(isPromoQaTask({ name: "QA - homepage banner" }), true);
  assert.equal(isPromoQaTask({ name: "Homepage Banners QA" }), true);
  assert.equal(isPromoQaTask({ name: "Product copy QA" }), false);
  assert.equal(isPromoQaTask({ name: "Promo QA" }), false);
  assert.equal(isPromoQaTask({ name: "LABOR15 QA" }), false);
});

test("Claude requests use Sonnet 5.5 settings and stay valid on rollback", async () => {
  const { buildMessageRequest, DEFAULT_ANTHROPIC_MODEL } = await import(
    "../supabase/functions/_shared/ai.ts"
  );
  assert.equal(DEFAULT_ANTHROPIC_MODEL, "claude-sonnet-5-5");

  const current = buildMessageRequest(DEFAULT_ANTHROPIC_MODEL, "sys", { a: 1 });
  assert.equal(current.body.temperature, undefined);
  assert.equal(current.body.thinking, undefined);
  assert.deepEqual(current.body.output_config, { effort: "low" });
  assert.equal(current.body.fallbacks, "default");
  assert.equal(current.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
  assert.ok(current.body.max_tokens >= 16000);

  // Rolling back via ANTHROPIC_MODEL must not send params Sonnet 4.5 rejects.
  const rollback = buildMessageRequest("claude-sonnet-4-5", "sys", {});
  assert.equal(rollback.body.output_config, undefined);
  assert.equal(rollback.body.fallbacks, undefined);
  assert.deepEqual(rollback.headers, {});

  // Dated Claude 4.0 IDs and Claude 3.x take neither effort nor 16k output.
  for (const model of ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-3-7-sonnet-latest"]) {
    assert.equal(buildMessageRequest(model, "sys", {}).body.output_config, undefined, model);
  }
  assert.equal(buildMessageRequest("claude-3-7-sonnet-latest", "sys", {}).body.max_tokens, 8192);
  assert.deepEqual(buildMessageRequest("claude-opus-5-5", "sys", {}).body.output_config, { effort: "low" });
});

const EMIL = "1206406200377321";
const creator = { gid: "c1", name: "Creator" };

test("missing-link recipient is the Banner Upload parent's assignee", () => {
  const recipient = getMissingLinkRecipient({
    parentTask: { gid: "p", name: "Banner Upload", assignee: { gid: "h1", name: "Hugo" } },
    subtasks: [{ name: "Banner Upload QA", completed: false, assignee_gid: EMIL, assignee_name: "Emil" }],
    comments: [],
  }, creator, EMIL);
  assert.deepEqual(recipient, { gid: "h1", name: "Hugo" });
});

test("missing-link recipient is a Banner Upload sibling's assignee", () => {
  const recipient = getMissingLinkRecipient({
    parentTask: { gid: "p", name: "Labor Day Promo", assignee: { gid: "x", name: "PM" } },
    subtasks: [
      { name: "Banner Upload QA", completed: false, assignee_gid: EMIL, assignee_name: "Emil" },
      { name: "Banner Upload - Desktop + Mobile", completed: false, assignee_gid: "d1", assignee_name: "Diana" },
    ],
    comments: [],
  }, creator, EMIL);
  assert.deepEqual(recipient, { gid: "d1", name: "Diana" });
});

test("missing-link recipient falls back to creator, never Emil", () => {
  const recipient = getMissingLinkRecipient({
    parentTask: { gid: "p", name: "Banner Upload", assignee: { gid: EMIL, name: "Emil" } },
    subtasks: [],
    comments: [],
  }, creator, EMIL);
  assert.deepEqual(recipient, creator);
});

test("failure dedup only suppresses when every issue was already posted", () => {
  const verdict = (issues) => ({
    banners: [{ label: "Hero", ok: false, issues }],
    warnings: [],
  });
  const posted = formatFailureComment(verdict(["Start date is 2026-09-01, expected 2026-09-02."]));
  // Asana returns the stripped HTML with list items run together.
  const stripped = posted.replace(/\n\s*/g, "");
  assert.equal(failureIssuesCoveredBy(verdict(["Start date is 2026-09-01, expected 2026-09-02."]), stripped), true);
  assert.equal(failureIssuesCoveredBy(verdict(["The matched banner block or section is disabled."]), stripped), false);
});

test("comment html keeps every plain line of a casual reply", () => {
  const html = buildAsanaCommentHtml(
    { gid: "h1", name: "Hugo" },
    "Looks good now.\nMarked it complete.",
  );
  assert.equal(
    html,
    '<body><a data-asana-gid="h1" data-asana-type="user"></a>Looks good now. Marked it complete.</body>',
  );
  assert.ok(!html.includes("<br"));
});

test("failure dedup with no itemised issues compares warnings, never 'nothing'", () => {
  const noIssues = (warnings) => ({ banners: [], warnings });
  const posted = formatFailureComment(noIssues(["The Asana specification was ambiguous (60% confidence)."]))
    .replace(/\n\s*/g, "");
  assert.equal(
    failureIssuesCoveredBy(noIssues(["The Asana specification was ambiguous (60% confidence)."]), posted),
    true,
  );
  assert.equal(failureIssuesCoveredBy(noIssues(["Expected 2 banners, found 1."]), posted), false);
  assert.equal(failureIssuesCoveredBy(noIssues([]), posted), false);
});

test("missing-link recipient is never Emil, even as the fallback", () => {
  const recipient = getMissingLinkRecipient(
    { parentTask: null, subtasks: [], comments: [] },
    { gid: EMIL, name: "Emil" },
    EMIL,
  );
  assert.equal(recipient, null);
});

test("Claude answers are cached by input and re-asked when the input changes", async () => {
  const { AnthropicClient } = await import("../supabase/functions/_shared/ai.ts");
  const store = new Map();
  const cache = {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => void store.set(key, value),
  };
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      stop_reason: "end_turn",
      content: [{ type: "text", text: '{"designed":true,"confidence":0.9,"summary":"done","signals":[]}' }],
    }), { status: 200 });
  };
  try {
    const client = new AnthropicClient("test-key", "claude-sonnet-5-5", cache);
    const input = { qaTaskName: "Banner Upload QA", qaTaskNotes: "", subtasks: [], comments: [] };
    await client.assessDesignReadiness(input);
    await client.assessDesignReadiness({ ...input });
    assert.equal(calls, 1);
    await client.assessDesignReadiness({ ...input, comments: [{ text: "design done" }] });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("parses Shopify editor target and HTML escaped query", () => {
  const target = parseShopifyEditorUrl(
    "https://admin.shopify.com/store/example-store/themes/123456/editor?block=select_abc&amp;section=template--1__hero",
  );
  assert.deepEqual(target, {
    url:
      "https://admin.shopify.com/store/example-store/themes/123456/editor?block=select_abc&section=template--1__hero",
    storeSlug: "example-store",
    shopDomain: "example-store.myshopify.com",
    themeId: "123456",
    sectionHint: "template--1__hero",
    blockHint: "select_abc",
  });
});

test("matches a scheduled banner and enforces exact values", () => {
  const template = {
    sections: {
      hero: {
        type: "customizer__hero-slider",
        blocks: {
          select_sale: {
            type: "select",
            settings: {
              link: "https://shop.test/discount/SUMMER20?redirect=%2Fcollections%2Fall",
              active_start_date: "2026-07-22",
              active_end_date: "2026-07-23",
            },
          },
        },
      },
    },
  };
  const expected = [{
    label: "First banner",
    promo_link: "https://shop.test/discount/SUMMER20?redirect=/collections/all",
    start_date: "2026-07-22",
    end_date: "2026-07-23",
    copy: null,
  }];

  const blocks = collectBannerBlocks(template, "template--1__hero");
  const matches = matchExpectedBanners(expected, blocks, "select_sale");
  const guarded = applyDeterministicGuards({
    passed: true,
    confidence: 0.98,
    summary: "Matches",
    warnings: [],
    banners: [{
      label: "First banner",
      matched_block_id: "select_sale",
      start_field: "active_start_date",
      end_field: "active_end_date",
      link_field: "link",
      found_start: "2026-07-22",
      found_end: "2026-07-23",
      found_link: expected[0].promo_link,
      ok: true,
      issues: [],
    }],
  }, matches, "123", "123");

  assert.equal(blocks.length, 1);
  assert.equal(matches[0].block?.blockId, "select_sale");
  assert.equal(guarded.passed, true);
  assert.equal(guarded.banners[0].ok, true);
});

test("fails when Claude maps an incorrect end date", () => {
  const expected = {
    label: "Sale",
    promo_link: "https://shop.test/discount/SAVE",
    start_date: "2026-07-22",
    end_date: "2026-07-24",
    copy: null,
  };
  const match = {
    expected,
    matchedBy: "link",
    matchScore: 1,
    block: {
      sectionId: "hero",
      sectionType: "hero",
      blockId: "sale",
      blockType: "slide",
      disabled: false,
      settings: {
        link: expected.promo_link,
        starts: "2026-07-22",
        ends: "2026-07-23",
      },
    },
  };
  const guarded = applyDeterministicGuards({
    passed: true,
    confidence: 1,
    summary: "Looks fine",
    warnings: [],
    banners: [{
      label: "Sale",
      matched_block_id: "sale",
      start_field: "starts",
      end_field: "ends",
      link_field: "link",
      found_start: "2026-07-22",
      found_end: "2026-07-23",
      found_link: expected.promo_link,
      ok: true,
      issues: [],
    }],
  }, [match], "123", "456");

  assert.equal(guarded.passed, false);
  assert.match(guarded.banners[0].issues.join(" "), /End date mismatch/);
  assert.match(guarded.warnings.join(" "), /not the published theme/);
});

test("normalizes encoded discount URLs", () => {
  assert.equal(
    urlsEquivalent(
      "https://shop.test/discount/FLASH20%20Sitewide?redirect=/collections/all-products",
      "https://shop.test/discount/FLASH20 Sitewide?redirect=%2Fcollections%2Fall-products",
    ),
    true,
  );
});

test("treats Shopify smart collection links as equivalent to storefront URLs", () => {
  assert.equal(
    urlsEquivalent(
      "https://classiccaladiums.com/collections/caladium_varieties",
      "shopify://collections/caladium_varieties",
    ),
    true,
  );
});
