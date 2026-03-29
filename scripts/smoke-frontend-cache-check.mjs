const defaultAppUrl = "https://d2r.bjav.io";
const appUrl = process.argv[2] ?? process.env.D2_SMOKE_APP_URL ?? defaultAppUrl;
const timeoutMs = Number(process.env.D2_SMOKE_APP_TIMEOUT_MS ?? 10000);

const fetchWithTimeout = async (url) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      headers: {
        Accept: "text/html,application/javascript",
      },
      redirect: "follow",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
};

const requireHeader = (headers, name, expectedPart) => {
  const value = headers.get(name);
  if (!value) {
    throw new Error(`Missing ${name} header.`);
  }
  if (!value.toLowerCase().includes(expectedPart.toLowerCase())) {
    throw new Error(`Expected ${name} to include "${expectedPart}", received "${value}".`);
  }
  return value;
};

const htmlResponse = await fetchWithTimeout(appUrl);
if (!htmlResponse.ok) {
  throw new Error(`Frontend HTML returned HTTP ${htmlResponse.status}.`);
}

const html = await htmlResponse.text();
const assetMatch = html.match(/\/assets\/index-[^"' ]+\.js/);
if (!assetMatch) {
  throw new Error("Could not find hashed frontend JS asset in index.html.");
}

const htmlCacheControl = requireHeader(htmlResponse.headers, "cache-control", "no-store");
const assetUrl = new URL(assetMatch[0], appUrl).toString();
const assetResponse = await fetchWithTimeout(assetUrl);
if (!assetResponse.ok) {
  throw new Error(`Frontend asset returned HTTP ${assetResponse.status}.`);
}

const assetCacheControl = requireHeader(assetResponse.headers, "cache-control", "immutable");

console.log(JSON.stringify({
  appUrl,
  assetUrl,
  htmlCacheControl,
  assetCacheControl,
}, null, 2));
