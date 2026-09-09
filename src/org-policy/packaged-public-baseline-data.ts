// Release preparation owns these two literals. No caller path, environment
// override, provider declaration, or browser import may supply trusted bytes.
// Missing publication custody is intentional here until actual preparation runs.
export const PACKAGED_PUBLIC_BASELINE_BYTES_V1: string | null = null;
export const PACKAGED_PUBLIC_BASELINE_SHA256_V1: string | null = null;
