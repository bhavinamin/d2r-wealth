const defaultHealthUrl = "https://d2r.bjav.io/health";
const healthUrl = process.argv[2] ?? process.env.D2_SMOKE_HEALTH_URL ?? defaultHealthUrl;
const attempts = Number(process.env.D2_SMOKE_HEALTH_ATTEMPTS ?? 6);
const retryDelayMs = Number(process.env.D2_SMOKE_HEALTH_RETRY_DELAY_MS ?? 5000);
const timeoutMs = Number(process.env.D2_SMOKE_HEALTH_TIMEOUT_MS ?? 10000);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchHealth = async () => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(healthUrl, {
      headers: {
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text || null;
    }

    return { response, body };
  } finally {
    clearTimeout(timeout);
  }
};

let lastFailure = null;

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const startedAt = Date.now();
    const { response, body } = await fetchHealth();
    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    }

    if (!body || typeof body !== "object") {
      throw new Error("Health response was not valid JSON.");
    }

    if (body.ok !== true) {
      throw new Error(`Health payload reported ok=${String(body.ok)}.`);
    }

    if (!body.checks?.database || !body.checks?.validity || !body.checks?.accuracy) {
      throw new Error("Health payload is missing required monitoring checks.");
    }

    console.log(JSON.stringify({
      healthUrl,
      attempt,
      durationMs,
      ok: body.ok,
      status: body.status,
      checkedAt: body.checkedAt,
      checks: body.checks,
      latestSnapshot: body.latestSnapshot,
    }, null, 2));
    process.exit(0);
  } catch (error) {
    lastFailure = error instanceof Error ? error.message : String(error);
    console.error(`Health smoke attempt ${attempt}/${attempts} failed: ${lastFailure}`);
    if (attempt < attempts) {
      await delay(retryDelayMs);
    }
  }
}

throw new Error(`Health smoke check failed for ${healthUrl}: ${lastFailure ?? "unknown error"}`);
