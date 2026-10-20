/**
 * Saved passwords, S3 secrets and key passphrases never reach the WebView.
 * The backend replaces them with this marker in `get_saved_sites` / vault import results,
 * and swaps the marker back for the stored secret (matched by site id) in
 * `save_site` and `connect_session`.
 */
export const STORED_SECRET = '__RUSTSCP_STORED_SECRET__';

export const isStoredSecret = (v: unknown): boolean => v === STORED_SECRET;
