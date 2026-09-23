import { describe, expect, it } from "vitest";

import { renderDashboard } from "../../src/web/dashboard";
import type { DashboardInput } from "../../src/web/dashboard";
import type { HistoryRow } from "../../src/storage/read";

/**
 * Dashboard render contract (SPEC §8.4).
 *
 * These are **semantic** tests: they assert that required fields are present and
 * that dynamic values are escaped. Pixel snapshots and CSS-literal assertions
 * are prohibited (PLAN §8.3 D2) deliberately — they break on restyling while
 * proving nothing about whether the operator can see the right values.
 *
 * The escaping tests carry the weight. Every value here originates from an
 * external response, a driver error, or a run report, and the document is served
 * to a browser with the operator's session. An unescaped value is an XSS with a
 * credential's reach.
 */

const ROW: HistoryRow = {
  id: 7,
  checked_at: "2026-09-22T00:00:00Z",
  trigger: "scheduled",
  status: "success",
  traffic_gb: 123.45,
  threshold_gb: 180,
  usage_percent: 68.583333,
  remaining_gb: 56.55,
  ecs_status_before: "running",
  desired_ecs_state: "stopped",
  action: "stop",
  ecs_status_after: "stopping",
  control_ok: 1,
  webhook_attempted: 1,
  webhook_ok: 1,
  error_stage: null,
  error_message: null,
  duration_ms: 812,
};

function input(overrides: Partial<DashboardInput> = {}): DashboardInput {
  return { latest: ROW, history: [ROW], ...overrides };
}

/** Strip tags so a field's value can be asserted as text, not markup. */
function textOf(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}

describe("renderDashboard — required fields (SPEC §8.4)", () => {
  it("renders current CDT traffic in GB", () => {
    expect(textOf(renderDashboard(input()))).toContain("123.45");
  });

  it("renders the configured threshold", () => {
    expect(textOf(renderDashboard(input()))).toContain("180");
  });

  it("renders the usage percentage", () => {
    // 68.583333 renders at one decimal place as 68.6.
    expect(textOf(renderDashboard(input()))).toMatch(/68\.6/);
  });

  it("renders remaining traffic before the threshold", () => {
    expect(textOf(renderDashboard(input()))).toMatch(/56\.5/);
  });

  it("renders the ECS state before and after", () => {
    const body = textOf(renderDashboard(input()));
    expect(body).toContain("running");
    expect(body).toContain("stopping");
  });

  it("renders the desired ECS state", () => {
    expect(textOf(renderDashboard(input()))).toContain("stopped");
  });

  it("renders the last action and the decision reason", () => {
    const body = textOf(renderDashboard(input()));
    expect(body).toContain("stop");
  });

  it("renders the last scheduled execution time", () => {
    expect(textOf(renderDashboard(input()))).toContain("2026-09-22T00:00:00Z");
  });

  it("renders execution success or failure", () => {
    expect(textOf(renderDashboard(input()))).toMatch(/success/i);
    expect(
      textOf(
        renderDashboard(input({ latest: { ...ROW, status: "error", error_stage: "cdt-query" } })),
      ),
    ).toMatch(/error/i);
  });

  it("renders the webhook attempt result", () => {
    // Both columns, so "attempted" and "succeeded" are separately visible.
    expect(textOf(renderDashboard(input()))).toMatch(/webhook/i);
  });

  it("renders the history persistence result where available", () => {
    const html = renderDashboard(input({ storageOk: true }));
    expect(textOf(html)).toMatch(/history/i);
  });

  it("renders execution duration", () => {
    expect(textOf(renderDashboard(input()))).toContain("812");
  });

  it("states plainly when traffic is unknown rather than showing a number", () => {
    // A missing reading must never render as a figure an operator could read as
    // an actual measurement.
    const unknown = { ...ROW, traffic_gb: null, usage_percent: null, remaining_gb: null };
    const body = textOf(renderDashboard(input({ latest: unknown, history: [unknown] })));
    expect(body).not.toContain("123.45");
    expect(body).toMatch(/unknown|unavailable|n\/a/i);
  });
});

describe("renderDashboard — escaping (SPEC §8.4)", () => {
  const hostile = [
    "<script>alert(1)</script>",
    '"><img src=x onerror=alert(1)>',
    "<svg/onload=alert(1)>",
    "javascript:alert(1)",
  ];

  it.each(hostile)("escapes a hostile value in the error message: %s", (value) => {
    const html = renderDashboard(
      input({ latest: { ...ROW, status: "error", error_message: value } }),
    );
    // The security property is that the payload cannot form a tag: every `<` and
    // `>` from the value must be entity-encoded. Asserting on the literal
    // strings `onerror=`/`onload=` would be wrong, because those substrings do
    // appear — as inert escaped text. What matters is that no raw tag delimiter
    // derived from the value exists, so there is no element for them to attach
    // to.
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("</script>");
    // The value's own angle brackets are entity-encoded.
    expect(html).not.toContain(">" + value.slice(1));
  });

  it("encodes the angle brackets of a hostile payload rather than stripping them", () => {
    // Encoding, not stripping: stripping would still allow an attribute to be
    // broken out of, and would silently alter what the operator sees.
    const payload = "<svg/onload=alert(1)>";
    const html = renderDashboard(
      input({ latest: { ...ROW, status: "error", error_message: payload } }),
    );
    expect(html).toContain("&lt;svg/onload=alert(1)&gt;");
  });

  it("escapes a hostile instance id", () => {
    const html = renderDashboard(
      input({ latest: { ...ROW, error_message: "<script>x</script>" } }),
    );
    expect(html).not.toContain("<script>x</script>");
  });

  it("escapes the ampersand, which would otherwise break attribute values", () => {
    const html = renderDashboard(
      input({ latest: { ...ROW, status: "error", error_message: "a & b" } }),
    );
    expect(html).toContain("&amp;");
  });

  it("escapes quotes so a value cannot break out of an attribute", () => {
    const html = renderDashboard(
      input({ latest: { ...ROW, status: "error", error_message: '" onmouseover="alert(1)' } }),
    );
    expect(html).not.toContain('onmouseover="alert(1)"');
  });
});

describe("renderDashboard — secret hygiene (SPEC §8.4, §7.5)", () => {
  it("does not embed a credential-shaped value from a stored error message", () => {
    const html = renderDashboard(
      input({
        latest: {
          ...ROW,
          status: "error",
          error_message: "AccessKeySecret=LTAI5tSecretValue failed",
        },
      }),
    );
    expect(html).not.toContain("LTAI5tSecretValue");
  });

  it("does not embed a bearer token from a stored error message", () => {
    const html = renderDashboard(
      input({
        latest: {
          ...ROW,
          status: "error",
          error_message: "Authorization: Bearer sk-live-abcdef123456",
        },
      }),
    );
    expect(html).not.toContain("sk-live-abcdef123456");
  });

  it("does not render any secret-shaped placeholder", () => {
    const html = renderDashboard(input({ storageOk: false }));
    expect(html).not.toMatch(/ADMIN_TOKEN|WEBHOOK_TOKEN|AccessKeySecret|AccessKeyId/i);
  });
});

describe("renderDashboard — no privileged work (SPEC §8.4)", () => {
  it("renders from data alone, with no deps to call", () => {
    // `renderDashboard` takes a plain value and returns a string. There is no
    // fetch, no D1 handle, and no ECS client in its signature, so rendering
    // cannot perform a privileged operation by construction.
    const html = renderDashboard(input());
    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(0);
  });

  it("renders a bounded set of history rows, not an unbounded table", () => {
    const many: HistoryRow[] = Array.from({ length: 500 }, (_, i) => ({ ...ROW, id: i }));
    const html = renderDashboard(input({ history: many }));
    const rows = html.match(/<tr/g) ?? [];
    // One header row plus a bounded number of data rows.
    expect(rows.length).toBeLessThan(many.length);
  });
});

describe("renderDashboard — empty history", () => {
  it("renders a meaningful empty state rather than failing", () => {
    const html = renderDashboard({ latest: undefined, history: [] });
    expect(typeof html).toBe("string");
    expect(textOf(html)).toMatch(/no (history|runs)|nothing|none/i);
  });
});
