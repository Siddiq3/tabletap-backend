// CONTRACT FILE — identical copies live in tabletap-backend, tabletap-web and tabletap-app.
// When you change it, make the same change in the other two repos in the same week,
// and bump CONTRACT_VERSION in index.ts.

/** Must match in all three repos. The backend returns it from /health so you can spot a mismatch. */
export const CONTRACT_VERSION = 2;

export * from "./types";
export * from "./rules";
export * from "./api";
