/**
 * Minimal compatibility facade for the imported donor UI.
 *
 * These responses deliberately fail closed. They keep the donor's query-action
 * calls on the authenticated Worker surface without claiming that unsupported
 * features succeeded or reaching ECS, D1, or notification providers.
 */

type DonorActionCode = "FEATURE_NOT_IMPLEMENTED" | "BACKEND_NOT_AVAILABLE" | "ADAPTER_REQUIRED";

const ACTION_CODES: ReadonlyMap<string, DonorActionCode> = new Map([
  ["check_init", "BACKEND_NOT_AVAILABLE"],
  ["setup", "BACKEND_NOT_AVAILABLE"],
  ["login", "ADAPTER_REQUIRED"],
  ["check_login", "ADAPTER_REQUIRED"],
  ["get_status", "ADAPTER_REQUIRED"],
  ["control_instance", "FEATURE_NOT_IMPLEMENTED"],
  ["get_config", "BACKEND_NOT_AVAILABLE"],
  ["save_config", "BACKEND_NOT_AVAILABLE"],
  ["send_test_email", "BACKEND_NOT_AVAILABLE"],
  ["send_test_telegram", "BACKEND_NOT_AVAILABLE"],
  ["send_test_webhook", "BACKEND_NOT_AVAILABLE"],
  ["refresh_account", "ADAPTER_REQUIRED"],
  ["get_logs", "BACKEND_NOT_AVAILABLE"],
  ["clear_logs", "FEATURE_NOT_IMPLEMENTED"],
  ["get_history", "ADAPTER_REQUIRED"],
  ["logout", "FEATURE_NOT_IMPLEMENTED"],
]);

const MESSAGES: Readonly<Record<DonorActionCode, string>> = {
  FEATURE_NOT_IMPLEMENTED: "This action is disabled and was not performed.",
  BACKEND_NOT_AVAILABLE: "This feature is not available in the Worker backend yet.",
  ADAPTER_REQUIRED: "This donor action has not been adapted to the Worker API yet.",
};

export interface DonorActionFailure {
  readonly success: false;
  readonly ok: false;
  readonly available: false;
  readonly mutation: false;
  readonly action: string;
  readonly code: DonorActionCode | "ACTION_NOT_AVAILABLE";
  readonly error: string;
  readonly message: string;
}

/** Return a stable HTTP 501 response; this function has no mutation dependencies. */
export function unsupportedDonorAction(action: string): {
  readonly status: 501;
  readonly headers: Record<string, string>;
  readonly body: string;
} {
  const knownCode = ACTION_CODES.get(action);
  const code = knownCode ?? "ACTION_NOT_AVAILABLE";
  const safeAction = /^[a-z0-9_]{1,64}$/.test(action) ? action : "unknown";
  const message =
    knownCode === undefined ? "This donor action is not available." : MESSAGES[knownCode];
  const body: DonorActionFailure = {
    success: false,
    ok: false,
    available: false,
    mutation: false,
    action: safeAction,
    code,
    error: message,
    message,
  };

  return {
    status: 501,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(body),
  };
}
