/**
 * The automated test logins (e2e-sh@itarang.com, …@e2e.itarang.local) are
 * real, active users on prod. Anything that mails people found by role or by
 * activity must skip them.
 */
export function isTestLogin(email: string): boolean {
    return /(^|[._+-])e2e([._+-]|@)|\.local$/i.test(email.trim());
}
