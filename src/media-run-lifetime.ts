/**
 * The longest a background provider call runs before it is cut off, safely
 * inside the 15-minute alarm wall-clock limit that would kill the call.
 */
export const backgroundProviderTimeoutMs = 12 * 60_000;
