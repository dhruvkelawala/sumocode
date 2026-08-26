const AUTH_INPUT_PREFIX = "\u{E000}sumocode-auth-input\u{E001}";
const SECRET_INPUT_PREFIX = "\u{E000}sumocode-secret-input\u{E001}";

/**
 * Pi's RPC extension-ui protocol does not currently carry the `AuthPrompt`
 * secret/text distinction. Prefix the title on the child side so SumoCode's
 * paired RPC host can request a masked retained input without exposing the
 * marker or credential. Remove this once Pi adds a first-class secret flag.
 */
export function authInputTitle(title: string, secret = false): string {
	return `${secret ? SECRET_INPUT_PREFIX : AUTH_INPUT_PREFIX}${title}`;
}

export function secretInputTitle(title: string): string {
	return authInputTitle(title, true);
}

export function isSecretInputTitle(title: string): boolean {
	return title.startsWith(SECRET_INPUT_PREFIX);
}

export interface DecodedInputTitle {
	title: string;
	auth: boolean;
	secret: boolean;
}

export function decodeAuthInputTitle(title: string): DecodedInputTitle {
	if (isSecretInputTitle(title)) return { title: title.slice(SECRET_INPUT_PREFIX.length), auth: true, secret: true };
	if (title.startsWith(AUTH_INPUT_PREFIX)) return { title: title.slice(AUTH_INPUT_PREFIX.length), auth: true, secret: false };
	return { title, auth: false, secret: false };
}

export function decodeSecretInputTitle(title: string) {
	const decoded = decodeAuthInputTitle(title);
	return { title: decoded.title, secret: decoded.secret };
}
