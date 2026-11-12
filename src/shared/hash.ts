const encoder = new TextEncoder();

/**
 * Lowercase hex SHA-256 of the UTF-8 text. Uses only Web Crypto, so it runs
 * in the Convex default runtime, Node and Bun.
 */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
